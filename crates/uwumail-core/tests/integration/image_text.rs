//! The text in a mail's pictures against a JMAP server on this machine: a UwUMail server that
//! reads them itself (`Email/imageText`, UwUMail-Server docs/jmap-image-text.md), one whose OCR is
//! off, and any other JMAP server, whose mail this device reads with a fake recognizer. Runs
//! everywhere.

use crate::support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use support::{Request, Response, Stub, http_stub};
use uwumail_core::jmap::{CORE, IMAGETEXT, MAIL};
use uwumail_core::model::*;
use uwumail_core::secrets::MemorySecrets;
use uwumail_core::{Engine, EngineOptions, TextRecognizer};

/// A PNG header of the given size with the text the fake recognizer "reads" after it.
fn png(width: u32, height: u32, text: &str) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    bytes.extend_from_slice(format!("TEXT:{text}").as_bytes());
    bytes
}

fn part(headers: &str, bytes: &[u8]) -> String {
    format!("{headers}\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n", B64.encode(bytes))
}

/// A mail with an embedded poster, a tracking pixel, an attached flyer, an SVG and a remote picture.
fn raw_message() -> Vec<u8> {
    let html =
        r#"<p>Kommt vorbei!</p><img src="cid:poster@example.com"><img src="https://pictures.invalid/banner.png">"#;
    format!(
        "From: Kino <kino@example.com>\r\nTo: mini@a.test\r\nSubject: Premiere\r\nDate: Tue, 1 Sep 2026 10:00:00 +0000\r\n\
         Message-ID: <premiere@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"outer\"\r\n\r\n\
         --outer\r\nContent-Type: multipart/related; boundary=\"inner\"\r\n\r\n\
         --inner\r\nContent-Type: text/html; charset=utf-8\r\n\r\n{html}\r\n\
         --inner\r\n{}--inner\r\n{}--inner--\r\n\
         --outer\r\n{}--outer\r\n{}--outer--\r\n",
        part(
            "Content-Type: image/png\r\nContent-ID: <poster@example.com>\r\nContent-Disposition: inline; filename=\"poster.png\"",
            &png(1200, 1600, "Premiere: Freitag, 9. Oktober\nKino am Hafen"),
        ),
        part(
            "Content-Type: image/gif\r\nContent-ID: <pixel@example.com>\r\nContent-Disposition: inline",
            &[b"GIF89a".as_slice(), &[1, 0, 1, 0], &[0; 8]].concat(),
        ),
        part(
            "Content-Type: image/png\r\nContent-Disposition: attachment; filename=\"flyer.png\"",
            &png(600, 200, "Sale ends Sunday"),
        ),
        part("Content-Type: image/svg+xml\r\nContent-Disposition: attachment; filename=\"logo.svg\"", b"<svg/>"),
    )
    .into_bytes()
}

#[derive(Default)]
struct Server {
    /// Offers `urn:uwumail:jmap:imagetext`, and whether its OCR is off.
    image_text: Option<bool>,
    methods: Vec<(String, Value)>,
    usings: Vec<Value>,
    downloads: usize,
}

type Shared = Arc<Mutex<Server>>;

fn session(image_text: Option<bool>) -> Value {
    let mut capabilities = json!({ CORE: { "maxObjectsInGet": 250 }, MAIL: {} });
    if let Some(unavailable) = image_text {
        capabilities[IMAGETEXT] = json!({ "maxImages": 20, "unavailable": unavailable });
    }
    json!({
        "capabilities": capabilities,
        "accounts": { "a1": { "name": "mini@a.test" } },
        "primaryAccounts": { MAIL: "a1" },
        "username": "mini@a.test",
        "apiUrl": "/api",
        "downloadUrl": "/download/{accountId}/{blobId}/{name}?type={type}",
        "uploadUrl": "/upload/{accountId}/",
        "state": "s1",
    })
}

fn answer(server: &Shared, request: &Request) -> Response {
    let mut server = server.lock().unwrap();
    if request.path.starts_with("/.well-known/jmap") {
        return Response::json(&session(server.image_text));
    }
    if request.path.starts_with("/download/a1/Bmsg/") {
        server.downloads += 1;
        return Response::new(200, raw_message());
    }
    let body: Value = serde_json::from_slice(&request.body).unwrap_or_default();
    server.usings.push(body["using"].clone());
    let calls = body["methodCalls"].as_array().cloned().unwrap_or_default();
    let mut responses = Vec::new();
    for call in &calls {
        let (name, arguments, id) = (call[0].as_str().unwrap_or_default(), &call[1], &call[2]);
        server.methods.push((name.to_string(), arguments.clone()));
        let result = match name {
            "Core/echo" => arguments.clone(),
            "Mailbox/get" => json!({ "accountId": "a1", "state": "m1", "notFound": [],
                "list": [{ "id": "m1", "name": "Inbox", "role": "inbox" }] }),
            "Email/query" => json!({ "accountId": "a1", "ids": ["e1"], "position": 0, "queryState": "q1" }),
            "Email/get" if arguments["properties"] == json!(["attachments"]) => json!({ "accountId": "a1",
                "state": "e1", "notFound": [], "list": [{ "id": "e1", "attachments": [
                    { "blobId": "Bposter", "cid": "<poster@example.com>", "name": "poster.png", "size": 1000, "type": "image/png" },
                    { "blobId": "Bpixel", "cid": "<pixel@example.com>", "size": 16, "type": "image/gif" },
                    { "blobId": "Bflyer", "name": "flyer.png", "size": 42, "type": "image/png" },
                    { "blobId": "Blogo", "name": "logo.svg", "size": 6, "type": "image/svg+xml" },
                ] }] }),
            "Email/get" => json!({ "accountId": "a1", "state": "e1", "notFound": [], "list": [{
                "id": "e1", "blobId": "Bmsg", "mailboxIds": { "m1": true }, "keywords": {}, "size": 4096,
                "receivedAt": "2026-09-01T10:00:00Z" }] }),
            "Email/changes" => json!({ "accountId": "a1", "oldState": "e1", "newState": "e1", "hasMoreChanges": false,
                "created": [], "updated": [], "destroyed": [] }),
            "Identity/get" => json!({ "accountId": "a1", "state": "i1", "list": [], "notFound": [] }),
            "Email/imageText" if server.image_text == Some(true) => {
                json!({ "accountId": "a1", "emailId": arguments["emailId"], "unavailable": true, "images": [], "skipped": 0 })
            }
            "Email/imageText" if server.image_text == Some(false) => json!({ "accountId": "a1",
                "emailId": arguments["emailId"], "unavailable": false, "skipped": 2, "images": [
                    { "source": "cid:poster@example.com", "text": "Premiere: Freitag, 9. Oktober", "width": 1200, "height": 1600 },
                    { "source": "blob:Bflyer", "text": "Sale ends Sunday", "width": 600, "height": 200 },
                ] }),
            _ => {
                responses.push(json!(["error", { "type": "unknownMethod" }, id]));
                continue;
            }
        };
        responses.push(json!([name, result, id]));
    }
    Response::json(&json!({ "methodResponses": responses, "sessionState": "s1" }))
}

/// Reads what [`png`] put after the header, and counts how often it was asked.
#[derive(Default)]
struct FakeRecognizer {
    calls: AtomicUsize,
}

impl TextRecognizer for FakeRecognizer {
    fn recognize(&self, image: &[u8]) -> Result<String, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let text = String::from_utf8_lossy(image);
        text.split_once("TEXT:").map(|(_, text)| text.to_string()).ok_or_else(|| "no text".to_string())
    }
}

struct Setup {
    engine: Engine,
    message_id: String,
    server: Shared,
    _stub: Stub,
    _data: tempfile::TempDir,
}

impl Setup {
    fn calls(&self, method: &str) -> Vec<Value> {
        self.server.lock().unwrap().methods.iter().filter(|(m, _)| m == method).map(|(_, a)| a.clone()).collect()
    }

    fn downloads(&self) -> usize {
        self.server.lock().unwrap().downloads
    }
}

async fn setup(image_text: Option<bool>, recognizer: Option<Arc<dyn TextRecognizer>>) -> Setup {
    let server: Shared = Arc::new(Mutex::new(Server { image_text, ..Server::default() }));
    let handler = Arc::clone(&server);
    let stub = http_stub(move |request| answer(&handler, request)).await;
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::new(EngineOptions {
        data_dir: data.path().to_path_buf(),
        secrets: Arc::new(MemorySecrets::default()),
        open_url: Arc::new(|_| {}),
        recognizer,
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
    // The first sync brings the mail.
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            match events.recv().await {
                Ok(EngineEvent::AccountStatus { account_id, status: AccountStatus::Idle })
                    if account_id == account.id =>
                {
                    return;
                }
                Ok(_) => {}
                Err(error) => panic!("events ended: {error}"),
            }
        }
    })
    .await
    .expect("the first sync");
    let message_id = engine.inbox_messages_from("kino@example.com").unwrap().pop().expect("the mail arrived");
    Setup { engine, message_id, server, _stub: stub, _data: data }
}

#[tokio::test]
async fn a_uwumail_server_reads_the_pictures_with_the_apps_ids_in_its_answer() {
    let recognizer = Arc::new(FakeRecognizer::default());
    let setup = setup(Some(false), Some(recognizer.clone())).await;
    let result = setup.engine.image_text(&setup.message_id, false).await.unwrap();

    assert_eq!(result.email_id, setup.message_id);
    assert!(!result.unavailable);
    assert_eq!(result.skipped, 2);
    let sources: Vec<&str> = result.images.iter().map(|image| image.source.as_str()).collect();
    assert_eq!(sources, ["cid:poster@example.com".to_string(), format!("blob:{}:2", setup.message_id)]);
    assert_eq!(result.images[0].text, "Premiere: Freitag, 9. Oktober");
    assert_eq!((result.images[1].width, result.images[1].height), (600, 200));

    let asked = setup.calls("Email/imageText");
    assert_eq!(asked, [json!({ "accountId": "a1", "emailId": "e1", "remote": false })]);
    let using = setup.server.lock().unwrap().usings.last().cloned().unwrap();
    assert!(using.as_array().unwrap().contains(&json!(IMAGETEXT)), "{using}");
    assert_eq!(recognizer.calls.load(Ordering::SeqCst), 0, "the pictures never go through this device's OCR");

    // Asked again, the answer is remembered; with remote pictures it's a question of its own.
    setup.engine.image_text(&setup.message_id, false).await.unwrap();
    assert_eq!(setup.calls("Email/imageText").len(), 1);
    setup.engine.image_text(&setup.message_id, true).await.unwrap();
    assert_eq!(setup.calls("Email/imageText").last().unwrap()["remote"], json!(true));
}

#[tokio::test]
async fn other_mailboxes_are_read_on_this_device_within_the_limits() {
    let recognizer = Arc::new(FakeRecognizer::default());
    let setup = setup(None, Some(recognizer.clone())).await;
    let downloads = setup.downloads();
    let result = setup.engine.image_text(&setup.message_id, false).await.unwrap();

    assert!(!result.unavailable);
    let found: Vec<(&str, &str, u32, u32)> =
        result.images.iter().map(|i| (i.source.as_str(), i.text.as_str(), i.width, i.height)).collect();
    let flyer = format!("blob:{}:2", setup.message_id);
    assert_eq!(
        found,
        [
            ("cid:poster@example.com", "Premiere: Freitag, 9. Oktober\nKino am Hafen", 1200, 1600),
            (flyer.as_str(), "Sale ends Sunday", 600, 200),
        ]
    );
    // The tracking pixel and the SVG; the remote picture isn't looked at without `remote`.
    assert_eq!(result.skipped, 2);
    assert_eq!(recognizer.calls.load(Ordering::SeqCst), 2);
    assert_eq!(setup.downloads(), downloads + 1, "the message is fetched once for all its pictures");
    assert!(setup.calls("Email/imageText").is_empty(), "only a server that offers it is asked");

    // Remembered: nothing is read or fetched again.
    assert_eq!(setup.engine.image_text(&setup.message_id, false).await.unwrap(), result);
    assert_eq!(recognizer.calls.load(Ordering::SeqCst), 2);
    assert_eq!(setup.downloads(), downloads + 1);

    // The remote picture is on a name that isn't public, so it can't be fetched: skipped, and that
    // result isn't kept, so a later try may still get it.
    let with_remote = setup.engine.image_text(&setup.message_id, true).await.unwrap();
    assert_eq!(with_remote.images, result.images);
    assert_eq!(with_remote.skipped, 3);
    setup.engine.image_text(&setup.message_id, true).await.unwrap();
    assert_eq!(recognizer.calls.load(Ordering::SeqCst), 6);
}

#[tokio::test]
async fn a_server_without_ocr_leaves_the_pictures_to_this_device() {
    let recognizer = Arc::new(FakeRecognizer::default());
    let setup = setup(Some(true), Some(recognizer.clone())).await;
    let result = setup.engine.image_text(&setup.message_id, false).await.unwrap();
    assert_eq!(setup.calls("Email/imageText").len(), 1);
    assert!(!result.unavailable);
    assert_eq!(result.images.len(), 2);
    assert_eq!(recognizer.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn without_a_recognizer_the_feature_is_off() {
    let setup = setup(None, None).await;
    let downloads = setup.downloads();
    let result = setup.engine.image_text(&setup.message_id, true).await.unwrap();
    assert_eq!(
        result,
        ImageTextResult { email_id: setup.message_id.clone(), unavailable: true, images: vec![], skipped: 0 }
    );
    assert_eq!(setup.downloads(), downloads, "nothing is fetched for it");

    let missing = setup.engine.image_text("nope", false).await.unwrap_err();
    assert_eq!(missing.code, uwumail_core::ErrorCode::NotFound);
}

/// Asked to read a mail's appointments with its pictures, a provider on this device gets the
/// pictures' text as quoted data, never the pictures, and without it when not asked.
#[tokio::test]
async fn the_assistant_on_this_device_reads_the_picture_text_along() {
    let recognizer = Arc::new(FakeRecognizer::default());
    let setup = setup(None, Some(recognizer.clone())).await;
    let prompts: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = Arc::clone(&prompts);
    let provider = http_stub(move |request: &Request| {
        seen.lock().unwrap().push(String::from_utf8_lossy(&request.body).into_owned());
        Response::json(&json!({
            "choices": [{ "message": { "role": "assistant", "content": "{\"events\":[]}" }, "finish_reason": "stop" }],
        }))
    })
    .await;
    let created = setup
        .engine
        .assist_create_provider(
            "device",
            json!({
                "name": "Local",
                "kind": "openaiCompatible",
                "baseUrl": provider.url("127.0.0.1", "/v1").to_string(),
                "model": "m-1",
            }),
        )
        .await
        .expect("a provider on this device");
    let provider_id = created["id"].as_str().unwrap().to_string();
    setup
        .engine
        .assist_update_settings("device", json!({ "default": { "providerId": provider_id, "model": null } }))
        .await
        .unwrap();

    let found = setup.engine.assist_extract_events(&setup.message_id, true).await.expect("asked the model");
    assert_eq!(found["events"], json!([]));
    let sent = prompts.lock().unwrap().last().cloned().expect("the provider was asked");
    assert!(sent.contains("Premiere: Freitag, 9. Oktober"), "{sent}");
    assert!(sent.contains("Sale ends Sunday"), "{sent}");
    assert!(!sent.contains("TEXT:") && !sent.contains("iVBOR"), "only text, never the pictures");
    assert_eq!(recognizer.calls.load(Ordering::SeqCst), 2);

    setup.engine.assist_extract_events(&setup.message_id, false).await.unwrap();
    let sent = prompts.lock().unwrap().last().cloned().unwrap();
    assert!(!sent.contains("Sale ends Sunday"), "{sent}");
}
