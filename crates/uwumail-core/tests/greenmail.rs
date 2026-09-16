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
        account_ids: None,
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
            sign_in_as: None,
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
            from_email: None,
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
            from_email: None,
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
    let trash = wait_for("both messages in the trash folder", async || {
        engine.sync_now(Some(&account.id));
        engine
            .list_folders(Some(&account.id))
            .unwrap()
            .into_iter()
            .find(|f| f.role == Some(FolderRole::Trash) && f.total >= 2)
    })
    .await;

    // The trash shows the conversation. Trashing it again changes nothing; deleting it for
    // good empties the trash on the server too.
    let trash_query = ThreadQuery {
        view: MailboxView::Folder { account_id: account.id.clone(), folder_id: trash.id.clone() },
        ..inbox_query(None)
    };
    let trashed = engine.list_threads(&trash_query).unwrap().threads.into_iter().find(|t| t.subject == subject);
    assert_eq!(trashed.expect("the trash shows the conversation").message_count, 2);
    assert!(engine.trash(&ids).await.unwrap().is_empty());
    assert_eq!(engine.delete_forever(&ids).await.unwrap(), 2);
    assert!(engine.list_threads(&trash_query).unwrap().threads.iter().all(|t| t.subject != subject));
    let mut other = imap::login(&imap, imap::Login::Password { username: &email, password: "uwu" }).await.unwrap();
    assert_eq!(other.select(&trash.path).await.unwrap().exists, 0, "the trash is empty on the server");
    let _ = other.logout().await;

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
            sign_in_as: None,
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
            sign_in_as: None,
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
        from_email: None,
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
            sign_in_as: None,
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
        from_email: None,
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

    // A second address of the mailbox can be the sender; unknown ones can't.
    let alias = format!("hallo-{}@uwumail.test", &unique[..8]);
    let identity = engine.add_identity(&account.id, &alias, "Mini vom Studio").unwrap();
    assert!(engine.add_identity(&account.id, &email, "Ich").is_err(), "the own address is already there");
    assert!(engine.list_identities().unwrap().iter().any(|i| i.email == alias && !i.primary));
    let stranger = OutgoingMessage { from_email: Some("chef@uwumail.test".into()), ..message("Fremd") };
    assert!(engine.queue_send(stranger, 30).is_err());
    let from_alias = format!("Vom Studio {unique}");
    engine.send(OutgoingMessage { from_email: Some(alias.clone()), ..message(&from_alias) }).await.unwrap();
    let thread = wait_for("the mail from the alias", async || {
        engine.sync_now(Some(&account.id));
        engine.list_threads(&inbox_query(None)).unwrap().threads.into_iter().find(|t| t.subject == from_alias)
    })
    .await;
    let received = engine.get_thread(&thread.id, true).await.unwrap();
    assert_eq!(received.messages[0].from.email, alias);
    assert_eq!(received.messages[0].from.name.as_deref(), Some("Mini vom Studio"));
    engine.remove_identity(&identity.id).unwrap();
    assert!(engine.list_identities().unwrap().iter().all(|i| i.email != alias));

    // Signatures belong to a sender address that exists.
    let signature = engine
        .save_signature(Signature {
            id: String::new(),
            email: email.to_uppercase(),
            name: "Lang".into(),
            html: "<p>Liebe Grüße</p>".into(),
            for_new: true,
            for_replies: false,
        })
        .unwrap();
    assert_eq!(signature.email, email, "stored with the address as it is set up");
    assert!(engine.save_signature(Signature { email: "fremd@uwumail.test".into(), ..signature.clone() }).is_err());
    assert_eq!(engine.list_signatures().unwrap().len(), 1);

    // A picture in the signature travels as an embedded part and comes back as one.
    let pictured = format!("Mit Logo {unique}");
    let html = r#"<p>Hi</p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" alt="Logo">"#;
    engine.send(OutgoingMessage { html: html.into(), ..message(&pictured) }).await.unwrap();
    let thread = wait_for("the mail with the logo", async || {
        engine.sync_now(Some(&account.id));
        engine.list_threads(&inbox_query(None)).unwrap().threads.into_iter().find(|t| t.subject == pictured)
    })
    .await;
    let received = engine.get_thread(&thread.id, true).await.unwrap().messages.remove(0);
    let logo = received.attachments.iter().find(|a| a.inline).expect("the logo is an inline part");
    let cid = logo.content_id.clone().expect("with a Content-ID");
    assert!(received.body_html.unwrap_or_default().contains(&format!("cid:{cid}")));
    let file = engine.attachment(&logo.id).await.unwrap();
    assert!(std::fs::read(&file.path).unwrap().starts_with(b"\x89PNG"));
    engine.delete_signature(&signature.id).unwrap();

    engine.remove_account(&account.id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn move_spam_and_blocked_senders() {
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
    let email = format!("sort-{}@uwumail.test", &unique[..8]);
    let imap = ServerSettings { host: host.clone(), port: 3143, security: Security::None };
    let account = engine
        .add_account(NewAccount {
            display_name: "Mini".into(),
            email: email.clone(),
            auth: AuthKind::Password,
            password: Some("uwu".into()),
            imap: imap.clone(),
            smtp: ServerSettings { host, port: 3025, security: Security::None },
            username: email.clone(),
            color: AccountColor::Pink,
            protocol: Protocol::Imap,
            jmap_url: None,
            sign_in_as: None,
        })
        .await
        .unwrap();
    let folder =
        |role: FolderRole| engine.list_folders(Some(&account.id)).unwrap().into_iter().find(|f| f.role == Some(role));
    wait_for("the inbox", async || folder(FolderRole::Inbox)).await;
    let mut other = imap::login(&imap, imap::Login::Password { username: &email, password: "uwu" }).await.unwrap();
    other.create("Projekte").await.unwrap();
    let _ = other.logout().await;
    let projects = wait_for("the Projekte folder", async || {
        engine.sync_now(Some(&account.id));
        engine.list_folders(Some(&account.id)).unwrap().into_iter().find(|f| f.path == "Projekte")
    })
    .await;

    let send = async |subject: &str, from: Option<String>| {
        engine
            .send(OutgoingMessage {
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
                from_email: from,
            })
            .await
            .unwrap();
    };
    let find = async |subject: &str| {
        wait_for(subject, async || {
            engine.sync_now(Some(&account.id));
            let query = ThreadQuery { conversations: false, ..inbox_query(None) };
            engine.list_threads(&query).unwrap().threads.into_iter().find(|t| t.subject == subject)
        })
        .await
    };
    let first_message =
        async |thread: &ThreadSummary| engine.get_thread(&thread.id, false).await.unwrap().messages.remove(0);

    // Moving into a folder of the same mailbox.
    let plan = format!("Plan {unique}");
    send(&plan, None).await;
    let message = first_message(&find(&plan).await).await;
    engine.move_messages(std::slice::from_ref(&message.id), &projects.id).await.unwrap();
    let in_projects = ThreadQuery {
        view: MailboxView::Folder { account_id: account.id.clone(), folder_id: projects.id.clone() },
        conversations: false,
        ..inbox_query(None)
    };
    wait_for("the mail in Projekte", async || {
        engine.sync_now(Some(&account.id));
        engine.list_threads(&in_projects).unwrap().threads.into_iter().find(|t| t.subject == plan)
    })
    .await;

    // Spam and back.
    let offer = format!("Angebot {unique}");
    send(&offer, None).await;
    let message = first_message(&find(&offer).await).await;
    engine.mark_spam(std::slice::from_ref(&message.id), true).await.unwrap();
    let junk = folder(FolderRole::Junk).expect("a junk folder exists now");
    let in_junk = ThreadQuery {
        view: MailboxView::Folder { account_id: account.id.clone(), folder_id: junk.id.clone() },
        conversations: false,
        ..inbox_query(None)
    };
    let spam = wait_for("the mail in junk", async || {
        engine.sync_now(Some(&account.id));
        engine.list_threads(&in_junk).unwrap().threads.into_iter().find(|t| t.subject == offer)
    })
    .await;
    let message = first_message(&spam).await;
    engine.mark_spam(std::slice::from_ref(&message.id), false).await.unwrap();
    find(&offer).await;

    // Mail from a blocked address never stays in the inbox.
    let spammer = format!("werbung-{}@uwumail.test", &unique[..8]);
    engine.add_identity(&account.id, &spammer, "Werbung").unwrap();
    assert!(engine.block_sender("kein @ding").is_err());
    engine.block_sender(&spammer.to_uppercase()).unwrap();
    assert_eq!(engine.blocked_senders().unwrap(), std::slice::from_ref(&spammer));
    let blocked = format!("Kauf jetzt {unique}");
    send(&blocked, Some(spammer.clone())).await;
    let trash_query = |trash: &Folder| ThreadQuery {
        view: MailboxView::Folder { account_id: account.id.clone(), folder_id: trash.id.clone() },
        conversations: false,
        ..inbox_query(None)
    };
    wait_for("the blocked mail in the trash", async || {
        engine.sync_now(Some(&account.id));
        let trash = folder(FolderRole::Trash)?;
        engine.list_threads(&trash_query(&trash)).unwrap().threads.into_iter().find(|t| t.subject == blocked)
    })
    .await;
    let inbox_now = engine.list_threads(&ThreadQuery { conversations: false, ..inbox_query(None) }).unwrap();
    assert!(inbox_now.threads.iter().all(|t| t.subject != blocked));
    engine.unblock_sender(&spammer).unwrap();
    assert!(engine.blocked_senders().unwrap().is_empty());

    engine.remove_account(&account.id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn unsubscribes_from_a_newsletter_by_mail() {
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
    let email = format!("leser-{}@uwumail.test", &unique[..8]);
    let list = format!("liste-{}@uwumail.test", &unique[..8]);
    let imap = ServerSettings { host: host.clone(), port: 3143, security: Security::None };

    // A newsletter is already waiting.
    let mut other = imap::login(&imap, imap::Login::Password { username: &email, password: "uwu" }).await.unwrap();
    let newsletter = format!(
        "From: Pixel News <{list}>\r\nTo: {email}\r\nSubject: News {unique}\r\nMessage-ID: <{unique}@news.test>\r\n\
         List-Unsubscribe: <mailto:{list}?subject=raus%20{unique}>\r\nContent-Type: text/plain\r\n\r\nNeue Keycaps!\r\n"
    );
    other.append("INBOX", None, None, newsletter).await.unwrap();
    let _ = other.logout().await;

    let account = engine
        .add_account(NewAccount {
            display_name: "Leser".into(),
            email: email.clone(),
            auth: AuthKind::Password,
            password: Some("uwu".into()),
            imap,
            smtp: ServerSettings { host: host.clone(), port: 3025, security: Security::None },
            username: email.clone(),
            color: AccountColor::Sky,
            protocol: Protocol::Imap,
            jmap_url: None,
            sign_in_as: None,
        })
        .await
        .unwrap();
    let subject = format!("News {unique}");
    let thread = wait_for("the newsletter", async || {
        engine.sync_now(Some(&account.id));
        engine.list_threads(&inbox_query(None)).unwrap().threads.into_iter().find(|t| t.subject == subject)
    })
    .await;
    let message = engine.get_thread(&thread.id, true).await.unwrap().messages.remove(0);
    let options = message.unsubscribe.clone().expect("the list says how to unsubscribe");
    assert!(!options.one_click);
    assert!(options.mailto.is_some());
    assert_eq!(engine.inbox_messages_from(&list.to_uppercase()).unwrap(), std::slice::from_ref(&message.id));

    // The whole mail can be saved as a file.
    let file = engine.message_file(&message.id).await.unwrap();
    assert!(file.filename.ends_with(".eml"));
    assert!(String::from_utf8_lossy(&std::fs::read(&file.path).unwrap()).contains("List-Unsubscribe"));

    // UwUMail writes to the list address itself.
    assert!(matches!(engine.unsubscribe(&message.id).await.unwrap(), UnsubscribeOutcome::Done));
    let list_imap = ServerSettings { host, port: 3143, security: Security::None };
    let request = format!("raus {unique}");
    wait_for("the unsubscribe mail at the list", async || {
        let mut session =
            imap::login(&list_imap, imap::Login::Password { username: &list, password: "uwu" }).await.ok()?;
        session.select("INBOX").await.ok()?;
        let found = session.uid_search(format!("SUBJECT \"{request}\"")).await.ok()?;
        let _ = session.logout().await;
        (!found.is_empty()).then_some(())
    })
    .await;

    engine.remove_account(&account.id).await.unwrap();
}
