//! End-to-end test against a real IMAP/SMTP server.
//!
//!   docker compose -f dev/mailserver.compose.yml up -d
//!   UWUMAIL_TEST_MAILSERVER=127.0.0.1 cargo test -p uwumail-core --test greenmail
//!
//! Skipped when `UWUMAIL_TEST_MAILSERVER` isn't set.

use std::sync::Arc;
use std::time::{Duration, Instant};

use uwumail_core::model::*;
use uwumail_core::secrets::MemorySecrets;
use uwumail_core::{Engine, EngineOptions};

fn server() -> Option<String> {
    std::env::var("UWUMAIL_TEST_MAILSERVER").ok().filter(|s| !s.is_empty())
}

async fn wait_for<T>(what: &str, mut check: impl AsyncFnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(40);
    loop {
        if let Some(value) = check().await {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

fn inbox_query(search: Option<&str>) -> ThreadQuery {
    ThreadQuery {
        view: MailboxView::Unified { role: UnifiedRole::Inbox },
        filter: ListFilter::All,
        search: search.map(String::from),
        conversations: true,
        cursor: None,
        limit: 50,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_send_reply_flag_and_trash() {
    let Some(host) = server() else {
        eprintln!("UWUMAIL_TEST_MAILSERVER not set, skipping");
        return;
    };
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::new(EngineOptions {
        data_dir: data.path().to_path_buf(),
        secrets: Arc::new(MemorySecrets::default()),
        open_url: Arc::new(|_| {}),
    })
    .unwrap();
    let mut events = engine.subscribe();

    let unique = uuid::Uuid::new_v4().simple().to_string();
    let email = format!("mini-{}@uwumail.test", &unique[..8]);
    let imap = ServerSettings { host: host.clone(), port: 3143, security: Security::None };
    let smtp = ServerSettings { host, port: 3025, security: Security::None };

    let account = engine
        .add_account(NewAccount {
            display_name: "Mini".into(),
            email: email.clone(),
            auth: AuthKind::Password,
            password: Some("uwu".into()),
            imap,
            smtp,
            username: email.clone(),
            color: AccountColor::Pink,
        })
        .await
        .expect("account can be added");

    // The first sync creates the folder list.
    wait_for("the inbox folder", async || {
        engine.list_folders(Some(&account.id)).unwrap().into_iter().find(|f| f.role == Some(FolderRole::Inbox))
    })
    .await;

    let subject = format!("Hallo {unique}");
    engine
        .send(OutgoingMessage {
            account_id: account.id.clone(),
            to: vec![Address { name: Some("Mini".into()), email: email.clone() }],
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
        })
        .await
        .expect("message can be sent");

    // It arrives in the inbox (IDLE or the wake-up after sending picks it up).
    let thread = wait_for("the sent message in the inbox", async || {
        engine.sync_now(Some(&account.id));
        engine.list_threads(&inbox_query(None)).unwrap().threads.into_iter().find(|t| t.subject == subject)
    })
    .await;
    assert_eq!(thread.unread_count, 1);
    assert!(thread.has_attachments);

    let detail = engine.get_thread(&thread.id, true).await.unwrap();
    let message = &detail.messages[0];
    assert!(message.body_html.as_deref().unwrap_or_default().contains("<b>Clip</b>"));
    assert_eq!(message.attachments[0].filename, "notiz.txt");

    // Full-text search finds it by a body word prefix.
    assert!(!engine.list_threads(&inbox_query(Some("gesehe"))).unwrap().threads.is_empty());

    // Flags go to the server and survive a fresh sync.
    engine
        .set_flags(std::slice::from_ref(&message.id), FlagChange { seen: Some(true), flagged: Some(true) })
        .await
        .unwrap();
    engine.sync_now(Some(&account.id));
    tokio::time::sleep(Duration::from_secs(2)).await;
    let thread =
        engine.list_threads(&inbox_query(None)).unwrap().threads.into_iter().find(|t| t.subject == subject).unwrap();
    assert_eq!(thread.unread_count, 0);
    assert!(thread.flagged);

    // Replying threads the answer into the same conversation.
    engine
        .send(OutgoingMessage {
            account_id: account.id.clone(),
            to: vec![Address { name: None, email: email.clone() }],
            cc: vec![Address {
                name: Some("Leni Wanders".into()),
                email: format!("leni-{}@uwumail.test", &unique[..8]),
            }],
            bcc: vec![],
            subject: format!("Re: {subject}"),
            html: "<p>Ja!</p>".into(),
            text: "Ja!".into(),
            in_reply_to: Some(message.id.clone()),
            attachments: vec![],
        })
        .await
        .unwrap();
    wait_for("the reply in the same conversation", async || {
        engine.sync_now(Some(&account.id));
        engine
            .list_threads(&inbox_query(None))
            .unwrap()
            .threads
            .into_iter()
            .find(|t| t.id == thread.id && t.message_count >= 2)
    })
    .await;

    // Contacts learned the new address, but never suggest my own.
    let contacts = engine.search_contacts("leni-").unwrap();
    assert!(contacts.iter().any(|c| c.name.as_deref() == Some("Leni Wanders")));
    assert!(!engine.search_contacts("mini-").unwrap().iter().any(|c| c.email == email));

    // Trash moves the whole conversation out of the inbox.
    let detail = engine.get_thread(&thread.id, true).await.unwrap();
    let ids: Vec<String> = detail.messages.iter().map(|m| m.id.clone()).collect();
    engine.trash(&ids).await.unwrap();
    wait_for("the conversation to leave the inbox", async || {
        engine.sync_now(Some(&account.id));
        let gone = !engine.list_threads(&inbox_query(None)).unwrap().threads.iter().any(|t| t.subject == subject);
        gone.then_some(())
    })
    .await;
    let trash = engine
        .list_folders(Some(&account.id))
        .unwrap()
        .into_iter()
        .find(|f| f.role == Some(FolderRole::Trash))
        .expect("a trash folder exists");
    assert!(trash.total >= 2);

    // The engine told the UI about all of it.
    let mut saw_change = false;
    while let Ok(event) = events.try_recv() {
        saw_change |= matches!(event, EngineEvent::MailChanged { .. });
    }
    assert!(saw_change);

    engine.remove_account(&account.id).await.unwrap();
    assert!(engine.list_accounts().unwrap().is_empty());
}
