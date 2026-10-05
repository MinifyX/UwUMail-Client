//! What the AI assistant keeps on this device: the person's own providers (their keys are in the
//! system keychain, see `assist::local`), the choices per feature, labels, the log of labels the
//! model set, and what was used per day. Also the own keywords of messages, which labels are.

use rusqlite::{OptionalExtension, params};

use super::Store;
use crate::assist::Label;
use crate::error::Result;

/// The migration of this feature, appended to `MIGRATIONS`.
pub(super) const MIGRATION: &str = r#"
-- AI assistant: the own keywords of messages (labels), space-separated and lower case; the
-- providers set up on this device (keys in the keychain as `assist-provider:<id>`), its assistant
-- settings, labels, the log of labels the model set, and usage per day.
ALTER TABLE messages ADD COLUMN keywords TEXT NOT NULL DEFAULT '';
CREATE TABLE assist_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    base_url TEXT,
    model TEXT,
    fast_model TEXT,
    key_hint TEXT,
    created_at INTEGER NOT NULL
);
CREATE TABLE assist_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE assist_labels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    keyword TEXT NOT NULL UNIQUE,
    color TEXT,
    created_at INTEGER NOT NULL
);
CREATE TABLE assist_label_log (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    label_id TEXT NOT NULL,
    name TEXT NOT NULL,
    keyword TEXT NOT NULL,
    reason TEXT NOT NULL,
    provider_name TEXT,
    model TEXT,
    created_at INTEGER NOT NULL,
    undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX assist_label_log_by_message ON assist_label_log (message_id);
CREATE INDEX assist_label_log_by_time ON assist_label_log (created_at DESC);
CREATE TABLE assist_usage (
    day TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    provider_name TEXT NOT NULL,
    feature TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, provider_id, feature)
);
"#;

/// Prices of the assistant: what an own provider costs when set by hand (USD per million tokens,
/// input and output), and what the day's requests cost in USD when they were made (null where the
/// price was unknown then).
pub(super) const PRICE_MIGRATION: &str = r#"
ALTER TABLE assist_providers ADD COLUMN input_price REAL;
ALTER TABLE assist_providers ADD COLUMN output_price REAL;
ALTER TABLE assist_usage ADD COLUMN cost_usd REAL;
"#;

/// What AI requests on this device really take: reasoning (apart from the answer), prompt tokens
/// read from the provider's cache (part of the input) and the calls made; and the last 50 calls per
/// provider, model and feature with what was expected, so estimates learn from them. No mail
/// content in there.
pub(super) const COST_MIGRATION: &str = r#"
ALTER TABLE assist_usage ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assist_usage ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assist_usage ADD COLUMN calls INTEGER NOT NULL DEFAULT 0;
CREATE TABLE assist_calibration (
    id INTEGER PRIMARY KEY,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    feature TEXT NOT NULL,
    estimated_input INTEGER NOT NULL,
    estimated_output INTEGER NOT NULL,
    estimated_reasoning INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    reasoning_tokens INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX assist_calibration_key ON assist_calibration (provider_id, model, feature, id);
"#;

/// Labels without a model (docs/labels.md of UwUMail Server): a label's rules (JSON), detector and
/// switches; who put a logged label on and why (`source`, `code`, `params` as JSON; older entries
/// were the model's); the headers of a mail the detectors read and whether it has a calendar part
/// (unknown for mail stored before); how often the person gave a sender's mail a label by hand;
/// and the classifier's examples: a mail's token hashes (little-endian i64s) with the ids of the
/// labels it has, space-separated.
pub(super) const LABELS_MIGRATION: &str = r#"
ALTER TABLE assist_labels ADD COLUMN rules TEXT;
ALTER TABLE assist_labels ADD COLUMN detector TEXT;
ALTER TABLE assist_labels ADD COLUMN learn_senders INTEGER NOT NULL DEFAULT 1;
ALTER TABLE assist_labels ADD COLUMN classifier INTEGER NOT NULL DEFAULT 1;
ALTER TABLE assist_label_log ADD COLUMN source TEXT NOT NULL DEFAULT 'ai';
ALTER TABLE assist_label_log ADD COLUMN code TEXT NOT NULL DEFAULT 'ai';
ALTER TABLE assist_label_log ADD COLUMN params TEXT NOT NULL DEFAULT '{}';
ALTER TABLE messages ADD COLUMN label_headers TEXT;
ALTER TABLE messages ADD COLUMN calendar INTEGER NOT NULL DEFAULT 0;
CREATE TABLE label_senders (
    label_id TEXT NOT NULL,
    address TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (label_id, address)
);
CREATE TABLE label_examples (
    id INTEGER PRIMARY KEY,
    message_id TEXT NOT NULL UNIQUE,
    labels TEXT NOT NULL DEFAULT '',
    tokens BLOB NOT NULL,
    created_at INTEGER NOT NULL
);
"#;

/// Whether the receiving server vouched for a mail's From address (`mime::ParsedMessage::from_trusted`);
/// mail stored before is not vouched for.
pub(super) const FROM_TRUSTED_MIGRATION: &str =
    "ALTER TABLE messages ADD COLUMN from_trusted INTEGER NOT NULL DEFAULT 0;";

/// Labels 0.22 of UwUMail Server (docs/labels.md): which base label a label is, the language its
/// definition was written in, and whether it is put on by itself at all; and the person's corrections shown to the model, a few per label: a
/// label put on (positive) or taken off by hand, with the sender's domain (never the address), the
/// subject and the start of the text, cut short.
pub(super) const BASE_LABELS_MIGRATION: &str = r#"
ALTER TABLE assist_labels ADD COLUMN base TEXT;
ALTER TABLE assist_labels ADD COLUMN auto INTEGER NOT NULL DEFAULT 1;
ALTER TABLE assist_labels ADD COLUMN base_language TEXT;
CREATE UNIQUE INDEX assist_labels_base ON assist_labels (base) WHERE base IS NOT NULL;
CREATE TABLE label_shots (
    label_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    positive INTEGER NOT NULL,
    sender_domain TEXT NOT NULL,
    subject TEXT NOT NULL,
    snippet TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (label_id, message_id)
);
"#;

/// What the person had written for a label a base label adopted (UwUMail Server's migration 0073,
/// LABELS22-L2): kept instead of lost, shown in the settings and given to the model as a hint.
pub(super) const PREVIOUS_DESCRIPTION_MIGRATION: &str =
    "ALTER TABLE assist_labels ADD COLUMN previous_description TEXT;";

/// Calls kept per provider, model and feature for calibration.
const CALIBRATION_KEPT: i64 = 50;

/// Keywords as the messages table keeps them.
pub(super) fn keywords_text(keywords: &[String]) -> String {
    let mut list: Vec<String> = keywords.iter().map(|k| k.trim().to_lowercase()).filter(|k| !k.is_empty()).collect();
    list.sort();
    list.dedup();
    list.truncate(MAX_KEYWORDS);
    list.join(" ")
}

pub(super) fn keywords_list(text: &str) -> Vec<String> {
    text.split_whitespace().map(String::from).collect()
}

/// Own keywords kept per message, at most.
const MAX_KEYWORDS: usize = 30;
/// Senders a label learned by hand, at most, and the longest address counted.
pub const MAX_LABEL_SENDERS: usize = 5_000;
const MAX_SENDER_CHARS: usize = 320;

/// A provider set up on this device.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderRecord {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub fast_model: Option<String>,
    /// The last four characters of the key; `None` without a key.
    pub key_hint: Option<String>,
    pub created_at: i64,
    /// The price set by hand, USD per million tokens; `None` follows the known prices.
    pub input_price: Option<f64>,
    pub output_price: Option<f64>,
}

/// A label put on by itself, as the log keeps it.
/// What labels without a model read of a stored mail besides its text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LabelHeaders {
    /// The headers the detectors read (empty when unknown).
    pub headers: Vec<(String, String)>,
    /// A calendar part.
    pub calendar: bool,
    /// The receiving server vouched for the From address.
    pub from_trusted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelLogRecord {
    pub id: String,
    pub account_id: String,
    pub message_id: String,
    pub label_id: String,
    pub name: String,
    pub keyword: String,
    pub reason: String,
    /// `ai`, `rule`, `sender`, `detector` or `classifier`.
    pub source: String,
    /// What `reason` says, for the page to put in its own words: `ai`, `rule`, `sender`,
    /// `classifier` or a detector's name.
    pub code: String,
    /// The details `code` names, as JSON.
    pub params: String,
    pub provider_name: Option<String>,
    pub model: Option<String>,
    pub created_at: i64,
    pub undone: bool,
}

/// One row of usage: a day (UTC, `YYYY-MM-DD`), a provider and a feature.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageRecord {
    pub day: String,
    pub provider_id: String,
    pub provider_name: String,
    pub feature: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Thinking, apart from `output_tokens`.
    pub reasoning_tokens: u64,
    /// Of `input_tokens`, read from the provider's cache.
    pub cached_tokens: u64,
    /// Requests sent to the provider.
    pub calls: u64,
    /// What it cost in USD at the time; `None` where the price was unknown.
    pub cost_usd: Option<f64>,
}

/// One real call for calibration: what was expected and what the provider reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalibrationRecord {
    pub provider_id: String,
    pub model: String,
    pub feature: String,
    pub sample: crate::assist::estimate::Sample,
    pub created_at: i64,
}

const LOG_COLUMNS: &str = "id, account_id, message_id, label_id, name, keyword, reason, provider_name, model, \
                           created_at, undone, source, code, params";

fn log_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LabelLogRecord> {
    Ok(LabelLogRecord {
        id: row.get(0)?,
        account_id: row.get(1)?,
        message_id: row.get(2)?,
        label_id: row.get(3)?,
        name: row.get(4)?,
        keyword: row.get(5)?,
        reason: row.get(6)?,
        provider_name: row.get(7)?,
        model: row.get(8)?,
        created_at: row.get(9)?,
        undone: row.get(10)?,
        source: row.get(11)?,
        code: row.get(12)?,
        params: row.get(13)?,
    })
}

/// Token hashes as a blob, and back.
fn tokens_blob(tokens: &[i64]) -> Vec<u8> {
    tokens.iter().flat_map(|token| token.to_le_bytes()).collect()
}

fn blob_tokens(blob: &[u8]) -> Vec<i64> {
    blob.as_chunks::<8>().0.iter().map(|chunk| i64::from_le_bytes(*chunk)).collect()
}

fn label_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Label> {
    let rules: Option<String> = row.get(5)?;
    Ok(Label {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        keyword: row.get(3)?,
        color: row.get(4)?,
        rules: rules.and_then(|text| serde_json::from_str(&text).ok()),
        detector: row.get(6)?,
        learn_senders: row.get(7)?,
        classifier: row.get(8)?,
        base: row.get(9)?,
        auto: row.get(10)?,
        base_language: row.get(11)?,
        previous_description: row.get(12)?,
    })
}

/// Corrections kept per label: put on, and taken off (UwUMail Server's numbers).
pub const MAX_SHOTS_POSITIVE: i64 = 4;
pub const MAX_SHOTS_NEGATIVE: i64 = 3;
const SHOT_SUBJECT_CHARS: usize = 120;
const SHOT_SNIPPET_CHARS: usize = 200;

/// One space between words, at most `max` characters (with "…" when cut).
/// A text for a correction example with what could be a code, a number of an account or a link
/// taken out: runs of four digits or more (spaces and hyphens inside a run count with it) become
/// `#`, words mixing letters and digits keep only their shape, and web addresses become `[link]`.
/// The same as UwUMail Server's `masked` (LABELS22-L3, R2 I-3; C3-6 here).
fn masked(text: &str) -> String {
    let words: Vec<String> = text
        .split_whitespace()
        .map(|word| {
            let lower = word.to_lowercase();
            if lower.contains("://") || lower.starts_with("www.") {
                "[link]".to_owned()
            } else if mixed_code(word) {
                word.chars().map(|c| if c.is_alphanumeric() { '#' } else { c }).collect()
            } else {
                word.to_owned()
            }
        })
        .collect();
    let text = words.join(" ");
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < chars.len() {
        if !chars[at].is_numeric() {
            out.push(chars[at]);
            at += 1;
            continue;
        }
        // A run: digits, with single spaces or hyphens between them.
        let mut end = at;
        let mut digits = 0;
        while end < chars.len() {
            if chars[end].is_numeric() {
                digits += 1;
                end += 1;
            } else if matches!(chars[end], ' ' | '-') && chars.get(end + 1).is_some_and(|c| c.is_numeric()) {
                end += 1;
            } else {
                break;
            }
        }
        for c in &chars[at..end] {
            out.push(if digits >= 4 && c.is_numeric() { '#' } else { *c });
        }
        at = end;
    }
    out
}

/// A word of four letters and digits or more that has both, like a code (`AB7-K2X`, `X9F2Q`),
/// not a short name like `MP3` or `A4`.
fn mixed_code(word: &str) -> bool {
    let alphanumeric = word.chars().filter(|c| c.is_alphanumeric()).count();
    alphanumeric >= 4 && word.chars().any(|c| c.is_numeric()) && word.chars().any(char::is_alphabetic)
}

fn shot_cut(text: &str, max: usize) -> String {
    let text: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match text.char_indices().nth(max) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text,
    }
}

/// One of the person's corrections, shown to the model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelShot {
    pub label_id: String,
    pub positive: bool,
    pub sender_domain: String,
    pub subject: String,
    pub snippet: String,
}

/// A classifier example: the ids of the labels the mail has, and its token hashes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelExample {
    pub message_id: String,
    pub labels: Vec<String>,
    pub tokens: Vec<i64>,
}

impl Store {
    // ------------------------------------------------------------ keywords

    /// Sets a message's own keywords. Returns whether they changed.
    pub fn set_keywords(&self, id: &str, keywords: &[String]) -> Result<bool> {
        let text = keywords_text(keywords);
        Ok(self
            .conn()
            .execute("UPDATE messages SET keywords = ?1 WHERE id = ?2 AND keywords != ?1", params![text, id])?
            > 0)
    }

    /// Sets the own keywords of a message by folder and uid (IMAP). Returns whether they changed.
    pub fn set_keywords_by_uid(&self, folder_id: &str, uid: u32, keywords: &[String]) -> Result<bool> {
        let text = keywords_text(keywords);
        Ok(self.conn().execute(
            "UPDATE messages SET keywords = ?1 WHERE folder_id = ?2 AND uid = ?3 AND keywords != ?1",
            params![text, folder_id, uid],
        )? > 0)
    }

    /// The own keywords of the messages of a folder by uid (IMAP).
    pub fn keywords_by_uid(&self, folder_id: &str) -> Result<std::collections::HashMap<u32, String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT uid, keywords FROM messages WHERE folder_id = ?1 AND uid > 0")?;
        let rows = stmt.query_map([folder_id], |row| Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Adds or takes off one own keyword locally, for a change made here that the server confirms.
    pub fn change_keyword(&self, ids: &[String], keyword: &str, on: bool) -> Result<()> {
        for id in ids {
            let current: Option<String> = self
                .conn()
                .query_row("SELECT keywords FROM messages WHERE id = ?1", [id], |row| row.get(0))
                .optional()?;
            let Some(current) = current else { continue };
            let mut list = keywords_list(&current);
            list.retain(|k| !k.eq_ignore_ascii_case(keyword));
            if on {
                list.push(keyword.to_lowercase());
            }
            self.set_keywords(id, &list)?;
        }
        Ok(())
    }

    /// Account and inbox-ness of messages, for the assistant: (id, account id, folder role).
    pub fn message_roles(&self, ids: &[String]) -> Result<Vec<(String, String, Option<String>)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.account_id, f.role FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?1",
        )?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(row) = stmt.query_row([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()? {
                out.push(row);
            }
        }
        Ok(out)
    }

    /// Local ids of JMAP emails by their server id, for those stored.
    pub fn ids_by_remote(
        &self,
        account_id: &str,
        remote_ids: &[String],
    ) -> Result<std::collections::HashMap<String, String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT id FROM messages WHERE account_id = ?1 AND remote_id = ?2 LIMIT 1")?;
        let mut found = std::collections::HashMap::new();
        for remote in remote_ids {
            if let Some(id) = stmt.query_row(params![account_id, remote], |row| row.get::<_, String>(0)).optional()? {
                found.insert(remote.clone(), id);
            }
        }
        Ok(found)
    }

    /// The newest messages in the inboxes of these accounts, newest first.
    pub fn recent_inbox(&self, account_ids: &[String], limit: u32) -> Result<Vec<String>> {
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn();
        let marks = (1..=account_ids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
        let mut stmt = conn.prepare(&format!(
            "SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE f.role = 'inbox' AND m.account_id IN ({marks}) ORDER BY m.date DESC LIMIT {}",
            limit.clamp(1, 500)
        ))?;
        let rows = stmt.query_map(rusqlite::params_from_iter(account_ids.iter()), |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// What this device knows about a sender, for the spam check: mails from the address before
    /// `before` (unix seconds) and how many of them are in Junk, mails sent to it from these
    /// accounts, and when the first one came.
    pub fn sender_history(&self, email: &str, before: i64) -> Result<(u64, u64, u64, Option<i64>)> {
        let conn = self.conn();
        let (earlier, in_junk, first): (i64, i64, Option<i64>) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(CASE WHEN f.role = 'junk' THEN 1 ELSE 0 END), 0), MIN(m.date)
             FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE m.date < ?2 AND lower(json_extract(m.from_json, '$.email')) = lower(?1)",
            params![email, before],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let written: i64 = conn.query_row(
            "SELECT COUNT(*) FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE f.role = 'sent' AND EXISTS (
                SELECT 1 FROM json_each(m.to_json) WHERE lower(json_extract(value, '$.email')) = lower(?1)
                UNION ALL
                SELECT 1 FROM json_each(m.cc_json) WHERE lower(json_extract(value, '$.email')) = lower(?1))",
            params![email],
            |row| row.get(0),
        )?;
        let count = |n: i64| u64::try_from(n).unwrap_or(0);
        Ok((count(earlier), count(in_junk), count(written), first))
    }

    // ----------------------------------------------------------- providers

    pub fn assist_providers(&self) -> Result<Vec<ProviderRecord>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, kind, base_url, model, fast_model, key_hint, created_at, input_price, output_price
             FROM assist_providers ORDER BY created_at, rowid",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ProviderRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                base_url: row.get(3)?,
                model: row.get(4)?,
                fast_model: row.get(5)?,
                key_hint: row.get(6)?,
                created_at: row.get(7)?,
                input_price: row.get(8)?,
                output_price: row.get(9)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Adds or replaces a provider.
    pub fn save_assist_provider(&self, provider: &ProviderRecord) -> Result<()> {
        self.conn().execute(
            "INSERT INTO assist_providers
                (id, name, kind, base_url, model, fast_model, key_hint, created_at, input_price, output_price)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url,
                model = excluded.model, fast_model = excluded.fast_model, key_hint = excluded.key_hint,
                input_price = excluded.input_price, output_price = excluded.output_price",
            params![
                provider.id,
                provider.name,
                provider.kind,
                provider.base_url,
                provider.model,
                provider.fast_model,
                provider.key_hint,
                provider.created_at,
                provider.input_price,
                provider.output_price
            ],
        )?;
        Ok(())
    }

    pub fn delete_assist_provider(&self, id: &str) -> Result<bool> {
        Ok(self.conn().execute("DELETE FROM assist_providers WHERE id = ?1", [id])? > 0)
    }

    // ------------------------------------------------------------ settings

    pub fn assist_setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT value FROM assist_settings WHERE key = ?1", [key], |row| row.get(0))
            .optional()?)
    }

    /// Sets a setting; `None` removes it.
    pub fn set_assist_setting(&self, key: &str, value: Option<&str>) -> Result<()> {
        let conn = self.conn();
        match value {
            Some(value) => conn.execute(
                "INSERT INTO assist_settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?,
            None => conn.execute("DELETE FROM assist_settings WHERE key = ?1", [key])?,
        };
        Ok(())
    }

    // -------------------------------------------------------------- labels

    pub fn assist_labels(&self) -> Result<Vec<Label>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, description, keyword, color, rules, detector, learn_senders, classifier, base, auto,
                    base_language, previous_description
             FROM assist_labels ORDER BY created_at, rowid",
        )?;
        let rows = stmt.query_map([], label_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn insert_assist_label(&self, label: &Label, created_at: i64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO assist_labels
                (id, name, description, keyword, color, created_at, rules, detector, learn_senders, classifier,
                 base, auto, base_language, previous_description)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                label.id,
                label.name,
                label.description,
                label.keyword,
                label.color,
                created_at,
                label.rules.as_ref().map(|rules| rules.to_json().to_string()),
                label.detector,
                label.learn_senders,
                label.classifier,
                label.base,
                label.auto,
                label.base_language,
                label.previous_description
            ],
        )?;
        Ok(())
    }

    /// Changes everything but the keyword, which stays.
    pub fn update_assist_label(&self, label: &Label) -> Result<bool> {
        Ok(self.conn().execute(
            "UPDATE assist_labels SET name = ?2, description = ?3, color = ?4, rules = ?5, detector = ?6,
                learn_senders = ?7, classifier = ?8, base = ?9, auto = ?10,
                base_language = ?11, previous_description = ?12 WHERE id = ?1",
            params![
                label.id,
                label.name,
                label.description,
                label.color,
                label.rules.as_ref().map(|rules| rules.to_json().to_string()),
                label.detector,
                label.learn_senders,
                label.classifier,
                label.base,
                label.auto,
                label.base_language,
                label.previous_description
            ],
        )? > 0)
    }

    /// Deletes a label and forgets its log, its learned senders and what its classifier learned.
    pub fn delete_assist_label(&self, id: &str) -> Result<bool> {
        let conn = self.conn();
        conn.execute("DELETE FROM assist_label_log WHERE label_id = ?1", [id])?;
        conn.execute("DELETE FROM label_senders WHERE label_id = ?1", [id])?;
        conn.execute("DELETE FROM label_shots WHERE label_id = ?1", [id])?;
        let mut stmt = conn.prepare("SELECT id, labels FROM label_examples WHERE labels != ''")?;
        let rows: Vec<(i64, String)> =
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        for (example, labels) in rows {
            if labels.split(' ').any(|label| label == id) {
                let rest: Vec<&str> = labels.split(' ').filter(|label| *label != id).collect();
                conn.execute("UPDATE label_examples SET labels = ?1 WHERE id = ?2", params![rest.join(" "), example])?;
            }
        }
        Ok(conn.execute("DELETE FROM assist_labels WHERE id = ?1", [id])? > 0)
    }

    /// What labels without a model read of a stored mail besides its text.
    pub fn label_headers(&self, message_id: &str) -> Result<LabelHeaders> {
        let found: Option<(Option<String>, bool, bool)> = self
            .conn()
            .query_row(
                "SELECT label_headers, calendar, from_trusted FROM messages WHERE id = ?1",
                [message_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (headers, calendar, from_trusted) = found.unwrap_or_default();
        Ok(LabelHeaders {
            headers: headers.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default(),
            calendar,
            from_trusted,
        })
    }

    /// Tests only: a message as if it were being moved (no uid on the server yet), so changes to
    /// its keywords stay on this device.
    #[cfg(test)]
    pub(crate) fn unlink_for_tests(&self, id: &str) {
        self.conn().execute("UPDATE messages SET uid = -rowid WHERE id = ?1", [id]).unwrap();
    }

    // ------------------------------------------------ learning from the person

    /// Per label id, how often the person gave mail from `address` (lower case) the label by hand.
    pub fn label_senders(&self, address: &str) -> Result<std::collections::HashMap<String, i64>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT label_id, count FROM label_senders WHERE address = ?1")?;
        let rows = stmt.query_map([address], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Counts one more hand-labeling of a sender's mail. A label remembers at most
    /// [`MAX_LABEL_SENDERS`] senders: a new one pushes out the one counted least (the oldest of
    /// those). Addresses longer than an address can be are not counted.
    pub fn count_label_sender(&self, label_id: &str, address: &str) -> Result<()> {
        self.count_label_sender_within(label_id, address, MAX_LABEL_SENDERS)
    }

    fn count_label_sender_within(&self, label_id: &str, address: &str, max: usize) -> Result<()> {
        if address.is_empty() || address.len() > MAX_SENDER_CHARS {
            return Ok(());
        }
        let conn = self.conn();
        let known: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM label_senders WHERE label_id = ?1 AND address = ?2)",
            params![label_id, address],
            |row| row.get(0),
        )?;
        if !known {
            conn.execute(
                "DELETE FROM label_senders WHERE rowid IN (SELECT rowid FROM label_senders WHERE label_id = ?1
                     ORDER BY abs(count), rowid LIMIT max(0, (SELECT COUNT(*) FROM label_senders WHERE label_id = ?1) - ?2))",
                params![label_id, i64::try_from(max.saturating_sub(1)).unwrap_or(i64::MAX)],
            )?;
        }
        conn.execute(
            "INSERT INTO label_senders (label_id, address, count) VALUES (?1, ?2, 1)
             ON CONFLICT (label_id, address) DO UPDATE SET count = CASE WHEN count < 0 THEN 1 ELSE count + 1 END",
            params![label_id, address],
        )?;
        Ok(())
    }

    /// The label was taken off mail of `address` by hand: it no longer goes on their mail by itself,
    /// except by the label's rules (count -1), until it is put on their mail by hand again. A new
    /// sender beyond [`MAX_LABEL_SENDERS`] pushes out the one counted least, like counting does.
    pub fn block_label_sender(&self, label_id: &str, address: &str) -> Result<()> {
        if address.is_empty() || address.len() > MAX_SENDER_CHARS {
            return Ok(());
        }
        let conn = self.conn();
        let known = conn.execute(
            "UPDATE label_senders SET count = -1 WHERE label_id = ?1 AND address = ?2",
            params![label_id, address],
        )?;
        if known == 0 {
            conn.execute(
                "DELETE FROM label_senders WHERE rowid IN (SELECT rowid FROM label_senders WHERE label_id = ?1
                     ORDER BY abs(count), rowid LIMIT max(0, (SELECT COUNT(*) FROM label_senders WHERE label_id = ?1) - ?2))",
                params![label_id, i64::try_from(MAX_LABEL_SENDERS.saturating_sub(1)).unwrap_or(i64::MAX)],
            )?;
            conn.execute(
                "INSERT INTO label_senders (label_id, address, count) VALUES (?1, ?2, -1)",
                params![label_id, address],
            )?;
        }
        Ok(())
    }

    /// Keeps a hand-labeling as a correction for the model: the sender's domain (never the
    /// address), the subject and the start of the text, codes and links masked ([`masked`]), cut
    /// short; a mail with a one-time code keeps none. The newest [`MAX_SHOTS_POSITIVE`] put on and
    /// [`MAX_SHOTS_NEGATIVE`] taken off stay per label.
    #[allow(clippy::too_many_arguments)]
    pub fn keep_label_shot(
        &self,
        label_id: &str,
        message_id: &str,
        positive: bool,
        sender_domain: &str,
        subject: &str,
        snippet: &str,
        now: i64,
    ) -> Result<()> {
        if uwumail_labels::has_one_time_code(&format!("{subject}\n{snippet}")) {
            return Ok(());
        }
        let conn = self.conn();
        conn.execute(
            "INSERT INTO label_shots (label_id, message_id, positive, sender_domain, subject, snippet, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (label_id, message_id) DO UPDATE SET positive = ?3, created_at = ?7",
            params![
                label_id,
                message_id,
                positive,
                shot_cut(sender_domain, 100),
                shot_cut(&masked(subject), SHOT_SUBJECT_CHARS),
                shot_cut(&masked(snippet), SHOT_SNIPPET_CHARS),
                now
            ],
        )?;
        let keep = if positive { MAX_SHOTS_POSITIVE } else { MAX_SHOTS_NEGATIVE };
        conn.execute(
            "DELETE FROM label_shots WHERE label_id = ?1 AND positive = ?2 AND rowid NOT IN (
                 SELECT rowid FROM label_shots WHERE label_id = ?1 AND positive = ?2
                 ORDER BY created_at DESC, rowid DESC LIMIT ?3)",
            params![label_id, positive, keep],
        )?;
        Ok(())
    }

    /// Forgets every correction: AI labels were switched off (C3-6).
    pub fn forget_label_shots(&self) -> Result<()> {
        self.conn().execute("DELETE FROM label_shots", [])?;
        Ok(())
    }

    /// The person's corrections for the model, newest first.
    pub fn label_shots(&self) -> Result<Vec<LabelShot>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT label_id, positive, sender_domain, subject, snippet FROM label_shots
             ORDER BY created_at DESC, rowid DESC LIMIT 200",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(LabelShot {
                label_id: row.get(0)?,
                positive: row.get(1)?,
                sender_domain: row.get(2)?,
                subject: row.get(3)?,
                snippet: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Learns a mail as a classifier example: with the label (`Some((id, true))`), without it
    /// (`Some((id, false))`) or with no label at all (`None`, an ordinary mail). A mail learned before
    /// keeps its other labels. Beyond `max` examples the oldest are forgotten. Answers whether it
    /// became an example with the label just now.
    pub fn learn_label_example(
        &self,
        message_id: &str,
        tokens: &[i64],
        label: Option<(&str, bool)>,
        now: i64,
        max: usize,
    ) -> Result<bool> {
        let conn = self.conn();
        let known: Option<String> = conn
            .query_row("SELECT labels FROM label_examples WHERE message_id = ?1", [message_id], |row| row.get(0))
            .optional()?;
        let mut labels: Vec<String> = known.as_deref().map(keywords_list).unwrap_or_default();
        let newly = label.is_some_and(|(id, with)| with && !labels.iter().any(|known| known == id));
        if let Some((id, with)) = label {
            labels.retain(|known| known != id);
            if with {
                labels.push(id.to_string());
            }
        }
        match known {
            Some(_) => conn.execute(
                "UPDATE label_examples SET labels = ?1 WHERE message_id = ?2",
                params![labels.join(" "), message_id],
            )?,
            None => conn.execute(
                "INSERT INTO label_examples (message_id, labels, tokens, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![message_id, labels.join(" "), tokens_blob(tokens), now],
            )?,
        };
        conn.execute(
            "DELETE FROM label_examples WHERE id NOT IN (SELECT id FROM label_examples ORDER BY id DESC LIMIT ?1)",
            [i64::try_from(max).unwrap_or(i64::MAX)],
        )?;
        Ok(newly)
    }

    /// Every classifier example.
    pub fn label_examples(&self) -> Result<Vec<LabelExample>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT labels, tokens, message_id FROM label_examples ORDER BY id")?;
        let rows = stmt.query_map([], |row| {
            let labels: String = row.get(0)?;
            let tokens: Vec<u8> = row.get(1)?;
            Ok(LabelExample { message_id: row.get(2)?, labels: keywords_list(&labels), tokens: blob_tokens(&tokens) })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Per label id, the examples with the label.
    pub fn label_example_counts(&self) -> Result<std::collections::HashMap<String, u64>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT labels FROM label_examples WHERE labels != ''")?;
        let mut counts = std::collections::HashMap::new();
        for labels in stmt.query_map([], |row| row.get::<_, String>(0))? {
            for label in keywords_list(&labels?) {
                *counts.entry(label).or_insert(0) += 1;
            }
        }
        Ok(counts)
    }

    /// Ordinary mail to learn as an example without any label: the newest `limit` inbox mails of
    /// an account since `since` (unix seconds) that carry none of `keywords` and are no example yet,
    /// newest first.
    pub fn unlabeled_inbox(
        &self,
        account_id: &str,
        since: i64,
        keywords: &[String],
        limit: usize,
    ) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.keywords FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE f.role = 'inbox' AND m.account_id = ?1 AND m.date >= ?2
               AND NOT EXISTS (SELECT 1 FROM label_examples e WHERE e.message_id = m.id)
             ORDER BY m.date DESC, m.id LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![account_id, since, i64::try_from(limit * 5).unwrap_or(i64::MAX)], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, own) = row?;
            if keywords_list(&own).iter().any(|keyword| keywords.contains(keyword)) {
                continue;
            }
            out.push(id);
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }

    /// Messages of these accounts that carry a keyword (the whole keyword, ignoring case), at most
    /// `limit`: to take a deleted label off all its mail.
    pub fn messages_with_keyword(&self, keyword: &str, account_ids: &[String], limit: usize) -> Result<Vec<String>> {
        let keyword = keyword.trim().to_lowercase();
        if keyword.is_empty() || keyword.contains(char::is_whitespace) || account_ids.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id FROM messages WHERE account_id = ?1 AND instr(' ' || keywords || ' ', ?2) > 0
             ORDER BY rowid LIMIT ?3",
        )?;
        let needle = format!(" {keyword} ");
        let mut out: Vec<String> = Vec::new();
        for account_id in account_ids {
            let left = i64::try_from(limit - out.len()).unwrap_or(i64::MAX);
            let rows = stmt.query_map(params![account_id, needle, left], |row| row.get(0))?;
            out.extend(rows.collect::<rusqlite::Result<Vec<String>>>()?);
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }

    // ----------------------------------------------------------- label log

    pub fn insert_label_log(&self, entry: &LabelLogRecord) -> Result<()> {
        self.conn().execute(
            &format!(
                "INSERT INTO assist_label_log ({LOG_COLUMNS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"
            ),
            params![
                entry.id,
                entry.account_id,
                entry.message_id,
                entry.label_id,
                entry.name,
                entry.keyword,
                entry.reason,
                entry.provider_name,
                entry.model,
                entry.created_at,
                entry.undone,
                entry.source,
                entry.code,
                entry.params
            ],
        )?;
        Ok(())
    }

    /// Newest first: for these messages, or the latest.
    pub fn label_log(&self, message_ids: Option<&[String]>, limit: u32) -> Result<Vec<LabelLogRecord>> {
        let conn = self.conn();
        let limit = limit.clamp(1, 500);
        match message_ids {
            None => {
                let mut stmt = conn.prepare(&format!(
                    "SELECT {LOG_COLUMNS} FROM assist_label_log ORDER BY created_at DESC, id LIMIT {limit}"
                ))?;
                let rows = stmt.query_map([], log_row)?;
                Ok(rows.collect::<rusqlite::Result<_>>()?)
            }
            Some(ids) => {
                let mut stmt = conn.prepare(&format!(
                    "SELECT {LOG_COLUMNS} FROM assist_label_log WHERE message_id = ?1 ORDER BY created_at DESC, id"
                ))?;
                let mut out = Vec::new();
                for id in ids.iter().take(500) {
                    let rows = stmt.query_map([id], log_row)?;
                    out.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
                }
                out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| a.id.cmp(&b.id)));
                out.truncate(limit as usize);
                Ok(out)
            }
        }
    }

    pub fn label_log_entries(&self, ids: &[String]) -> Result<Vec<LabelLogRecord>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!("SELECT {LOG_COLUMNS} FROM assist_label_log WHERE id = ?1"))?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(entry) = stmt.query_row([id], log_row).optional()? {
                out.push(entry);
            }
        }
        Ok(out)
    }

    pub fn mark_label_undone(&self, id: &str) -> Result<()> {
        self.conn().execute("UPDATE assist_label_log SET undone = 1 WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Log entries older than `before` (unix seconds) go, and all older than the newest `keep`
    /// (entries of the same second as the last one kept stay too).
    pub fn forget_label_log_before(&self, before: i64, keep: usize) -> Result<usize> {
        let conn = self.conn();
        let old = conn.execute("DELETE FROM assist_label_log WHERE created_at < ?1", [before])?;
        let beyond = conn.execute(
            "DELETE FROM assist_label_log WHERE created_at <
                (SELECT created_at FROM assist_label_log ORDER BY created_at DESC LIMIT 1 OFFSET ?1)",
            [i64::try_from(keep.saturating_sub(1)).unwrap_or(i64::MAX)],
        )?;
        Ok(old + beyond)
    }

    // --------------------------------------------------------------- usage

    /// Counts one request.
    pub fn add_assist_usage(&self, row: &UsageRecord) -> Result<()> {
        self.conn().execute(
            "INSERT INTO assist_usage
                (day, provider_id, provider_name, feature, requests, input_tokens, output_tokens, cost_usd,
                 reasoning_tokens, cached_tokens, calls)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT (day, provider_id, feature) DO UPDATE SET requests = requests + excluded.requests,
                input_tokens = input_tokens + excluded.input_tokens,
                output_tokens = output_tokens + excluded.output_tokens, provider_name = excluded.provider_name,
                reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
                cached_tokens = cached_tokens + excluded.cached_tokens,
                calls = calls + excluded.calls,
                cost_usd = CASE WHEN excluded.cost_usd IS NULL THEN cost_usd
                                ELSE COALESCE(cost_usd, 0) + excluded.cost_usd END",
            params![
                row.day,
                row.provider_id,
                row.provider_name,
                row.feature,
                row.requests as i64,
                row.input_tokens as i64,
                row.output_tokens as i64,
                row.cost_usd,
                row.reasoning_tokens as i64,
                row.cached_tokens as i64,
                row.calls as i64
            ],
        )?;
        Ok(())
    }

    /// Usage from `since` (a UTC day) on, newest first.
    pub fn assist_usage(&self, since: &str) -> Result<Vec<UsageRecord>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT day, provider_id, provider_name, feature, requests, input_tokens, output_tokens, cost_usd,
                    reasoning_tokens, cached_tokens, calls
             FROM assist_usage WHERE day >= ?1 ORDER BY day DESC, provider_name, feature",
        )?;
        let count = |row: &rusqlite::Row<'_>, index: usize| row.get::<_, i64>(index).map(|n| n.max(0) as u64);
        let rows = stmt.query_map([since], |row| {
            Ok(UsageRecord {
                day: row.get(0)?,
                provider_id: row.get(1)?,
                provider_name: row.get(2)?,
                feature: row.get(3)?,
                requests: count(row, 4)?,
                input_tokens: count(row, 5)?,
                output_tokens: count(row, 6)?,
                cost_usd: row.get(7)?,
                reasoning_tokens: count(row, 8)?,
                cached_tokens: count(row, 9)?,
                calls: count(row, 10)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Keeps a real call for calibration; only the latest 50 per provider, model and feature stay.
    pub fn add_assist_calibration(&self, record: &CalibrationRecord) -> Result<()> {
        let conn = self.conn();
        let sample = &record.sample;
        conn.execute(
            "INSERT INTO assist_calibration (provider_id, model, feature, estimated_input, estimated_output,
                estimated_reasoning, input_tokens, output_tokens, reasoning_tokens, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                record.provider_id,
                record.model,
                record.feature,
                sample.estimated_input as i64,
                sample.estimated_output as i64,
                sample.estimated_reasoning as i64,
                sample.input as i64,
                sample.output as i64,
                sample.reasoning as i64,
                record.created_at
            ],
        )?;
        conn.execute(
            "DELETE FROM assist_calibration WHERE provider_id = ?1 AND model = ?2 AND feature = ?3 AND id NOT IN
                (SELECT id FROM assist_calibration WHERE provider_id = ?1 AND model = ?2 AND feature = ?3
                 ORDER BY id DESC LIMIT ?4)",
            params![record.provider_id, record.model, record.feature, CALIBRATION_KEPT],
        )?;
        Ok(())
    }

    /// The latest calls of a provider, model and feature, newest first.
    pub fn assist_calibration(
        &self,
        provider_id: &str,
        model: &str,
        feature: &str,
    ) -> Result<Vec<crate::assist::estimate::Sample>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT estimated_input, estimated_output, estimated_reasoning, input_tokens, output_tokens,
                    reasoning_tokens
             FROM assist_calibration WHERE provider_id = ?1 AND model = ?2 AND feature = ?3
             ORDER BY id DESC LIMIT ?4",
        )?;
        let count = |row: &rusqlite::Row<'_>, index: usize| row.get::<_, i64>(index).map(|n| n.max(0) as u64);
        let rows = stmt.query_map(params![provider_id, model, feature, CALIBRATION_KEPT], |row| {
            Ok(crate::assist::estimate::Sample {
                estimated_input: count(row, 0)?,
                estimated_output: count(row, 1)?,
                estimated_reasoning: count(row, 2)?,
                input: count(row, 3)?,
                output: count(row, 4)?,
                reasoning: count(row, 5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Calibration of a provider that is gone.
    pub fn forget_assist_calibration(&self, provider_id: &str) -> Result<usize> {
        Ok(self.conn().execute("DELETE FROM assist_calibration WHERE provider_id = ?1", [provider_id])?)
    }

    /// Usage older than `before` (a UTC day) goes.
    pub fn forget_assist_usage_before(&self, before: &str) -> Result<usize> {
        Ok(self.conn().execute("DELETE FROM assist_usage WHERE day < ?1", [before])?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;
    use crate::store::AccountRecord;

    fn store() -> (Store, String) {
        let store = Store::open_in_memory().unwrap();
        store
            .insert_account(&AccountRecord {
                id: "acc".into(),
                name: "Test".into(),
                email: "mia@example.org".into(),
                display_name: "Mia".into(),
                color: AccountColor::Pink,
                auth: AuthKind::Password,
                username: "mia@example.org".into(),
                imap: ServerSettings { host: "imap.example.org".into(), port: 993, security: Security::Tls },
                smtp: ServerSettings { host: "smtp.example.org".into(), port: 465, security: Security::Tls },
                protocol: Protocol::Imap,
                jmap_url: None,
            })
            .unwrap();
        let inbox = store
            .upsert_folder(
                "acc",
                &crate::store::FolderInfo {
                    path: "INBOX",
                    name: "Inbox",
                    role: Some(FolderRole::Inbox),
                    delimiter: Some("."),
                    selectable: true,
                    parent_ref: None,
                },
            )
            .unwrap();
        let raw = b"From: Leni <leni@example.com>\r\nTo: mia@example.org\r\nSubject: Rechnung\r\nMessage-ID: <1@example.com>\r\nDate: Mon, 5 Oct 2026 10:00:00 +0000\r\n\r\nHallo";
        let id = store
            .insert_message("acc", &inbox, 1, MessageFlags::default(), 100, None, &crate::mime::parse(raw))
            .unwrap()
            .unwrap();
        (store, id)
    }

    #[test]
    fn keywords_are_kept_per_message_and_show_in_threads() {
        let (store, id) = store();
        assert!(store.set_keywords(&id, &["Rechnungen".into(), "reisen".into(), "rechnungen".into()]).unwrap());
        assert!(!store.set_keywords(&id, &["reisen".into(), "rechnungen".into()]).unwrap(), "unchanged");
        let message = store.messages_by_ids(std::slice::from_ref(&id)).unwrap().pop().unwrap();
        assert_eq!(message.keywords, ["rechnungen", "reisen"]);
        store.change_keyword(std::slice::from_ref(&id), "reisen", false).unwrap();
        store.change_keyword(std::slice::from_ref(&id), "privat", true).unwrap();
        let thread = store.get_thread(&message.thread_id, true).unwrap().thread;
        assert_eq!(thread.keywords, ["privat", "rechnungen"]);
        let acc = ["acc".to_string()];
        assert_eq!(store.messages_with_keyword("privat", &acc, 10).unwrap(), std::slice::from_ref(&id));
        assert_eq!(store.messages_with_keyword(" Privat ", &acc, 10).unwrap(), std::slice::from_ref(&id));
        for none in ["priv", "%", "_rivat", "privat rechnungen", ""] {
            assert!(store.messages_with_keyword(none, &acc, 10).unwrap().is_empty(), "{none}");
        }
        assert!(store.messages_with_keyword("privat", &["other".to_string()], 10).unwrap().is_empty());
        assert!(store.messages_with_keyword("privat", &acc, 0).unwrap().is_empty());
    }

    #[test]
    fn learning_stays_bounded() {
        let (store, _) = store();
        for n in 0..5 {
            store.count_label_sender_within("g1", &format!("p{n}@example.org"), 3).unwrap();
        }
        store.count_label_sender_within("g1", "p4@example.org", 3).unwrap();
        store.count_label_sender_within("g2", "p0@example.org", 3).unwrap();
        let kept = |address: &str| store.label_senders(address).unwrap().get("g1").copied();
        // The ones counted least and oldest went; the label counted twice stays.
        assert_eq!((kept("p0@example.org"), kept("p1@example.org")), (None, None));
        assert_eq!(
            (kept("p2@example.org"), kept("p3@example.org"), kept("p4@example.org")),
            (Some(1), Some(1), Some(2))
        );
        assert_eq!(store.label_senders("p0@example.org").unwrap().get("g2"), Some(&1), "per label");
        let long = format!("{}@example.org", "x".repeat(400));
        store.count_label_sender("g1", &long).unwrap();
        assert!(store.label_senders(&long).unwrap().is_empty());

        // The log keeps the newest entries only.
        for n in 0..6 {
            let entry = LabelLogRecord {
                id: format!("l{n}"),
                account_id: "acc".into(),
                message_id: "m".into(),
                label_id: "g1".into(),
                name: "R".into(),
                keyword: "r".into(),
                reason: String::new(),
                source: "rule".into(),
                code: "rule".into(),
                params: "{}".into(),
                provider_name: None,
                model: None,
                created_at: 1000 + n,
                undone: false,
            };
            store.insert_label_log(&entry).unwrap();
        }
        assert_eq!(store.forget_label_log_before(1001, 3).unwrap(), 3);
        let left: Vec<String> = store.label_log(None, 10).unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(left, ["l5", "l4", "l3"]);
    }

    #[test]
    fn labels_log_and_usage() {
        let (store, id) = store();
        let label =
            Label { description: "Rechnungen und Quittungen".into(), ..Label::named("g1", "Rechnungen", "rechnungen") };
        store.insert_assist_label(&label, 1).unwrap();
        assert!(store.insert_assist_label(&Label { id: "g2".into(), ..label.clone() }, 2).is_err(), "keyword unique");
        let entry = LabelLogRecord {
            id: "l1".into(),
            account_id: "acc".into(),
            message_id: id.clone(),
            label_id: "g1".into(),
            name: "Rechnungen".into(),
            keyword: "rechnungen".into(),
            reason: "Eine Rechnung".into(),
            source: "ai".into(),
            code: "ai".into(),
            params: "{}".into(),
            provider_name: Some("Mistral".into()),
            model: None,
            created_at: 100,
            undone: false,
        };
        store.insert_label_log(&entry).unwrap();
        assert_eq!(store.label_log(Some(std::slice::from_ref(&id)), 10).unwrap(), std::slice::from_ref(&entry));
        store.mark_label_undone("l1").unwrap();
        assert!(store.label_log(None, 10).unwrap()[0].undone);
        store.delete_assist_label("g1").unwrap();
        assert!(store.label_log(None, 10).unwrap().is_empty(), "a deleted label's log goes");

        let row = UsageRecord {
            day: "2026-09-29".into(),
            provider_id: "p1".into(),
            provider_name: "Mistral".into(),
            feature: "summarize".into(),
            requests: 1,
            input_tokens: 10,
            output_tokens: 5,
            reasoning_tokens: 7,
            cached_tokens: 2,
            calls: 1,
            cost_usd: Some(0.25),
        };
        store.add_assist_usage(&row).unwrap();
        store.add_assist_usage(&row).unwrap();
        // A request whose price was unknown adds nothing to the cost.
        store.add_assist_usage(&UsageRecord { cost_usd: None, ..row.clone() }).unwrap();
        let rows = store.assist_usage("2026-09-01").unwrap();
        assert_eq!((rows[0].requests, rows[0].input_tokens), (3, 30));
        assert_eq!((rows[0].reasoning_tokens, rows[0].cached_tokens, rows[0].calls), (21, 6, 3));
        assert_eq!(rows[0].cost_usd, Some(0.5));
        store.add_assist_usage(&UsageRecord { feature: "compose".into(), cost_usd: None, ..row.clone() }).unwrap();
        let unknown = store.assist_usage("2026-09-01").unwrap().into_iter().find(|r| r.feature == "compose").unwrap();
        assert_eq!(unknown.cost_usd, None);
        assert!(store.assist_usage("2026-09-30").unwrap().is_empty());
    }

    #[test]
    fn calibration_keeps_the_latest_fifty() {
        let (store, _) = store();
        let record = |n: u64, model: &str| CalibrationRecord {
            provider_id: "p1".into(),
            model: model.into(),
            feature: "spamCheck".into(),
            sample: crate::assist::estimate::Sample { estimated_input: 100, input: n, ..Default::default() },
            created_at: n as i64,
        };
        for n in 1..=60 {
            store.add_assist_calibration(&record(n, "small")).unwrap();
        }
        store.add_assist_calibration(&record(7, "big")).unwrap();
        let samples = store.assist_calibration("p1", "small", "spamCheck").unwrap();
        assert_eq!(samples.len(), 50);
        assert_eq!((samples[0].input, samples[49].input), (60, 11), "newest first");
        assert_eq!(store.assist_calibration("p1", "big", "spamCheck").unwrap().len(), 1);
        assert!(store.assist_calibration("p1", "small", "summarize").unwrap().is_empty());
        store.forget_assist_calibration("p1").unwrap();
        assert!(store.assist_calibration("p1", "big", "spamCheck").unwrap().is_empty());
    }

    #[test]
    fn corrections_keep_the_newest_few_and_blocked_senders_count_again() {
        let (store, _) = store();
        for n in 0..6 {
            let subject = format!("Rechnung {n}   mit   Abstand {}", "x".repeat(200));
            store.keep_label_shot("g1", &format!("m{n}"), true, "stadtwerke.example", &subject, "Anbei", n).unwrap();
        }
        store.keep_label_shot("g1", "m9", false, "shop.example", "Angebot", "Rabatt", 10).unwrap();
        store.keep_label_shot("g2", "m9", true, "shop.example", "Angebot", "Rabatt", 11).unwrap();
        let shots = store.label_shots().unwrap();
        let positive: Vec<&LabelShot> = shots.iter().filter(|s| s.label_id == "g1" && s.positive).collect();
        assert_eq!(positive.len() as i64, MAX_SHOTS_POSITIVE);
        assert!(positive[0].subject.starts_with("Rechnung 5 mit Abstand"), "newest first, one space between words");
        assert_eq!(positive[0].subject.chars().count(), SHOT_SUBJECT_CHARS + 1, "cut, with an ellipsis");
        assert_eq!(shots.iter().filter(|s| s.label_id == "g1" && !s.positive).count(), 1);
        assert_eq!(shots[0].label_id, "g2");

        let count = |address: &str| store.label_senders(address).unwrap().get("g1").copied();
        store.count_label_sender("g1", "leni@example.com").unwrap();
        store.count_label_sender("g1", "leni@example.com").unwrap();
        store.block_label_sender("g1", "leni@example.com").unwrap();
        assert_eq!(count("leni@example.com"), Some(-1));
        store.block_label_sender("g1", "tom@example.com").unwrap();
        assert_eq!(count("tom@example.com"), Some(-1), "blocked without being counted first");
        store.count_label_sender("g1", "leni@example.com").unwrap();
        assert_eq!(count("leni@example.com"), Some(1), "put on by hand again, it counts from one");
        store.delete_assist_label("g1").unwrap();
        assert!(store.label_shots().unwrap().iter().all(|s| s.label_id != "g1"));
    }

    /// Digits of any script are masked like ASCII ones (the server's R3 I-5).
    #[test]
    fn masking_covers_unicode_digits_and_mixed_codes() {
        assert_eq!(masked("Kunde ４８２９１３ heute"), "Kunde ###### heute");
        assert_eq!(masked("رقم ٤٨٢٩١٣"), "رقم ######");
        assert_eq!(masked("Code AB７-K2X für MP3"), "Code ###-### für MP3");
        assert_eq!(masked("Tag 12, Seite 3"), "Tag 12, Seite 3");
    }

    /// C3-6: codes, account numbers and links never go into a correction; a mail with a one-time
    /// code keeps none at all.
    #[test]
    fn corrections_mask_codes_and_links() {
        let (store, _) = store();
        store
            .keep_label_shot(
                "g1",
                "m1",
                true,
                "bank.example",
                "Konto 1234 5678 9012, Gutschein AB7-K2X",
                "Zurücksetzen: https://bank.example/reset?t=abc oder www.bank.example, Bestellung 42",
                1,
            )
            .unwrap();
        let shot = &store.label_shots().unwrap()[0];
        assert_eq!(shot.subject, "Konto #### #### ####, Gutschein ###-###");
        assert_eq!(shot.snippet, "Zurücksetzen: [link] oder [link] Bestellung 42");
        store.keep_label_shot("g1", "m2", true, "bank.example", "Dein Code", "Dein Code: 482913", 2).unwrap();
        assert_eq!(store.label_shots().unwrap().len(), 1, "a one-time code mail keeps no example");
        store.forget_label_shots().unwrap();
        assert!(store.label_shots().unwrap().is_empty());
    }

    #[test]
    fn sender_history_counts() {
        let (store, _) = store();
        assert_eq!(store.sender_history("leni@example.com", i64::MAX).unwrap().0, 1);
        assert_eq!(store.sender_history("LENI@example.com", 0).unwrap().0, 0);
        assert_eq!(store.sender_history("other@example.com", i64::MAX).unwrap().0, 0);
    }
}
