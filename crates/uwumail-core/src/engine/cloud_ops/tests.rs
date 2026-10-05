//! The Graph and Google backends against a fake of both on 127.0.0.1: tokens per resource,
//! calendars, events, contacts, shared mailboxes, and sign-ins without consent.

use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;

use super::*;
use crate::cloud::fake::{Reply, Request, Server};
use crate::oauth::TokenEndpoint;
use crate::secrets::MemorySecrets;

const OWN: &str = "alex@example.com";
const SHARED: &str = "team@example.com";

struct Setup {
    engine: Engine,
    secrets: Arc<MemorySecrets>,
    server: Server,
    _dir: tempfile::TempDir,
}

/// An engine with one mailbox (`m`) signed in with `auth`, its APIs and token endpoint on `server`.
async fn setup(auth: AuthKind, email: &str, handler: impl Fn(&Request) -> Reply + Send + Sync + 'static) -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let engine = Engine::new(EngineOptions {
        data_dir: dir.path().to_path_buf(),
        secrets: secrets.clone(),
        open_url: Arc::new(|_| {}),
        recognizer: None,
    })
    .unwrap();
    let (imap, smtp) = match auth {
        AuthKind::Google => ("imap.gmail.com", "smtp.gmail.com"),
        _ => ("outlook.office365.com", "smtp.office365.com"),
    };
    engine
        .inner
        .store
        .insert_account(&AccountRecord {
            id: "m".into(),
            name: "Work".into(),
            email: email.into(),
            display_name: "Alex".into(),
            color: AccountColor::Sky,
            auth,
            username: email.into(),
            imap: ServerSettings { host: imap.into(), port: 993, security: Security::Tls },
            smtp: ServerSettings { host: smtp.into(), port: 587, security: Security::Starttls },
            protocol: Protocol::Imap,
            jmap_url: None,
        })
        .unwrap();
    secrets.set("m", &Secret::oauth("refresh-0", None)).unwrap();
    let server = Server::start(handler).await;
    let token =
        TokenEndpoint { url: format!("{}/token", server.base), client_id: "test-app".into(), client_secret: None };
    engine.set_cloud_endpoints(cloud::Endpoints {
        graph: server.url("/graph/"),
        google_calendar: server.url("/gcal/"),
        google_people: server.url("/people/"),
        microsoft_token: Some(token.clone()),
        microsoft_business_token: None,
        google_token: Some(token),
    });
    Setup { engine, secrets, server, _dir: dir }
}

/// A token answer: a new refresh token each time (Microsoft rotates them), the scope asked for.
fn token_reply(request: &Request, count: &AtomicUsize, scope: Option<&str>) -> Reply {
    let n = count.fetch_add(1, Ordering::SeqCst) + 1;
    let scope = scope.map(String::from).or_else(|| request.form("scope")).unwrap_or_default();
    Reply::json(json!({
        "access_token": format!("access-{n}"), "refresh_token": format!("refresh-{n}"), "expires_in": 3600, "scope": scope
    }))
}

fn graph_event(id: &str, kind: &str, start: &str, end: &str, master: Option<&str>) -> Value {
    json!({
        "id": id, "type": kind, "subject": "Yoga", "isAllDay": false, "seriesMasterId": master,
        "body": { "contentType": "text", "content": "" }, "location": { "displayName": "Studio 3" },
        "start": { "dateTime": start, "timeZone": "UTC" }, "end": { "dateTime": end, "timeZone": "UTC" },
        "originalStartTimeZone": "W. Europe Standard Time", "recurrence": null
    })
}

fn graph_handler(tokens: Arc<AtomicUsize>, base: &'static str) -> impl Fn(&Request) -> Reply + Send + Sync {
    move |request: &Request| {
        let path = request.path().to_string();
        if path == "/token" {
            return token_reply(request, &tokens, None);
        }
        let Some(rest) = path.strip_prefix("/graph/") else { return Reply::status(404, json!({})) };
        let method = request.method.as_str();
        if rest == "me" {
            return Reply::json(
                json!({ "mail": OWN, "userPrincipalName": OWN, "proxyAddresses": [format!("SMTP:{OWN}")] }),
            );
        }
        if rest == format!("users/{}/calendars", SHARED.replace('@', "%40")) && method == "GET" {
            return Reply::json(json!({ "value": [] }));
        }
        let Some(rest) = rest.strip_prefix(base).and_then(|r| r.strip_prefix('/')) else {
            return Reply::status(404, json!({ "error": { "code": "ErrorItemNotFound" } }));
        };
        match (method, rest) {
            ("GET", "calendars") => Reply::json(json!({ "value": [
                { "id": "CAL-1", "name": "Calendar", "color": "auto", "hexColor": "#0078d4", "isDefaultCalendar": true, "canEdit": true, "isRemovable": false },
                { "id": "CAL-2", "name": "Anna's calendar", "hexColor": "", "color": "lightGreen", "isDefaultCalendar": false, "canEdit": false, "isRemovable": true }
            ] })),
            ("GET", "calendars/CAL-1/calendarView") => Reply::json(json!({ "value": [
                graph_event("OCC-1", "occurrence", "2026-09-24T16:00:00.0000000", "2026-09-24T17:00:00.0000000", Some("SER-1")),
                { "id": "ONE-1", "type": "singleInstance", "subject": "Dentist", "isAllDay": false,
                  "start": { "dateTime": "2026-09-25T08:00:00", "timeZone": "UTC" }, "end": { "dateTime": "2026-09-25T08:30:00", "timeZone": "UTC" },
                  "originalStartTimeZone": "Europe/Berlin",
                  "organizer": { "emailAddress": { "name": "Dr. Kim", "address": "Kim@example.com" } },
                  "attendees": [
                    { "type": "required", "status": { "response": "tentativelyAccepted" }, "emailAddress": { "name": "Nyu", "address": "nyu@example.com" } },
                    { "type": "resource", "status": { "response": "none" }, "emailAddress": { "name": "Room 1", "address": "room@example.com" } }
                  ] }
            ] })),
            ("GET", "calendars/CAL-2/calendarView") => Reply::json(json!({ "value": [
                { "id": "ANNA-1", "type": "singleInstance", "subject": "Busy", "isAllDay": true,
                  "start": { "dateTime": "2026-09-26T00:00:00", "timeZone": "UTC" }, "end": { "dateTime": "2026-09-27T00:00:00", "timeZone": "UTC" } }
            ] })),
            ("GET", "calendars/CAL-1/events/SER-1") => {
                let mut master =
                    graph_event("SER-1", "seriesMaster", "2026-09-03T16:00:00", "2026-09-03T17:00:00", None);
                master["recurrence"] = json!({
                    "pattern": { "type": "weekly", "interval": 1, "daysOfWeek": ["thursday"], "firstDayOfWeek": "sunday" },
                    "range": { "type": "noEnd", "startDate": "2026-09-03", "recurrenceTimeZone": "W. Europe Standard Time" }
                });
                Reply::json(master)
            }
            ("GET", "calendars/CAL-1/events/OCC-1") => Reply::json(json!({ "id": "OCC-1", "seriesMasterId": "SER-1" })),
            ("POST", "calendars/CAL-1/events") => Reply::json(json!({ "id": "NEW-1" })),
            ("PATCH" | "DELETE", _) if rest.starts_with("calendars/CAL-1/events/") => Reply::empty(),
            ("POST", "calendars") => Reply::json(json!({ "id": "CAL-3" })),
            ("GET", "contactFolders") => Reply::json(json!({ "value": [{ "id": "F-1", "displayName": "Customers" }] })),
            ("GET", "contacts") => Reply::json(json!({ "value": [
                { "id": "C-1", "displayName": "Mina Sommer", "givenName": "Mina", "surname": "Sommer",
                  "emailAddresses": [{ "address": "mina@example.org" }], "birthday": "1990-05-01T11:59:00Z" }
            ] })),
            ("GET", "contactFolders/F-1/contacts") => Reply::json(json!({ "value": [
                { "id": "C-2", "displayName": "Otto", "givenName": "Otto", "emailAddresses": [{ "address": "otto@example.net" }] }
            ] })),
            ("GET", "contacts/C-1") => Reply::json(json!({
                "id": "C-1", "parentFolderId": "DEFAULT-FOLDER", "displayName": "Mina Sommer", "givenName": "Mina", "surname": "Sommer",
                "emailAddresses": [{ "address": "mina@example.org" }], "birthday": "1990-05-01T11:59:00Z"
            })),
            ("POST", "contacts") | ("POST", "contactFolders/F-1/contacts") => Reply::json(json!({ "id": "C-NEW" })),
            ("PATCH" | "DELETE", "contacts/C-1") => Reply::empty(),
            _ => Reply::status(404, json!({ "error": { "code": "ErrorItemNotFound", "message": rest } })),
        }
    }
}

fn input(calendar_id: &str, title: &str) -> EventInput {
    EventInput {
        calendar_id: calendar_id.into(),
        title: title.into(),
        description: String::new(),
        location: "Studio 3".into(),
        all_day: false,
        start: "2026-09-24T18:00:00".into(),
        end: "2026-09-24T19:00:00".into(),
        time_zone: Some("Europe/Berlin".into()),
        recurrence: None,
    }
}

#[tokio::test]
async fn microsoft_calendars_through_graph() {
    let tokens = Arc::new(AtomicUsize::new(0));
    let s = setup(AuthKind::Microsoft, OWN, graph_handler(tokens.clone(), "me")).await;
    let accounts = s.engine.calendar_accounts(false).await.unwrap();
    assert_eq!(accounts[0].source, Some(CalendarSource::Microsoft));
    assert!(!accounts[0].needs_sign_in);

    // The Graph token is its own, asked for with Graph's scopes; the newest refresh token is kept.
    let refreshes: Vec<Request> = s.server.seen().into_iter().filter(|r| r.path() == "/token").collect();
    assert_eq!(refreshes.len(), 1);
    assert_eq!(refreshes[0].form("grant_type").as_deref(), Some("refresh_token"));
    assert_eq!(refreshes[0].form("refresh_token").as_deref(), Some("refresh-0"));
    assert!(refreshes[0].form("scope").unwrap().contains("https://graph.microsoft.com/Calendars.ReadWrite"));
    assert!(!refreshes[0].form("scope").unwrap().contains("outlook.office.com"));
    assert!(matches!(s.secrets.get("m").unwrap(), Secret::OAuth { refresh_token, .. } if refresh_token == "refresh-1"));

    let calendars: Vec<CalendarInfo> =
        s.engine.calendars().await.unwrap().into_iter().filter(|c| !c.is_local).collect();
    assert_eq!(calendars.len(), 2);
    assert!(calendars[0].is_default && calendars[0].may_write);
    assert_eq!(calendars[0].color.as_deref(), Some("#0078d4"));
    assert!(!calendars[1].may_write, "a calendar shared for reading");
    assert_eq!(calendars[1].color.as_deref(), Some("#87d28e"));

    let events = s.engine.calendar_events("2026-09-21T00:00:00", "2026-09-28T00:00:00", "Europe/Berlin").await.unwrap();
    assert_eq!(events.len(), 3, "{events:#?}");
    let yoga = events.iter().find(|e| e.title == "Yoga").unwrap();
    assert_eq!((yoga.start.as_str(), yoga.end.as_str()), ("2026-09-24T18:00:00", "2026-09-24T19:00:00"));
    assert_eq!(yoga.recurrence.as_ref().unwrap().frequency, Frequency::Weekly, "the series' rule");
    assert!(yoga.recurrence_editable);
    assert_eq!(yoga.time_zone.as_deref(), Some("Europe/Berlin"));
    assert_eq!(yoga.event_id, "m:CAL-1/SER-1");
    assert_eq!(yoga.id, "m:CAL-1/OCC-1");
    assert!(yoga.participants.is_empty(), "no one invited, no list");
    let dentist = events.iter().find(|e| e.title == "Dentist").unwrap();
    let who: Vec<_> = dentist.participants.iter().map(|p| (p.email.as_str(), p.status, p.organizer)).collect();
    assert_eq!(
        who,
        [
            ("kim@example.com", crate::calendar::invite::Partstat::Accepted, true),
            ("nyu@example.com", crate::calendar::invite::Partstat::Tentative, false),
            ("room@example.com", crate::calendar::invite::Partstat::NeedsAction, false),
        ]
    );
    let busy = events.iter().find(|e| e.title == "Busy").unwrap();
    assert!(busy.all_day && busy.read_only);
    assert_eq!(busy.start, "2026-09-26T00:00:00");
    let view = s.server.seen().into_iter().find(|r| r.path().ends_with("CAL-1/calendarView")).unwrap();
    assert!(view.header("Prefer").unwrap().contains("outlook.timezone=\"UTC\""));
    assert_eq!(view.header("Authorization"), Some("Bearer access-1"));
    assert_eq!(view.query("startDateTime").as_deref(), Some("2026-09-19T22:00:00Z"), "a day wider");
    assert!(view.query("$select").unwrap().contains("attendees,organizer"));

    // Writing: a new event, the series renamed, an occurrence and the series deleted.
    let id = s.engine.create_event(input("m:CAL-1", "Run")).await.unwrap();
    assert_eq!(id, "m:CAL-1/NEW-1");
    let created = s.server.seen().into_iter().find(|r| r.method == "POST" && r.path().ends_with("/events")).unwrap();
    let body = created.json();
    assert_eq!(body["subject"], "Run");
    assert_eq!(body["start"], json!({ "dateTime": "2026-09-24T18:00:00", "timeZone": "W. Europe Standard Time" }));
    assert_eq!(body["location"]["displayName"], "Studio 3");

    let mut renamed = input("m:CAL-1", "Yin Yoga");
    renamed.recurrence = yoga.recurrence.clone();
    s.engine.update_event(&yoga.event_id, renamed, Some(&yoga.start)).await.unwrap();
    let patch = s.server.seen().into_iter().find(|r| r.method == "PATCH").unwrap();
    assert_eq!(patch.path(), "/graph/me/calendars/CAL-1/events/SER-1");
    assert_eq!(patch.json(), json!({ "subject": "Yin Yoga" }), "only what changed");

    s.engine.delete_event(&yoga.id, EventDeleteScope::Occurrence).await.unwrap();
    s.engine.delete_event(&yoga.id, EventDeleteScope::Series).await.unwrap();
    let deleted: Vec<String> =
        s.server.seen().into_iter().filter(|r| r.method == "DELETE").map(|r| r.path().to_string()).collect();
    assert_eq!(deleted, ["/graph/me/calendars/CAL-1/events/OCC-1", "/graph/me/calendars/CAL-1/events/SER-1"]);

    // A shared calendar takes no events.
    let refused = s.engine.create_event(input("m:CAL-2", "Sneaky")).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::InvalidInput);

    let created = s
        .engine
        .create_calendar(NewCalendar {
            account_id: Some("m".into()),
            name: "Gym".into(),
            color: Some("#ff9090".into()),
        })
        .await;
    // The fake doesn't list it afterwards; what was asked for counts here.
    assert!(created.is_err());
    let made = s.server.seen().into_iter().find(|r| r.method == "POST" && r.path() == "/graph/me/calendars").unwrap();
    assert_eq!(made.json(), json!({ "name": "Gym", "color": "lightRed" }));
    assert_eq!(tokens.load(Ordering::SeqCst), 1, "one Graph token for all of it");
}

#[tokio::test]
async fn shared_mailboxes_use_their_own_path() {
    let tokens = Arc::new(AtomicUsize::new(0));
    let s = setup(AuthKind::Microsoft, SHARED, graph_handler(tokens, "users/team%40example.com")).await;
    let books = s.engine.address_books().await.unwrap();
    assert_eq!(books.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), ["Contacts", "Customers"]);
    assert!(books[0].is_default && !books[0].may_delete);
    let cards = s.engine.contact_cards().await.unwrap();
    assert_eq!(cards.len(), 2);
    let mina = cards.iter().find(|c| c.card["name"]["full"] == "Mina Sommer").unwrap();
    assert_eq!(mina.card["id"], "m:C-1");
    assert_eq!(mina.card["addressBookIds"], json!({ "m:contacts": true }));
    assert_eq!(mina.card["anniversaries"]["b1"]["date"]["year"], 1990);
    let otto = cards.iter().find(|c| c.card["name"]["full"] == "Otto").unwrap();
    assert_eq!(otto.card["addressBookIds"], json!({ "m:F-1": true }));

    // Suggestions come from these contacts too.
    let suggestions = s.engine.recipient_suggestions("mina").await.unwrap();
    assert_eq!(suggestions[0].email, "mina@example.org");

    let new = s
        .engine
        .create_contact_card(
            "m:F-1",
            json!({ "name": { "full": "Neu" }, "emails": { "e": { "address": "neu@example.org" } } }),
        )
        .await
        .unwrap();
    assert_eq!(new, "m:C-NEW");
    let mut patch = Map::new();
    patch.insert("emails/e1/address".into(), json!("mina@example.net"));
    s.engine.update_contact_card("m:C-1", patch).await.unwrap();
    s.engine.delete_contact_card("m:C-1").await.unwrap();

    let seen = s.server.seen();
    let api: Vec<&Request> =
        seen.iter().filter(|r| r.path().starts_with("/graph/") && r.path() != "/graph/me").collect();
    assert!(
        api.iter().all(|r| r.path().starts_with("/graph/users/team%40example.com/")),
        "{:?}",
        api.iter().map(|r| r.path()).collect::<Vec<_>>()
    );
    let created = seen.iter().find(|r| r.method == "POST" && r.path().starts_with("/graph/")).unwrap();
    assert_eq!(created.path(), "/graph/users/team%40example.com/contactFolders/F-1/contacts");
    assert_eq!(created.json()["emailAddresses"], json!([{ "address": "neu@example.org", "name": "neu@example.org" }]));
    let changed = seen.iter().find(|r| r.method == "PATCH").unwrap();
    assert_eq!(changed.json()["emailAddresses"][0]["address"], "mina@example.net");
    assert_eq!(changed.json().as_object().unwrap().len(), 1, "only what changed: {}", changed.body);
    assert!(seen.iter().any(|r| r.method == "DELETE" && r.path().ends_with("/contacts/C-1")));
}

#[tokio::test]
async fn sign_ins_without_consent_ask_to_sign_in_again() {
    let s = setup(AuthKind::Microsoft, OWN, |request: &Request| {
        if request.path() == "/token" {
            return Reply::status(
                400,
                json!({ "error": "invalid_grant", "error_description": "AADSTS65001: The user or administrator has not consented to use the application." }),
            );
        }
        Reply::status(500, json!({}))
    })
    .await;
    let calendars = s.engine.calendar_accounts(false).await.unwrap();
    assert!(calendars[0].needs_sign_in && calendars[0].checked && calendars[0].source.is_none());
    let contacts = s.engine.contacts_accounts(false).await.unwrap();
    assert!(contacts[0].needs_sign_in && contacts[0].source.is_none());
    assert!(s.engine.calendars().await.unwrap().is_empty());
    assert!(s.engine.calendar_events("2026-09-01T00:00:00", "2026-10-01T00:00:00", "UTC").await.unwrap().is_empty());
    // Calendar and contacts each tried both Graph scope sets once; then the answer is remembered.
    let asked = s.server.count("POST", "/token");
    assert_eq!(asked, 4);
    s.engine.calendar_accounts(false).await.unwrap();
    assert_eq!(s.server.count("POST", "/token"), asked);
    // The mail's refresh token stays as it was.
    assert!(matches!(s.secrets.get("m").unwrap(), Secret::OAuth { refresh_token, .. } if refresh_token == "refresh-0"));

    // Google: the token works, but without the calendar and contacts the person didn't allow.
    let tokens = Arc::new(AtomicUsize::new(0));
    let g = setup(AuthKind::Google, "mini@example.com", move |request: &Request| {
        token_reply(request, &tokens, Some("https://mail.google.com/"))
    })
    .await;
    let calendars = g.engine.calendar_accounts(false).await.unwrap();
    assert!(calendars[0].needs_sign_in);
    assert!(g.engine.contacts_accounts(false).await.unwrap()[0].needs_sign_in);
    assert!(g.server.seen().iter().all(|r| r.path() == "/token"), "no API was asked");
}

#[tokio::test]
async fn a_refused_token_is_renewed_once() {
    let tokens = Arc::new(AtomicUsize::new(0));
    let calls = Arc::new(AtomicUsize::new(0));
    let (t, c) = (tokens.clone(), calls.clone());
    let s = setup(AuthKind::Microsoft, OWN, move |request: &Request| match request.path() {
        "/token" => token_reply(request, &t, None),
        "/graph/me" => Reply::json(json!({ "mail": OWN })),
        "/graph/me/calendars" => {
            // The first token was revoked meanwhile.
            if c.fetch_add(1, Ordering::SeqCst) == 0 {
                Reply::status(401, json!({ "error": { "code": "InvalidAuthenticationToken" } }))
            } else {
                Reply::json(json!({ "value": [{ "id": "CAL-1", "name": "Calendar", "canEdit": true, "isDefaultCalendar": true }] }))
            }
        }
        _ => Reply::status(404, json!({})),
    })
    .await;
    assert_eq!(s.engine.calendars().await.unwrap().len(), 1);
    assert_eq!(tokens.load(Ordering::SeqCst), 2);
    let listing: Vec<Request> = s.server.seen().into_iter().filter(|r| r.path() == "/graph/me/calendars").collect();
    assert_eq!(listing[1].header("Authorization"), Some("Bearer access-2"));
    assert!(matches!(s.secrets.get("m").unwrap(), Secret::OAuth { refresh_token, .. } if refresh_token == "refresh-2"));
}

#[tokio::test]
async fn google_calendars_and_contacts() {
    let tokens = Arc::new(AtomicUsize::new(0));
    let full =
        "https://mail.google.com/ https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/contacts";
    let s = setup(AuthKind::Google, "mini@example.com", move |request: &Request| {
        let path = request.path();
        let method = request.method.as_str();
        if path == "/token" {
            assert!(request.form("scope").is_none(), "Google's one token covers everything");
            return token_reply(request, &tokens, Some(full));
        }
        match (method, path) {
            ("GET", "/gcal/users/me/calendarList") => Reply::json(json!({ "items": [
                { "id": "mini@example.com", "summary": "mini@example.com", "accessRole": "owner", "primary": true,
                  "backgroundColor": "#9fe1e7", "timeZone": "Europe/Berlin" },
                { "id": "addressbook#contacts@group.v.calendar.google.com", "summary": "Birthdays", "accessRole": "reader" }
            ] })),
            ("GET", "/gcal/calendars/mini%40example.com/events") => {
                assert_eq!(request.query("singleEvents").as_deref(), Some("true"));
                if request.query("pageToken").is_none() {
                    return Reply::json(json!({ "timeZone": "Europe/Berlin", "nextPageToken": "p2", "items": [
                        { "id": "yoga_20260924T160000Z", "recurringEventId": "yoga", "summary": "Yoga",
                          "start": { "dateTime": "2026-09-24T18:00:00+02:00", "timeZone": "Europe/Berlin" },
                          "end": { "dateTime": "2026-09-24T19:00:00+02:00", "timeZone": "Europe/Berlin" } }
                    ] }));
                }
                Reply::json(json!({ "items": [
                    { "id": "gone", "status": "cancelled" },
                    { "id": "trip", "summary": "Trip", "start": { "date": "2026-09-26" }, "end": { "date": "2026-09-28" },
                      "organizer": { "email": "mina@example.org", "displayName": "Mina" },
                      "attendees": [
                        { "email": "mini@example.com", "self": true, "responseStatus": "accepted" },
                        { "email": "mina@example.org", "organizer": true, "responseStatus": "tentative" }
                      ] }
                ] }))
            }
            ("GET", "/gcal/calendars/mini%40example.com/events/yoga") => Reply::json(json!({
                "id": "yoga", "summary": "Yoga", "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=TH"],
                "start": { "dateTime": "2026-09-03T18:00:00+02:00", "timeZone": "Europe/Berlin" },
                "end": { "dateTime": "2026-09-03T19:00:00+02:00", "timeZone": "Europe/Berlin" }
            })),
            ("GET", "/gcal/calendars/mini%40example.com/events/yoga_20260924T160000Z") => {
                Reply::json(json!({ "id": "yoga_20260924T160000Z", "recurringEventId": "yoga" }))
            }
            ("POST", "/gcal/calendars/mini%40example.com/events") => Reply::json(json!({ "id": "new1" })),
            ("PATCH" | "DELETE", _) if path.starts_with("/gcal/calendars/mini%40example.com/events/") => Reply::empty(),
            ("GET", "/people/people/me/connections") => Reply::json(json!({ "connections": [
                { "resourceName": "people/c1", "etag": "e1", "names": [{ "givenName": "Mina", "familyName": "Sommer" }],
                  "emailAddresses": [{ "value": "mina@example.org", "type": "home" }], "birthdays": [{ "date": { "month": 5, "day": 1 } }] }
            ] })),
            ("GET", "/people/people/c1") => Reply::json(json!({
                "resourceName": "people/c1", "etag": "e1", "names": [{ "givenName": "Mina", "familyName": "Sommer" }],
                "emailAddresses": [{ "value": "mina@example.org", "type": "home" }]
            })),
            ("POST", "/people/people:createContact") => Reply::json(json!({ "resourceName": "people/c2" })),
            ("PATCH", "/people/people/c1:updateContact") | ("DELETE", "/people/people/c1:deleteContact") => {
                Reply::json(json!({}))
            }
            _ => Reply::status(404, json!({ "error": { "code": 404, "message": path } })),
        }
    })
    .await;
    let accounts = s.engine.calendar_accounts(false).await.unwrap();
    assert_eq!(accounts[0].source, Some(CalendarSource::Google));
    let calendars = s.engine.calendars().await.unwrap();
    let names: Vec<&str> = calendars.iter().filter(|c| !c.is_local).map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["mini@example.com"], "Google's contact birthdays come from the app's own calendar");
    assert!(calendars.iter().any(|c| c.is_birthdays && c.is_local), "made from the contacts");

    let events = s.engine.calendar_events("2026-09-21T00:00:00", "2026-09-28T00:00:00", "Europe/Berlin").await.unwrap();
    let yoga = events.iter().find(|e| e.title == "Yoga").unwrap();
    assert_eq!(yoga.start, "2026-09-24T18:00:00");
    assert_eq!(yoga.event_id, "m:mini%40example.com/yoga");
    assert_eq!(yoga.recurrence.as_ref().unwrap().by_day, Some(vec![Weekday::Th]));
    let trip = events.iter().find(|e| e.title == "Trip").unwrap();
    assert!(trip.all_day);
    assert_eq!((trip.start.as_str(), trip.end.as_str()), ("2026-09-26T00:00:00", "2026-09-28T00:00:00"));
    let who: Vec<_> = trip.participants.iter().map(|p| (p.name.as_str(), p.status, p.organizer)).collect();
    assert_eq!(
        who,
        [
            ("Mina", crate::calendar::invite::Partstat::Tentative, true),
            ("mini@example.com", crate::calendar::invite::Partstat::Accepted, false),
        ]
    );
    assert!(yoga.participants.is_empty());

    let id = s.engine.create_event(input("m:mini@example.com", "Run")).await.unwrap();
    assert_eq!(id, "m:mini%40example.com/new1");
    let mut moved = input("m:mini@example.com", "Yoga");
    moved.start = "2026-09-24T19:00:00".into();
    moved.end = "2026-09-24T20:00:00".into();
    moved.recurrence = yoga.recurrence.clone();
    s.engine.update_event(&yoga.event_id, moved, Some(&yoga.start)).await.unwrap();
    s.engine.delete_event(&yoga.id, EventDeleteScope::Series).await.unwrap();

    let cards = s.engine.contact_cards().await.unwrap();
    assert_eq!(cards[0].card["id"], "m:people/c1");
    // The full name alone doesn't change Google's structured name: nothing to send.
    let mut patch = Map::new();
    patch.insert("name/full".into(), json!("Mina S."));
    s.engine.update_contact_card("m:people/c1", patch).await.unwrap();
    assert_eq!(s.server.count("PATCH", "/people/"), 0);
    let mut patch = Map::new();
    patch.insert("emails/e1/address".into(), json!("mina@example.net"));
    s.engine.update_contact_card("m:people/c1", patch).await.unwrap();
    assert_eq!(
        s.engine.create_contact_card("m:contacts", json!({ "name": { "full": "Otto" } })).await.unwrap(),
        "m:people/c2"
    );
    s.engine.delete_contact_card("m:people/c1").await.unwrap();
    assert!(s.engine.delete_contact_card("m:people/../x").await.is_err());

    let seen = s.server.seen();
    let created = seen.iter().find(|r| r.method == "POST" && r.path().starts_with("/gcal/")).unwrap();
    assert_eq!(
        created.json()["start"],
        json!({ "dateTime": "2026-09-24T18:00:00", "timeZone": "Europe/Berlin", "date": null })
    );
    let patched = seen.iter().find(|r| r.method == "PATCH" && r.path().starts_with("/gcal/")).unwrap();
    assert_eq!(patched.path(), "/gcal/calendars/mini%40example.com/events/yoga");
    assert_eq!(patched.json()["start"]["dateTime"], "2026-09-03T19:00:00", "the series moved by an hour");
    assert!(patched.json().get("summary").is_none());
    let deleted = seen.iter().find(|r| r.method == "DELETE" && r.path().starts_with("/gcal/")).unwrap();
    assert_eq!(deleted.path(), "/gcal/calendars/mini%40example.com/events/yoga", "the whole series");
    let updated = seen.iter().find(|r| r.method == "PATCH" && r.path().starts_with("/people/")).unwrap();
    assert_eq!(updated.json()["etag"], "e1");
    assert_eq!(updated.json()["emailAddresses"], json!([{ "value": "mina@example.net", "type": "home" }]));
    assert!(updated.json().get("names").is_none(), "only what changed");
    assert_eq!(updated.query("updatePersonFields").as_deref(), Some("emailAddresses"));
    assert_eq!(s.server.count("POST", "/token"), 1, "one token for calendar and contacts");
}

#[tokio::test]
async fn personal_microsoft_accounts_ask_graph_for_their_own_calendars_only() {
    let tokens = Arc::new(AtomicUsize::new(0));
    let s = setup(AuthKind::Microsoft, OWN, graph_handler(tokens.clone(), "me")).await;
    // The token said Microsoft's consumer tenant (a personal account under its own domain).
    s.engine.inner.store.set_shared_search("m", super::super::shared_ops::PERSONAL, 0).unwrap();
    assert_eq!(s.engine.calendars().await.unwrap().iter().filter(|c| !c.is_local).count(), 2);
    let refreshes: Vec<Request> = s.server.seen().into_iter().filter(|r| r.path() == "/token").collect();
    assert_eq!(refreshes.len(), 1, "no second try with other scopes");
    assert_eq!(refreshes[0].form("scope").as_deref(), Some(oauth::MICROSOFT_GRAPH_OWN_SCOPES));
}

#[tokio::test]
async fn nested_shared_mailboxes_use_their_accounts_sign_in() {
    let tokens = Arc::new(AtomicUsize::new(0));
    let s = setup(AuthKind::Microsoft, OWN, graph_handler(tokens.clone(), "users/team%40example.com")).await;
    let store = &s.engine.inner.store;
    let mut team = store.account("m").unwrap();
    team.id = "t".into();
    team.name = "Team".into();
    team.email = SHARED.into();
    team.username = SHARED.into();
    store.insert_account(&team).unwrap();
    store.set_account_parent("t", Some("m")).unwrap();
    // The shared mailbox has no secret of its own.
    assert!(s.secrets.get("t").is_err());

    let books: Vec<_> = s.engine.address_books().await.unwrap().into_iter().filter(|b| b.account_id == "t").collect();
    assert_eq!(books.len(), 2);
    let seen = s.server.seen();
    let refreshes: Vec<&Request> = seen.iter().filter(|r| r.path() == "/token").collect();
    assert!(refreshes.iter().all(|r| r.form("refresh_token").as_deref() == Some("refresh-0")), "the account's token");
    assert!(seen.iter().any(|r| r.path() == "/graph/users/team%40example.com/contactFolders"));
    // The rotated refresh token went to the account, still none for the shared mailbox.
    assert!(
        matches!(s.secrets.get("m").unwrap(), Secret::OAuth { refresh_token, .. } if refresh_token.starts_with("refresh-") && refresh_token != "refresh-0")
    );
    assert!(s.secrets.get("t").is_err());
}

#[tokio::test]
async fn a_shared_mailbox_graph_refuses_is_never_the_persons_own() {
    let tokens = Arc::new(AtomicUsize::new(0));
    let s = setup(AuthKind::Microsoft, OWN, move |request: &Request| match request.path() {
        "/token" => token_reply(request, &tokens, None),
        "/graph/me" => Reply::json(json!({ "mail": OWN, "userPrincipalName": OWN })),
        _ => Reply::status(403, json!({ "error": { "code": "ErrorAccessDenied", "message": "Access is denied." } })),
    })
    .await;
    let store = &s.engine.inner.store;
    let mut team = store.account("m").unwrap();
    team.id = "t".into();
    team.email = SHARED.into();
    team.username = SHARED.into();
    store.insert_account(&team).unwrap();
    store.set_account_parent("t", Some("m")).unwrap();

    let error = s.engine.inner.graph_base(&team).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotSupported, "{error:?}");
    // A mailbox of the person's own under an address Graph doesn't list is still theirs.
    let mut alias = store.account("m").unwrap();
    alias.email = "alex.alias@example.com".into();
    assert_eq!(s.engine.inner.graph_base(&alias).await.unwrap(), "me");
    assert!(!s.server.seen().iter().any(|r| r.path().starts_with("/graph/me/")), "nothing of the person's own");
}

#[tokio::test]
async fn meetings_do_not_move_between_microsoft_calendars() {
    let tokens = Arc::new(AtomicUsize::new(0));
    let s = setup(AuthKind::Microsoft, OWN, move |request: &Request| match (request.method.as_str(), request.path()) {
        (_, "/token") => token_reply(request, &tokens, None),
        (_, "/graph/me") => Reply::json(json!({ "mail": OWN, "userPrincipalName": OWN })),
        ("GET", "/graph/me/calendars") => Reply::json(json!({ "value": [
            { "id": "CAL-1", "name": "Calendar", "isDefaultCalendar": true, "canEdit": true },
            { "id": "CAL-2", "name": "Other", "canEdit": true, "isRemovable": true }
        ] })),
        ("GET", "/graph/me/calendars/CAL-1/events/MEET-1") => {
            let mut meeting =
                graph_event("MEET-1", "singleInstance", "2026-09-24T16:00:00", "2026-09-24T17:00:00", None);
            meeting["attendees"] = json!([{ "emailAddress": { "address": "kim@example.com" }, "type": "required" }]);
            Reply::json(meeting)
        }
        _ => Reply::empty(),
    })
    .await;
    let error = s.engine.update_event("m:CAL-1/MEET-1", input("m:CAL-2", "Yoga"), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotSupported);
    let seen = s.server.seen();
    assert!(seen.iter().all(|r| r.method == "GET" || r.path() == "/token"), "nothing created or deleted");
    let read = seen.iter().find(|r| r.path().ends_with("/events/MEET-1")).unwrap();
    assert!(read.query("$select").unwrap().contains("attendees"));
}

#[tokio::test]
async fn a_refresh_waiting_for_another_uses_the_newest_refresh_token() {
    let tokens = Arc::new(AtomicUsize::new(0));
    let s = setup(AuthKind::Microsoft, OWN, move |request: &Request| token_reply(request, &tokens, None)).await;
    let record = s.engine.inner.store.account("m").unwrap();
    // Another refresh holds the lock and rotates the refresh token meanwhile.
    let busy = s.engine.inner.tokens.lock().await;
    let secrets = s.secrets.clone();
    let other = async move {
        tokio::task::yield_now().await;
        secrets.set("m", &Secret::oauth("refresh-rotated", None)).unwrap();
        drop(busy);
    };
    let (credential, ()) = tokio::join!(s.engine.inner.credential(&record), other);
    assert!(matches!(credential.unwrap(), Credential::Token(_)));
    let refreshes: Vec<Request> = s.server.seen().into_iter().filter(|r| r.path() == "/token").collect();
    assert_eq!(refreshes.len(), 1);
    assert_eq!(refreshes[0].form("refresh_token").as_deref(), Some("refresh-rotated"));
    assert_eq!(refreshes[0].form("scope").as_deref(), Some(oauth::MICROSOFT_MAIL_SCOPES));
}

/// The personal app's token endpoint stays `test-app`; the business app's is `business-app` on the
/// same fake, which answers only the client id the refresh token was issued to.
async fn with_business_app(s: &Setup) {
    let personal =
        TokenEndpoint { url: format!("{}/token", s.server.base), client_id: "test-app".into(), client_secret: None };
    let business = TokenEndpoint { client_id: "business-app".into(), ..personal.clone() };
    s.engine.set_cloud_endpoints(cloud::Endpoints {
        graph: s.server.url("/graph/"),
        google_calendar: s.server.url("/gcal/"),
        google_people: s.server.url("/people/"),
        microsoft_token: Some(personal.clone()),
        microsoft_business_token: Some(business),
        google_token: Some(personal),
    });
}

fn issued_to(app: &'static str, tokens: Arc<AtomicUsize>) -> impl Fn(&Request) -> Reply + Send + Sync {
    move |request: &Request| {
        if request.path() == "/token" && request.form("client_id").as_deref() != Some(app) {
            return Reply::status(
                400,
                json!({ "error": "invalid_grant", "error_description": "AADSTS700025: Client is public so neither 'client_assertion' nor 'client_secret' should be presented. AADSTS7000215: wrong client" }),
            );
        }
        graph_handler(tokens.clone(), "me")(request)
    }
}

#[tokio::test]
async fn refreshes_go_to_the_app_the_refresh_token_was_issued_to() {
    let tokens = Arc::new(AtomicUsize::new(0));
    let s = setup(AuthKind::Microsoft, OWN, issued_to("business-app", tokens)).await;
    with_business_app(&s).await;
    s.secrets.set("m", &Secret::oauth("refresh-0", Some(oauth::MicrosoftApp::Business))).unwrap();

    // Mail (IMAP/SMTP, and Exchange Web Services with it) and Graph both as the business app.
    let record = s.engine.inner.store.account("m").unwrap();
    assert!(matches!(s.engine.inner.credential(&record).await.unwrap(), Credential::Token(_)));
    assert!(!s.engine.calendar_accounts(false).await.unwrap()[0].needs_sign_in);
    let refreshes: Vec<Request> = s.server.seen().into_iter().filter(|r| r.path() == "/token").collect();
    assert_eq!(refreshes.len(), 2);
    assert!(refreshes.iter().all(|r| r.form("client_id").as_deref() == Some("business-app")));
    // The rotated refresh token stays the business app's.
    assert_eq!(s.secrets.get("m").unwrap().microsoft_app(), oauth::MicrosoftApp::Business);

    // A shared mailbox nested under it opens with its account's sign-in, so with the business app.
    let mut shared = record.clone();
    shared.id = "team".into();
    shared.email = SHARED.into();
    shared.username = SHARED.into();
    s.engine.inner.store.insert_account(&shared).unwrap();
    s.engine.inner.store.set_account_parent("team", Some("m")).unwrap();
    s.engine.inner.tokens.lock().await.clear();
    assert!(matches!(s.engine.inner.credential(&shared).await.unwrap(), Credential::Token(_)));
    let last = s.server.seen().into_iter().rfind(|r| r.path() == "/token").unwrap();
    assert_eq!(last.form("client_id").as_deref(), Some("business-app"));
    assert!(s.secrets.get("team").is_err(), "no secret of its own");
}

#[tokio::test]
async fn sign_ins_saved_before_the_business_app_refresh_with_the_personal_one() {
    let tokens = Arc::new(AtomicUsize::new(0));
    let s = setup(AuthKind::Microsoft, OWN, issued_to("test-app", tokens)).await;
    with_business_app(&s).await;
    // A company account from 0.8.0-beta.1: no app in its secret.
    let record = s.engine.inner.store.account("m").unwrap();
    assert!(matches!(s.engine.inner.credential(&record).await.unwrap(), Credential::Token(_)));
    assert!(!s.engine.calendar_accounts(false).await.unwrap()[0].needs_sign_in);
    let refreshes: Vec<Request> = s.server.seen().into_iter().filter(|r| r.path() == "/token").collect();
    assert_eq!(refreshes.len(), 2);
    assert!(refreshes.iter().all(|r| r.form("client_id").as_deref() == Some("test-app")));
    assert!(matches!(s.secrets.get("m").unwrap(), Secret::OAuth { microsoft_app: None, .. }));
}

/// A small GIF whose bytes are all ASCII, so the fake server can hand it out as text.
const GIF: &str = "GIF89a\u{1}\u{0}\u{1}\u{0}\u{0}\u{0}\u{0};";

fn photo_uri() -> String {
    use base64::Engine as _;
    format!("data:image/gif;base64,{}", base64::engine::general_purpose::STANDARD.encode(GIF))
}

/// Contact photos at Microsoft go through Graph's photo calls, apart from the contact: written
/// with a new contact or a change, removed, and read when the contact shows.
#[tokio::test]
async fn microsoft_contact_photos_go_their_own_way() {
    let tokens = Arc::new(AtomicUsize::new(0));
    let s = setup(AuthKind::Microsoft, OWN, move |request: &Request| {
        let path = request.path();
        if path == "/token" {
            return token_reply(request, &tokens, None);
        }
        match (request.method.as_str(), path) {
            ("GET", "/graph/me") => Reply::json(json!({ "mail": OWN, "userPrincipalName": OWN })),
            ("GET", "/graph/me/contactFolders") => Reply::json(json!({ "value": [] })),
            ("GET", "/graph/me/contacts") => {
                Reply::json(json!({ "value": [{ "id": "K1", "givenName": "Mina", "parentFolderId": "F0" }] }))
            }
            ("GET", "/graph/me/contacts/K1") => Reply::json(json!({ "id": "K1", "givenName": "Mina" })),
            ("POST", "/graph/me/contacts") => Reply::json(json!({ "id": "K2" })),
            ("PATCH", "/graph/me/contacts/K1") => Reply::json(json!({})),
            ("GET", "/graph/me/contacts/K1/photo/$value") => Reply { status: 200, body: GIF.into() },
            ("GET", "/graph/me/contacts/K2/photo/$value") => {
                Reply::status(404, json!({ "error": { "code": "ErrorItemNotFound" } }))
            }
            ("PUT", "/graph/me/contacts/K1/photo/$value" | "/graph/me/contacts/K2/photo/$value") => Reply::empty(),
            ("DELETE", "/graph/me/contacts/K1/photo/$value") => Reply::empty(),
            _ => Reply::status(404, json!({ "error": { "code": "ErrorItemNotFound", "message": path } })),
        }
    })
    .await;
    let cards = s.engine.contact_cards().await.unwrap();
    assert_eq!(cards[0].card["uwuRemotePhoto"], true, "Graph lists no photos: asked when shown");
    let shown = s.engine.contact_photo("m:K1").await.unwrap().unwrap();
    assert!(shown.starts_with("data:image/gif;base64,"), "{shown}");
    assert_eq!(s.engine.contact_photo("m:K2").await.unwrap(), None);

    let card = json!({ "name": { "full": "Otto" }, "uwuRemotePhoto": true,
        "media": { "p1": { "kind": "photo", "uri": photo_uri() } } });
    assert_eq!(s.engine.create_contact_card("m:contacts", card).await.unwrap(), "m:K2");
    let created = s.server.seen().into_iter().find(|r| r.method == "POST" && r.path() == "/graph/me/contacts").unwrap();
    assert!(created.json().get("media").is_none() && created.json().get("uwuRemotePhoto").is_none());
    let put = s.server.seen().into_iter().find(|r| r.method == "PUT").unwrap();
    assert_eq!(put.path(), "/graph/me/contacts/K2/photo/$value");
    assert_eq!(put.header("content-type"), Some("image/gif"));
    assert_eq!(put.body, GIF);

    // Only the photo changes: the contact itself isn't written.
    let mut patch = Map::new();
    patch.insert("media".into(), json!({ "p1": { "kind": "photo", "uri": photo_uri() } }));
    s.engine.update_contact_card("m:K1", patch).await.unwrap();
    assert_eq!(s.server.count("PATCH", "/graph/"), 0);
    assert_eq!(s.server.count("PUT", "/graph/me/contacts/K1/photo"), 1);
    let mut patch = Map::new();
    patch.insert("media".into(), Value::Null);
    patch.insert("notes".into(), json!({ "n1": { "note": "hi" } }));
    s.engine.update_contact_card("m:K1", patch).await.unwrap();
    assert_eq!(s.server.count("PATCH", "/graph/me/contacts/K1"), 1);
    assert_eq!(s.server.count("DELETE", "/graph/me/contacts/K1/photo"), 1);

    // Something that isn't a picture never leaves.
    let mut patch = Map::new();
    patch.insert("media/p1".into(), json!({ "kind": "photo", "uri": "data:image/png;base64,PGh0bWw+" }));
    assert!(s.engine.update_contact_card("m:K1", patch).await.is_err());
    assert_eq!(s.server.count("PUT", "/graph/"), 2);
}

/// Google links the photos of its contacts (the page never loads them itself) and takes new
/// ones through its own photo calls.
#[tokio::test]
async fn google_contact_photos_go_their_own_way() {
    let tokens = Arc::new(AtomicUsize::new(0));
    let full = "https://mail.google.com/ https://www.googleapis.com/auth/contacts";
    let s = setup(AuthKind::Google, "mini@example.com", move |request: &Request| {
        let path = request.path();
        if path == "/token" {
            return token_reply(request, &tokens, Some(full));
        }
        match (request.method.as_str(), path) {
            ("GET", "/people/people/me/connections") => {
                assert!(request.query("personFields").unwrap().contains("photos"));
                Reply::json(json!({ "connections": [
                    { "resourceName": "people/c1", "etag": "e1", "names": [{ "givenName": "Mina" }],
                      "photos": [{ "url": "https://lh3.googleusercontent.com/a/letter", "default": true },
                                 { "url": "https://lh3.googleusercontent.com/a/mina" }] },
                    { "resourceName": "people/c2", "etag": "e2", "names": [{ "givenName": "Otto" }],
                      "photos": [{ "url": "https://tracker.example/pixel.gif" }] }
                ] }))
            }
            ("PATCH", "/people/people/c1:updateContactPhoto") | ("DELETE", "/people/people/c2:deleteContactPhoto") => {
                Reply::json(json!({}))
            }
            _ => Reply::status(404, json!({ "error": { "code": 404, "message": path } })),
        }
    })
    .await;
    let cards = s.engine.contact_cards().await.unwrap();
    let mina = cards.iter().find(|c| c.card["id"] == "m:people/c1").unwrap();
    assert_eq!(mina.card["media"]["p1"]["uri"], "https://lh3.googleusercontent.com/a/mina", "not the drawn letter");
    let otto = cards.iter().find(|c| c.card["id"] == "m:people/c2").unwrap();
    assert!(otto.card.get("media").is_none() && otto.card.get("uwuRemotePhoto").is_none(), "only Google's own host");

    let mut patch = Map::new();
    patch.insert("media/p1".into(), json!({ "kind": "photo", "uri": photo_uri() }));
    s.engine.update_contact_card("m:people/c1", patch).await.unwrap();
    let mut patch = Map::new();
    patch.insert("media".into(), Value::Null);
    s.engine.update_contact_card("m:people/c2", patch).await.unwrap();
    let seen = s.server.seen();
    let photo = seen.iter().find(|r| r.path().ends_with(":updateContactPhoto")).unwrap();
    assert_eq!(photo.json()["photoBytes"], photo_uri().split_once(',').unwrap().1);
    assert_eq!(s.server.count("DELETE", "/people/people/c2:deleteContactPhoto"), 1);
    assert!(!seen.iter().any(|r| r.path() == "/people/people/c1:updateContact"), "the contact itself stays");
}
