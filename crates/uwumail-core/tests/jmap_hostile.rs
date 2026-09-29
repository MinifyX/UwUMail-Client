//! Mail rules and calendars against a hostile JMAP server on this machine (plain HTTP on
//! loopback, which the JMAP client allows for local servers). Runs everywhere.

mod support;

use chrono_tz::Tz;
use serde_json::{Value, json};
use support::{Request, Response, http_stub};
use uwumail_core::calendar::jmap_cal;
use uwumail_core::calendar::jscal::{self, OccurrenceIds, OccurrenceTime};
use uwumail_core::jmap::{CORE, Client, MAIL};
use uwumail_core::jmap_sieve;

const SIEVE: &str = "urn:ietf:params:jmap:sieve";
const CALENDARS: &str = "urn:ietf:params:jmap:calendars";

fn session() -> Value {
    json!({
        "capabilities": { CORE: { "maxObjectsInGet": 0 }, MAIL: {}, SIEVE: {}, CALENDARS: {} },
        "accounts": { "a1": { "name": "mini@a.test" } },
        "primaryAccounts": { MAIL: "a1", SIEVE: "a1", CALENDARS: "a1" },
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
