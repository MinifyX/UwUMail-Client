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
