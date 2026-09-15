//! End-to-end test against a real JMAP server (Stalwart).
//!
//!   dev/stalwart.sh
//!   UWUMAIL_TEST_JMAP=http://127.0.0.1:8080 cargo test -p uwumail-core --test stalwart
//!
//! Skipped when `UWUMAIL_TEST_JMAP` isn't set.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use uwumail_core::jmap::Client;
use uwumail_core::model::*;
use uwumail_core::secrets::MemorySecrets;
use uwumail_core::{Engine, EngineOptions};

const MINI: (&str, &str) = ("mini@uwumail.test", "Kirschbluete-Tastatur-42!");
const LENI: (&str, &str) = ("leni@uwumail.test", "Seifenblase-Wanderweg-17!");

async fn wait_for<T>(what: &str, mut check: impl AsyncFnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(40);
    loop {
        if let Some(value) = check().await {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn folder_query(account_id: &str, folder_id: &str) -> ThreadQuery {
    ThreadQuery {
        view: MailboxView::Folder { account_id: account_id.into(), folder_id: folder_id.into() },
        filter: ListFilter::All,
        search: None,
        conversations: true,
        cursor: None,
        limit: 50,
    }
}

fn role_folder(engine: &Engine, account_id: &str, role: FolderRole) -> Option<Folder> {
    engine.list_folders(Some(account_id)).unwrap().into_iter().find(|f| f.role == Some(role))
}

/// Keywords and mailboxes of the emails with exactly this subject, straight from the server.
async fn server_keywords(client: &Client, subject: &str) -> Vec<Value> {
    let responses = client
        .call(vec![
            ("Email/query", json!({ "accountId": client.account_id(), "filter": { "subject": subject } })),
            (
                "Email/get",
                json!({
                    "accountId": client.account_id(),
                    "#ids": { "resultOf": "0", "name": "Email/query", "path": "/ids" },
                    "properties": ["subject", "keywords", "mailboxIds"],
                }),
            ),
        ])
        .await
        .unwrap();
    // The subject filter also matches "Re: …".
    let list = responses.get(1, "Email/get").unwrap()["list"].as_array().cloned().unwrap_or_default();
    list.into_iter().filter(|email| email["subject"] == subject).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn jmap_sync_send_push_flags_and_trash() {
    let Some(base) = std::env::var("UWUMAIL_TEST_JMAP").ok().filter(|s| !s.is_empty()) else {
        eprintln!("UWUMAIL_TEST_JMAP not set, skipping");
        return;
    };
    // Through the well-known redirect, with the announced (unreachable) public address.
    let session_url = format!("{}/.well-known/jmap", base.trim_end_matches('/'));
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::new(EngineOptions {
        data_dir: data.path().to_path_buf(),
        secrets: Arc::new(MemorySecrets::default()),
        open_url: Arc::new(|_| {}),
    })
    .unwrap();
    let mut events = engine.subscribe();

    let no_server = ServerSettings { host: String::new(), port: 0, security: Security::Tls };
    let add = async |(email, password): (&str, &str), name: &str| {
        engine
            .add_account(NewAccount {
                display_name: name.into(),
                email: email.into(),
                auth: AuthKind::Password,
                password: Some(password.into()),
                imap: no_server.clone(),
                smtp: no_server.clone(),
                username: email.into(),
                color: AccountColor::Pink,
                protocol: Protocol::Jmap,
                jmap_url: Some(session_url.clone()),
            })
            .await
            .expect("a JMAP account can be added")
    };
    let mini = add(MINI, "Mini").await;
    let leni = add(LENI, "Leni Wanders").await;
    assert_eq!(mini.protocol, Protocol::Jmap);
    assert_eq!(mini.protocols, [Protocol::Jmap]);
    assert!(engine.set_protocol(&mini.id, Protocol::Imap).await.is_err(), "no IMAP settings to switch to");

    // Wrong passwords are refused before anything is stored.
    let wrong = engine
        .add_account(NewAccount {
            display_name: "Nope".into(),
            email: "nope@uwumail.test".into(),
            auth: AuthKind::Password,
            password: Some("wrong".into()),
            imap: no_server.clone(),
            smtp: no_server.clone(),
            username: "nope@uwumail.test".into(),
            color: AccountColor::Pink,
            protocol: Protocol::Jmap,
            jmap_url: Some(session_url.clone()),
        })
        .await;
    assert_eq!(wrong.unwrap_err().code, uwumail_core::ErrorCode::AuthFailed);

    let leni_inbox = wait_for("Leni's mailboxes", async || role_folder(&engine, &leni.id, FolderRole::Inbox)).await;
    wait_for("Mini's mailboxes", async || role_folder(&engine, &mini.id, FolderRole::Sent)).await;

    let unique = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
    let http = reqwest::Client::new();
    let mini_server = Client::connect(&http, &session_url, MINI.0, MINI.1).await.unwrap();
    let leni_server = Client::connect(&http, &session_url, LENI.0, LENI.1).await.unwrap();

    // Mailboxes nested by another client show up as a tree.
    let projects = format!("Projekte {unique}");
    let created = mini_server
        .call(vec![(
            "Mailbox/set",
            json!({
                "accountId": mini_server.account_id(),
                "create": {
                    "parent": { "name": projects, "parentId": null },
                    "child": { "name": "Bugs", "parentId": "#parent" },
                },
            }),
        )])
        .await
        .unwrap();
    assert!(created.get(0, "Mailbox/set").unwrap()["created"]["child"]["id"].is_string());
    let (parent, child) = wait_for("the nested mailboxes", async || {
        let folders = engine.list_folders(Some(&mini.id)).unwrap();
        let parent = folders.iter().find(|f| f.name == projects)?.clone();
        let child = folders.iter().find(|f| f.name == "Bugs" && f.parent_id.as_ref() == Some(&parent.id))?.clone();
        Some((parent, child))
    })
    .await;
    assert_eq!(parent.parent_id, None);
    assert!(child.selectable);

    // Mini writes to Leni with an attachment.
    let subject = format!("Hallo {unique}");
    engine
        .send(OutgoingMessage {
            account_id: mini.id.clone(),
            to: vec![Address { name: Some("Leni Wanders".into()), email: LENI.0.into() }],
            cc: vec![],
            bcc: vec![],
            subject: subject.clone(),
            html: "<p>Hast du den <b>Clip</b> gesehen?</p>".into(),
            text: "Hast du den Clip gesehen?".into(),
            in_reply_to: None,
            attachments: vec![OutgoingAttachment {
                filename: "notiz.txt".into(),
                mime_type: "text/plain".into(),
                size: 5,
                source: AttachmentSource::Base64 { data: "SGFsbG8=".into() },
            }],
            draft_key: None,
            from_email: None,
        })
        .await
        .expect("message can be sent over JMAP");

    // Push brings it to Leni; nobody asks for a sync here.
    let thread = wait_for("the mail in Leni's inbox", async || {
        engine
            .list_threads(&folder_query(&leni.id, &leni_inbox.id))
            .unwrap()
            .threads
            .into_iter()
            .find(|t| t.subject == subject)
    })
    .await;
    assert_eq!(thread.unread_count, 1);
    assert!(thread.has_attachments);

    let detail = engine.get_thread(&thread.id, true).await.unwrap();
    let message = detail.messages.last().unwrap().clone();
    assert!(message.body_html.as_deref().unwrap_or_default().contains("<b>Clip</b>"));
    let file = engine.attachment(&message.attachments[0].id).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file.path).unwrap(), "Hallo");

    // Mini's copy is filed in Sent.
    wait_for("Mini's sent copy", async || {
        let sent = role_folder(&engine, &mini.id, FolderRole::Sent)?;
        engine
            .list_threads(&folder_query(&mini.id, &sent.id))
            .unwrap()
            .threads
            .into_iter()
            .find(|t| t.subject == subject)
    })
    .await;

    // Flags reach the server.
    engine
        .set_flags(std::slice::from_ref(&message.id), FlagChange { seen: Some(true), flagged: Some(true) })
        .await
        .unwrap();
    let keywords = server_keywords(&leni_server, &subject).await;
    assert_eq!(keywords.len(), 1);
    assert_eq!(keywords[0]["keywords"]["$seen"], true);
    assert_eq!(keywords[0]["keywords"]["$flagged"], true);

    // A flag set on the server comes back.
    let email_id = leni_server
        .call(vec![("Email/query", json!({ "accountId": leni_server.account_id(), "filter": { "subject": subject } }))])
        .await
        .unwrap()
        .get(0, "Email/query")
        .unwrap()["ids"][0]
        .as_str()
        .unwrap()
        .to_string();
    leni_server
        .call(vec![(
            "Email/set",
            json!({ "accountId": leni_server.account_id(), "update": { email_id.clone(): { "keywords/$flagged": null } } }),
        )])
        .await
        .unwrap();
    wait_for("the server's unflag", async || {
        let messages = engine.get_thread(&thread.id, true).await.ok()?.messages;
        messages.iter().all(|m| !m.flags.flagged).then_some(())
    })
    .await;

    // Leni answers; the reply joins Mini's conversation.
    engine
        .send(OutgoingMessage {
            account_id: leni.id.clone(),
            to: vec![Address { name: Some("Mini".into()), email: MINI.0.into() }],
            cc: vec![],
            bcc: vec![],
            subject: format!("Re: {subject}"),
            html: "<p>Ja!</p>".into(),
            text: "Ja!".into(),
            in_reply_to: Some(message.id.clone()),
            attachments: vec![],
            draft_key: None,
            from_email: None,
        })
        .await
        .unwrap();
    let mini_inbox = role_folder(&engine, &mini.id, FolderRole::Inbox).unwrap();
    wait_for("the reply in Mini's conversation", async || {
        engine
            .list_threads(&folder_query(&mini.id, &mini_inbox.id))
            .unwrap()
            .threads
            .into_iter()
            .find(|t| t.subject == subject && t.message_count >= 2)
    })
    .await;
    let answered = server_keywords(&leni_server, &subject).await;
    assert!(answered.iter().any(|email| email["keywords"]["$answered"] == true), "the original is marked answered");

    // Trash moves the message on the server; trashing it again deletes it.
    engine.trash(std::slice::from_ref(&message.id)).await.unwrap();
    let trash = role_folder(&engine, &leni.id, FolderRole::Trash).unwrap();
    assert!(
        engine
            .list_threads(&folder_query(&leni.id, &leni_inbox.id))
            .unwrap()
            .threads
            .iter()
            .all(|t| t.subject != subject)
    );
    let on_server = server_keywords(&leni_server, &subject).await;
    assert_eq!(on_server[0]["mailboxIds"], json!({ trash.path.clone(): true }));
    engine.trash(std::slice::from_ref(&message.id)).await.unwrap();
    let left = server_keywords(&leni_server, &subject).await;
    assert!(left.is_empty(), "still on the server: {left:?}");
    assert!(
        engine.list_threads(&folder_query(&leni.id, &trash.id)).unwrap().threads.iter().all(|t| t.subject != subject)
    );

    // The engine told the UI about new mail.
    let mut saw_received = false;
    while let Ok(event) = events.try_recv() {
        saw_received |= matches!(event, EngineEvent::MailReceived { ref account_id, .. } if *account_id == mini.id);
    }
    assert!(saw_received);

    engine.remove_account(&mini.id).await.unwrap();
    engine.remove_account(&leni.id).await.unwrap();
    assert!(engine.list_accounts().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn jmap_drafts_are_saved_replaced_and_removed_on_send() {
    let Some(base) = std::env::var("UWUMAIL_TEST_JMAP").ok().filter(|s| !s.is_empty()) else {
        eprintln!("UWUMAIL_TEST_JMAP not set, skipping");
        return;
    };
    let session_url = format!("{}/.well-known/jmap", base.trim_end_matches('/'));
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::new(EngineOptions {
        data_dir: data.path().to_path_buf(),
        secrets: Arc::new(MemorySecrets::default()),
        open_url: Arc::new(|_| {}),
    })
    .unwrap();
    let no_server = ServerSettings { host: String::new(), port: 0, security: Security::Tls };
    let mini = engine
        .add_account(NewAccount {
            display_name: "Mini".into(),
            email: MINI.0.into(),
            auth: AuthKind::Password,
            password: Some(MINI.1.into()),
            imap: no_server.clone(),
            smtp: no_server,
            username: MINI.0.into(),
            color: AccountColor::Pink,
            protocol: Protocol::Jmap,
            jmap_url: Some(session_url.clone()),
        })
        .await
        .unwrap();
    wait_for("Mini's mailboxes", async || role_folder(&engine, &mini.id, FolderRole::Inbox)).await;

    let unique = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
    let subject = format!("Entwurf {unique}");
    let leni = Address { name: Some("Leni Wanders".into()), email: LENI.0.into() };
    let draft = |to: Vec<Address>, html: &str, draft_key: Option<String>| OutgoingMessage {
        account_id: mini.id.clone(),
        to,
        cc: vec![],
        bcc: vec![],
        subject: subject.clone(),
        html: html.into(),
        text: html.replace("<p>", "").replace("</p>", ""),
        in_reply_to: None,
        attachments: vec![],
        draft_key,
        from_email: None,
    };

    let first = engine.save_draft(draft(vec![], "<p>Hi</p>", None)).await.unwrap();
    engine.save_draft(draft(vec![leni.clone()], "<p>Hi Leni!</p>", Some(first.draft_key.clone()))).await.unwrap();
    let http = reqwest::Client::new();
    let server = Client::connect(&http, &session_url, MINI.0, MINI.1).await.unwrap();
    let on_server = server_keywords(&server, &subject).await;
    assert_eq!(on_server.len(), 1, "only the newest version stays: {on_server:?}");
    assert_eq!(on_server[0]["keywords"]["$draft"], true);

    let drafts = wait_for("Mini's drafts folder", async || role_folder(&engine, &mini.id, FolderRole::Drafts)).await;
    let thread = wait_for("the draft in the drafts folder", async || {
        engine
            .list_threads(&folder_query(&mini.id, &drafts.id))
            .unwrap()
            .threads
            .into_iter()
            .find(|t| t.subject == subject)
    })
    .await;
    let detail = engine.get_thread(&thread.id, true).await.unwrap();
    let opened = engine.open_draft(&detail.messages[0].id).await.unwrap();
    assert_eq!(opened.draft_key.as_deref(), Some(first.draft_key.as_str()));
    assert_eq!(opened.to[0].email, LENI.0);

    engine.send(draft(vec![leni], "<p>Hi Leni!</p>", Some(first.draft_key.clone()))).await.unwrap();
    let left = server_keywords(&server, &subject).await;
    assert!(left.iter().all(|email| email["keywords"]["$draft"] != true), "the draft is gone: {left:?}");

    engine.remove_account(&mini.id).await.unwrap();
}
