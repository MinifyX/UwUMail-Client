//! The own mail in a UwUMail server's backups (`urn:uwumail:jmap:backups`, UwUMail-Server
//! docs/jmap-backups.md): find deleted mail by its headers, read it, and take it back into a
//! `Restored <date>` folder. Only the login's own account has it, never a shared one.
//!
//! What the server says reaches the page as plain text: the preview is the mail's text, never its
//! HTML.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::{Error, ErrorCode, Result};
use crate::jmap::{Client, MethodError, Responses};

/// What the server takes at most per call (docs: 256 characters, 200 hits, 10 previews, 50 restores).
pub const MAX_TEXT: usize = 256;
pub const MAX_HITS: usize = 200;
pub const MAX_PREVIEWS: usize = 10;
pub const MAX_RESTORE: usize = 50;
/// The longest preview text the server sends.
const MAX_BODY: usize = 100_000;
const MAX_ID: usize = 255;
const MAX_SHORT: usize = 998;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFilter {
    #[serde(default)]
    pub text: Option<String>,
    /// RFC 3339 times; the server is told them in UTC.
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default)]
    pub before: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackupAddress {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub email: String,
}

/// A mail found in the backups.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEmail {
    pub id: String,
    pub subject: String,
    pub from: Vec<BackupAddress>,
    pub to: Vec<BackupAddress>,
    pub received_at: Option<String>,
    pub size: u64,
    /// The folder it was in.
    pub folder: String,
    /// When the backups it is in were made, oldest first.
    pub snapshots: Vec<String>,
    /// The mailbox has it already.
    pub in_mailbox: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Indexing {
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackupSearch {
    pub list: Vec<BackupEmail>,
    /// While `done` is below `total`, older backups are still being read.
    pub indexing: Indexing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupAttachment {
    pub name: Option<String>,
    pub media_type: Option<String>,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    #[serde(flatten)]
    pub email: BackupEmail,
    pub text_body: String,
    pub attachments: Vec<BackupAttachment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NotRestored {
    pub id: String,
    /// `notFound`, `overQuota`, `invalidEmail` or what else the server said.
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    pub restored: Vec<String>,
    pub already_there: Vec<String>,
    pub not_restored: Vec<NotRestored>,
}

/// The session offers the backups for the login's own account.
pub fn available(client: &Client) -> bool {
    client.session.backups
}

fn require(client: &Client) -> Result<()> {
    if available(client) {
        Ok(())
    } else {
        Err(Error::not_supported("This server doesn't let you search its backups."))
    }
}

/// Text without control characters (newlines and tabs kept where `lines`), at most `max` chars.
fn clean(text: &str, max: usize, lines: bool) -> String {
    // Bidi controls too: a sender or file name must not reorder what stands around it (BK-1).
    text.chars()
        .filter(|&c| {
            (!c.is_control() || (lines && matches!(c, '\n' | '\t'))) && !crate::assist::signals::is_bidi_control(c)
        })
        .take(max)
        .collect()
}

fn text_of(raw: &Value, key: &str, max: usize) -> String {
    raw.get(key).and_then(Value::as_str).map(|text| clean(text, max, false)).unwrap_or_default()
}

fn id_of(value: &Value) -> Option<String> {
    value
        .as_str()
        // JMAP Ids (RFC 8620 1.2): they also end up in DOM ids and label links (BK-2).
        .filter(|id| {
            !id.is_empty()
                && id.len() <= MAX_ID
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .map(String::from)
}

fn addresses(raw: &Value) -> Vec<BackupAddress> {
    let Some(list) = raw.as_array() else { return Vec::new() };
    list.iter()
        .take(100)
        .filter_map(|entry| {
            let email = clean(entry.get("email")?.as_str()?, 320, false);
            let name =
                entry.get("name").and_then(Value::as_str).map(|n| clean(n, 320, false)).filter(|n| !n.is_empty());
            (!email.is_empty() || name.is_some()).then_some(BackupAddress { name, email })
        })
        .collect()
}

fn email_of(raw: &Value) -> Option<BackupEmail> {
    Some(BackupEmail {
        id: id_of(raw.get("id")?)?,
        subject: text_of(raw, "subject", MAX_SHORT),
        from: addresses(raw.get("from").unwrap_or(&Value::Null)),
        to: addresses(raw.get("to").unwrap_or(&Value::Null)),
        received_at: Some(text_of(raw, "receivedAt", 40)).filter(|at| !at.is_empty()),
        size: raw.get("size").and_then(Value::as_u64).unwrap_or(0),
        folder: text_of(raw, "folder", MAX_SHORT),
        snapshots: raw
            .get("snapshots")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_str).take(1000).map(|at| clean(at, 40, false)).collect())
            .unwrap_or_default(),
        in_mailbox: raw.get("inMailbox").and_then(Value::as_bool) == Some(true),
    })
}

pub fn parse_search(answer: &Value) -> BackupSearch {
    let list = answer.get("list").and_then(Value::as_array);
    let indexing = answer.get("indexing");
    let count = |key: &str| indexing.and_then(|i| i.get(key)).and_then(Value::as_u64).unwrap_or(0);
    BackupSearch {
        list: {
            let mut seen = std::collections::HashSet::new();
            list.into_iter()
                .flatten()
                .take(MAX_HITS)
                .filter_map(email_of)
                .filter(|hit| seen.insert(hit.id.clone()))
                .collect()
        },
        indexing: Indexing { done: count("done"), total: count("total") },
    }
}

pub fn parse_previews(answer: &Value) -> Vec<BackupPreview> {
    let list = answer.get("list").and_then(Value::as_array);
    list.into_iter()
        .flatten()
        .take(MAX_PREVIEWS)
        .filter_map(|raw| {
            let attachments = raw
                .get("attachments")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .take(500)
                        .map(|part| BackupAttachment {
                            name: part.get("name").and_then(Value::as_str).map(|n| clean(n, 255, false)),
                            media_type: part.get("type").and_then(Value::as_str).map(|t| clean(t, 255, false)),
                            size: part.get("size").and_then(Value::as_u64).unwrap_or(0),
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(BackupPreview {
                email: email_of(raw)?,
                text_body: raw
                    .get("textBody")
                    .and_then(Value::as_str)
                    .map(|t| clean(t, MAX_BODY, true))
                    .unwrap_or_default(),
                attachments,
            })
        })
        .collect()
}

/// The answer for the ids asked: one the server leaves out counts as not restored.
pub fn parse_restore(answer: &Value, asked: &[String]) -> RestoreOutcome {
    let restored = answer.get("restored").and_then(Value::as_object);
    let already: Vec<&str> =
        answer.get("alreadyThere").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    let failed = answer.get("notRestored").and_then(Value::as_object);
    let mut outcome = RestoreOutcome::default();
    for id in asked {
        if restored.is_some_and(|map| map.contains_key(id)) {
            outcome.restored.push(id.clone());
        } else if already.contains(&id.as_str()) {
            outcome.already_there.push(id.clone());
        } else {
            let reason = failed
                .and_then(|map| map.get(id))
                .and_then(|error| error.get("type"))
                .and_then(Value::as_str)
                .map(|kind| clean(kind, 40, false))
                .unwrap_or_else(|| "notFound".into());
            outcome.not_restored.push(NotRestored { id: id.clone(), reason });
        }
    }
    outcome
}

/// A time as the server reads it: RFC 3339 in UTC, without fractions.
fn utc_date(value: &str) -> Result<String> {
    let at = DateTime::parse_from_rfc3339(value.trim()).map_err(|_| Error::invalid("That date can't be read."))?;
    Ok(at.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn checked_ids(ids: &[String], max: usize) -> Result<Vec<String>> {
    if ids.is_empty() || ids.len() > max {
        return Err(Error::invalid(format!("Choose between 1 and {max} mails.")));
    }
    let mut seen = std::collections::HashSet::new();
    ids.iter()
        .filter(|id| seen.insert(id.as_str()))
        .map(|id| id_of(&json!(id)).ok_or_else(|| Error::invalid("That isn't a mail in the backups.")))
        .collect()
}

fn answer<'a>(responses: &'a Responses, method: &str) -> Result<&'a Value> {
    responses.get(0, method).map_err(|error: MethodError| match error.kind.as_str() {
        // Switched off by the administrator: not a sign-in problem.
        "forbidden" => Error::new(ErrorCode::Forbidden, clean(&error.description, 300, false)),
        _ => error.into(),
    })
}

pub async fn search(client: &Client, filter: &BackupFilter) -> Result<BackupSearch> {
    require(client)?;
    let mut object = serde_json::Map::new();
    if let Some(text) = filter.text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        object.insert("text".into(), json!(text.chars().take(MAX_TEXT).collect::<String>()));
    }
    for (key, value) in [("after", &filter.after), ("before", &filter.before)] {
        if let Some(value) = value.as_deref().filter(|v| !v.trim().is_empty()) {
            object.insert(key.into(), json!(utc_date(value)?));
        }
    }
    let arguments = json!({ "accountId": client.account_id(), "filter": object, "limit": MAX_HITS });
    let responses = client.call(vec![("BackupEmail/query", arguments)]).await?;
    Ok(parse_search(answer(&responses, "BackupEmail/query")?))
}

pub async fn preview(client: &Client, ids: &[String]) -> Result<Vec<BackupPreview>> {
    require(client)?;
    let ids = checked_ids(ids, MAX_PREVIEWS)?;
    let arguments = json!({ "accountId": client.account_id(), "ids": ids });
    let responses = client.call(vec![("BackupEmail/get", arguments)]).await?;
    Ok(parse_previews(answer(&responses, "BackupEmail/get")?))
}

pub async fn restore(client: &Client, ids: &[String]) -> Result<RestoreOutcome> {
    require(client)?;
    let ids = checked_ids(ids, MAX_RESTORE)?;
    let arguments = json!({ "accountId": client.account_id(), "ids": ids });
    let responses = client.call(vec![("BackupEmail/restore", arguments)]).await?;
    Ok(parse_restore(answer(&responses, "BackupEmail/restore")?, &ids))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_bidi_controls_odd_ids_and_duplicates() {
        assert_eq!(clean("a\u{202E}b\u{2066}c", 10, false), "abc");
        assert_eq!(id_of(&json!("k1 2")), None);
        assert_eq!(id_of(&json!("k12")), Some("k12".into()));
        assert_eq!(checked_ids(&["k1".into(), "k1".into()], 5).unwrap(), vec!["k1".to_string()]);
    }

    #[test]
    fn reads_a_search() {
        let found = parse_search(&json!({
            "accountId": "a1",
            "list": [{
                "id": "k17",
                "subject": "Deine eSIM\u{0007}",
                "from": [{ "name": "Telekom", "email": "esim@example.com" }],
                "to": [{ "name": null, "email": "mini@example.org" }],
                "receivedAt": "2026-11-02T09:14:00Z",
                "size": 48211,
                "folder": "Inbox",
                "snapshots": ["2026-11-03T01:30:00Z", "2026-11-04T01:30:00Z"],
                "inMailbox": false
            }, { "subject": "no id" }],
            "indexing": { "done": 4, "total": 7 }
        }));
        assert_eq!(found.indexing, Indexing { done: 4, total: 7 });
        assert_eq!(found.list.len(), 1);
        let mail = &found.list[0];
        assert_eq!(mail.id, "k17");
        assert_eq!(mail.subject, "Deine eSIM");
        assert_eq!(mail.from, vec![BackupAddress { name: Some("Telekom".into()), email: "esim@example.com".into() }]);
        assert_eq!(mail.to[0].name, None);
        assert_eq!(mail.snapshots.len(), 2);
        assert!(!mail.in_mailbox);
        assert_eq!(parse_search(&json!({})).indexing, Indexing { done: 0, total: 0 });
    }

    #[test]
    fn reads_a_preview_as_text() {
        let previews = parse_previews(&json!({
            "list": [{
                "id": "k17", "subject": "Deine eSIM", "folder": "Inbox", "snapshots": [],
                "textBody": "Hallo\n\tdein Code\u{0000}",
                "attachments": [{ "name": "esim.pdf", "type": "application/pdf", "size": 1200 }, { "name": null, "type": null, "size": 3 }]
            }],
            "notFound": ["k9"]
        }));
        assert_eq!(previews.len(), 1);
        assert_eq!(previews[0].text_body, "Hallo\n\tdein Code");
        assert_eq!(previews[0].attachments[0].media_type.as_deref(), Some("application/pdf"));
        assert_eq!(previews[0].attachments[1].name, None);
    }

    #[test]
    fn every_asked_id_has_an_outcome() {
        let asked: Vec<String> = ["k1", "k2", "k3", "k4"].map(String::from).into();
        let outcome = parse_restore(
            &json!({
                "restored": { "k1": "m5" },
                "alreadyThere": ["k2"],
                "notRestored": { "k3": { "type": "overQuota", "description": "the mailbox is full" } }
            }),
            &asked,
        );
        assert_eq!(outcome.restored, ["k1"]);
        assert_eq!(outcome.already_there, ["k2"]);
        assert_eq!(
            outcome.not_restored,
            [
                NotRestored { id: "k3".into(), reason: "overQuota".into() },
                NotRestored { id: "k4".into(), reason: "notFound".into() }
            ]
        );
    }

    #[test]
    fn dates_and_ids_are_checked() {
        assert_eq!(utc_date("2026-11-02T00:00:00.000+01:00").unwrap(), "2026-11-01T23:00:00Z");
        assert!(utc_date("yesterday").is_err());
        assert!(checked_ids(&[], 10).is_err());
        assert!(checked_ids(&vec!["k1".to_string(); 11], 10).is_err());
        assert!(checked_ids(&["".to_string()], 10).is_err());
        assert_eq!(checked_ids(&["k1".to_string()], 10).unwrap(), ["k1"]);
    }
}
