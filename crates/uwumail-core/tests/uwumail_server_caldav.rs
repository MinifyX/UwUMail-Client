//! End-to-end test of the CalDAV client against a real UwUMail server's CalDAV (`/dav`), over
//! HTTPS with the server's own (self-signed) certificate, which only this test trusts.
//!
//! Start a server with HTTPS (UwUMail-Server docs/development.md, `UWUMAIL_TLS__MODE=self-signed`,
//! hostname `localhost`), create two accounts, then:
//!
//!   UWUMAIL_TEST_CALDAV=https://localhost:8443 UWUMAIL_TEST_CA=<data dir>/tls/self-signed.crt \
//!   UWUMAIL_TEST_LOGIN=mini@a.test UWUMAIL_TEST_PASSWORD=… \
//!   UWUMAIL_TEST_OTHER_LOGIN=ami@a.test UWUMAIL_TEST_OTHER_PASSWORD=… \
//!   cargo test -p uwumail-core --test uwumail_server_caldav -- --test-threads=1
//!
//! Skipped when `UWUMAIL_TEST_CALDAV` isn't set. Works in calendars of its own and deletes them.

mod support;

use chrono::{DateTime, Utc};
use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject;
use serde_json::json;
use url::Url;
use uwumail_core::ErrorCode;
use uwumail_core::calendar::dav::{self, DavClient};
use uwumail_core::calendar::{ical, jscal};
use uwumail_core::model::*;

struct Server {
    base: Url,
    ca: CertificateDer<'static>,
}

fn server() -> Option<Server> {
    let base = std::env::var("UWUMAIL_TEST_CALDAV").ok().filter(|s| !s.is_empty())?;
    let ca = std::env::var("UWUMAIL_TEST_CA").expect("UWUMAIL_TEST_CA: the server's certificate (PEM)");
    Some(Server {
        base: Url::parse(&base).expect("UWUMAIL_TEST_CALDAV is a URL"),
        ca: CertificateDer::from_pem_file(&ca).expect("a PEM certificate"),
    })
}

fn credentials(prefix: &str) -> Option<(String, String)> {
    let login = std::env::var(format!("UWUMAIL_TEST_{prefix}LOGIN")).ok()?;
    let password = std::env::var(format!("UWUMAIL_TEST_{prefix}PASSWORD")).ok()?;
    Some((login, password))
}

fn client(server: &Server, login: &str, password: &str) -> DavClient {
    let host = server.base.host_str().unwrap();
    DavClient::with_http(support::http_builder(std::slice::from_ref(&server.ca)), login, password, &[host]).unwrap()
}

fn utc(text: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(text).unwrap().to_utc()
}

fn weekly(calendar: &str) -> EventInput {
    EventInput {
        calendar_id: calendar.into(),
        title: "UwUMail CalDAV test".into(),
        description: "made by the client's tests, <b>not</b> HTML".into(),
        location: "Studio 3".into(),
        all_day: false,
        start: "2030-01-03T18:00:00".into(),
        end: "2030-01-03T19:00:00".into(),
        time_zone: Some("Europe/Berlin".into()),
        recurrence: Some(Recurrence {
            frequency: Frequency::Weekly,
            interval: 1,
            by_day: Some(vec![Weekday::Th]),
            until: None,
            count: Some(4),
        }),
    }
}

/// The event as the engine writes a new one over CalDAV.
fn new_object(input: &EventInput, uid: &str) -> String {
    let mut event = jscal::new_event(input).unwrap();
    event.insert("uid".into(), json!(uid));
    ical::from_jscalendar(&json!({ "@type": "Group", "prodId": "-//UwUMail//Calendar//EN", "entries": [event] }))
        .unwrap()
}

/// The occurrences of the one object at `url` in January 2030, in Berlin.
async fn occurrences(client: &DavClient, calendar: &Url, object: &Url) -> Vec<ical::Instance> {
    let objects =
        dav::objects_between(client, calendar, utc("2029-12-31T00:00:00Z"), utc("2030-02-01T00:00:00Z")).await.unwrap();
    let Some(found) = objects.iter().find(|o| o.url.path() == object.path()) else { return Vec::new() };
    let parsed = ical::parse(&found.data).unwrap();
    let group = ical::to_jscalendar(&parsed).unwrap();
    let berlin = "Europe/Berlin".parse().unwrap();
    let mut budget = ical::Budget::default();
    ical::instances(&parsed, &group, utc("2030-01-01T00:00:00Z"), utc("2030-02-01T00:00:00Z"), berlin, &mut budget)
}

#[tokio::test]
async fn events_travel_through_the_servers_caldav() {
    let Some(server) = server() else {
        eprintln!("UWUMAIL_TEST_CALDAV not set, skipping");
        return;
    };
    let (login, password) = credentials("").expect("UWUMAIL_TEST_LOGIN and UWUMAIL_TEST_PASSWORD");
    let client = client(&server, &login, &password);

    // Discovery through /.well-known/caldav, as the engine does it.
    let home = dav::discover_among(&client, &[server.base.join("/.well-known/caldav").unwrap()]).await.unwrap();
    assert!(home.path().contains(&login), "the home is the login's own: {home}");

    let calendar = dav::make_calendar(&client, &home, "UwUMail CalDAV test", Some("#ff66aa")).await.unwrap();
    let listed = dav::calendars(&client, &home).await.unwrap();
    let mine = listed.iter().find(|c| c.url == calendar).expect("the new calendar is listed");
    assert_eq!(mine.name, "UwUMail CalDAV test");
    assert!(mine.writable);
    dav::update_calendar(&client, &calendar, Some("UwUMail CalDAV test, renamed"), Some(Some("#3366ff")))
        .await
        .unwrap();
    let listed = dav::calendars(&client, &home).await.unwrap();
    assert!(listed.iter().any(|c| c.url == calendar && c.name == "UwUMail CalDAV test, renamed"));

    // A weekly series with four occurrences.
    let uid = uuid::Uuid::new_v4().to_string();
    let object = calendar.join(&format!("{uid}.ics")).unwrap();
    dav::put_object(&client, &object, &new_object(&weekly(calendar.path()), &uid), None).await.unwrap();
    let found = occurrences(&client, &calendar, &object).await;
    assert_eq!(found.len(), 4, "a weekly series with four occurrences");
    // 18:00 in Berlin is 17:00 UTC in January.
    assert_eq!(found[0].time.utc.unwrap().0, utc("2030-01-03T17:00:00Z"));
    assert_eq!(found[0].event["description"], json!("made by the client's tests, <b>not</b> HTML"));
    let (rule, editable) = jscal::recurrence_of(&found[0].series);
    assert!(editable);
    assert_eq!(rule.unwrap().count, Some(4));
    // Creating it again doesn't overwrite it.
    assert!(dav::put_object(&client, &object, &new_object(&weekly(calendar.path()), &uid), None).await.is_err());

    // Changing it: only with the version read.
    let current = dav::get_object(&client, &object).await.unwrap();
    let mut group = ical::to_jscalendar(&ical::parse(&current.data).unwrap()).unwrap();
    let event = ical::events_mut(&mut group).next().unwrap();
    let mut changed = weekly(calendar.path());
    changed.title = "UwUMail CalDAV test, longer".into();
    changed.end = "2030-01-03T19:30:00".into();
    let patch = jscal::patch_for(event, &changed, None).unwrap();
    assert_eq!(patch.len(), 2, "title and duration only: {patch:?}");
    jscal::apply_patch(event, &patch).unwrap();
    let text = ical::from_jscalendar(&group).unwrap();
    dav::put_object(&client, &object, &text, current.etag.as_deref()).await.unwrap();
    let stale = dav::put_object(&client, &object, &text, Some("\"not-the-etag\"")).await.unwrap_err();
    assert_eq!(stale.code, ErrorCode::InvalidInput, "{}", stale.message);
    let found = occurrences(&client, &calendar, &object).await;
    assert_eq!(found[0].event["title"], json!("UwUMail CalDAV test, longer"));

    // One occurrence goes (an EXDATE), the series stays.
    let second = found[1].recurrence_id.clone().unwrap();
    let current = dav::get_object(&client, &object).await.unwrap();
    let mut group = ical::to_jscalendar(&ical::parse(&current.data).unwrap()).unwrap();
    let event = ical::events_mut(&mut group).next().unwrap();
    let mut exclude = serde_json::Map::new();
    exclude.insert(format!("recurrenceOverrides/{}", jscal::pointer_segment(&second)), json!({ "excluded": true }));
    jscal::apply_patch(event, &exclude).unwrap();
    dav::put_object(&client, &object, &ical::from_jscalendar(&group).unwrap(), current.etag.as_deref()).await.unwrap();
    let stored = dav::get_object(&client, &object).await.unwrap();
    assert!(stored.data.contains("EXDATE"), "{}", stored.data);
    let found = occurrences(&client, &calendar, &object).await;
    assert_eq!(found.len(), 3);
    assert!(found.iter().all(|instance| instance.recurrence_id.as_deref() != Some(second.as_str())));

    // Deleting: the event, then the calendar; deleting again is fine.
    let current = dav::get_object(&client, &object).await.unwrap();
    dav::delete(&client, &object, current.etag.as_deref()).await.unwrap();
    assert!(occurrences(&client, &calendar, &object).await.is_empty());
    dav::delete(&client, &object, None).await.unwrap();
    dav::delete(&client, &calendar, None).await.unwrap();
    assert!(!dav::calendars(&client, &home).await.unwrap().iter().any(|c| c.url == calendar));
}

/// One login can't read, change or delete another's calendars, even with the exact address.
#[tokio::test]
async fn another_logins_calendars_stay_closed() {
    let Some(server) = server() else {
        eprintln!("UWUMAIL_TEST_CALDAV not set, skipping");
        return;
    };
    let (login, password) = credentials("").expect("UWUMAIL_TEST_LOGIN and UWUMAIL_TEST_PASSWORD");
    let Some((other_login, other_password)) = credentials("OTHER_") else {
        eprintln!("UWUMAIL_TEST_OTHER_LOGIN not set, skipping");
        return;
    };
    let mine = client(&server, &login, &password);
    let theirs = client(&server, &other_login, &other_password);
    let start = [server.base.join("/.well-known/caldav").unwrap()];
    let their_home = dav::discover_among(&theirs, &start).await.unwrap();
    let their_calendar = dav::make_calendar(&theirs, &their_home, "Private", None).await.unwrap();
    let uid = uuid::Uuid::new_v4().to_string();
    let their_object = their_calendar.join(&format!("{uid}.ics")).unwrap();
    dav::put_object(&theirs, &their_object, &new_object(&weekly(their_calendar.path()), &uid), None).await.unwrap();

    let refused = |result: Result<(), uwumail_core::Error>, what: &str| {
        let error = result.expect_err(what);
        assert!(
            matches!(error.code, ErrorCode::InvalidInput | ErrorCode::NotFound | ErrorCode::AuthFailed),
            "{what}: {error:?}"
        );
    };
    refused(dav::calendars(&mine, &their_home).await.map(|_| ()), "listing their calendars");
    refused(
        dav::objects_between(&mine, &their_calendar, utc("2030-01-01T00:00:00Z"), utc("2030-02-01T00:00:00Z"))
            .await
            .map(|_| ()),
        "reading their events",
    );
    refused(dav::get_object(&mine, &their_object).await.map(|_| ()), "reading their event");
    let overwrite = new_object(&weekly(their_calendar.path()), &uid).replace("UwUMail CalDAV test", "Changed");
    refused(dav::put_object(&mine, &their_object, &overwrite, None).await.map(|_| ()), "writing into their calendar");
    refused(dav::update_calendar(&mine, &their_calendar, Some("Renamed"), None).await, "renaming their calendar");
    // Deleting answers 404 for what the login can't see, which counts as gone: check it's still there.
    let _ = dav::delete(&mine, &their_object, None).await;
    let _ = dav::delete(&mine, &their_calendar, None).await;
    let still = dav::get_object(&theirs, &their_object).await.expect("their event is still there");
    assert!(still.data.contains("UwUMail CalDAV test"));
    assert!(!still.data.contains("Changed"));

    dav::delete(&theirs, &their_calendar, None).await.unwrap();
}
