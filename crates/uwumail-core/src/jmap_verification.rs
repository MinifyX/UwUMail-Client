//! Sign-in codes and links a UwUMail server found in mail (`urn:uwumail:jmap:verification`,
//! UwUMail-Server docs/jmap-verification.md): `VerificationCode/query` lists the emails with a
//! code still valid, `Email/get` with the `verification` property says what it is.
//!
//! The app never looks for codes itself. Everything the server says is checked here before the
//! code bar, a notification or the clipboard gets it: a code is letters, digits and dashes, a link
//! is `https` on the code's own host, and nothing lives longer than a day.

use chrono::{DateTime, TimeDelta, Utc};
use serde::Serialize;
use serde_json::{Value, json};

use crate::error::Result;
use crate::jmap::Client;
use crate::notify::{self, VerificationKind};

/// Codes asked for per sync; the server gives at most 256 ids per call, and nobody waits for more
/// than a handful of codes at once.
pub const MAX_CODES: usize = 50;
/// A code never lives longer than this after its mail (the server's own limit).
const MAX_LIFETIME: TimeDelta = TimeDelta::hours(24);
/// The longest host name (RFC 1035).
const MAX_ORIGIN: usize = 253;
/// The longest link the code bar opens.
const MAX_URL: usize = 2048;

/// Why a mail carries a code, as the server says.
const PURPOSES: &[&str] = &["login", "signup", "confirm-email", "reset-password", "confirm-action", "other"];

/// The `verification` of an Email after the checks, still with the server's ids.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerCode {
    pub kind: VerificationKind,
    /// Letters, digits and dashes only (one-time codes only).
    pub code: Option<String>,
    /// `https` on `origin` or a host below it (links only).
    pub url: Option<String>,
    /// The host the code is for, in lower case.
    pub origin: String,
    pub purpose: String,
    /// `header`: the sender declared it; `heuristic`: read from the text.
    pub heuristic: bool,
    pub autofill: bool,
    pub expires_at: DateTime<Utc>,
}

/// A code as the app shows it (the code bar, a list row, the reader), with the mail's local ids.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationCode {
    /// The local id of the mail: one code per mail.
    pub id: String,
    pub account_id: String,
    /// The local id of the mail (the list and the reader match it).
    pub email_id: String,
    pub thread_id: String,
    /// `otp` or `link`.
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub origin: String,
    /// Who sent the mail, plain and short (see [`notify::notification_sender`]).
    pub sender: String,
    pub purpose: String,
    /// `header` or `heuristic`.
    pub source: &'static str,
    pub autofill: bool,
    /// RFC 3339, UTC.
    pub expires_at: String,
}

impl VerificationCode {
    pub fn new(account_id: &str, email_id: &str, thread_id: &str, sender: String, code: &ServerCode) -> Self {
        Self {
            id: email_id.to_string(),
            account_id: account_id.to_string(),
            email_id: email_id.to_string(),
            thread_id: thread_id.to_string(),
            kind: match code.kind {
                VerificationKind::Otp => "otp",
                VerificationKind::Link => "link",
            },
            code: code.code.clone(),
            url: code.url.clone(),
            origin: code.origin.clone(),
            sender,
            purpose: code.purpose.clone(),
            source: if code.heuristic { "heuristic" } else { "header" },
            autofill: code.autofill,
            expires_at: code.expires_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        }
    }

    /// Whether it still works at `now`.
    pub fn valid_at(&self, now: DateTime<Utc>) -> bool {
        DateTime::parse_from_rfc3339(&self.expires_at).is_ok_and(|at| at > now)
    }

    /// What a notification needs of it.
    pub fn for_notification(&self) -> notify::Verification {
        notify::Verification {
            kind: if self.kind == "link" { VerificationKind::Link } else { VerificationKind::Otp },
            code: self.code.clone(),
            origin: self.origin.clone(),
            expires_at: DateTime::parse_from_rfc3339(&self.expires_at).ok().map(|at| at.timestamp()),
        }
    }
}

/// A host name as the server gives it: lower case letters, digits, dashes and dots, with a dot.
fn origin(value: &str) -> Option<String> {
    let host = value.trim().trim_end_matches('.').to_ascii_lowercase();
    let fits = (3..=MAX_ORIGIN).contains(&host.len())
        && host.contains('.')
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        });
    fits.then_some(host)
}

/// A one-time code as the bar shows and copies it: letters, digits and dashes, 4 to 16 of them.
fn otp(value: &str) -> Option<String> {
    let code: String = value.chars().filter(|c| !c.is_whitespace()).collect();
    let fits = (4..=notify::MAX_CODE).contains(&code.chars().count())
        && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    fits.then_some(code)
}

/// A sign-in link: `https`, without a password in it, on `origin` or a host below it.
fn link(value: &str, origin: &str) -> Option<String> {
    if value.len() > MAX_URL {
        return None;
    }
    let url = url::Url::parse(value.trim()).ok()?;
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    let on_origin = host == origin || host.strip_suffix(origin).is_some_and(|rest| rest.ends_with('.'));
    (url.scheme() == "https" && url.username().is_empty() && url.password().is_none() && on_origin)
        .then(|| url.to_string())
}

/// Reads and checks an Email's `verification`. `received` is when the mail came in, if known:
/// a code never outlives it by more than a day, whatever the server says. `None` for `null` and
/// for anything that doesn't pass.
pub fn parse(value: &Value, received: Option<DateTime<Utc>>) -> Option<ServerCode> {
    let text = |key: &str| value.get(key).and_then(Value::as_str);
    let origin = origin(text("origin")?)?;
    let kind = match text("kind")? {
        "otp" => VerificationKind::Otp,
        "link" => VerificationKind::Link,
        _ => return None,
    };
    let (code, url) = match kind {
        VerificationKind::Otp => (Some(otp(text("code")?)?), None),
        VerificationKind::Link => (None, Some(link(text("url")?, &origin)?)),
    };
    let purpose = text("purpose").filter(|purpose| PURPOSES.contains(purpose)).unwrap_or("other").to_string();
    let heuristic = text("source") != Some("header");
    let mut expires_at = DateTime::parse_from_rfc3339(text("expiresAt")?).ok()?.with_timezone(&Utc);
    if let Some(received) = received {
        expires_at = expires_at.min(received + MAX_LIFETIME);
    }
    Some(ServerCode {
        kind,
        code,
        url,
        origin,
        purpose,
        heuristic,
        // Autofill only for a code the sender declared and DMARC confirmed (the server says so).
        autofill: value.get("autofill").and_then(Value::as_bool) == Some(true) && !heuristic,
        expires_at,
    })
}

/// The calls that list the codes still valid and read them: `VerificationCode/query` (newest
/// first) and an `Email/get` of its ids with only what the code needs.
pub fn query_calls(account_id: &str) -> Vec<(&'static str, Value)> {
    vec![
        (
            "VerificationCode/query",
            json!({ "accountId": account_id, "filter": { "expired": false }, "limit": MAX_CODES }),
        ),
        (
            "Email/get",
            json!({
                "accountId": account_id,
                "#ids": { "resultOf": "0", "name": "VerificationCode/query", "path": "/ids" },
                "properties": ["id", "receivedAt", "verification"],
            }),
        ),
    ]
}

/// The valid codes of the account by their Email id, newest first.
pub async fn fetch(client: &Client, account_id: &str) -> Result<Vec<(String, ServerCode)>> {
    let responses = client.call(query_calls(account_id)).await?;
    let order: Vec<String> = responses
        .get(0, "VerificationCode/query")?
        .get("ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|id| id.as_str().map(String::from))
        .collect();
    let list = responses.get(1, "Email/get")?.get("list").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(read_list(&order, &list))
}

/// The checked codes of an `Email/get` list, in the order of the query.
pub fn read_list(order: &[String], list: &[Value]) -> Vec<(String, ServerCode)> {
    order
        .iter()
        .take(MAX_CODES)
        .filter_map(|id| {
            let email = list.iter().find(|email| email.get("id").and_then(Value::as_str) == Some(id))?;
            let received = email
                .get("receivedAt")
                .and_then(Value::as_str)
                .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
                .map(|at| at.with_timezone(&Utc));
            Some((id.clone(), parse(email.get("verification")?, received)?))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text).unwrap().with_timezone(&Utc)
    }

    fn otp_value() -> Value {
        json!({ "kind": "otp", "origin": "Login.Shop.example", "code": "482 913", "url": null,
            "purpose": "login", "expiresAt": "2026-11-02T10:10:00Z", "source": "header", "autofill": true })
    }

    #[test]
    fn reads_a_one_time_code() {
        let code = parse(&otp_value(), None).unwrap();
        assert_eq!(code.kind, VerificationKind::Otp);
        assert_eq!(code.code.as_deref(), Some("482913"));
        assert_eq!(code.origin, "login.shop.example");
        assert_eq!(code.purpose, "login");
        assert!(!code.heuristic);
        assert!(code.autofill);
        assert_eq!(code.expires_at, at("2026-11-02T10:10:00Z"));
    }

    #[test]
    fn reads_a_link_only_on_its_own_host() {
        let value = |url: &str| {
            json!({ "kind": "link", "origin": "shop.example", "code": null, "url": url,
                "purpose": "confirm-email", "expiresAt": "2026-11-02T10:10:00Z", "source": "heuristic", "autofill": true })
        };
        let code = parse(&value("https://login.shop.example/confirm?t=1"), None).unwrap();
        assert_eq!(code.url.as_deref(), Some("https://login.shop.example/confirm?t=1"));
        assert_eq!(code.code, None);
        // A guess is never offered for autofill, whatever the server says.
        assert!(code.heuristic);
        assert!(!code.autofill);
        assert!(parse(&value("https://shop.example/"), None).is_some());
        for refused in [
            "http://shop.example/confirm",
            "https://evilshop.example/confirm",
            "https://shop.example.evil.example/confirm",
            "https://user:pass@shop.example/",
            "javascript:alert(1)",
        ] {
            assert!(parse(&value(refused), None).is_none(), "{refused}");
        }
    }

    #[test]
    fn refuses_what_isnt_a_code() {
        let with = |key: &str, replacement: Value| {
            let mut value = otp_value();
            value[key] = replacement;
            value
        };
        assert!(parse(&Value::Null, None).is_none());
        assert!(parse(&with("code", json!("12")), None).is_none());
        assert!(parse(&with("code", json!("12345678901234567")), None).is_none());
        assert!(parse(&with("code", json!("48<b>13")), None).is_none());
        assert!(parse(&with("code", Value::Null), None).is_none());
        assert!(parse(&with("origin", json!("")), None).is_none());
        assert!(parse(&with("origin", json!("localhost")), None).is_none());
        assert!(parse(&with("origin", json!("shop.example/path")), None).is_none());
        assert!(parse(&with("kind", json!("password")), None).is_none());
        assert!(parse(&with("expiresAt", json!("soon")), None).is_none());
        // An unknown purpose is "other", not a reason to drop the code.
        assert_eq!(parse(&with("purpose", json!("party")), None).unwrap().purpose, "other");
    }

    #[test]
    fn a_code_lives_a_day_at_most() {
        let mut value = otp_value();
        value["expiresAt"] = json!("2026-11-09T10:00:00Z");
        let code = parse(&value, Some(at("2026-11-02T10:00:00Z"))).unwrap();
        assert_eq!(code.expires_at, at("2026-11-03T10:00:00Z"));
    }

    #[test]
    fn asks_for_valid_codes_and_reads_them_in_order() {
        let calls = query_calls("a1");
        assert_eq!(calls[0].0, "VerificationCode/query");
        assert_eq!(calls[0].1["filter"], json!({ "expired": false }));
        assert!(calls[0].1.get("sort").is_none());
        assert_eq!(calls[1].1["properties"], json!(["id", "receivedAt", "verification"]));

        let list = vec![
            json!({ "id": "e1", "receivedAt": "2026-11-02T09:00:00Z", "verification": otp_value() }),
            json!({ "id": "e2", "verification": null }),
            json!({ "id": "e3", "receivedAt": "2026-11-02T10:00:00Z", "verification": otp_value() }),
        ];
        let order = ["e3", "e2", "e1", "e4"].map(String::from);
        let codes = read_list(&order, &list);
        assert_eq!(codes.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["e3", "e1"]);
    }

    #[test]
    fn hands_the_app_and_the_notification_what_they_need() {
        let code = parse(&otp_value(), None).unwrap();
        let shown = VerificationCode::new("acc", "m7", "t7", "Shop".into(), &code);
        let json = serde_json::to_value(&shown).unwrap();
        assert_eq!(json["emailId"], "m7");
        assert_eq!(json["threadId"], "t7");
        assert_eq!(json["kind"], "otp");
        assert_eq!(json["code"], "482913");
        assert!(json.get("url").is_none());
        assert_eq!(json["source"], "header");
        assert_eq!(json["expiresAt"], "2026-11-02T10:10:00Z");
        assert!(shown.valid_at(at("2026-11-02T10:09:59Z")));
        assert!(!shown.valid_at(at("2026-11-02T10:10:00Z")));
        let note = shown.for_notification();
        assert_eq!(note.code.as_deref(), Some("482913"));
        assert_eq!(note.expires_at, Some(at("2026-11-02T10:10:00Z").timestamp()));
    }
}
