//! End-to-end test of the settings sync against a real UwUMail server
//! (`urn:uwumail:jmap:settings`, UwUMail-Server docs/jmap-settings.md).
//!
//! Start a server (UwUMail-Server docs/development.md, "Without Docker", with
//! `UWUMAIL_LISTEN__PROXY=127.0.0.1:18080` for plain HTTP), create an account, then:
//!
//!   UWUMAIL_TEST_SERVER=http://127.0.0.1:18080 UWUMAIL_TEST_LOGIN=mini@a.test \
//!   UWUMAIL_TEST_PASSWORD=… cargo test -p uwumail-core --test uwumail_server -- --test-threads=1
//!
//! Skipped when `UWUMAIL_TEST_SERVER` isn't set. The test changes the account's settings and
//! puts back what it found.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};
use uwumail_core::jmap::Client;
use uwumail_core::jmap_settings;
use uwumail_core::model::*;
use uwumail_core::secrets::MemorySecrets;
use uwumail_core::{Engine, EngineOptions};

fn server() -> Option<(String, String, String)> {
    let url = std::env::var("UWUMAIL_TEST_SERVER").ok()?;
    let login = std::env::var("UWUMAIL_TEST_LOGIN").expect("UWUMAIL_TEST_LOGIN");
    let password = std::env::var("UWUMAIL_TEST_PASSWORD").expect("UWUMAIL_TEST_PASSWORD");
    Some((format!("{}/.well-known/jmap", url.trim_end_matches('/')), login, password))
}

fn changes(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs.iter().map(|(key, value)| ((*key).to_string(), value.clone())).collect()
}

#[tokio::test]
async fn settings_travel_through_the_server() {
    let Some((url, login, password)) = server() else {
        eprintln!("UWUMAIL_TEST_SERVER not set, skipping");
        return;
    };
    let http = reqwest::Client::builder().build().unwrap();
    let client = Client::connect(&http, &url, &login, &password).await.expect("sign in");
    assert!(client.session.user_settings, "the server offers urn:uwumail:jmap:settings");

    let before = jmap_settings::load(&client).await.expect("read the settings");
    let theme = before.values.get("theme").cloned().unwrap_or(json!("system"));
    let other_theme = if theme == json!("dark") { "light" } else { "dark" };

    // Push: a write shows up as a StateChange for UserSettings with the new state.
    let mut push = client.push().await.expect("open push").expect("the server offers push");

    let entry = "trustedSenders:@sync-test.example";
    let saved = jmap_settings::save(
        &client,
        &changes(&[("theme", json!(other_theme)), (entry, json!(true)), ("linkDomains:intranet", json!(true))]),
        Some(&before.state),
    )
    .await
    .expect("write");
    assert!(saved.ok, "{saved:?}");
    let state = saved.state.clone().expect("a new state");
    assert_ne!(state, before.state);

    let change = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let change = push.changed().await.expect("push");
            if change.state_of("UserSettings").is_some() {
                return change;
            }
        }
    })
    .await
    .expect("a push for the settings");
    assert_eq!(change.state_of("UserSettings"), Some(state.as_str()));

    let after = jmap_settings::load(&client).await.unwrap();
    assert_eq!(after.state, state);
    assert_eq!(after.values.get("theme"), Some(&json!(other_theme)));
    assert_eq!(after.values.get(entry), Some(&json!(true)));

    // A write that lost a race says so instead of overwriting.
    let raced =
        jmap_settings::save(&client, &changes(&[("tone", json!("neutral"))]), Some(&before.state)).await.unwrap();
    assert_eq!(raced.kind.as_deref(), Some("stateMismatch"));

    // One refused key and nothing of the write is kept; the refused keys come back by name.
    let refused = jmap_settings::save(
        &client,
        &changes(&[("tone", json!("neutral")), ("trustedSenders:@localhost", json!(true)), ("colour", json!("pink"))]),
        None,
    )
    .await
    .unwrap();
    assert_eq!(refused.kind.as_deref(), Some("invalidProperties"));
    let mut named = refused.properties.clone();
    named.sort();
    assert_eq!(named, vec!["colour".to_string(), "trustedSenders:@localhost".to_string()]);
    assert_eq!(jmap_settings::load(&client).await.unwrap().values.get("tone"), before.values.get("tone"));

    // Signatures go whole.
    let signature =
        json!({ "email": "", "name": "Sync-Test", "html": "<p>Mini</p>", "forNew": false, "forReplies": false });
    let stored =
        jmap_settings::save(&client, &changes(&[("signature:sync-test", signature.clone())]), None).await.unwrap();
    assert!(stored.ok, "{stored:?}");
    assert_eq!(jmap_settings::load(&client).await.unwrap().values.get("signature:sync-test"), Some(&signature));

    // Put back what was there.
    let restored = jmap_settings::save(
        &client,
        &changes(&[
            ("theme", theme),
            (entry, Value::Null),
            ("linkDomains:intranet", before.values.get("linkDomains:intranet").cloned().unwrap_or(Value::Null)),
            ("signature:sync-test", Value::Null),
        ]),
        None,
    )
    .await
    .unwrap();
    assert!(restored.ok, "{restored:?}");
}

/// The engine finds the account, carries reads and writes, and tells the page when another
/// device changed the settings.
#[tokio::test(flavor = "multi_thread")]
async fn the_engine_reports_settings_changes() {
    let Some((url, login, password)) = server() else {
        eprintln!("UWUMAIL_TEST_SERVER not set, skipping");
        return;
    };
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::new(EngineOptions {
        data_dir: data.path().to_path_buf(),
        secrets: Arc::new(MemorySecrets::default()),
        open_url: Arc::new(|_| {}),
    })
    .unwrap();
    let mut events = engine.subscribe();
    let no_server = ServerSettings { host: String::new(), port: 0, security: Security::Tls };
    let account = engine
        .add_account(NewAccount {
            display_name: "Mini".into(),
            email: login.clone(),
            auth: AuthKind::Password,
            password: Some(password.clone()),
            imap: no_server.clone(),
            smtp: no_server,
            username: login.clone(),
            color: AccountColor::Pink,
            protocol: Protocol::Jmap,
            jmap_url: Some(url.clone()),
            sign_in_as: None,
        })
        .await
        .expect("add the account");
    assert_eq!(engine.settings_sync_accounts().await.unwrap(), vec![account.id.clone()]);

    let before = engine.user_settings(&account.id).await.unwrap();
    // Once push is up, the engine asks the page to read the settings (a queue may wait).
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Ok(EngineEvent::SettingsChanged { account_id, .. }) = events.recv().await
                && account_id == account.id
            {
                return;
            }
        }
    })
    .await
    .expect("a settings event once push is up");

    // Another device writes.
    let http = reqwest::Client::builder().build().unwrap();
    let other = Client::connect(&http, &url, &login, &password).await.unwrap();
    let key = "linkDomains:engine-test.example";
    let saved = jmap_settings::save(&other, &changes(&[(key, json!(true))]), None).await.unwrap();
    let state = saved.state.expect("a new state");
    let reported = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Ok(EngineEvent::SettingsChanged { account_id, state: Some(state) }) = events.recv().await
                && account_id == account.id
            {
                return state;
            }
        }
    })
    .await
    .expect("a settings event with the new state");
    assert_eq!(reported, state);

    let seen = engine.user_settings(&account.id).await.unwrap();
    assert_eq!(seen.values.get(key), Some(&json!(true)));
    let removed =
        engine.save_user_settings(&account.id, &changes(&[(key, Value::Null)]), Some(&seen.state)).await.unwrap();
    assert!(removed.ok, "{removed:?}");
    assert_eq!(engine.user_settings(&account.id).await.unwrap().values.get(key), before.values.get(key));
}
