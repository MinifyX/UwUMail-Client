//! Mail rules, calendars and birthdays against a hostile JMAP server on this machine (plain HTTP on
//! loopback, which the JMAP client allows for local servers). Runs everywhere.

mod jmap_account;
mod support;

use chrono_tz::Tz;
use serde_json::{Value, json};
use support::{Request, Response, http_stub};
use uwumail_core::birthdays::jmap as birthdays;
use uwumail_core::birthdays::scan::{BirthdayImportEntry, BirthdayMatch};
use uwumail_core::calendar::jmap_cal;
use uwumail_core::calendar::jscal::{self, OccurrenceIds, OccurrenceTime};
use uwumail_core::jmap::{BIRTHDAYS, CORE, Client, MAIL, SIGNATURES};
use uwumail_core::{jmap_sieve, jmap_signatures};

const SIEVE: &str = "urn:ietf:params:jmap:sieve";
const CALENDARS: &str = "urn:ietf:params:jmap:calendars";

fn session() -> Value {
    json!({
        "capabilities": { CORE: { "maxObjectsInGet": 0 }, MAIL: {}, SIEVE: {}, CALENDARS: {}, BIRTHDAYS: {}, SIGNATURES: {} },
        "accounts": { "a1": { "name": "mini@a.test" } },
        "primaryAccounts": { MAIL: "a1", SIEVE: "a1", CALENDARS: "a1", BIRTHDAYS: "a1", SIGNATURES: "a1" },
        "username": "mini@a.test",
        "apiUrl": "/api",
        "downloadUrl": "/download/{accountId}/{blobId}/{name}?type={type}",
        "uploadUrl": "/upload/{accountId}/",
        "state": "s1",
    })
}

fn hostile_events(ids: &Value) -> Value {
    let all = [
        json!({ "id": "e1", "calendarIds": { "c1": true }, "title": "Huge", "description": "x".repeat(300_000),
            "start": "not-a-date", "timeZone": "Nowhere/Land", "duration": "P99999999999999999999D" }),
        json!({ "id": "e2", "calendarIds": { "c1": true }, "title": "Tick\u{0}\u{202e}gnp.exe", "start": "2030-01-03T18:00:00",
            "duration": "-PT5H", "timeZone": "Europe/Berlin", "color": "red; background: url(https://tracker.example/)",
            "recurrenceRule": { "frequency": "secondly", "interval": 0 }, "utcStart": "yesterday", "utcEnd": "2030-01-03T17:00:00Z",
            "locations": { "x": { "name": "<img src=x onerror=alert(1)>" } } }),
        json!({ "id": "e3", "title": "No calendar", "start": "2030-01-04T10:00:00", "baseEventId": "../../e1" }),
    ];
    let wanted: Vec<&str> = ids.as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    Value::Array(all.into_iter().filter(|e| wanted.contains(&e["id"].as_str().unwrap_or_default())).collect())
}

/// A scan with everything a server shouldn't send: controls, endless titles, bad days, a match
/// without its contact, too many options.
fn hostile_scan() -> Value {
    let many: Vec<Value> = (0..40)
        .map(|n| json!({ "contactId": format!("k{n}"), "name": format!("Max {n}"), "birthday": null }))
        .collect();
    json!({ "accountId": "a1", "truncated": false, "candidates": [
        { "eventId": "e1", "calendarId": "c1", "title": "Mia\u{0}'s birthday", "name": "Mia", "marked": false,
          "birthday": { "year": 1999, "month": 10, "day": 19 }, "mayDeleteEvent": true, "match": "matched",
          "contacts": [{ "contactId": "k1", "addressBookId": "b1", "name": "Mia Mood",
                         "birthday": { "year": null, "month": 10, "day": 19 } }] },
        { "eventId": "e2", "calendarId": "c1", "title": "x".repeat(10_000), "name": "Oma Hilde",
          "birthday": { "month": 2, "day": 29 }, "mayDeleteEvent": false, "match": "known", "contacts": [] },
        { "eventId": "e3", "calendarId": "c1", "title": "Max", "name": "Max",
          "birthday": { "year": 2023, "month": 2, "day": 29 }, "match": "matched", "contacts": [] },
        { "eventId": "e".repeat(300), "birthday": { "month": 1, "day": 1 }, "match": "matched" },
        { "eventId": "e5", "calendarId": "c1", "title": "Geb. Max", "name": "Max",
          "birthday": { "month": 5, "day": 1 }, "match": "whatever", "contacts": many },
    ] })
}

/// Imports what it is asked, except the event "e9"; says which contact each went into.
fn import_answer(arguments: &Value) -> Value {
    let entries = arguments["entries"].as_object().cloned().unwrap_or_default();
    let mut imported = serde_json::Map::new();
    let mut failed = serde_json::Map::new();
    for (event, entry) in entries {
        if event == "e9" {
            failed.insert(event, json!({ "type": "notFound", "description": "The event is gone\u{7}." }));
        } else {
            let created = entry.get("newContact").is_some();
            let contact = entry["contactId"].as_str().unwrap_or("k-new").to_owned();
            imported.insert(event, json!({ "contactId": contact, "created": created, "eventDeleted": true }));
        }
    }
    json!({ "accountId": arguments["accountId"], "imported": imported, "notImported": failed })
}

fn answer(request: &Request) -> Response {
    if request.path.starts_with("/.well-known/jmap") {
        return Response::json(&session());
    }
    if request.path.starts_with("/download/") {
        // A "script" far bigger than any rule set.
        return Response::new(200, vec![b'#'; 2 * 1024 * 1024]);
    }
    let body: Value = serde_json::from_slice(&request.body).unwrap_or_default();
    let calls = body["methodCalls"].as_array().cloned().unwrap_or_default();
    let responses: Vec<Value> = calls
        .iter()
        .map(|call| {
            let (name, arguments, id) = (call[0].as_str().unwrap_or_default(), &call[1], &call[2]);
            let result = match name {
                "Core/echo" => arguments.clone(),
                "SieveScript/get" => json!({ "list": [
                    { "id": "s1", "name": "UwUMail", "blobId": "../../../admin/secrets?all=1#x", "isActive": true }
                ] }),
                "CalendarEvent/query" => json!({ "ids": ["e1", "e2", "e3"] }),
                "CalendarEvent/get" => json!({ "list": hostile_events(&arguments["ids"]) }),
                "Birthdays/scan" => hostile_scan(),
                "Birthdays/import" => import_answer(arguments),
                "SignatureSettings/get" => json!({ "accountId": "a1", "state": "s9", "domains": [
                    { "domain": "a.test", "addressCount": 1, "signature": { "text": "<b>x</b>", "html": 7 } }
                ], "identities": "nope" }),
                "SignatureSettings/set" if arguments["domains"].get("evil.test").is_some() => {
                    return json!(["error", { "type": "invalidArguments", "description": "evil.test is not yours" }, id]);
                }
                "SignatureSettings/set" => json!({ "accountId": "a1", "oldState": "s8", "newState": "s9" }),
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

/// A blob id from the server is one path segment of the download address, whatever it says, and
/// a script too big to be rules is refused.
#[tokio::test]
async fn a_hostile_rules_script_stays_in_its_place() {
    let stub = http_stub(answer).await;
    let client = client(&stub).await;
    let error = jmap_sieve::load(&client).await.unwrap_err();
    assert!(error.message.contains("too big"), "{}", error.message);
    let download = stub.seen().into_iter().find(|r| r.path.starts_with("/download/")).unwrap();
    assert!(
        download.path.starts_with("/download/a1/..%2F..%2F..%2Fadmin%2Fsecrets%3Fall%3D1%23x/"),
        "{}",
        download.path
    );
}

/// Events with broken or hostile fields are shown safely or left out; none takes the rest along.
#[tokio::test]
async fn hostile_events_are_shown_safely_or_left_out() {
    let stub = http_stub(answer).await;
    let client = client(&stub).await;
    let instances =
        jmap_cal::occurrences(&client, "2030-01-01T00:00:00", "2030-02-01T00:00:00", "Europe/Berlin").await.unwrap();
    assert_eq!(instances.len(), 3);
    let viewer: Tz = "Europe/Berlin".parse().unwrap();
    let shown: Vec<_> = instances
        .iter()
        .filter_map(|instance| {
            // As the engine does it (engine/calendar_ops.rs): no start, no occurrence.
            let start = instance.event.get("start").and_then(Value::as_str).and_then(jscal::parse_local)?;
            Some(jscal::occurrence(
                OccurrenceIds {
                    id: "a:x".into(),
                    event_id: "a:x".into(),
                    account_id: "a".into(),
                    calendar_id: "a:c1".into(),
                    read_only: false,
                },
                &instance.event,
                instance.base.as_ref(),
                &OccurrenceTime { start, utc: instance.utc },
                viewer,
            ))
        })
        .collect();
    assert_eq!(shown.len(), 2, "the event without a start is left out, the others stay");
    for occurrence in &shown {
        assert!(occurrence.end >= occurrence.start, "{occurrence:?}");
        assert!(occurrence.color.is_none(), "only #rrggbb reaches a style: {:?}", occurrence.color);
        assert!(!occurrence.recurrence_editable || occurrence.recurrence.is_none());
    }
    // Text stays text: the page renders it as such (EventPopover, React text nodes).
    assert!(shown.iter().any(|o| o.location == "<img src=x onerror=alert(1)>"));
}

fn sizes_session(sizes_url: &str) -> Value {
    let mut session = session();
    session["capabilities"][uwumail_core::jmap::REMOTE] =
        json!({ "imageUrl": "/image/{accountId}?url={url}", "imageSizesUrl": sizes_url });
    session
}

/// The picture sizes a server tells are taken for the addresses asked about only, each once, and
/// a server that says nothing sensible can't make the reader wait for more.
#[tokio::test]
async fn picture_sizes_take_only_what_was_asked() {
    let stub = http_stub(|request| {
        if request.path.starts_with("/.well-known/jmap") {
            return Response::json(&sizes_session("/sizes/{accountId}"));
        }
        if !request.path.starts_with("/sizes/") {
            return answer(request);
        }
        let asked: Value = serde_json::from_slice(&request.body).unwrap_or_default();
        assert_eq!(asked["urls"].as_array().map(Vec::len), Some(2), "each address once");
        Response::new(
            200,
            "{\"url\":\"https://cdn.example.com/a.png\",\"width\":640,\"height\":480}\n\
             {\"url\":\"http://127.0.0.1/admin\",\"width\":1,\"height\":1}\n\
             {\"url\":\"https://cdn.example.com/a.png\",\"failed\":true}\n\
             {\"url\":\"https://t.example.net/o.gif\",\"width\":99999999999,\"height\":1}\n",
        )
        .header("content-type", "application/x-ndjson")
    })
    .await;
    let client = client(&stub).await;
    let urls = ["https://cdn.example.com/a.png", "https://t.example.net/o.gif", "https://cdn.example.com/a.png"]
        .map(String::from);
    let mut sizes = Vec::new();
    client.image_sizes(&urls, |size| sizes.push(size)).await.unwrap();
    assert_eq!(sizes.len(), 2);
    assert_eq!((sizes[0].width, sizes[0].height, sizes[0].failed), (Some(640), Some(480), false));
    assert_eq!((sizes[1].url.as_str(), sizes[1].width, sizes[1].failed), ("https://t.example.net/o.gif", None, false));
    let request = stub.seen().into_iter().find(|r| r.path == "/sizes/a1").expect("asked the server");
    assert_eq!(request.method, "POST");
    assert!(request.has_password());
}

/// A sizes address on another site never gets the login.
#[tokio::test]
async fn picture_sizes_stay_on_the_servers_site() {
    let stub = http_stub(|request| {
        if request.path.starts_with("/.well-known/jmap") {
            return Response::json(&sizes_session("https://collector.example.net/sizes/{accountId}"));
        }
        answer(request)
    })
    .await;
    let client = client(&stub).await;
    let error = client.image_sizes(&["https://cdn.example.com/a.png".to_string()], |_| {}).await.unwrap_err();
    assert!(error.message.contains("another site"), "{}", error.message);
}

/// The server's birthday scan arrives bounded, with the app's ids, and nothing it claims without
/// grounds (a match without a contact) is believed.
#[tokio::test]
async fn a_hostile_birthday_scan_is_bounded() {
    let stub = http_stub(answer).await;
    let client = client(&stub).await;
    let scan = birthdays::scan(&client, "acc").await.unwrap();
    let ids: Vec<&str> = scan.candidates.iter().map(|c| c.event_id.as_str()).collect();
    // The 300-character id and the 29 February 2023 are no birthdays.
    assert_eq!(ids, ["acc:e1", "acc:e2", "acc:e5"]);
    let [mia, oma, max] = &scan.candidates[..] else { unreachable!() };
    assert_eq!((mia.title.as_str(), mia.birthday.as_str()), ("Mia's birthday", "1999-10-19"));
    assert_eq!(mia.state, BirthdayMatch::Matched);
    assert_eq!(mia.contacts[0].contact_id, "acc:k1");
    assert_eq!(mia.contacts[0].address_book_id.as_deref(), Some("acc:b1"));
    assert_eq!(mia.contacts[0].birthday.as_deref(), Some("--10-19"));
    assert_eq!((oma.birthday.as_str(), oma.state), ("--02-29", BirthdayMatch::Unmatched));
    assert_eq!(oma.title.chars().count(), 300);
    assert!(!oma.may_delete_event);
    assert_eq!(max.state, BirthdayMatch::Unmatched);
    assert_eq!(max.contacts.len(), 10);
    let call: Value = serde_json::from_slice(&stub.seen().last().unwrap().body).unwrap();
    assert_eq!(call["methodCalls"][0][1], json!({ "accountId": "a1" }));
    assert!(call["using"].as_array().unwrap().contains(&json!(BIRTHDAYS)));
}

/// An import goes out with the server's ids and in parts, and comes back with the app's.
#[tokio::test]
async fn birthdays_are_imported_in_parts() {
    let stub = http_stub(answer).await;
    let client = client(&stub).await;
    let entry = |event: String| BirthdayImportEntry {
        event_id: format!("acc:{event}"),
        contact_id: Some("acc:k1".into()),
        overwrite: false,
        new_contact_name: None,
        address_book_id: None,
        delete_event: None,
    };
    let mut entries: Vec<BirthdayImportEntry> = (0..250).map(|n| entry(format!("x{n}"))).collect();
    entries.push(BirthdayImportEntry { overwrite: true, delete_event: Some(false), ..entry("e1".into()) });
    entries.push(BirthdayImportEntry {
        contact_id: None,
        new_contact_name: Some("  Oma\u{0} Hilde  ".into()),
        address_book_id: Some("acc:b2".into()),
        ..entry("e2".into())
    });
    entries.push(entry("e9".into()));
    let result = birthdays::import(&client, "acc", &entries).await.unwrap();
    assert_eq!(result.imported.len(), 252);
    let oma = result.imported.iter().find(|i| i.event_id == "acc:e2").unwrap();
    assert_eq!((oma.contact_id.as_str(), oma.created, oma.event_deleted), ("acc:k-new", true, true));
    assert_eq!(result.failed.len(), 1);
    assert_eq!(
        (result.failed[0].event_id.as_str(), result.failed[0].reason.as_str()),
        ("acc:e9", "The event is gone.")
    );

    let calls: Vec<Value> = stub
        .seen()
        .iter()
        .filter_map(|r| serde_json::from_slice::<Value>(&r.body).ok())
        .filter(|body| body["methodCalls"][0][0] == "Birthdays/import")
        .map(|body| body["methodCalls"][0][1].clone())
        .collect();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["entries"].as_object().unwrap().len(), 200);
    let last = &calls[1]["entries"];
    assert_eq!(last["e1"], json!({ "contactId": "k1", "overwrite": true, "deleteEvent": false }));
    assert_eq!(last["e2"], json!({ "newContact": { "name": "Oma Hilde", "addressBookId": "b2" } }));

    // A contact of another mailbox is refused before anything is sent.
    let before = stub.seen().len();
    let other = BirthdayImportEntry { contact_id: Some("other:k1".into()), ..entry("e1".into()) };
    assert!(birthdays::import(&client, "acc", &[other]).await.is_err());
    assert_eq!(stub.seen().len(), before);
}

// The AI assistant of a UwUMail server (`urn:uwumail:jmap:assist`), with a server that refuses,
// streams and tries to slip things past the client.

const ASSIST: &str = "urn:uwumail:jmap:assist";

fn assist_session() -> Value {
    json!({
        "capabilities": { CORE: {}, MAIL: {}, ASSIST: { "streamUrl": "/jmap/assist/stream" } },
        "accounts": { "a1": { "name": "mini@a.test", "accountCapabilities": { ASSIST: {
            "features": { "compose": true, "summarize": true, "spamCheck": false, "extractEvents": "yes" },
            "mayAddProviders": true, "maxLabels": 30
        } } } },
        "primaryAccounts": { MAIL: "a1" },
        "username": "mini@a.test",
        "apiUrl": "/api",
        "downloadUrl": "/download/{accountId}/{blobId}/{name}?type={type}",
        "uploadUrl": "/upload/{accountId}/",
        "state": "s1",
    })
}

fn assist_answer(request: &Request) -> Response {
    if request.path.starts_with("/.well-known/jmap") {
        return Response::json(&assist_session());
    }
    let body: Value = serde_json::from_slice(&request.body).unwrap_or_default();
    if request.path == "/jmap/assist/stream" {
        let stream = if body["arguments"]["instruction"] == "fail" {
            "event: error\ndata: {\"type\":\"overQuota\",\"description\":\"Today's limit\\u0007 is used up.\"}\n\n"
                .to_string()
        } else {
            // A comment, a subject, deltas split oddly, an unknown event, then the answer, and
            // text after it that must be ignored.
            [
                ": keep-alive\n\n",
                "event: subject\ndata: {\"subject\":\"Lunch on Friday\"}\n\n",
                "event: delta\ndata: {\"text\":\"Hi Leni, \"}\n\n",
                "event: delta\r\ndata: {\"text\":\"Friday works.\"}\r\n\r\n",
                "event: surprise\ndata: {}\n\n",
                "event: done\ndata: {\"text\":\"Hi Leni, Friday works.\",\"subject\":\"Lunch on Friday\"}\n\n",
                "event: delta\ndata: {\"text\":\"ignored\"}\n\n",
            ]
            .concat()
        };
        return Response::new(200, stream).header("content-type", "text/event-stream");
    }
    let calls = body["methodCalls"].as_array().cloned().unwrap_or_default();
    let responses: Vec<Value> = calls
        .iter()
        .map(|call| {
            let (name, arguments, id) = (call[0].as_str().unwrap_or_default(), &call[1], &call[2]);
            let result = match name {
                "Core/echo" => arguments.clone(),
                "AssistLabel/get" => json!({ "accountId": arguments["accountId"], "list": [
                    { "id": "l1", "name": "Travel", "keyword": "travel", "description": "", "color": null }
                ] }),
                "AssistLabel/set" => json!({ "notCreated": { "k1": {
                    "type": "invalidProperties", "description": "That name is taken.", "properties": ["name"]
                } } }),
                "Assist/spamCheck" => {
                    return json!(["error", { "type": "providerFailed", "description": "Busy", "retryAfter": 12.2 }, id]);
                }
                _ => return json!(["error", { "type": "unknownMethod" }, id]),
            };
            json!([name, result, id])
        })
        .collect();
    Response::json(&json!({ "methodResponses": responses, "sessionState": "s1" }))
}

#[tokio::test]
async fn the_servers_assistant_answers_refuses_and_streams_safely() {
    use std::sync::{Arc, Mutex};
    use uwumail_core::assist::{StreamEvent, StreamSink, server};

    let stub = http_stub(assist_answer).await;
    let jmap = client(&stub).await;

    // Only real `true`s count as features.
    let features = server::features(&jmap).unwrap();
    assert_eq!(features["compose"], true);
    assert_eq!(features["extractEvents"], false);
    assert_eq!(features["spamCheck"], false);

    // Every call names the login's own account, whatever the page asked for.
    let labels = server::labels(&jmap).await.unwrap();
    assert_eq!(labels[0]["keyword"], "travel");
    let sent = stub.seen().into_iter().find(|r| r.text().contains("AssistLabel/get")).unwrap();
    assert!(sent.text().contains("\"accountId\":\"a1\""), "{}", sent.text());

    // Refusals keep their type, the fields they name and how long to wait.
    let refused = server::create_label(&jmap, json!({ "name": "Travel" })).await.unwrap_err();
    assert_eq!(refused.assist_kind(), Some("invalidProperties"));
    assert_eq!(refused.assist.as_ref().unwrap().properties, ["name"]);
    let busy = server::spam_check(&jmap, "m1", Some("en")).await.unwrap_err();
    assert_eq!(busy.assist_kind(), Some("providerFailed"));
    assert_eq!(busy.assist.as_ref().unwrap().retry_after, Some(13));

    // The stream: subject and deltas reach the page as they come, the answer is `done`'s.
    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = events.clone();
    let sink: StreamSink = Arc::new(move |event: StreamEvent| seen.lock().unwrap().push(event));
    let answer = server::stream_or_call(
        &jmap,
        "Assist/compose",
        json!({ "mode": "write", "instruction": "lunch" }),
        Some(sink.clone()),
    )
    .await
    .unwrap();
    assert_eq!(answer["text"], "Hi Leni, Friday works.");
    let events = events.lock().unwrap().clone();
    assert_eq!(events.len(), 3, "{events:?}");
    assert!(matches!(&events[0], StreamEvent::Subject { subject } if subject == "Lunch on Friday"));
    assert!(matches!(&events[2], StreamEvent::Delta { text } if text == "Friday works."));
    let request = stub.seen().into_iter().find(|r| r.path == "/jmap/assist/stream").unwrap();
    assert_eq!(request.header("accept"), Some("text/event-stream"));
    assert!(request.text().contains("\"accountId\":\"a1\""));

    // An error event is the assistant's refusal, without control characters.
    let failed = server::stream_or_call(&jmap, "Assist/compose", json!({ "instruction": "fail" }), Some(sink))
        .await
        .unwrap_err();
    assert_eq!(failed.assist_kind(), Some("overQuota"));
    assert!(!failed.message.contains('\u{7}'), "{}", failed.message);
}

async fn connect_to(stub: &support::Stub) -> uwumail_core::Result<Client> {
    let http = reqwest::Client::builder().build().unwrap();
    Client::connect(&http, stub.url("127.0.0.1", "/.well-known/jmap").as_str(), "mini@a.test", "dummy-password").await
}

/// A session that names its endpoints on another site never sends the login there: announced under
/// another name for the whole API, it moves to the address that answered; a single endpoint
/// elsewhere is refused (audit CC-11).
#[tokio::test]
async fn endpoints_on_another_site_never_get_the_login() {
    for (key, elsewhere) in [
        ("downloadUrl", "https://collector.example.net/d/{accountId}/{blobId}/{name}?type={type}"),
        ("uploadUrl", "https://collector.example.net/u/{accountId}/"),
        ("eventSourceUrl", "https://collector.example.net/events?types={types}"),
        ("downloadUrl", "http://127.0.0.2/d/{accountId}/{blobId}/{name}?type={type}"),
    ] {
        let stub = http_stub(move |request| {
            if request.path.starts_with("/.well-known/jmap") {
                let mut session = session();
                session[key] = json!(elsewhere);
                return Response::json(&session);
            }
            answer(request)
        })
        .await;
        let refused = connect_to(&stub).await.err().unwrap_or_else(|| panic!("{key} {elsewhere} was taken"));
        assert!(refused.message.contains("another site"), "{}", refused.message);
        assert!(stub.seen().iter().all(|r| r.path.starts_with("/.well-known/jmap")), "no API call went out");
    }

    // A server behind a proxy announcing its public name everywhere: used at the address that answered.
    let stub = http_stub(|request| {
        if request.path.starts_with("/.well-known/jmap") {
            let mut session = session();
            session["apiUrl"] = json!("https://mail.public.example/api");
            session["downloadUrl"] =
                json!("https://mail.public.example/download/{accountId}/{blobId}/{name}?type={type}");
            session["uploadUrl"] = json!("https://mail.public.example/upload/{accountId}/");
            return Response::json(&session);
        }
        answer(request)
    })
    .await;
    let client = connect_to(&stub).await.unwrap();
    assert!(client.session.api_url.starts_with(stub.url("127.0.0.1", "/").as_str()), "{}", client.session.api_url);
    assert!(client.session.download_url.starts_with(stub.url("127.0.0.1", "/download/").as_str()));
}

/// Blobs stop arriving past their limit instead of filling the memory (audit C-14).
#[tokio::test]
async fn a_blob_bigger_than_its_limit_stops_arriving() {
    let stub = http_stub(answer).await;
    let client = client(&stub).await;
    let refused = client.download_within("a1", "b1", "m.eml", "message/rfc822", 1024).await.unwrap_err();
    assert!(refused.message.contains("too big"), "{}", refused.message);
    assert_eq!(
        client.download_within("a1", "b1", "m.eml", "message/rfc822", 4 * 1024 * 1024).await.unwrap().len(),
        2 * 1024 * 1024
    );
}

const PNG_2X1: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR\0\0\0\x02\0\0\0\x01\x08\x06\0\0\0";

/// Pictures the server fetched for the reader: only pictures, typed by their bytes (EG-2), and no
/// bigger than pictures fetched here (EG-3).
#[tokio::test]
async fn pictures_from_the_server_are_pictures_of_a_sensible_size() {
    let stub = http_stub(|request| {
        if request.path.starts_with("/.well-known/jmap") {
            let mut session = session();
            session["capabilities"][uwumail_core::jmap::REMOTE] = json!({ "imageUrl": "/image/{accountId}?url={url}" });
            return Response::json(&session);
        }
        if request.path.contains("page") {
            return Response::new(200, "<html><script>alert(1)</script></html>").header("content-type", "image/png");
        }
        if request.path.contains("huge") {
            return Response::new(200, [PNG_2X1, &vec![0u8; 11 * 1024 * 1024]].concat())
                .header("content-type", "image/png");
        }
        if request.path.starts_with("/image/") {
            return Response::new(200, PNG_2X1).header("content-type", "text/html");
        }
        answer(request)
    })
    .await;
    let client = client(&stub).await;
    let (media_type, bytes) = client.remote_image("https://cdn.example.com/a.png").await.unwrap().unwrap();
    assert_eq!((media_type.as_str(), bytes.as_slice()), ("image/png", PNG_2X1), "the type comes from the bytes");
    assert_eq!(client.remote_image("https://cdn.example.com/page").await.unwrap(), None, "a page is no picture");
    let refused = client.remote_image("https://cdn.example.com/huge.png").await.unwrap_err();
    assert!(refused.message.contains("too big"), "{}", refused.message);
}

/// The assistant's stream endpoint gets the login only on the server's own site (CC-11).
#[tokio::test]
async fn the_assistants_stream_stays_on_the_servers_site() {
    use std::sync::Arc;
    use uwumail_core::assist::{StreamEvent, StreamSink, server};

    let stub = http_stub(|request| {
        if request.path.starts_with("/.well-known/jmap") {
            let mut session = assist_session();
            session["capabilities"][ASSIST]["streamUrl"] = json!("https://collector.example.net/stream");
            return Response::json(&session);
        }
        assist_answer(request)
    })
    .await;
    let jmap = client(&stub).await;
    let sink: StreamSink = Arc::new(|_: StreamEvent| {});
    let refused = server::stream_or_call(&jmap, "Assist/compose", json!({ "instruction": "lunch" }), Some(sink))
        .await
        .unwrap_err();
    assert!(refused.message.contains("another site"), "{}", refused.message);
}

/// Signatures per domain go out checked, set before the overview is read again, and a refusal
/// comes back as an error; the overview is handed on as it came (the page checks its fields).
#[tokio::test]
async fn signatures_per_domain_are_set_all_or_nothing() {
    let stub = http_stub(answer).await;
    let client = client(&stub).await;
    let overview = jmap_signatures::load(&client).await.unwrap();
    assert_eq!(overview["state"], "s9");

    let change = json!({ "domains": { "*": { "text": "Mini" }, "a.test": null } });
    let after = jmap_signatures::save(&client, &change).await.unwrap();
    assert_eq!(after["state"], "s9");
    let request: Value = serde_json::from_slice(&stub.seen().last().unwrap().body).unwrap();
    assert!(request["using"].as_array().unwrap().contains(&json!(SIGNATURES)));
    assert_eq!(request["methodCalls"][0][0], "SignatureSettings/set");
    assert_eq!(request["methodCalls"][0][1]["domains"]["*"], json!({ "text": "Mini", "html": "" }));
    assert_eq!(request["methodCalls"][1][0], "SignatureSettings/get");

    let refused = jmap_signatures::save(&client, &json!({ "domains": { "evil.test": null } })).await.unwrap_err();
    assert!(refused.message.contains("evil.test is not yours"), "{}", refused.message);

    // A change that is no change never leaves the device.
    let before = stub.seen().len();
    assert!(jmap_signatures::save(&client, &json!({ "domains": { "a.test": 1 } })).await.is_err());
    assert_eq!(stub.seen().len(), before);
}

/// A Drafts mailbox with an older version of the draft; the new one is imported as "e9".
fn draft_answer(request: &Request, created: &str) -> Response {
    if request.path.starts_with("/.well-known/jmap") {
        return Response::json(&session());
    }
    if request.path.starts_with("/upload/") {
        return Response::json(&json!({ "accountId": "a1", "blobId": "b9", "type": "message/rfc822", "size": 10 }));
    }
    let body: Value = serde_json::from_slice(&request.body).unwrap_or_default();
    let calls = body["methodCalls"].as_array().cloned().unwrap_or_default();
    // One page of drafts; the next page is empty.
    let first_page = body["methodCalls"][0][1]["position"].as_u64().unwrap_or(0) == 0;
    let responses: Vec<Value> = calls
        .iter()
        .map(|call| {
            let (name, id) = (call[0].as_str().unwrap_or_default(), &call[2]);
            let result = match name {
                "Core/echo" => call[1].clone(),
                "Email/query" | "Email/get" if !first_page => json!({ "ids": [], "list": [] }),
                "Mailbox/get" => json!({ "list": [{ "id": "mb-drafts", "name": "Drafts", "parentId": null }] }),
                "Email/import" => json!({ "created": { "draft": { "id": created, "blobId": "b9" } } }),
                "Email/query" => json!({ "ids": ["e9", "e3"] }),
                "Email/get" => json!({ "list": [
                    { "id": "e9", "messageId": ["draft-1@a.test"] },
                    { "id": "e3", "messageId": ["draft-1@a.test"] },
                ] }),
                "Email/set" => json!({ "destroyed": ["e3"] }),
                _ => return json!(["error", { "type": "unknownMethod" }, id]),
            };
            json!([name, result, id])
        })
        .collect();
    Response::json(&json!({ "methodResponses": responses, "sessionState": "s1" }))
}

fn draft_store() -> uwumail_core::store::Store {
    use uwumail_core::model::{AccountColor, AuthKind, Protocol, Security, ServerSettings};
    let store = uwumail_core::store::Store::open_in_memory().unwrap();
    store
        .insert_account(&uwumail_core::store::AccountRecord {
            id: "acc".into(),
            name: "Mini".into(),
            email: "mini@a.test".into(),
            display_name: "Mini".into(),
            color: AccountColor::Pink,
            auth: AuthKind::Password,
            username: "mini@a.test".into(),
            imap: ServerSettings { host: "imap.a.test".into(), port: 993, security: Security::Tls },
            smtp: ServerSettings { host: "smtp.a.test".into(), port: 465, security: Security::Tls },
            protocol: Protocol::Jmap,
            jmap_url: None,
        })
        .unwrap();
    store
}

const DRAFT: &[u8] = b"Message-ID: <draft-1@a.test>\r\nFrom: mini@a.test\r\nTo: leni@b.test\r\nSubject: Hi Leni\r\n\r\nHast du Zeit?\r\n";

/// A saved draft comes back with the id it can be opened by, and only the older version is
/// destroyed on the server.
#[tokio::test]
async fn a_saved_draft_names_the_id_it_opens_by() {
    let stub = http_stub(|request| draft_answer(request, "e9")).await;
    let client = client(&stub).await;
    let store = draft_store();

    let id = uwumail_core::jmap_sync::save_draft(&client, &store, "acc", DRAFT.to_vec(), "draft-1@a.test")
        .await
        .unwrap()
        .expect("the new version has an id");
    let message = store.messages_by_ids(std::slice::from_ref(&id)).unwrap().pop().unwrap();
    assert_eq!(message.subject, "Hi Leni");
    assert!(message.flags.draft);
    let location = store.locations(std::slice::from_ref(&id)).unwrap().pop().unwrap();
    assert_eq!(location.remote_id.as_deref(), Some("e9"));
    assert_eq!(location.folder_path, "mb-drafts");

    let destroyed: Vec<Value> = stub
        .seen()
        .iter()
        .filter_map(|r| serde_json::from_slice::<Value>(&r.body).ok())
        .flat_map(|b| b["methodCalls"].as_array().cloned().unwrap_or_default())
        .filter(|call| call[0] == "Email/set")
        .map(|call| call[1]["destroy"].clone())
        .collect();
    assert_eq!(destroyed, vec![json!(["e3"])]);

    // Saving the same version again (a sync was quicker) names the same id.
    let again =
        uwumail_core::jmap_sync::save_draft(&client, &store, "acc", DRAFT.to_vec(), "draft-1@a.test").await.unwrap();
    assert_eq!(again, Some(id));
}

/// A server that names no usable id leaves the composer its full copy (no id comes back).
#[tokio::test]
async fn a_draft_without_a_usable_id_names_none() {
    for created in [String::new(), "x".repeat(300)] {
        let stub = http_stub(move |request| draft_answer(request, &created)).await;
        let client = client(&stub).await;
        let store = draft_store();
        let saved = uwumail_core::jmap_sync::save_draft(&client, &store, "acc", DRAFT.to_vec(), "draft-1@a.test")
            .await
            .unwrap();
        assert_eq!(saved, None);
    }
}
