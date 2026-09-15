//! End-to-end test against a real IMAP/SMTP server.
//!
//!   docker compose -f dev/mailserver.compose.yml up -d
//!   UWUMAIL_TEST_MAILSERVER=127.0.0.1 cargo test -p uwumail-core --test greenmail
//!
//! Skipped when `UWUMAIL_TEST_MAILSERVER` isn't set.

use std::sync::Arc;
use std::time::{Duration, Instant};

use uwumail_core::imap;
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
            imap: imap.clone(),
            smtp,
            username: email.clone(),
            color: AccountColor::Pink,
            protocol: Protocol::Imap,
            jmap_url: None,
        })
        .await
        .expect("account can be added");
    assert_eq!(account.protocol, Protocol::Imap);
    assert_eq!(account.protocols, [Protocol::Imap]);

    // The first sync creates the folder list.
    wait_for("the inbox folder", async || {
        engine.list_folders(Some(&account.id)).unwrap().into_iter().find(|f| f.role == Some(FolderRole::Inbox))
    })
    .await;

    // Nested folders created by another client show up as a tree.
    let mut other_client =
        imap::login(&imap, imap::Login::Password { username: &email, password: "uwu" }).await.unwrap();
    let delimiter = imap::list_folders(&mut other_client)
        .await
        .unwrap()
        .into_iter()
        .find_map(|f| f.delimiter)
        .unwrap_or(".".into());
    other_client.create("Projekte").await.unwrap();
    other_client.create(format!("Projekte{delimiter}Bugs")).await.unwrap();
    let _ = other_client.logout().await;
    let (parent, child) = wait_for("the nested folder", async || {
        engine.sync_now(Some(&account.id));
        let folders = engine.list_folders(Some(&account.id)).unwrap();
        let parent = folders.iter().find(|f| f.path == "Projekte")?.clone();
        let child = folders.iter().find(|f| f.name == "Bugs")?.clone();
        Some((parent, child))
    })
    .await;
    assert_eq!(child.parent_id.as_deref(), Some(parent.id.as_str()));
    assert_eq!(parent.parent_id, None);

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
            draft_key: None,
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

    // Attachments load once, then come from the local cache and can be saved anywhere.
    let file = engine.attachment(&message.attachments[0].id).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file.path).unwrap(), "Hallo");
    assert!(!file.dangerous);
    assert!(file.path.starts_with(engine.attachment_dir()));
    let copy = data.path().join("kopie.txt");
    engine.save_attachment(&message.attachments[0].id, &copy).await.unwrap();
    assert_eq!(std::fs::read_to_string(&copy).unwrap(), "Hallo");

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
            draft_key: None,
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
    wait_for("both messages in the trash folder", async || {
        engine.sync_now(Some(&account.id));
        engine
            .list_folders(Some(&account.id))
            .unwrap()
            .into_iter()
            .find(|f| f.role == Some(FolderRole::Trash) && f.total >= 2)
    })
    .await;

    // The engine told the UI about all of it.
    let mut saw_change = false;
    while let Ok(event) = events.try_recv() {
        saw_change |= matches!(event, EngineEvent::MailChanged { .. });
    }
    assert!(saw_change);

    engine.remove_account(&account.id).await.unwrap();
    assert!(engine.list_accounts().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn old_mail_becomes_previews_and_server_search_finds_the_rest() {
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
    // Like the phone: only the last 30 days complete.
    engine.set_offline_days(Some(30)).unwrap();

    let unique = uuid::Uuid::new_v4().simple().to_string();
    let email = format!("nyu-{}@uwumail.test", &unique[..8]);
    let imap = ServerSettings { host: host.clone(), port: 3143, security: Security::None };
    let smtp = ServerSettings { host, port: 3025, security: Security::None };

    // Fill the inbox before UwUMail looks: the oldest mail lies beyond the first sync's window.
    let mut client = imap::login(&imap, imap::Login::Password { username: &email, password: "uwu" }).await.unwrap();
    let raw = |subject: &str, body: &str, date: &str| {
        format!(
            "From: Leni <leni@uwumail.test>\r\nTo: {email}\r\nSubject: {subject}\r\nDate: {date}\r\n\
             Message-ID: <{}@uwumail.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n",
            uuid::Uuid::new_v4().simple()
        )
    };
    let long_ago = Some("\"01-Jan-2024 10:00:00 +0000\"");
    client
        .append(
            "INBOX",
            None,
            long_ago,
            raw("Ganz alt", "Das Geheimwort ist Zimtschnecke.", "Mon, 1 Jan 2024 10:00:00 +0000"),
        )
        .await
        .unwrap();
    for index in 0..imap::INITIAL_WINDOW - 1 {
        let body = format!("Nachricht {index}");
        client.append("INBOX", None, None, raw("Neu", &body, "Mon, 14 Sep 2026 10:00:00 +0000")).await.unwrap();
    }
    client
        .append("INBOX", None, long_ago, raw("Etwas aelter", "Hier sind die Kekse.", "Mon, 1 Jan 2024 11:00:00 +0000"))
        .await
        .unwrap();
    let _ = client.logout().await;

    let account = engine
        .add_account(NewAccount {
            display_name: "Nyu".into(),
            email: email.clone(),
            auth: AuthKind::Password,
            password: Some("uwu".into()),
            imap,
            smtp,
            username: email.clone(),
            color: AccountColor::Violet,
            protocol: Protocol::Imap,
            jmap_url: None,
        })
        .await
        .unwrap();

    let single = |search: Option<&str>| ThreadQuery { conversations: false, limit: 500, ..inbox_query(search) };
    let older = wait_for("the older message in the inbox", async || {
        engine.list_threads(&single(None)).unwrap().threads.into_iter().find(|t| t.subject == "Etwas aelter")
    })
    .await;

    // Older than 30 days: only headers are stored, the body comes when opening it.
    // (GreenMail garbles partial fetches, so there is no preview text here.)
    let message_id = older.id.strip_prefix("m:").unwrap().to_string();
    let stored = engine.messages(std::slice::from_ref(&message_id)).unwrap();
    assert_eq!(stored[0].body_text, None);
    let opened = engine.get_thread(&older.id, false).await.unwrap();
    assert!(opened.messages[0].body_text.as_deref().unwrap_or_default().contains("Kekse"));

    // The oldest mail isn't on this device, but the server finds it.
    assert!(engine.list_threads(&single(Some("Zimtschnecke"))).unwrap().threads.is_empty());
    let found = engine.search_server(&single(Some("Zimtschnecke"))).await.unwrap();
    let thread = found.threads.iter().find(|t| t.subject == "Ganz alt").expect("server search finds the old mail");
    let detail = engine.get_thread(&thread.id, false).await.unwrap();
    assert!(detail.messages[0].body_text.as_deref().unwrap_or_default().contains("Zimtschnecke"));

    engine.remove_account(&account.id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn drafts_are_saved_replaced_continued_and_removed_on_send() {
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
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let email = format!("draft-{}@uwumail.test", &unique[..8]);
    let imap = ServerSettings { host: host.clone(), port: 3143, security: Security::None };
    let smtp = ServerSettings { host, port: 3025, security: Security::None };
    let account = engine
        .add_account(NewAccount {
            display_name: "Mini".into(),
            email: email.clone(),
            auth: AuthKind::Password,
            password: Some("uwu".into()),
            imap: imap.clone(),
            smtp,
            username: email.clone(),
            color: AccountColor::Pink,
            protocol: Protocol::Imap,
            jmap_url: None,
        })
        .await
        .unwrap();
    wait_for("the inbox folder", async || {
        engine.list_folders(Some(&account.id)).unwrap().into_iter().find(|f| f.role == Some(FolderRole::Inbox))
    })
    .await;

    let subject = format!("Entwurf {unique}");
    let draft = |to: Vec<Address>, html: &str, draft_key: Option<String>| OutgoingMessage {
        account_id: account.id.clone(),
        to,
        cc: vec![],
        bcc: vec![Address { name: None, email: "heimlich@uwumail.test".into() }],
        subject: subject.clone(),
        html: html.into(),
        text: html.replace("<p>", "").replace("</p>", ""),
        in_reply_to: None,
        attachments: vec![OutgoingAttachment {
            filename: "notiz.txt".into(),
            mime_type: "text/plain".into(),
            size: 5,
            source: AttachmentSource::Base64 { data: "SGFsbG8=".into() },
        }],
        draft_key,
    };

    // A draft without recipients can be saved; saving again replaces it instead of adding one.
    let first = engine.save_draft(draft(vec![], "<p>Hi</p>", None)).await.expect("a draft can be saved");
    let me = Address { name: None, email: email.clone() };
    let second = engine
        .save_draft(draft(vec![me.clone()], "<p>Hi Leni, hast du Zeit?</p>", Some(first.draft_key.clone())))
        .await
        .unwrap();
    assert_eq!(first.draft_key, second.draft_key);

    let drafts_query = ThreadQuery { view: MailboxView::Unified { role: UnifiedRole::Drafts }, ..inbox_query(None) };
    let drafts = engine.list_threads(&drafts_query).unwrap().threads;
    let mine: Vec<_> = drafts.iter().filter(|t| t.subject == subject).collect();
    assert_eq!(mine.len(), 1, "the draft shows up once right away");

    let folder = engine
        .list_folders(Some(&account.id))
        .unwrap()
        .into_iter()
        .find(|f| f.role == Some(FolderRole::Drafts))
        .unwrap();
    let mut other_client =
        imap::login(&imap, imap::Login::Password { username: &email, password: "uwu" }).await.unwrap();
    let on_server = imap::uids_with_message_id(&mut other_client, &folder.path, &first.draft_key).await.unwrap();
    assert_eq!(on_server.len(), 1, "only the newest version stays on the server");

    // Opening it brings back everything, including Bcc and the attachment.
    let detail = engine.get_thread(&mine[0].id, true).await.unwrap();
    let opened = engine.open_draft(&detail.messages[0].id).await.unwrap();
    assert_eq!(opened.draft_key.as_deref(), Some(first.draft_key.as_str()));
    assert_eq!(opened.to, std::slice::from_ref(&me));
    assert_eq!(opened.bcc[0].email, "heimlich@uwumail.test");
    assert!(opened.html.contains("hast du Zeit"));
    assert_eq!(opened.attachments[0].filename, "notiz.txt");

    // Sending it removes the draft, here and on the server.
    engine
        .send(OutgoingMessage {
            bcc: vec![],
            ..draft(vec![me], "<p>Hi Leni, hast du Zeit?</p>", Some(first.draft_key.clone()))
        })
        .await
        .unwrap();
    assert!(engine.list_threads(&drafts_query).unwrap().threads.iter().all(|t| t.subject != subject));
    assert!(imap::uids_with_message_id(&mut other_client, &folder.path, &first.draft_key).await.unwrap().is_empty());
    let _ = other_client.logout().await;

    // Throwing a draft away works the same way.
    let thrown = engine.save_draft(draft(vec![], "<p>Doch nicht</p>", None)).await.unwrap();
    engine.delete_draft(&account.id, &thrown.draft_key).await.unwrap();
    assert!(engine.list_threads(&drafts_query).unwrap().threads.iter().all(|t| t.subject != subject));

    engine.remove_account(&account.id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn undo_send_takes_mail_back_and_otherwise_sends_it() {
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
    let email = format!("undo-{}@uwumail.test", &unique[..8]);
    let account = engine
        .add_account(NewAccount {
            display_name: "Mini".into(),
            email: email.clone(),
            auth: AuthKind::Password,
            password: Some("uwu".into()),
            imap: ServerSettings { host: host.clone(), port: 3143, security: Security::None },
            smtp: ServerSettings { host, port: 3025, security: Security::None },
            username: email.clone(),
            color: AccountColor::Pink,
            protocol: Protocol::Imap,
            jmap_url: None,
        })
        .await
        .unwrap();
    let message = |subject: &str| OutgoingMessage {
        account_id: account.id.clone(),
        to: vec![Address { name: None, email: email.clone() }],
        cc: vec![],
        bcc: vec![],
        subject: subject.into(),
        html: "<p>Hi</p>".into(),
        text: "Hi".into(),
        in_reply_to: None,
        attachments: vec![],
        draft_key: None,
    };

    // Taken back in time: the composer gets it again, nothing goes out.
    let oops = format!("Ups {unique}");
    let queued = engine.queue_send(message(&oops), 30).unwrap();
    let back = engine.cancel_send(&queued.id).unwrap();
    assert_eq!(back.subject, oops);
    assert!(engine.cancel_send(&queued.id).is_err());

    // Broken addresses are refused right away.
    let broken = OutgoingMessage { to: vec![Address { name: None, email: "nope".into() }], ..message("Kaputt") };
    assert!(engine.queue_send(broken, 30).is_err());

    // Left alone, it goes out after the wait and says so.
    let fine = format!("Klappt {unique}");
    let queued = engine.queue_send(message(&fine), 1).unwrap();
    wait_for("the queued message in the inbox", async || {
        engine.sync_now(Some(&account.id));
        engine.list_threads(&inbox_query(None)).unwrap().threads.into_iter().find(|t| t.subject == fine)
    })
    .await;
    let mut done = false;
    while let Ok(event) = events.try_recv() {
        done |= matches!(event, EngineEvent::SendDone { ref send_id, .. } if *send_id == queued.id);
    }
    assert!(done, "the UI hears that it went out");
    assert!(engine.list_threads(&inbox_query(None)).unwrap().threads.iter().all(|t| t.subject != oops));

    engine.remove_account(&account.id).await.unwrap();
}
