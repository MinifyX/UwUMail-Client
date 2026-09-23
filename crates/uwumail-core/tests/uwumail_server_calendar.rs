//! End-to-end tests of mail rules (JMAP Sieve) and JMAP calendars against a real UwUMail server.
//!
//! Start a server like for `uwumail_server.rs` (UwUMail-Server docs/development.md, "Without
//! Docker", `UWUMAIL_LISTEN__PROXY=127.0.0.1:18080`), create an account, then:
//!
//!   UWUMAIL_TEST_SERVER=http://127.0.0.1:18080 UWUMAIL_TEST_LOGIN=mini@a.test \
//!   UWUMAIL_TEST_PASSWORD=… cargo test -p uwumail-core --test uwumail_server_calendar -- --test-threads=1
//!
//! Skipped when `UWUMAIL_TEST_SERVER` isn't set, or when the server doesn't offer the extension.
//! The rules test puts back the script it found; the calendar test works in a calendar of its own
//! and deletes it again.

use serde_json::{Value, json};
use uwumail_core::calendar::{jmap_cal, jscal};
use uwumail_core::jmap::Client;
use uwumail_core::jmap_sieve;
use uwumail_core::model::*;

async fn client() -> Option<Client> {
    let url = std::env::var("UWUMAIL_TEST_SERVER").ok()?;
    let login = std::env::var("UWUMAIL_TEST_LOGIN").expect("UWUMAIL_TEST_LOGIN");
    let password = std::env::var("UWUMAIL_TEST_PASSWORD").expect("UWUMAIL_TEST_PASSWORD");
    let session = format!("{}/.well-known/jmap", url.trim_end_matches('/'));
    let http = reqwest::Client::builder().build().unwrap();
    Some(Client::connect(&http, &session, &login, &password).await.expect("sign in"))
}

#[tokio::test]
async fn mail_rules_travel_through_the_server() {
    let Some(client) = client().await else {
        eprintln!("UWUMAIL_TEST_SERVER not set, skipping");
        return;
    };
    if client.session.sieve_account_id.is_none() {
        eprintln!("The server has no JMAP Sieve, skipping");
        return;
    }
    let before = jmap_sieve::load(&client).await.unwrap();

    let script =
        "# uwumail test\nrequire [\"fileinto\"];\nif header :contains \"subject\" \"[test]\" {\n    keep;\n}\n";
    assert_eq!(jmap_sieve::validate(&client, script).await.unwrap(), None);
    let broken = jmap_sieve::validate(&client, "if header :contains {").await.unwrap();
    assert!(broken.is_some(), "a broken script is refused");

    jmap_sieve::save(&client, script).await.unwrap();
    let saved = jmap_sieve::load(&client).await.unwrap();
    assert_eq!(saved.script.as_deref(), Some(script));
    assert!(saved.active);
    assert!(jmap_sieve::save(&client, "if header :contains {").await.is_err());

    if let Some(previous) = before.script {
        jmap_sieve::save(&client, &previous).await.unwrap();
    }
}

fn input(calendar: &str, start: &str, end: &str) -> EventInput {
    EventInput {
        calendar_id: calendar.into(),
        title: "UwUMail test".into(),
        description: "made by the client's tests".into(),
        location: "Studio 3".into(),
        all_day: false,
        start: start.into(),
        end: end.into(),
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

#[tokio::test]
async fn calendar_events_travel_through_the_server() {
    let Some(client) = client().await else {
        eprintln!("UWUMAIL_TEST_SERVER not set, skipping");
        return;
    };
    if client.session.calendar_account_id.is_none() {
        eprintln!("The server has no JMAP calendars, skipping");
        return;
    }
    let calendar = jmap_cal::create_calendar(&client, "UwUMail test", Some("#ff66aa")).await.unwrap();
    let listed = jmap_cal::calendars(&client).await.unwrap();
    assert!(listed.iter().any(|c| c.id == calendar && c.color.as_deref() == Some("#ff66aa")));

    let event = jscal::new_event(&input(&calendar, "2030-01-03T18:00:00", "2030-01-03T19:00:00")).unwrap();
    let id = jmap_cal::create_event(&client, &calendar, event).await.unwrap();
    let mine = |instances: Vec<jmap_cal::JmapInstance>| -> Vec<jmap_cal::JmapInstance> {
        instances
            .into_iter()
            .filter(|i| {
                i.event.get("baseEventId").and_then(Value::as_str).unwrap_or_default() == id
                    || i.event.get("id").and_then(Value::as_str) == Some(id.as_str())
            })
            .collect()
    };
    let found = mine(
        jmap_cal::occurrences(&client, "2030-01-01T00:00:00", "2030-02-01T00:00:00", "Europe/Berlin").await.unwrap(),
    );
    assert_eq!(found.len(), 4, "a weekly series with four occurrences");
    let (rule, editable) = jscal::recurrence_of(found[0].base.as_ref().unwrap());
    assert!(editable);
    assert_eq!(rule.unwrap().count, Some(4));
    // 18:00 in Berlin is 17:00 UTC in January.
    assert_eq!(found[0].utc.unwrap().0.to_rfc3339(), "2030-01-03T17:00:00+00:00");

    let current = jmap_cal::event(&client, &id).await.unwrap();
    let mut changed = input(&calendar, "2030-01-03T18:00:00", "2030-01-03T19:30:00");
    changed.title = "UwUMail test, longer".into();
    let patch = jscal::patch_for(&current, &changed, None).unwrap();
    assert_eq!(patch.len(), 2, "title and duration only: {patch:?}");
    jmap_cal::update_event(&client, &id, patch).await.unwrap();

    // One occurrence goes, the series stays.
    let second = found[1].event.get("id").and_then(Value::as_str).unwrap().to_string();
    jmap_cal::destroy_event(&client, &second).await.unwrap();
    let found = mine(
        jmap_cal::occurrences(&client, "2030-01-01T00:00:00", "2030-02-01T00:00:00", "Europe/Berlin").await.unwrap(),
    );
    assert_eq!(found.len(), 3);
    assert_eq!(found[0].event["title"], json!("UwUMail test, longer"));
    assert_eq!(jmap_cal::base_of(&client, found[0].event["id"].as_str().unwrap()).await.unwrap(), id);
    jmap_cal::delete_calendar(&client, &calendar).await.unwrap();
}
