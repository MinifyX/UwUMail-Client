//! JMAP push through a push service: a PushSubscription (RFC 8620 §7.2) makes the mail server POST
//! its StateChange objects to a Web Push endpoint instead of UwUMail keeping a connection open. The
//! messages are encrypted for this device (RFC 8291, aes128gcm) and signed for the push service
//! with the key the server announces in its session (VAPID, RFC 8292, as
//! `urn:ietf:params:jmap:webpush-vapid`). Only servers that announce that key get a subscription;
//! UwUMail Server does from 0.14 on. Other servers keep the push connection as before.
//!
//! The endpoint and the Web Push keys come from the platform: on Android the UnifiedPush connector
//! makes the keys, registers with the distributor and decrypts what arrives. This module builds the
//! requests and reads the messages; the engine keeps one subscription per account
//! (`engine/push_ops.rs`).

use std::collections::HashMap;

use base64::Engine as _;
use chrono::{DateTime, Duration as TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::jmap::{self, Client, StateChange};

/// How long a subscription is asked to last. Servers may shorten it, to no less than 48 hours.
pub const LIFETIME: TimeDelta = TimeDelta::days(7);
/// A subscription is renewed about once a day ...
const RENEW_EVERY: TimeDelta = TimeDelta::hours(20);
/// ... and whenever it would end within this, but not more than once an hour.
const RENEW_BEFORE_END: TimeDelta = TimeDelta::days(1);
const RENEW_AT_MOST: TimeDelta = TimeDelta::hours(1);
/// A verification that hasn't come this long after the subscription was made isn't coming. Each
/// time that happens again, the next attempt waits twice as long, up to a day.
const VERIFICATION_WAIT: TimeDelta = TimeDelta::minutes(10);
const VERIFICATION_WAIT_MAX: TimeDelta = TimeDelta::days(1);
/// JMAP push messages are small objects; anything bigger isn't one.
const MAX_MESSAGE: usize = 64 * 1024;
/// Names this app in `deviceClientId`, as RFC 8620 asks.
const VENDOR: &str = "app.uwumail";

/// Where the push service takes messages for this device, and the Web Push keys the server
/// encrypts them with (RFC 8291), base64url like the connector hands them over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub url: String,
    /// The device's P-256 public key, uncompressed.
    pub p256dh: String,
    /// The authentication secret, 16 bytes.
    pub auth: String,
}

fn base64url(text: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(text.trim().trim_end_matches('=')).ok()
}

impl Endpoint {
    /// Refuses what a JMAP server must not be given: an address that isn't HTTPS (RFC 8620), or
    /// keys that aren't Web Push keys.
    pub fn check(&self) -> Result<()> {
        let url = url::Url::parse(self.url.trim()).map_err(|_| Error::invalid("The push address isn't one."))?;
        if url.scheme() != "https" || url.host_str().is_none_or(str::is_empty) {
            return Err(Error::invalid("The push address has to start with https://."));
        }
        let key = base64url(&self.p256dh).filter(|key| key.len() == 65 && key[0] == 4);
        let auth = base64url(&self.auth).filter(|auth| auth.len() == 16);
        if key.is_none() || auth.is_none() {
            return Err(Error::invalid("The push keys aren't Web Push keys."));
        }
        Ok(())
    }
}

/// An account whose server takes push subscriptions over Web Push, for registering with the push
/// service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub account_id: String,
    pub email: String,
    /// The key the push service has to accept the server's messages with (VAPID, RFC 8292).
    pub vapid_key: String,
}

/// How many accounts get new mail through the push service.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// With a confirmed subscription.
    pub active: usize,
    /// Subscribed, waiting for the server's verification.
    pub waiting: usize,
    /// Without push: IMAP, or a server without push subscriptions.
    pub other: usize,
}

impl Overview {
    /// Whether every account gets new mail through the push service, so nothing else has to wait
    /// for it.
    pub fn covers_all(&self) -> bool {
        self.waiting == 0 && self.other == 0
    }
}

/// The push subscription UwUMail keeps for one account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub device_client_id: String,
    pub endpoint: Endpoint,
    /// The server's VAPID key when the subscription was made. Another one later means the push
    /// service will refuse the server's messages, so the subscription has to be made again.
    pub vapid_key: Option<String>,
    pub id: String,
    /// When the server said the subscription ends.
    pub expires: Option<String>,
    /// The verification code went back to the server, so it pushes to the endpoint.
    pub verified: bool,
    /// Unix seconds of the creation or last renewal.
    pub renewed_at: i64,
    /// How many subscriptions for this endpoint in a row never got their verification.
    #[serde(default)]
    pub lost: u32,
}

impl Subscription {
    /// Whether the server's verification should have come by now but didn't, e.g. because the
    /// push service refused it. The subscription is then made again.
    pub fn verification_lost(&self, now: DateTime<Utc>) -> bool {
        let wait = VERIFICATION_WAIT.checked_mul(1 << self.lost.min(10)).unwrap_or(VERIFICATION_WAIT_MAX);
        !self.verified
            && now - DateTime::from_timestamp(self.renewed_at, 0).unwrap_or_default() > wait.min(VERIFICATION_WAIT_MAX)
    }

    /// Whether the subscription should be renewed now.
    pub fn renewal_due(&self, now: DateTime<Utc>) -> bool {
        let renewed = DateTime::from_timestamp(self.renewed_at, 0).unwrap_or_default();
        let since = now - renewed;
        let ends = self
            .expires
            .as_deref()
            .and_then(|expires| DateTime::parse_from_rfc3339(expires).ok())
            .map(|expires| expires.with_timezone(&Utc));
        since >= RENEW_EVERY || (since >= RENEW_AT_MOST && ends.is_none_or(|ends| ends - now < RENEW_BEFORE_END))
    }
}

/// The `deviceClientId` for one account on one installation. RFC 8620 asks for a hash of a device
/// id and an app id, so the id itself never reaches the server.
pub fn device_client_id(install_id: &str, account_id: &str) -> String {
    let digest = Sha256::digest(format!("{VENDOR}\n{install_id}\n{account_id}").as_bytes());
    digest[..16].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A JMAP `UTCDate`.
pub fn utc_date(time: DateTime<Utc>) -> String {
    time.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// `PushSubscription/set` arguments that create a subscription (creation id `push`). Every type is
/// pushed: the engine sorts out what is mail and what is settings, calendars or contacts.
pub fn create_arguments(device_client_id: &str, endpoint: &Endpoint, expires: &str) -> Value {
    json!({
        "create": {
            "push": {
                "deviceClientId": device_client_id,
                "url": endpoint.url.trim(),
                "keys": { "p256dh": endpoint.p256dh.trim(), "auth": endpoint.auth.trim() },
                "expires": expires,
                "types": null,
            }
        }
    })
}

/// `PushSubscription/set` arguments that hand the server the code from its PushVerification.
pub fn verify_arguments(id: &str, code: &str) -> Value {
    json!({ "update": { id: { "verificationCode": code } } })
}

/// `PushSubscription/set` arguments that move a subscription's end.
pub fn renew_arguments(id: &str, expires: &str) -> Value {
    json!({ "update": { id: { "expires": expires } } })
}

pub fn destroy_arguments(ids: &[String]) -> Value {
    json!({ "destroy": ids })
}

/// What a push message says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    /// Sent once after a subscription was created; the code has to go back to the server.
    Verification { subscription_id: String, code: String },
    /// New states per account and type (RFC 8620 §7.1).
    StateChange(HashMap<String, HashMap<String, String>>),
}

/// Reads a decrypted push message.
pub fn parse_message(body: &[u8]) -> Result<Message> {
    let unreadable = || Error::invalid("The push message isn't a JMAP push object.");
    if body.len() > MAX_MESSAGE {
        return Err(unreadable());
    }
    let document: Map<String, Value> = serde_json::from_slice(body).map_err(|_| unreadable())?;
    let text = |key: &str| document.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
    match text("@type") {
        Some("PushVerification") => Ok(Message::Verification {
            subscription_id: text("pushSubscriptionId").ok_or_else(unreadable)?.to_string(),
            code: text("verificationCode").ok_or_else(unreadable)?.to_string(),
        }),
        Some("StateChange") => {
            let changed = document.get("changed").and_then(Value::as_object).ok_or_else(unreadable)?;
            Ok(Message::StateChange(
                changed
                    .iter()
                    .map(|(account, types)| {
                        let states = types
                            .as_object()
                            .into_iter()
                            .flatten()
                            .filter_map(|(kind, state)| Some((kind.clone(), state.as_str()?.to_string())))
                            .collect();
                        (account.clone(), states)
                    })
                    .collect(),
            ))
        }
        _ => Err(unreadable()),
    }
}

/// What changed for a login whose accounts are `account_ids`, or `None` when the push is about
/// none of them.
pub fn state_change_for(
    changed: &HashMap<String, HashMap<String, String>>,
    account_ids: &[&str],
) -> Option<StateChange> {
    let mut types = HashMap::new();
    let mut named = false;
    for id in account_ids {
        if let Some(states) = changed.get(*id) {
            named = true;
            types.extend(states.iter().map(|(kind, state)| (kind.clone(), state.clone())));
        }
    }
    named.then_some(StateChange { types: Some(types) })
}

/// The ids of the subscriptions made under `device_client_id` by this login.
pub async fn ours(client: &Client, device_client_id: &str) -> Result<Vec<String>> {
    let responses = client
        .call(vec![("PushSubscription/get", json!({ "ids": null, "properties": ["id", "deviceClientId"] }))])
        .await?;
    Ok(responses
        .get(0, "PushSubscription/get")?
        .get("list")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("deviceClientId").and_then(Value::as_str) == Some(device_client_id))
        .filter_map(|item| item.get("id").and_then(Value::as_str).map(String::from))
        .collect())
}

/// Creates a subscription and returns its id and the end the server set.
pub async fn create(
    client: &Client,
    device_client_id: &str,
    endpoint: &Endpoint,
    expires: &str,
) -> Result<(String, Option<String>)> {
    let arguments = create_arguments(device_client_id, endpoint, expires);
    let responses = client.call(vec![("PushSubscription/set", arguments)]).await?;
    let answer = responses.get(0, "PushSubscription/set")?;
    let Some(created) = answer.pointer("/created/push") else {
        return Err(jmap::set_errors(answer)
            .map(Error::from)
            .unwrap_or_else(|| Error::internal("The mail server didn't make the push subscription.")));
    };
    let id = created
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::internal("The mail server didn't say which push subscription it made."))?;
    let expires = created.get("expires").and_then(Value::as_str).map(String::from);
    Ok((id.to_string(), expires))
}

/// Hands the server the code from its PushVerification, after which it pushes to the endpoint.
pub async fn verify(client: &Client, id: &str, code: &str) -> Result<()> {
    let responses = client.call(vec![("PushSubscription/set", verify_arguments(id, code))]).await?;
    match jmap::set_errors(responses.get(0, "PushSubscription/set")?) {
        Some(error) => Err(error.into()),
        None => Ok(()),
    }
}

/// How a renewal went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Renewal {
    /// With the end the server set, if it said.
    Renewed(Option<String>),
    /// The server doesn't have the subscription anymore.
    Gone,
}

pub async fn renew(client: &Client, id: &str, expires: &str) -> Result<Renewal> {
    let responses = client.call(vec![("PushSubscription/set", renew_arguments(id, expires))]).await?;
    let answer = responses.get(0, "PushSubscription/set")?;
    match jmap::set_errors(answer) {
        Some(error) if error.kind == "notFound" => Ok(Renewal::Gone),
        Some(error) => Err(error.into()),
        None => Ok(Renewal::Renewed(
            answer
                .pointer(&format!("/updated/{}", id.replace('~', "~0").replace('/', "~1")))
                .and_then(|updated| updated.get("expires").and_then(Value::as_str).map(String::from)),
        )),
    }
}

/// Destroys subscriptions; ones already gone count as destroyed.
pub async fn destroy(client: &Client, ids: &[String]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let responses = client.call(vec![("PushSubscription/set", destroy_arguments(ids))]).await?;
    match jmap::set_errors(responses.get(0, "PushSubscription/set")?) {
        Some(error) if error.kind != "notFound" => Err(error.into()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint() -> Endpoint {
        let key = [&[4u8][..], &[7u8; 64][..]].concat();
        Endpoint {
            url: "https://push.uwumail.test/up/AbC?x=1".into(),
            p256dh: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key),
            auth: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([9u8; 16]),
        }
    }

    #[test]
    fn builds_the_subscription_requests() {
        let endpoint = endpoint();
        let device = device_client_id("install-1", "account-1");
        let create = create_arguments(&device, &endpoint, "2026-10-04T12:00:00Z");
        assert_eq!(
            create,
            json!({ "create": { "push": {
                "deviceClientId": device,
                "url": "https://push.uwumail.test/up/AbC?x=1",
                "keys": { "p256dh": endpoint.p256dh, "auth": endpoint.auth },
                "expires": "2026-10-04T12:00:00Z",
                "types": null,
            } } })
        );
        assert!(create.get("accountId").is_none(), "push subscriptions belong to no account");
        assert_eq!(
            verify_arguments("P43", "da1f097b"),
            json!({ "update": { "P43": { "verificationCode": "da1f097b" } } })
        );
        assert_eq!(
            renew_arguments("P43", "2026-10-11T00:00:00Z"),
            json!({ "update": { "P43": { "expires": "2026-10-11T00:00:00Z" } } })
        );
        assert_eq!(destroy_arguments(&["P43".into()]), json!({ "destroy": ["P43"] }));
        let time = DateTime::parse_from_rfc3339("2026-09-27T08:05:09.5+02:00").unwrap().with_timezone(&Utc);
        assert_eq!(utc_date(time), "2026-09-27T06:05:09Z");
    }

    #[test]
    fn device_ids_are_stable_hashes_per_installation_and_account() {
        let id = device_client_id("install-1", "account-1");
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(id, device_client_id("install-1", "account-1"));
        assert_ne!(id, device_client_id("install-1", "account-2"));
        assert_ne!(id, device_client_id("install-2", "account-1"));
        assert!(!id.contains("install"));
    }

    #[test]
    fn refuses_endpoints_a_server_must_not_get() {
        assert!(endpoint().check().is_ok());
        let plain = Endpoint { url: "http://push.uwumail.test/up".into(), ..endpoint() };
        assert!(plain.check().is_err());
        let short = Endpoint { auth: "c2hvcnQ".into(), ..endpoint() };
        assert!(short.check().is_err());
        let compressed =
            Endpoint { p256dh: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([2u8; 33]), ..endpoint() };
        assert!(compressed.check().is_err());
        let padded = Endpoint { auth: format!("{}==", endpoint().auth), ..endpoint() };
        assert!(padded.check().is_ok());
    }

    #[test]
    fn reads_a_push_verification() {
        let body = br#"{
            "@type": "PushVerification",
            "pushSubscriptionId": "P43dcfa4-1dd4-41ef-9156-2c89b3b19c60",
            "verificationCode": "da1f097b11ca17f06424e30bf02bfa67"
        }"#;
        assert_eq!(
            parse_message(body).unwrap(),
            Message::Verification {
                subscription_id: "P43dcfa4-1dd4-41ef-9156-2c89b3b19c60".into(),
                code: "da1f097b11ca17f06424e30bf02bfa67".into(),
            }
        );
        let without_code = br#"{ "@type": "PushVerification", "pushSubscriptionId": "P43" }"#;
        assert!(parse_message(without_code).is_err());
    }

    #[test]
    fn reads_a_state_change() {
        let body = br#"{
            "@type": "StateChange",
            "changed": {
                "a3123": { "Email": "d35ecb040aab", "EmailDelivery": "428d565f2440", "CalendarEvent": "87accfac587a" },
                "a43461d": { "Mailbox": "0af7a512ce70", "CalendarEvent": "7a4297cecd76" }
            }
        }"#;
        let Message::StateChange(changed) = parse_message(body).unwrap() else { panic!("expected a state change") };
        assert_eq!(changed["a3123"]["Email"], "d35ecb040aab");
        assert_eq!(changed["a43461d"].len(), 2);

        let mail = state_change_for(&changed, &["a3123"]).unwrap();
        assert_eq!(mail.state_of("EmailDelivery"), Some("428d565f2440"));
        assert!(mail.may_have_changed("Email") && !mail.may_have_changed("Mailbox"));
        // A login whose calendars live in another account hears about both.
        let both = state_change_for(&changed, &["a3123", "a43461d"]).unwrap();
        assert!(both.may_have_changed("Mailbox") && both.may_have_changed("Email"));
        // A push about other accounts of the login is nothing for this one.
        assert!(state_change_for(&changed, &["b1"]).is_none());
    }

    #[test]
    fn refuses_what_isnt_a_push_object() {
        assert!(parse_message(b"not json").is_err());
        assert!(parse_message(br#"{ "@type": "Something" }"#).is_err());
        assert!(parse_message(br#"{ "@type": "StateChange" }"#).is_err());
        assert!(parse_message(br#"[1, 2]"#).is_err());
        let huge = format!(r#"{{ "@type": "StateChange", "changed": {{}}, "pad": "{}" }}"#, "x".repeat(MAX_MESSAGE));
        assert!(parse_message(huge.as_bytes()).is_err());
        // Unknown extra types and odd states don't stop the rest from being read.
        let odd = br#"{ "@type": "StateChange", "changed": { "a1": { "Email": "s2", "Weird": 5 }, "a2": null } }"#;
        let Message::StateChange(changed) = parse_message(odd).unwrap() else { panic!("expected a state change") };
        assert_eq!(changed["a1"].len(), 1);
        assert!(changed["a2"].is_empty());
    }

    #[test]
    fn renews_about_daily_and_before_the_end() {
        let now = DateTime::parse_from_rfc3339("2026-09-27T12:00:00Z").unwrap().with_timezone(&Utc);
        let subscription = |renewed: TimeDelta, expires: Option<&str>| Subscription {
            device_client_id: "d".into(),
            endpoint: endpoint(),
            vapid_key: None,
            id: "P1".into(),
            expires: expires.map(String::from),
            verified: true,
            renewed_at: (now - renewed).timestamp(),
            lost: 0,
        };
        assert!(!subscription(TimeDelta::hours(2), Some("2026-10-04T10:00:00Z")).renewal_due(now));
        assert!(subscription(TimeDelta::hours(21), Some("2026-10-04T10:00:00Z")).renewal_due(now));
        // A server that allows only two days: renewed when one is left, not every few minutes.
        assert!(subscription(TimeDelta::hours(2), Some("2026-09-28T06:00:00Z")).renewal_due(now));
        assert!(!subscription(TimeDelta::minutes(10), Some("2026-09-28T06:00:00Z")).renewal_due(now));
        assert!(subscription(TimeDelta::hours(2), None).renewal_due(now));

        let waiting = Subscription { verified: false, ..subscription(TimeDelta::minutes(2), None) };
        assert!(!waiting.verification_lost(now));
        let lost = Subscription { verified: false, ..subscription(TimeDelta::minutes(30), None) };
        assert!(lost.verification_lost(now));
        assert!(!subscription(TimeDelta::days(3), None).verification_lost(now), "a verified one isn't waiting");
        // A push service that never delivers isn't asked again every ten minutes.
        let again = Subscription { lost: 2, ..lost.clone() };
        assert!(!again.verification_lost(now), "the third attempt waits 40 minutes");
        let later = Subscription { lost: 2, verified: false, ..subscription(TimeDelta::minutes(41), None) };
        assert!(later.verification_lost(now));
        let often = Subscription { lost: 30, verified: false, ..subscription(TimeDelta::hours(23), None) };
        assert!(!often.verification_lost(now), "at most a day");
        let day = Subscription { lost: 30, verified: false, ..subscription(TimeDelta::hours(25), None) };
        assert!(day.verification_lost(now));
    }
}
