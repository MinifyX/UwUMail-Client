//! Mail rules, calendars and birthdays against a hostile JMAP server on this machine (plain HTTP on
//! loopback, which the JMAP client allows for local servers). Runs everywhere.

mod support;

use chrono_tz::Tz;
use serde_json::{Value, json};
use support::{Request, Response, http_stub};
use uwumail_core::birthdays::jmap as birthdays;
use uwumail_core::birthdays::scan::{BirthdayImportEntry, BirthdayMatch};
use uwumail_core::calendar::jmap_cal;
use uwumail_core::calendar::jscal::{self, OccurrenceIds, OccurrenceTime};
use uwumail_core::jmap::{BIRTHDAYS, CORE, Client, MAIL};
use uwumail_core::jmap_sieve;

const SIEVE: &str = "urn:ietf:params:jmap:sieve";
const CALENDARS: &str = "urn:ietf:params:jmap:calendars";

fn session() -> Value {
    json!({
        "capabilities": { CORE: { "maxObjectsInGet": 0 }, MAIL: {}, SIEVE: {}, CALENDARS: {}, BIRTHDAYS: {} },
        "accounts": { "a1": { "name": "mini@a.test" } },
        "primaryAccounts": { MAIL: "a1", SIEVE: "a1", CALENDARS: "a1", BIRTHDAYS: "a1" },
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
