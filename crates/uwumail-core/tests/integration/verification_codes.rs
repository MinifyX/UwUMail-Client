//! Sign-in codes against a JMAP server on this machine that finds them like a UwUMail server
//! (`urn:uwumail:jmap:verification`, UwUMail-Server docs/jmap-verification.md), and one that
//! doesn't. Runs everywhere.

use crate::support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{TimeDelta, Utc};
use serde_json::{Value, json};
use support::{Request, Response, Stub, http_stub};
use uwumail_core::jmap::{CORE, MAIL, VERIFICATION};
use uwumail_core::model::*;
use uwumail_core::notify::{NotifyAction, NotifyPlatform, NotifyPrefs};
use uwumail_core::secrets::MemorySecrets;
use uwumail_core::{Engine, EngineOptions};

#[derive(Default)]
struct Server {
    codes: bool,
    /// The `using` of every API request, and every method called.
    usings: Vec<Value>,
    methods: Vec<String>,
}

type Shared = Arc<Mutex<Server>>;

fn session(codes: bool) -> Value {
    let mut capabilities = json!({ CORE: { "maxObjectsInGet": 250 }, MAIL: {} });
    let mut account_capabilities = json!({ MAIL: {} });
    if codes {
        capabilities[VERIFICATION] = json!({});
        account_capabilities[VERIFICATION] = json!({});
    }
    json!({
        "capabilities": capabilities,
        "accounts": { "a1": { "name": "mini@a.test", "isPersonal": true, "accountCapabilities": account_capabilities } },
        "primaryAccounts": { MAIL: "a1" },
        "username": "mini@a.test",
        "apiUrl": "/api",
        "downloadUrl": "/download/{accountId}/{blobId}/{name}?type={type}",
        "uploadUrl": "/upload/{accountId}/",
        "state": "s1",
    })
}

fn received() -> String {
    (Utc::now() - TimeDelta::minutes(1)).format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn expires(minutes: i64) -> String {
    (Utc::now() + TimeDelta::minutes(minutes)).format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn from(id: &str) -> &'static str {
    if id == "e1" { "Shop <no-reply@shop.example>" } else { "Bank <hello@bank.example>" }
}

fn raw_message(id: &str) -> Vec<u8> {
    format!(
        "From: {}\r\nTo: mini@a.test\r\nSubject: Your code\r\nMessage-ID: <{id}@example.com>\r\n\
         Date: Mon, 2 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nYour code is in here.\r\n",
        from(id)
    )
    .into_bytes()
}

fn email(id: &str) -> Value {
    json!({ "id": id, "blobId": format!("B{id}"), "mailboxIds": { "m1": true }, "keywords": {}, "size": 512,
        "receivedAt": received(), "preview": "Your code is in here.",
        "headers": [
            { "name": "From", "value": format!(" {}", from(id)) },
            { "name": "Subject", "value": " Your code" },
            { "name": "Message-ID", "value": format!(" <{id}@example.com>") },
        ] })
}

fn answer(server: &Shared, request: &Request) -> Response {
    let mut server = server.lock().unwrap();
    if request.path.starts_with("/.well-known/jmap") {
        return Response::json(&session(server.codes));
    }
    if let Some(rest) = request.path.strip_prefix("/download/a1/B") {
        return Response::new(200, raw_message(rest.split('/').next().unwrap_or_default()));
    }
    let body: Value = serde_json::from_slice(&request.body).unwrap_or_default();
    server.usings.push(body["using"].clone());
    let codes_offered = body["using"].as_array().is_some_and(|using| using.contains(&json!(VERIFICATION)));
    let calls = body["methodCalls"].as_array().cloned().unwrap_or_default();
    let mut responses = Vec::new();
    for call in &calls {
        let (name, arguments, id) = (call[0].as_str().unwrap_or_default(), &call[1], &call[2]);
        server.methods.push(name.to_string());
        let wants_codes = arguments["properties"].as_array().is_some_and(|p| p.contains(&json!("verification")));
        let result = match name {
            "Core/echo" => arguments.clone(),
            "Mailbox/get" => json!({ "accountId": "a1", "state": "m1", "notFound": [],
                "list": [{ "id": "m1", "name": "Inbox", "role": "inbox" }] }),
            "Email/query" => json!({ "accountId": "a1", "ids": ["e2", "e1"], "position": 0, "queryState": "q1" }),
            // Like the server: without the capability in `using`, the property isn't there.
            "Email/get" if wants_codes && codes_offered => json!({ "accountId": "a1", "state": "e1", "notFound": [],
                "list": [
                    { "id": "e1", "receivedAt": received(), "verification": {
                        "kind": "otp", "origin": "login.shop.example", "code": "482913", "url": null,
                        "purpose": "login", "expiresAt": expires(10), "source": "header", "autofill": true } },
                    { "id": "e2", "receivedAt": received(), "verification": {
                        "kind": "link", "origin": "bank.example", "code": null,
                        "url": "https://id.bank.example/confirm?t=abc", "purpose": "confirm-email",
                        "expiresAt": expires(30), "source": "heuristic", "autofill": false } },
                ] }),
            "Email/get" => json!({ "accountId": "a1", "state": "e1", "notFound": [],
                "list": [email("e1"), email("e2")] }),
            "Email/changes" => json!({ "accountId": "a1", "oldState": "e1", "newState": "e1", "hasMoreChanges": false,
                "created": [], "updated": [], "destroyed": [] }),
            "Identity/get" => json!({ "accountId": "a1", "state": "i1", "list": [], "notFound": [] }),
            "VerificationCode/query" if codes_offered => {
                assert_eq!(arguments["filter"], json!({ "expired": false }));
                json!({ "accountId": "a1", "queryState": "v1", "canCalculateChanges": false, "position": 0,
                    "ids": ["e2", "e1"] })
            }
            _ => {
                responses.push(json!(["error", { "type": "unknownMethod" }, id]));
                continue;
            }
        };
        responses.push(json!([name, result, id]));
    }
    Response::json(&json!({ "methodResponses": responses, "sessionState": "s1" }))
}

struct Setup {
    engine: Engine,
    account_id: String,
    server: Shared,
    _stub: Stub,
    _data: tempfile::TempDir,
}

impl Setup {
    fn count(&self, method: &str) -> usize {
        self.server.lock().unwrap().methods.iter().filter(|m| *m == method).count()
    }

    fn local_id(&self, sender: &str) -> String {
        self.engine.inbox_messages_from(sender).unwrap().pop().expect("the mail arrived")
    }
}

async fn setup(codes: bool) -> Setup {
    let server: Shared = Arc::new(Mutex::new(Server { codes, ..Server::default() }));
    let handler = Arc::clone(&server);
    let stub = http_stub(move |request| answer(&handler, request)).await;
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::new(EngineOptions {
        data_dir: data.path().to_path_buf(),
        secrets: Arc::new(MemorySecrets::default()),
        open_url: Arc::new(|_| {}),
        recognizer: None,
    })
    .unwrap();
    let mut events = engine.subscribe();
    let no_server = ServerSettings { host: String::new(), port: 0, security: Security::Tls };
    let account = engine
        .add_account(NewAccount {
            display_name: "Mini".into(),
            email: "mini@a.test".into(),
            auth: AuthKind::Password,
            password: Some("dummy-password".into()),
            imap: no_server.clone(),
            smtp: no_server,
            username: "mini@a.test".into(),
            color: AccountColor::Pink,
            protocol: Protocol::Jmap,
            jmap_url: Some(stub.url("127.0.0.1", "/.well-known/jmap").to_string()),
            sign_in_as: None,
            account_name: None,
            app_password_name: None,
        })
        .await
        .expect("add the account");
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            match events.recv().await {
                Ok(EngineEvent::SyncFinished { account_id }) if account_id == account.id => return,
                Ok(_) => {}
                Err(error) => panic!("events ended: {error}"),
            }
        }
    })
    .await
    .expect("the first sync");
    Setup { engine, account_id: account.id, server, _stub: stub, _data: data }
}

fn prefs() -> NotifyPrefs {
    NotifyPrefs::default().with_codes("Sign-in code from {sender}", "Sign-in link from {sender}", "Copy code", false)
}

#[tokio::test(flavor = "multi_thread")]
async fn the_codes_of_a_server_that_finds_them_point_at_the_mail_here() {
    let setup = setup(true).await;
    let shop = setup.local_id("no-reply@shop.example");
    let bank = setup.local_id("hello@bank.example");
    assert!(
        setup
            .server
            .lock()
            .unwrap()
            .usings
            .iter()
            .all(|using| using.as_array().unwrap().contains(&json!(VERIFICATION)))
    );
    assert_eq!(setup.count("VerificationCode/query"), 1);

    let codes = setup.engine.verification_codes().unwrap();
    assert_eq!(codes.len(), 2);
    // Newest first: the link runs longer.
    let (link, otp) = (&codes[0], &codes[1]);
    assert_eq!(otp.email_id, shop);
    assert_eq!(otp.account_id, setup.account_id);
    assert_eq!(otp.kind, "otp");
    assert_eq!(otp.code.as_deref(), Some("482913"));
    assert_eq!(otp.origin, "login.shop.example");
    assert_eq!(otp.sender, "Shop");
    assert!(otp.autofill);
    assert_eq!(link.email_id, bank);
    assert_eq!(link.url.as_deref(), Some("https://id.bank.example/confirm?t=abc"));
    assert_eq!(link.source, "heuristic");
    assert!(!link.autofill);

    // The notification of the mail with the code; never the code on the lock screen by default.
    let (code, note) = setup.engine.code_notification(&prefs(), &shop, NotifyPlatform::Android).unwrap();
    assert_eq!(code.email_id, shop);
    assert_eq!(note.title, "Sign-in code from Shop");
    assert_eq!(note.copy.as_deref(), Some("482913"));
    assert_eq!(note.locked_body, "login.shop.example");
    assert_eq!(note.actions[0], NotifyAction::CopyCode);
    assert!(setup.engine.code_notification(&prefs(), "not-a-mail", NotifyPlatform::Desktop).is_none());

    // A sync that brings nothing new doesn't ask again; a pushed code does.
    setup
        .engine
        .push_received(
            &setup.account_id,
            br#"{ "@type": "VerificationCode", "accountId": "other",
        "emailId": "e1", "verification": null }"#,
        )
        .await
        .unwrap();
    assert_eq!(setup.count("VerificationCode/query"), 1);
    let changes = setup.count("Email/changes");
    setup
        .engine
        .push_received(
            &setup.account_id,
            br#"{ "@type": "VerificationCode", "accountId": "a1",
        "emailId": "e1", "verification": null }"#,
        )
        .await
        .unwrap();
    assert_eq!(setup.count("Email/changes"), changes + 1, "a pushed code syncs right away");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_without_codes_is_never_asked() {
    let setup = setup(false).await;
    let shop = setup.local_id("no-reply@shop.example");
    assert_eq!(setup.count("VerificationCode/query"), 0);
    assert!(
        setup
            .server
            .lock()
            .unwrap()
            .usings
            .iter()
            .all(|using| !using.as_array().unwrap().contains(&json!(VERIFICATION)))
    );
    assert!(setup.engine.verification_codes().unwrap().is_empty());
    assert!(setup.engine.code_notification(&prefs(), &shop, NotifyPlatform::Ios).is_none());
}
