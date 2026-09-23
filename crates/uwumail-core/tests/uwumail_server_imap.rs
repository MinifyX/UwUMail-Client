//! End-to-end test of folder management over IMAP against a real UwUMail server's IMAPS, with the
//! server's own (self-signed) certificate, which only this test trusts. Runs the steps the engine
//! runs for create, rename, delete and empty (engine/folder_ops.rs), on a session of its own.
//!
//!   UWUMAIL_TEST_IMAPS=localhost:2993 UWUMAIL_TEST_CA=<data dir>/tls/self-signed.crt \
//!   UWUMAIL_TEST_LOGIN=mini@a.test UWUMAIL_TEST_PASSWORD=… \
//!   cargo test -p uwumail-core --test uwumail_server_imap -- --test-threads=1
//!
//! Skipped when `UWUMAIL_TEST_IMAPS` isn't set. Works in folders of its own and deletes them.

mod support;

use std::sync::Arc;

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName};
use uwumail_core::folders;
use uwumail_core::imap::{self, ImapSession, MailStream};

async fn session() -> Option<ImapSession> {
    let address = std::env::var("UWUMAIL_TEST_IMAPS").ok().filter(|s| !s.is_empty())?;
    let ca = std::env::var("UWUMAIL_TEST_CA").expect("UWUMAIL_TEST_CA: the server's certificate (PEM)");
    let login = std::env::var("UWUMAIL_TEST_LOGIN").expect("UWUMAIL_TEST_LOGIN");
    let password = std::env::var("UWUMAIL_TEST_PASSWORD").expect("UWUMAIL_TEST_PASSWORD");
    let (host, _) = address.rsplit_once(':').expect("host:port");
    let config = support::client_config(&[CertificateDer::from_pem_file(&ca).expect("a PEM certificate")]);
    let tcp = tokio::net::TcpStream::connect(&address).await.expect("the IMAPS port answers");
    let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(ServerName::try_from(host.to_string()).unwrap(), tcp)
        .await
        .expect("TLS with the server's certificate");
    let mut client = async_imap::Client::new(MailStream::Tls(Box::new(tls)));
    client.read_response().await.expect("a greeting").expect("a greeting");
    Some(client.login(&login, &password).await.map_err(|(error, _)| error).expect("sign in"))
}

const MESSAGE: &[u8] = b"From: Mini <mini@a.test>\r\nTo: mini@a.test\r\nSubject: folder test\r\n\
Message-ID: <folder-test@a.test>\r\n\r\nHello.\r\n";

#[tokio::test]
async fn folders_are_made_renamed_emptied_and_deleted() {
    let Some(mut session) = session().await else {
        eprintln!("UWUMAIL_TEST_IMAPS not set, skipping");
        return;
    };
    let listed = imap::list_folders(&mut session).await.unwrap();
    let delimiter = listed.iter().find_map(|f| f.delimiter.clone()).unwrap_or_else(|| "/".into());
    let namespace = folders::inbox_namespace(listed.iter().map(|f| (f.path.as_str(), f.delimiter.as_deref())));
    let unique = &uuid::Uuid::new_v4().simple().to_string()[..8];

    // A name with what modified UTF-7 must carry: an ampersand, umlauts and an emoji. It comes
    // back exactly as typed. (Quotes and backslashes don't yet: the LIST answer's quoted names
    // aren't unescaped, security-audit C-7.)
    let typed = format!("Test & Grüße 📬 {unique}");
    let name = folders::clean_name(&typed, Some(&delimiter), true).unwrap();
    let path = folders::child_path(None, &name, Some(&delimiter), namespace.as_deref()).unwrap();
    imap::create_folder(&mut session, &path).await.unwrap();
    let listed = imap::list_folders(&mut session).await.unwrap();
    let made = listed.iter().find(|f| f.path == path).expect("the new folder is listed");
    assert_eq!(made.name, typed);

    // A folder inside another, and the parent knows it has one. (A parent whose name has a space
    // isn't asked right yet: the LIST pattern goes out unquoted, security-audit C-8.)
    let parent = folders::child_path(None, &format!("Parent{unique}"), Some(&delimiter), namespace.as_deref()).unwrap();
    imap::create_folder(&mut session, &parent).await.unwrap();
    let child = folders::child_path(Some(&parent), "Inner Folder", Some(&delimiter), None).unwrap();
    imap::create_folder(&mut session, &child).await.unwrap();
    assert!(imap::has_children(&mut session, &parent, &delimiter).await.unwrap());
    assert!(imap::delete_folder(&mut session, &parent).await.is_err(), "the server keeps a folder with folders inside");
    imap::delete_folder(&mut session, &child).await.unwrap();
    assert!(!imap::has_children(&mut session, &parent, &delimiter).await.unwrap());
    imap::delete_folder(&mut session, &parent).await.unwrap();

    // Names that would break the command never reach the server.
    for bad in ["line\r\nA1 DELETE INBOX", "a*b", "100%", &format!("x{delimiter}y")] {
        assert!(folders::clean_name(bad, Some(&delimiter), true).is_err(), "{bad:?}");
    }
    assert!(
        imap::create_folder(&mut session, "x\r\nA1 DELETE INBOX").await.is_err(),
        "the IMAP library refuses it too"
    );
    assert!(imap::list_folders(&mut session).await.unwrap().iter().any(|f| f.path.eq_ignore_ascii_case("INBOX")));

    // Renaming keeps the mail in it.
    imap::append(&mut session, &path, MESSAGE, Some("(\\Seen)")).await.unwrap();
    let renamed_name = format!("Umbenannt {unique}");
    let renamed = folders::renamed_path(&path, &renamed_name, Some(&delimiter));
    imap::rename_folder(&mut session, &path, &renamed).await.unwrap();
    let listed = imap::list_folders(&mut session).await.unwrap();
    assert!(!listed.iter().any(|f| f.path == path));
    assert!(listed.iter().any(|f| f.path == renamed && f.name == renamed_name));

    // Deleting moves its mail somewhere else first (the trash in the app; a folder of its own here).
    let keep = folders::child_path(None, &format!("Kept {unique}"), Some(&delimiter), namespace.as_deref()).unwrap();
    imap::create_folder(&mut session, &keep).await.unwrap();
    assert_eq!(imap::move_all(&mut session, &renamed, &keep).await.unwrap(), 1);
    imap::delete_folder(&mut session, &renamed).await.unwrap();
    assert!(!imap::list_folders(&mut session).await.unwrap().iter().any(|f| f.path == renamed));

    // Emptying deletes for good.
    imap::append(&mut session, &keep, MESSAGE, None).await.unwrap();
    assert_eq!(imap::expunge_all(&mut session, &keep).await.unwrap(), 2);
    assert_eq!(session.select(&keep).await.unwrap().exists, 0);
    assert_eq!(imap::expunge_all(&mut session, &keep).await.unwrap(), 0);
    imap::delete_folder(&mut session, &keep).await.unwrap();
    let _ = session.logout().await;
}
