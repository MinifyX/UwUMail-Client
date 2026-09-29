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

/// A provider set up on this device.
#[derive(Debug, Clone, PartialEq, Eq)]
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
}

/// A label the model set, as the log keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelLogRecord {
    pub id: String,
    pub account_id: String,
    pub message_id: String,
    pub label_id: String,
    pub name: String,
    pub keyword: String,
    pub reason: String,
    pub provider_name: Option<String>,
    pub model: Option<String>,
    pub created_at: i64,
    pub undone: bool,
}

/// One row of usage: a day (UTC, `YYYY-MM-DD`), a provider and a feature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageRecord {
    pub day: String,
    pub provider_id: String,
    pub provider_name: String,
    pub feature: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

const LOG_COLUMNS: &str =
    "id, account_id, message_id, label_id, name, keyword, reason, provider_name, model, created_at, undone";

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
    })
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
            "SELECT id, name, kind, base_url, model, fast_model, key_hint, created_at FROM assist_providers
             ORDER BY created_at, rowid",
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
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Adds or replaces a provider.
    pub fn save_assist_provider(&self, provider: &ProviderRecord) -> Result<()> {
        self.conn().execute(
            "INSERT INTO assist_providers (id, name, kind, base_url, model, fast_model, key_hint, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url,
                model = excluded.model, fast_model = excluded.fast_model, key_hint = excluded.key_hint",
            params![
                provider.id,
                provider.name,
                provider.kind,
                provider.base_url,
                provider.model,
                provider.fast_model,
                provider.key_hint,
                provider.created_at
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
        let mut stmt =
            conn.prepare("SELECT id, name, description, keyword, color FROM assist_labels ORDER BY created_at, rowid")?;
        let rows = stmt.query_map([], |row| {
            Ok(Label {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                keyword: row.get(3)?,
                color: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn insert_assist_label(&self, label: &Label, created_at: i64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO assist_labels (id, name, description, keyword, color, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![label.id, label.name, label.description, label.keyword, label.color, created_at],
        )?;
        Ok(())
    }

    /// Changes name, description and color; the keyword stays.
    pub fn update_assist_label(&self, label: &Label) -> Result<bool> {
        Ok(self.conn().execute(
            "UPDATE assist_labels SET name = ?2, description = ?3, color = ?4 WHERE id = ?1",
            params![label.id, label.name, label.description, label.color],
        )? > 0)
    }

    /// Deletes a label and forgets its log.
    pub fn delete_assist_label(&self, id: &str) -> Result<bool> {
        let conn = self.conn();
        conn.execute("DELETE FROM assist_label_log WHERE label_id = ?1", [id])?;
        Ok(conn.execute("DELETE FROM assist_labels WHERE id = ?1", [id])? > 0)
    }

    /// Messages that carry a keyword, with their account: to take a deleted label off.
    pub fn messages_with_keyword(&self, keyword: &str) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT id FROM messages WHERE (' ' || keywords || ' ') LIKE ?1")?;
        let pattern = format!("% {} %", keyword.replace(['%', '_'], ""));
        let rows = stmt.query_map([pattern], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    // ----------------------------------------------------------- label log

    pub fn insert_label_log(&self, entry: &LabelLogRecord) -> Result<()> {
        self.conn().execute(
            &format!(
                "INSERT INTO assist_label_log ({LOG_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
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
                entry.undone
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

    /// Log entries older than `before` (unix seconds) go.
    pub fn forget_label_log_before(&self, before: i64) -> Result<usize> {
        Ok(self.conn().execute("DELETE FROM assist_label_log WHERE created_at < ?1", [before])?)
    }

    // --------------------------------------------------------------- usage

    /// Counts one request.
    pub fn add_assist_usage(&self, row: &UsageRecord) -> Result<()> {
        self.conn().execute(
            "INSERT INTO assist_usage (day, provider_id, provider_name, feature, requests, input_tokens, output_tokens)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (day, provider_id, feature) DO UPDATE SET requests = requests + excluded.requests,
                input_tokens = input_tokens + excluded.input_tokens,
                output_tokens = output_tokens + excluded.output_tokens, provider_name = excluded.provider_name",
            params![
                row.day,
                row.provider_id,
                row.provider_name,
                row.feature,
                row.requests as i64,
                row.input_tokens as i64,
                row.output_tokens as i64
            ],
        )?;
        Ok(())
    }

    /// Usage from `since` (a UTC day) on, newest first.
    pub fn assist_usage(&self, since: &str) -> Result<Vec<UsageRecord>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT day, provider_id, provider_name, feature, requests, input_tokens, output_tokens
             FROM assist_usage WHERE day >= ?1 ORDER BY day DESC, provider_name, feature",
        )?;
        let rows = stmt.query_map([since], |row| {
            Ok(UsageRecord {
                day: row.get(0)?,
                provider_id: row.get(1)?,
                provider_name: row.get(2)?,
                feature: row.get(3)?,
                requests: row.get::<_, i64>(4)?.max(0) as u64,
                input_tokens: row.get::<_, i64>(5)?.max(0) as u64,
                output_tokens: row.get::<_, i64>(6)?.max(0) as u64,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
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
        assert_eq!(store.messages_with_keyword("privat").unwrap(), std::slice::from_ref(&id));
        assert!(store.messages_with_keyword("priv").unwrap().is_empty());
    }

    #[test]
    fn labels_log_and_usage() {
        let (store, id) = store();
        let label = Label {
            id: "g1".into(),
            name: "Rechnungen".into(),
            description: "Rechnungen und Quittungen".into(),
            keyword: "rechnungen".into(),
            color: None,
        };
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
        };
        store.add_assist_usage(&row).unwrap();
        store.add_assist_usage(&row).unwrap();
        let rows = store.assist_usage("2026-09-01").unwrap();
        assert_eq!((rows[0].requests, rows[0].input_tokens), (2, 20));
        assert!(store.assist_usage("2026-09-30").unwrap().is_empty());
    }

    #[test]
    fn sender_history_counts() {
        let (store, _) = store();
        assert_eq!(store.sender_history("leni@example.com", i64::MAX).unwrap().0, 1);
        assert_eq!(store.sender_history("LENI@example.com", 0).unwrap().0, 0);
        assert_eq!(store.sender_history("other@example.com", i64::MAX).unwrap().0, 0);
    }
}
