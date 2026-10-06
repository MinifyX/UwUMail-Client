//! Masked addresses, the own profile picture and calendar sharing against a hostile UwUMail
//! server on this machine: what goes out is checked first, and what comes back is bounded.

use serde_json::{Value, json};
use uwumail_core::ErrorCode;
use uwumail_core::calendar::jmap_cal;
use uwumail_core::jmap::{CORE, Client, MAIL, MASKED, PRINCIPALS, PROFILE};
use uwumail_core::jmap_masked::{self, MaskedInput, MaskedPatch};
use uwumail_core::jmap_profile::{self, ProfilePatch};

use crate::support::{self, Request, Response, http_stub};

const CALENDARS: &str = "urn:ietf:params:jmap:calendars";
/// A 1 × 1 PNG header: enough for the picture check.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0, 0, 1, 0, 0, 0, 1, 8, 6,
    0, 0, 0,
];

fn session() -> Value {
    json!({
        "capabilities": { CORE: {}, MAIL: {}, CALENDARS: {}, MASKED: {}, PROFILE: { "maxSize": 4096, "mayBePublic": false },
                          PRINCIPALS: {} },
        "accounts": { "a1": { "name": "mini@a.test", "accountCapabilities": {
            MASKED: { "domains": ["a.test", "masked.test"], "defaultDomain": "masked.test" },
            PROFILE: { "maxSize": 4096, "mayBePublic": false },
            PRINCIPALS: { "currentUserPrincipalId": "p1" } } } },
        "primaryAccounts": { MAIL: "a1", CALENDARS: "a1", MASKED: "a1", PROFILE: "a1", PRINCIPALS: "a1" },
        "username": "mini@a.test",
        "apiUrl": "/api",
        "downloadUrl": "/download/{accountId}/{blobId}/{name}?type={type}",
        "uploadUrl": "/upload/{accountId}/",
        "state": "s1",
    })
}

fn masked_set(arguments: &Value) -> Value {
    if let Some(create) = arguments["create"]["new"].as_object() {
        if create.get("domain") == Some(&json!("a.test")) {
            return json!({ "notCreated": { "new": { "type": "forbidden", "description": "limit\u{7}" } } });
        }
        return json!({ "created": { "new": { "id": "x9", "email": "shop.comet.fern1@masked.test", "state": "enabled",
            "createdAt": "2026-10-05T10:00:00Z", "createdBy": "JMAP", "lastMessageAt": null } } });
    }
    if arguments["update"].get("x404").is_some() {
        return json!({ "notUpdated": { "x404": { "type": "notFound" } } });
    }
    json!({ "updated": { "x1": null } })
}

fn answer(request: &Request) -> Response {
    if request.path.starts_with("/.well-known/jmap") {
        return Response::json(&session());
    }
    if request.path.starts_with("/download/a1/good/") {
        return Response::new(200, PNG.to_vec());
    }
    if request.path.starts_with("/download/") {
        return Response::new(200, b"<html><script>alert(1)</script>".to_vec());
    }
    if request.path.starts_with("/upload/a1/") {
        return Response::json(&json!({ "blobId": "up1", "type": "image/png", "size": request.body.len() }));
    }
    let body: Value = serde_json::from_slice(&request.body).unwrap_or_default();
    let calls = body["methodCalls"].as_array().cloned().unwrap_or_default();
    let responses: Vec<Value> = calls
        .iter()
        .map(|call| {
            let (name, arguments, id) = (call[0].as_str().unwrap_or_default(), &call[1], &call[2]);
            let result = match name {
                "Core/echo" => arguments.clone(),
                "MaskedEmail/get" => json!({ "list": [
                    { "id": "x1", "email": "maple.otter1@masked.test", "state": "pending", "createdAt": "2026-10-01T00:00:00Z",
                      "description": "Shop\u{0}", "forDomain": "https://shop.example.com" },
                    { "id": "../../x2", "email": "evil@masked.test" },
                    { "id": "x3", "email": "no address" },
                    { "id": "x4", "email": "old.badger2@masked.test", "state": "deleted", "createdAt": "2025-01-01T00:00:00Z",
                      "url": "javascript:alert(1)" }
                ] }),
                "MaskedEmail/set" => masked_set(arguments),
                "ProfilePicture/get" => {
                    let blob = if arguments["accountId"] == "a1" { "good" } else { "bad" };
                    json!({ "list": [{ "id": "singleton", "blobId": blob, "type": "image/png", "visibility": "everyone",
                        "sendFace": true, "updated": "2026-10-01T00:00:00Z" }] })
                }
                "ProfilePicture/set" => json!({ "updated": { "singleton": null } }),
                "Principal/get" => json!({ "list": [
                    { "id": "p1", "type": "individual", "name": "Mini", "email": "mini@a.test" },
                    { "id": "p3", "type": "individual", "name": "Leni\u{202e}", "email": "leni@a.test" },
                    { "id": "g1", "type": "group", "name": "Team", "email": "team@a.test" },
                    { "id": "p/4", "type": "individual", "name": "Bad", "email": "bad@a.test" },
                    { "id": "p5", "name": "", "email": "anna@a.test" }
                ] }),
                "Calendar/set" => json!({ "updated": { "c1": null } }),
                _ => return json!(["error", { "type": "unknownMethod" }, id]),
            };
            json!([name, result, id])
        })
        .collect();
    Response::json(&json!({ "methodResponses": responses, "sessionState": "s1" }))
}

async fn client(stub: &support::Stub) -> Client {
    let http = reqwest::Client::builder().build().unwrap();
    Client::connect(&http, stub.url("127.0.0.1", "/.well-known/jmap").as_str(), "mini@a.test", "dummy-password")
        .await
        .unwrap()
}

fn last_call(stub: &support::Stub) -> Value {
    let request: Value = serde_json::from_slice(&stub.seen().last().unwrap().body).unwrap();
    request
}

#[tokio::test]
async fn masked_addresses_go_out_checked_and_come_back_bounded() {
    let stub = http_stub(answer).await;
    let client = client(&stub).await;
    let options = jmap_masked::options(&client).unwrap();
    assert_eq!(options.default_domain.as_deref(), Some("masked.test"));

    let list = jmap_masked::list(&client).await.unwrap();
    let ids: Vec<&str> = list.iter().map(|item| item.id.as_str()).collect();
    assert_eq!(ids, ["x1", "x4"], "newest first, broken ones left out");
    assert_eq!(list[0].description, "Shop");
    assert_eq!(list[0].state, "pending");
    let request = last_call(&stub);
    assert!(request["using"].as_array().unwrap().contains(&json!(MASKED)));
    assert_eq!(request["methodCalls"][0][1]["accountId"], "a1");

    let input = MaskedInput {
        description: "Shop".into(),
        for_domain: "https://shop.example.com".into(),
        email_prefix: Some("Shop".into()),
        domain: Some("masked.test".into()),
        ..MaskedInput::default()
    };
    let made = jmap_masked::create(&client, &input).await.unwrap();
    assert_eq!(made.email, "shop.comet.fern1@masked.test");
    assert_eq!(made.description, "Shop", "what was asked for, with the server's own fields");
    let sent = &last_call(&stub)["methodCalls"][0][1]["create"]["new"];
    assert_eq!(sent["state"], "enabled");
    assert_eq!(sent["emailPrefix"], "shop");

    let refused =
        jmap_masked::create(&client, &MaskedInput { domain: Some("a.test".into()), ..MaskedInput::default() })
            .await
            .unwrap_err();
    assert_eq!(refused.code, ErrorCode::Forbidden);
    assert_eq!(refused.message, "limit");

    // A domain the account may not use, or a value the server would refuse, never leaves.
    let before = stub.seen().len();
    let other = MaskedInput { domain: Some("evil.test".into()), ..MaskedInput::default() };
    assert_eq!(jmap_masked::create(&client, &other).await.unwrap_err().code, ErrorCode::Forbidden);
    let long = MaskedInput { description: "x".repeat(201), ..MaskedInput::default() };
    assert!(jmap_masked::create(&client, &long).await.is_err());
    let back = MaskedPatch { state: Some("pending".into()), ..MaskedPatch::default() };
    assert!(jmap_masked::update(&client, "x1", &back).await.is_err());
    let off = MaskedPatch { state: Some("disabled".into()), ..MaskedPatch::default() };
    assert!(jmap_masked::update(&client, "x/1", &off).await.is_err());
    assert_eq!(stub.seen().len(), before);

    jmap_masked::update(&client, "x1", &off).await.unwrap();
    assert_eq!(last_call(&stub)["methodCalls"][0][1]["update"]["x1"], json!({ "state": "disabled" }));
    assert_eq!(jmap_masked::update(&client, "x404", &off).await.unwrap_err().code, ErrorCode::NotFound);
}

#[tokio::test]
async fn the_profile_picture_is_a_picture_or_nothing() {
    let stub = http_stub(answer).await;
    let client = client(&stub).await;
    let options = jmap_profile::options(&client).unwrap();
    assert_eq!((options.max_size, options.may_be_public), (4096, false));

    let picture = jmap_profile::get(&client).await.unwrap();
    assert!(picture.url.as_deref().unwrap().starts_with("data:image/png;base64,"));
    assert_eq!(picture.visibility, "server", "an unknown visibility reads as the default");
    assert!(picture.send_face);

    use base64::Engine as _;
    let uri = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(PNG));
    jmap_profile::set_picture(&client, Some(&uri)).await.unwrap();
    let seen = stub.seen();
    let upload = seen.iter().find(|r| r.path.starts_with("/upload/")).unwrap();
    assert_eq!(upload.body, PNG, "only the picture's bytes go up");
    assert_eq!(upload.header("content-type"), Some("image/png"));
    let set = seen.iter().rev().find(|r| r.text().contains("ProfilePicture/set")).unwrap();
    let set: Value = serde_json::from_slice(&set.body).unwrap();
    assert_eq!(set["methodCalls"][0][1]["update"]["singleton"], json!({ "blobId": "up1" }));
    assert!(set["using"].as_array().unwrap().contains(&json!(PROFILE)));

    // Not a picture, too big, or public where it isn't allowed: nothing leaves.
    let before = stub.seen().len();
    assert!(jmap_profile::set_picture(&client, Some("data:image/png;base64,PGh0bWw+")).await.is_err());
    let big = format!("data:image/png;base64,{}", "A".repeat(8000));
    assert!(jmap_profile::set_picture(&client, Some(&big)).await.is_err());
    let public = ProfilePatch { visibility: Some("public".into()), send_face: None };
    assert_eq!(jmap_profile::update(&client, &public).await.unwrap_err().code, ErrorCode::Forbidden);
    assert_eq!(stub.seen().len(), before);

    jmap_profile::update(&client, &ProfilePatch { visibility: Some("off".into()), send_face: Some(false) })
        .await
        .unwrap();
    assert_eq!(
        last_call(&stub)["methodCalls"][0][1]["update"]["singleton"],
        json!({ "visibility": "off", "sendFace": false })
    );
}

#[tokio::test]
async fn calendars_are_shared_with_the_people_of_the_server() {
    let stub = http_stub(answer).await;
    let client = client(&stub).await;
    let people = jmap_cal::people(&client).await.unwrap();
    let ids: Vec<&str> = people.iter().map(|person| person.id.as_str()).collect();
    assert_eq!(ids, ["p5", "p3"], "not oneself, no groups, no broken ids; by name");
    assert_eq!(people[0].name, "anna@a.test");
    assert_eq!(people[1].name, "Leni");

    jmap_cal::share_calendar(&client, "c1", "p3", Some("write")).await.unwrap();
    let update = &last_call(&stub)["methodCalls"][0][1]["update"]["c1"];
    assert_eq!(update["shareWith/p3"]["mayWriteAll"], true);
    assert!(update["shareWith/p3"].get("mayShare").is_none());
    jmap_cal::share_calendar(&client, "c1", "p3", None).await.unwrap();
    assert_eq!(last_call(&stub)["methodCalls"][0][1]["update"]["c1"]["shareWith/p3"], Value::Null);

    let before = stub.seen().len();
    assert!(jmap_cal::share_calendar(&client, "c1", "p3/../x", Some("read")).await.is_err());
    assert!(jmap_cal::share_calendar(&client, "c1", "p3", Some("owner")).await.is_err());
    assert_eq!(stub.seen().len(), before);
}
