//! Local SQLite cache. The IMAP server stays the source of truth; everything
//! here can be deleted and rebuilt by syncing again.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter, types::Value};

use crate::error::{Error, Result};
use crate::mime::{ParsedMessage, iso8601};
use crate::model::*;

const MIGRATIONS: &[&str] = &[
    r#"
CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    color TEXT NOT NULL,
    auth TEXT NOT NULL,
    username TEXT NOT NULL,
    imap_host TEXT NOT NULL,
    imap_port INTEGER NOT NULL,
    imap_security TEXT NOT NULL,
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL,
    smtp_security TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT,
    uid_validity INTEGER,
    uid_next INTEGER,
    UNIQUE (account_id, path)
);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    uid INTEGER NOT NULL,
    message_id TEXT,
    in_reply_to TEXT,
    refs TEXT NOT NULL DEFAULT '',
    thread_id TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    from_json TEXT NOT NULL,
    to_json TEXT NOT NULL,
    cc_json TEXT NOT NULL,
    reply_to_json TEXT NOT NULL,
    date INTEGER NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    flagged INTEGER NOT NULL DEFAULT 0,
    answered INTEGER NOT NULL DEFAULT 0,
    draft INTEGER NOT NULL DEFAULT 0,
    snippet TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    has_body INTEGER NOT NULL DEFAULT 0,
    body_html TEXT,
    body_text TEXT,
    has_remote INTEGER NOT NULL DEFAULT 0,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE (folder_id, uid)
);
CREATE INDEX messages_by_thread ON messages (thread_id, date);
CREATE INDEX messages_by_folder ON messages (folder_id, date DESC);
CREATE INDEX messages_by_message_id ON messages (account_id, message_id);
CREATE INDEX messages_by_parent ON messages (account_id, in_reply_to);

CREATE VIRTUAL TABLE messages_fts USING fts5 (
    subject, sender, recipients, body,
    content = '', contentless_delete = 1,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE contacts (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    name TEXT,
    times INTEGER NOT NULL DEFAULT 0,
    last_used INTEGER NOT NULL
);

CREATE TABLE addon_storage (
    addon_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (addon_id, key)
);
"#,
    r#"
-- Folder hierarchy: the server's delimiter, and containers that hold folders but no mail.
ALTER TABLE folders ADD COLUMN delimiter TEXT;
ALTER TABLE folders ADD COLUMN selectable INTEGER NOT NULL DEFAULT 1;
"#,
    r#"
-- JMAP: accounts pick a protocol, mailboxes point at their parent by id,
-- emails keep their server id and blob, and sync resumes from saved states.
ALTER TABLE accounts ADD COLUMN protocol TEXT NOT NULL DEFAULT 'imap';
ALTER TABLE accounts ADD COLUMN jmap_url TEXT;
ALTER TABLE folders ADD COLUMN parent_ref TEXT;
ALTER TABLE messages ADD COLUMN remote_id TEXT;
ALTER TABLE messages ADD COLUMN blob_id TEXT;
CREATE INDEX messages_by_remote_id ON messages (account_id, remote_id);
CREATE TABLE sync_state (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (account_id, kind)
);
"#,
];

/// A stable positive stand-in for IMAP's uid, so JMAP emails fit the same table.
fn remote_uid(remote_id: &str) -> i64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in remote_id.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    (hash >> 2) as i64 + 1
}

/// Everything about an account except its secret.
#[derive(Debug, Clone)]
pub struct AccountRecord {
    pub id: String,
    pub name: String,
    pub email: String,
    pub display_name: String,
    pub color: AccountColor,
    pub auth: AuthKind,
    pub username: String,
    pub imap: ServerSettings,
    pub smtp: ServerSettings,
    pub protocol: Protocol,
    /// The JMAP session URL, also kept for IMAP accounts so they can switch.
    pub jmap_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FolderRecord {
    pub id: String,
    pub account_id: String,
    pub path: String,
    pub role: Option<FolderRole>,
    pub uid_validity: Option<u32>,
    pub uid_next: Option<u32>,
    pub selectable: bool,
    pub delimiter: Option<String>,
}

/// A folder as the server lists it.
#[derive(Debug, Clone)]
pub struct FolderInfo<'a> {
    pub path: &'a str,
    pub name: &'a str,
    pub role: Option<FolderRole>,
    pub delimiter: Option<&'a str>,
    pub selectable: bool,
    /// The parent's path, for servers that name parents instead of nesting paths (JMAP).
    pub parent_ref: Option<&'a str>,
}

struct FolderRow {
    folder: Folder,
    delimiter: Option<String>,
    parent_ref: Option<String>,
}

/// Works out each folder's parent from its path.
///
/// System folders always stay at the top, even when a server files them under
/// INBOX. If every folder lives under `INBOX.` (Courier-style namespaces),
/// that prefix is treated as the namespace and not as a parent.
fn assign_parents(rows: &mut [FolderRow]) {
    let mut by_account: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        by_account.entry(row.folder.account_id.clone()).or_default().push(index);
    }
    for indexes in by_account.values() {
        let is_inbox = |path: &str| path.eq_ignore_ascii_case("INBOX");
        let under_inbox = |row: &FolderRow| {
            row.delimiter.as_deref().is_some_and(|d| {
                let path = row.folder.path.as_str();
                path.get(..5).is_some_and(|head| head.eq_ignore_ascii_case("INBOX"))
                    && path.get(5..).is_some_and(|rest| rest.len() > d.len() && rest.starts_with(d))
            })
        };
        let others: Vec<usize> = indexes.iter().copied().filter(|&i| !is_inbox(&rows[i].folder.path)).collect();
        let inbox_is_namespace = !others.is_empty() && others.iter().all(|&i| under_inbox(&rows[i]));
        let paths: std::collections::HashMap<String, String> =
            indexes.iter().map(|&i| (rows[i].folder.path.clone(), rows[i].folder.id.clone())).collect();

        for &i in indexes {
            let row = &rows[i];
            let parent = if row.folder.role.is_some() {
                None
            } else if let Some(parent_ref) = &row.parent_ref {
                paths.get(parent_ref).cloned()
            } else {
                row.delimiter
                    .as_deref()
                    .filter(|d| !d.is_empty())
                    .and_then(|d| row.folder.path.rsplit_once(d))
                    .map(|(parent_path, _)| parent_path)
                    .filter(|parent_path| !(inbox_is_namespace && is_inbox(parent_path)))
                    .and_then(|parent_path| paths.get(parent_path).cloned())
            };
            rows[i].folder.parent_id = parent;
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct StoredFlags {
    pub uid: u32,
    pub flags: MessageFlags,
}

/// Where a message lives on the server.
#[derive(Debug, Clone)]
pub struct MessageLocation {
    pub id: String,
    pub account_id: String,
    pub folder_id: String,
    pub folder_path: String,
    pub uid: i64,
    pub message_id: Option<String>,
    /// JMAP email id and blob id; `None` for IMAP.
    pub remote_id: Option<String>,
    pub blob_id: Option<String>,
}

/// What the store knows about a JMAP email, to compare with the server.
#[derive(Debug, Clone)]
pub struct RemoteMessage {
    pub id: String,
    pub folder_id: String,
    pub flags: MessageFlags,
}

pub struct Store {
    conn: Mutex<Connection>,
}

fn json<T: serde::Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}

fn from_json<T: serde::de::DeserializeOwned + Default>(text: &str) -> T {
    serde_json::from_str(text).unwrap_or_default()
}

/// Turns user input into an FTS5 prefix query: `leni clip` → `"leni"* "clip"*`.
fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .map(|term| term.replace('"', ""))
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{term}\"*"))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        for (index, migration) in MIGRATIONS.iter().enumerate().skip(usize::try_from(version).unwrap_or(0)) {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(migration)?;
            tx.pragma_update(None, "user_version", (index + 1) as i64)?;
            tx.commit()?;
        }
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // ---------------------------------------------------------------- accounts

    pub fn insert_account(&self, account: &AccountRecord) -> Result<()> {
        self.conn().execute(
            "INSERT INTO accounts (id, name, email, display_name, color, auth, username,
                imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, created_at, protocol, jmap_url)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                account.id,
                account.name,
                account.email,
                account.display_name,
                account.color.as_str(),
                account.auth.as_str(),
                account.username,
                account.imap.host,
                account.imap.port,
                account.imap.security.as_str(),
                account.smtp.host,
                account.smtp.port,
                account.smtp.security.as_str(),
                crate::mime::now(),
                account.protocol.as_str(),
                account.jmap_url,
            ],
        )?;
        Ok(())
    }

    pub fn set_account_protocol(&self, id: &str, protocol: Protocol) -> Result<()> {
        self.conn().execute("UPDATE accounts SET protocol = ?1 WHERE id = ?2", params![protocol.as_str(), id])?;
        Ok(())
    }

    /// Forgets all mail, folders and sync states of an account, e.g. before syncing it over another protocol.
    pub fn clear_account_mail(&self, account_id: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE account_id = ?1)",
            [account_id],
        )?;
        conn.execute("DELETE FROM messages WHERE account_id = ?1", [account_id])?;
        conn.execute("DELETE FROM folders WHERE account_id = ?1", [account_id])?;
        conn.execute("DELETE FROM sync_state WHERE account_id = ?1", [account_id])?;
        Ok(())
    }

    pub fn sync_state(&self, account_id: &str, kind: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT state FROM sync_state WHERE account_id = ?1 AND kind = ?2",
                params![account_id, kind],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn set_sync_state(&self, account_id: &str, kind: &str, state: Option<&str>) -> Result<()> {
        let conn = self.conn();
        match state {
            Some(state) => conn.execute(
                "INSERT INTO sync_state (account_id, kind, state) VALUES (?1, ?2, ?3)
                 ON CONFLICT (account_id, kind) DO UPDATE SET state = excluded.state",
                params![account_id, kind, state],
            )?,
            None => {
                conn.execute("DELETE FROM sync_state WHERE account_id = ?1 AND kind = ?2", params![account_id, kind])?
            }
        };
        Ok(())
    }

    fn account_from_row(row: &Row<'_>) -> rusqlite::Result<AccountRecord> {
        Ok(AccountRecord {
            id: row.get("id")?,
            name: row.get("name")?,
            email: row.get("email")?,
            display_name: row.get("display_name")?,
            color: AccountColor::parse(&row.get::<_, String>("color")?),
            auth: AuthKind::parse(&row.get::<_, String>("auth")?),
            username: row.get("username")?,
            imap: ServerSettings {
                host: row.get("imap_host")?,
                port: row.get("imap_port")?,
                security: Security::parse(&row.get::<_, String>("imap_security")?),
            },
            smtp: ServerSettings {
                host: row.get("smtp_host")?,
                port: row.get("smtp_port")?,
                security: Security::parse(&row.get::<_, String>("smtp_security")?),
            },
            protocol: Protocol::parse(&row.get::<_, String>("protocol")?),
            jmap_url: row.get("jmap_url")?,
        })
    }

    pub fn accounts(&self) -> Result<Vec<AccountRecord>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM accounts ORDER BY created_at")?;
        let rows = stmt.query_map([], Self::account_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn account(&self, id: &str) -> Result<AccountRecord> {
        Ok(self.conn().query_row("SELECT * FROM accounts WHERE id = ?1", [id], Self::account_from_row)?)
    }

    pub fn delete_account(&self, id: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE account_id = ?1)",
            [id],
        )?;
        conn.execute("DELETE FROM accounts WHERE id = ?1", [id])?;
        Ok(())
    }

    // ----------------------------------------------------------------- folders

    /// Creates or updates a folder and returns its id.
    pub fn upsert_folder(&self, account_id: &str, info: &FolderInfo<'_>) -> Result<String> {
        let conn = self.conn();
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM folders WHERE account_id = ?1 AND path = ?2",
                params![account_id, info.path],
                |row| row.get(0),
            )
            .optional()?;
        let role = info.role.map(FolderRole::as_str);
        if let Some(id) = existing {
            conn.execute(
                "UPDATE folders SET name = ?1, role = ?2, delimiter = ?3, selectable = ?4, parent_ref = ?5 WHERE id = ?6",
                params![info.name, role, info.delimiter, info.selectable, info.parent_ref, id],
            )?;
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO folders (id, account_id, path, name, role, delimiter, selectable, parent_ref)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, account_id, info.path, info.name, role, info.delimiter, info.selectable, info.parent_ref],
        )?;
        Ok(id)
    }

    /// Drops folders that no longer exist on the server.
    pub fn retain_folders(&self, account_id: &str, paths: &HashSet<String>) -> Result<()> {
        let stale: Vec<(String, String)> = {
            let conn = self.conn();
            let mut stmt = conn.prepare("SELECT id, path FROM folders WHERE account_id = ?1")?;
            let rows = stmt.query_map([account_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?.into_iter().filter(|(_, path)| !paths.contains(path)).collect()
        };
        for (id, _) in stale {
            self.clear_folder(&id)?;
            self.conn().execute("DELETE FROM folders WHERE id = ?1", [id])?;
        }
        Ok(())
    }

    pub fn folders(&self, account_id: Option<&str>) -> Result<Vec<Folder>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT f.id, f.account_id, f.name, f.path, f.role, f.delimiter, f.selectable,
                    COUNT(m.id) AS total, COALESCE(SUM(m.seen = 0), 0) AS unread, f.parent_ref
             FROM folders f LEFT JOIN messages m ON m.folder_id = f.id
             WHERE ?1 IS NULL OR f.account_id = ?1
             GROUP BY f.id ORDER BY f.path",
        )?;
        let rows = stmt.query_map([account_id], |row| {
            Ok(FolderRow {
                folder: Folder {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    name: row.get(2)?,
                    path: row.get(3)?,
                    role: row.get::<_, Option<String>>(4)?.as_deref().and_then(FolderRole::parse),
                    parent_id: None,
                    selectable: row.get(6)?,
                    total: row.get(7)?,
                    unread: row.get(8)?,
                },
                delimiter: row.get(5)?,
                parent_ref: row.get(9)?,
            })
        })?;
        let mut rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        assign_parents(&mut rows);
        Ok(rows.into_iter().map(|row| row.folder).collect())
    }

    fn folder_from_row(row: &Row<'_>) -> rusqlite::Result<FolderRecord> {
        Ok(FolderRecord {
            id: row.get("id")?,
            account_id: row.get("account_id")?,
            path: row.get("path")?,
            role: row.get::<_, Option<String>>("role")?.as_deref().and_then(FolderRole::parse),
            uid_validity: row.get("uid_validity")?,
            uid_next: row.get("uid_next")?,
            selectable: row.get("selectable")?,
            delimiter: row.get("delimiter")?,
        })
    }

    pub fn folder(&self, id: &str) -> Result<FolderRecord> {
        Ok(self.conn().query_row("SELECT * FROM folders WHERE id = ?1", [id], Self::folder_from_row)?)
    }

    pub fn folder_records(&self, account_id: &str) -> Result<Vec<FolderRecord>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM folders WHERE account_id = ?1")?;
        let rows = stmt.query_map([account_id], Self::folder_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn folder_by_role(&self, account_id: &str, role: FolderRole) -> Result<Option<FolderRecord>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT * FROM folders WHERE account_id = ?1 AND role = ?2",
                params![account_id, role.as_str()],
                Self::folder_from_row,
            )
            .optional()?)
    }

    pub fn set_folder_state(&self, id: &str, uid_validity: u32, uid_next: Option<u32>) -> Result<()> {
        self.conn().execute(
            "UPDATE folders SET uid_validity = ?1, uid_next = ?2 WHERE id = ?3",
            params![uid_validity, uid_next, id],
        )?;
        Ok(())
    }

    /// Removes all cached messages of a folder, e.g. after UIDVALIDITY changed.
    pub fn clear_folder(&self, folder_id: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE folder_id = ?1)",
            [folder_id],
        )?;
        conn.execute("DELETE FROM messages WHERE folder_id = ?1", [folder_id])?;
        Ok(())
    }

    // ---------------------------------------------------------------- messages

    pub fn max_uid(&self, folder_id: &str) -> Result<u32> {
        Ok(self.conn().query_row(
            "SELECT COALESCE(MAX(uid), 0) FROM messages WHERE folder_id = ?1 AND uid > 0",
            [folder_id],
            |row| row.get(0),
        )?)
    }

    pub fn stored_flags(&self, folder_id: &str) -> Result<Vec<StoredFlags>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT uid, seen, flagged, answered, draft FROM messages WHERE folder_id = ?1 AND uid > 0")?;
        let rows = stmt.query_map([folder_id], |row| {
            Ok(StoredFlags {
                uid: row.get(0)?,
                flags: MessageFlags {
                    seen: row.get(1)?,
                    flagged: row.get(2)?,
                    answered: row.get(3)?,
                    draft: row.get(4)?,
                },
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Stores a message synced from the server. Returns the new id, or `None`
    /// when the message was already known.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_message(
        &self,
        account_id: &str,
        folder_id: &str,
        uid: u32,
        flags: MessageFlags,
        size: u64,
        internal_date: Option<i64>,
        parsed: &ParsedMessage,
    ) -> Result<Option<String>> {
        self.insert(account_id, folder_id, i64::from(uid), None, flags, size, internal_date, parsed)
    }

    /// Stores an email synced over JMAP. Returns `None` when it was already known.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_jmap_message(
        &self,
        account_id: &str,
        folder_id: &str,
        remote_id: &str,
        blob_id: &str,
        flags: MessageFlags,
        size: u64,
        received_at: Option<i64>,
        parsed: &ParsedMessage,
    ) -> Result<Option<String>> {
        let uid = remote_uid(remote_id);
        self.insert(account_id, folder_id, uid, Some((remote_id, blob_id)), flags, size, received_at, parsed)
    }

    #[allow(clippy::too_many_arguments)]
    fn insert(
        &self,
        account_id: &str,
        folder_id: &str,
        uid: i64,
        remote: Option<(&str, &str)>,
        flags: MessageFlags,
        size: u64,
        internal_date: Option<i64>,
        parsed: &ParsedMessage,
    ) -> Result<Option<String>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;

        let exists: bool = match remote {
            Some((remote_id, _)) => tx.query_row(
                "SELECT 1 FROM messages WHERE account_id = ?1 AND remote_id = ?2",
                params![account_id, remote_id],
                |_| Ok(()),
            ),
            None => tx.query_row(
                "SELECT 1 FROM messages WHERE folder_id = ?1 AND uid = ?2",
                params![folder_id, uid],
                |_| Ok(()),
            ),
        }
        .optional()?
        .is_some();
        if exists {
            return Ok(None);
        }

        // A local IMAP move leaves a placeholder with a negative uid until the target folder syncs.
        if remote.is_none()
            && let Some(message_id) = &parsed.message_id
        {
            let placeholder: Option<String> = tx
                .query_row(
                    "SELECT id FROM messages WHERE folder_id = ?1 AND uid < 0 AND message_id = ?2",
                    params![folder_id, message_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(id) = placeholder {
                tx.execute("UPDATE messages SET uid = ?1 WHERE id = ?2", params![uid, id])?;
                tx.commit()?;
                return Ok(None);
            }
        }

        let id = uuid::Uuid::new_v4().to_string();
        let thread_id = Self::find_thread(&tx, account_id, parsed)?.unwrap_or_else(|| id.clone());
        let date = parsed.date.or(internal_date).unwrap_or_else(crate::mime::now);
        let from = parsed.from.clone().unwrap_or(Address { name: None, email: String::new() });
        let attachments: Vec<Attachment> = parsed
            .attachments
            .iter()
            .enumerate()
            .map(|(index, a)| Attachment {
                id: format!("{id}:{index}"),
                filename: a.filename.clone(),
                mime_type: a.mime_type.clone(),
                size: a.size,
                inline: a.inline,
            })
            .collect();

        tx.execute(
            "INSERT INTO messages (id, account_id, folder_id, uid, message_id, in_reply_to, refs, thread_id, subject,
                from_json, to_json, cc_json, reply_to_json, date, seen, flagged, answered, draft, snippet, size,
                has_body, body_html, body_text, has_remote, attachments_json, remote_id, blob_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                ?21, ?22, ?23, ?24, ?25, ?26, ?27)",
            params![
                id,
                account_id,
                folder_id,
                uid,
                parsed.message_id,
                parsed.in_reply_to,
                parsed.references.join(" "),
                thread_id,
                parsed.subject,
                json(&from)?,
                json(&parsed.to)?,
                json(&parsed.cc)?,
                json(&parsed.reply_to)?,
                date,
                flags.seen,
                flags.flagged,
                flags.answered,
                flags.draft,
                parsed.snippet,
                i64::try_from(size).unwrap_or(i64::MAX),
                parsed.has_body,
                parsed.html,
                parsed.text,
                parsed.has_remote_content,
                json(&attachments)?,
                remote.map(|(remote_id, _)| remote_id),
                remote.map(|(_, blob_id)| blob_id),
            ],
        )?;

        let rowid = tx.last_insert_rowid();
        Self::index(&tx, rowid, parsed, &from)?;

        // Replies that arrived before their parent join this thread now.
        if let Some(message_id) = &parsed.message_id {
            let orphans: Vec<String> = {
                let mut stmt = tx.prepare(
                    "SELECT DISTINCT thread_id FROM messages
                     WHERE account_id = ?1 AND thread_id != ?2
                       AND (in_reply_to = ?3 OR (' ' || refs || ' ') LIKE ('% ' || ?3 || ' %'))",
                )?;
                let rows = stmt.query_map(params![account_id, thread_id, message_id], |row| row.get(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            for orphan in orphans {
                tx.execute(
                    "UPDATE messages SET thread_id = ?1 WHERE account_id = ?2 AND thread_id = ?3",
                    params![thread_id, account_id, orphan],
                )?;
            }
        }

        let when = date;
        let people: Vec<&Address> = std::iter::once(&from).chain(parsed.to.iter()).chain(parsed.cc.iter()).collect();
        for person in people.into_iter().filter(|p| !p.email.is_empty()) {
            tx.execute(
                "INSERT INTO contacts (email, name, times, last_used) VALUES (?1, ?2, 1, ?3)
                 ON CONFLICT (email) DO UPDATE SET times = times + 1,
                    name = COALESCE(excluded.name, contacts.name),
                    last_used = MAX(last_used, excluded.last_used)",
                params![person.email, person.name, when],
            )?;
        }

        tx.commit()?;
        Ok(Some(id))
    }

    fn find_thread(tx: &rusqlite::Transaction<'_>, account_id: &str, parsed: &ParsedMessage) -> Result<Option<String>> {
        let mut candidates: Vec<&str> = parsed.references.iter().rev().map(String::as_str).collect();
        if let Some(parent) = &parsed.in_reply_to {
            candidates.insert(0, parent);
        }
        for candidate in candidates {
            let thread: Option<String> = tx
                .query_row(
                    "SELECT thread_id FROM messages WHERE account_id = ?1 AND message_id = ?2 LIMIT 1",
                    params![account_id, candidate],
                    |row| row.get(0),
                )
                .optional()?;
            if thread.is_some() {
                return Ok(thread);
            }
        }
        // The same message in another folder (e.g. Sent and Inbox) shares the thread.
        if let Some(message_id) = &parsed.message_id {
            return Ok(tx
                .query_row(
                    "SELECT thread_id FROM messages WHERE account_id = ?1 AND message_id = ?2 LIMIT 1",
                    params![account_id, message_id],
                    |row| row.get(0),
                )
                .optional()?);
        }
        Ok(None)
    }

    fn index(tx: &rusqlite::Transaction<'_>, rowid: i64, parsed: &ParsedMessage, from: &Address) -> Result<()> {
        let recipients = parsed
            .to
            .iter()
            .chain(parsed.cc.iter())
            .map(|a| format!("{} {}", a.name.as_deref().unwrap_or_default(), a.email))
            .collect::<Vec<_>>()
            .join(" ");
        let body = parsed
            .text
            .clone()
            .or_else(|| parsed.html.as_deref().map(crate::mime::html_to_text))
            .unwrap_or_else(|| parsed.snippet.clone());
        tx.execute("DELETE FROM messages_fts WHERE rowid = ?1", [rowid])?;
        tx.execute(
            "INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                rowid,
                parsed.subject,
                format!("{} {}", from.name.as_deref().unwrap_or_default(), from.email),
                recipients,
                body
            ],
        )?;
        Ok(())
    }

    pub fn has_body(&self, id: &str) -> Result<bool> {
        Ok(self.conn().query_row("SELECT has_body FROM messages WHERE id = ?1", [id], |row| row.get(0))?)
    }

    /// Adds the body of a message that was synced headers-only.
    pub fn set_body(&self, id: &str, parsed: &ParsedMessage) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let (rowid, from_json): (i64, String) =
            tx.query_row("SELECT rowid, from_json FROM messages WHERE id = ?1", [id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;
        let attachments: Vec<Attachment> = parsed
            .attachments
            .iter()
            .enumerate()
            .map(|(index, a)| Attachment {
                id: format!("{id}:{index}"),
                filename: a.filename.clone(),
                mime_type: a.mime_type.clone(),
                size: a.size,
                inline: a.inline,
            })
            .collect();
        tx.execute(
            "UPDATE messages SET has_body = 1, body_html = ?1, body_text = ?2, has_remote = ?3, snippet = ?4,
                attachments_json = ?5 WHERE id = ?6",
            params![parsed.html, parsed.text, parsed.has_remote_content, parsed.snippet, json(&attachments)?, id],
        )?;
        let from: Address = serde_json::from_str(&from_json)?;
        Self::index(&tx, rowid, parsed, &from)?;
        tx.commit()?;
        Ok(())
    }

    pub fn update_flags(&self, folder_id: &str, uid: u32, flags: MessageFlags) -> Result<bool> {
        let changed = self.conn().execute(
            "UPDATE messages SET seen = ?1, flagged = ?2, answered = ?3, draft = ?4
             WHERE folder_id = ?5 AND uid = ?6 AND (seen != ?1 OR flagged != ?2 OR answered != ?3 OR draft != ?4)",
            params![flags.seen, flags.flagged, flags.answered, flags.draft, folder_id, uid],
        )?;
        Ok(changed > 0)
    }

    pub fn delete_uids(&self, folder_id: &str, uids: &[u32]) -> Result<usize> {
        if uids.is_empty() {
            return Ok(0);
        }
        let conn = self.conn();
        let mut deleted = 0;
        for chunk in uids.chunks(500) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let mut values: Vec<Value> = vec![Value::Text(folder_id.to_string())];
            values.extend(chunk.iter().map(|uid| Value::Integer(i64::from(*uid))));
            conn.execute(
                &format!(
                    "DELETE FROM messages_fts WHERE rowid IN
                        (SELECT rowid FROM messages WHERE folder_id = ?1 AND uid IN ({placeholders}))"
                ),
                params_from_iter(values.iter()),
            )?;
            deleted += conn.execute(
                &format!("DELETE FROM messages WHERE folder_id = ?1 AND uid IN ({placeholders})"),
                params_from_iter(values.iter()),
            )?;
        }
        Ok(deleted)
    }

    pub fn locations(&self, ids: &[String]) -> Result<Vec<MessageLocation>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.account_id, m.folder_id, f.path, m.uid, m.message_id, m.remote_id, m.blob_id
             FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?1",
        )?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(location) = stmt
                .query_row([id], |row| {
                    Ok(MessageLocation {
                        id: row.get(0)?,
                        account_id: row.get(1)?,
                        folder_id: row.get(2)?,
                        folder_path: row.get(3)?,
                        uid: row.get(4)?,
                        message_id: row.get(5)?,
                        remote_id: row.get(6)?,
                        blob_id: row.get(7)?,
                    })
                })
                .optional()?
            {
                out.push(location);
            }
        }
        Ok(out)
    }

    /// Every JMAP email of an account by its server id.
    pub fn remote_messages(&self, account_id: &str) -> Result<std::collections::HashMap<String, RemoteMessage>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT remote_id, id, folder_id, seen, flagged, answered, draft FROM messages
             WHERE account_id = ?1 AND remote_id IS NOT NULL",
        )?;
        let rows = stmt.query_map([account_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                RemoteMessage {
                    id: row.get(1)?,
                    folder_id: row.get(2)?,
                    flags: MessageFlags {
                        seen: row.get(3)?,
                        flagged: row.get(4)?,
                        answered: row.get(5)?,
                        draft: row.get(6)?,
                    },
                },
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Updates folder and flags of a JMAP email. Returns whether anything changed.
    pub fn update_remote_message(&self, id: &str, folder_id: &str, flags: MessageFlags) -> Result<bool> {
        let changed = self.conn().execute(
            "UPDATE messages SET folder_id = ?1, seen = ?2, flagged = ?3, answered = ?4, draft = ?5
             WHERE id = ?6 AND (folder_id != ?1 OR seen != ?2 OR flagged != ?3 OR answered != ?4 OR draft != ?5)",
            params![folder_id, flags.seen, flags.flagged, flags.answered, flags.draft, id],
        )?;
        Ok(changed > 0)
    }

    /// Moves messages without a placeholder, for servers that confirm moves right away (JMAP).
    pub fn set_folder(&self, ids: &[String], folder_id: &str) -> Result<()> {
        let conn = self.conn();
        for id in ids {
            conn.execute("UPDATE messages SET folder_id = ?1 WHERE id = ?2", params![folder_id, id])?;
        }
        Ok(())
    }

    pub fn apply_flag_change(&self, ids: &[String], change: FlagChange) -> Result<()> {
        let conn = self.conn();
        for id in ids {
            if let Some(seen) = change.seen {
                conn.execute("UPDATE messages SET seen = ?1 WHERE id = ?2", params![seen, id])?;
            }
            if let Some(flagged) = change.flagged {
                conn.execute("UPDATE messages SET flagged = ?1 WHERE id = ?2", params![flagged, id])?;
            }
        }
        Ok(())
    }

    /// Moves messages locally. They keep a placeholder uid until the target folder syncs.
    pub fn move_local(&self, ids: &[String], target_folder_id: &str) -> Result<()> {
        let conn = self.conn();
        for (index, id) in ids.iter().enumerate() {
            let placeholder = -(crate::mime::now() * 1000 + index as i64);
            conn.execute(
                "UPDATE messages SET folder_id = ?1, uid = ?2 WHERE id = ?3",
                params![target_folder_id, placeholder, id],
            )?;
        }
        Ok(())
    }

    pub fn delete_messages(&self, ids: &[String]) -> Result<()> {
        let conn = self.conn();
        for id in ids {
            conn.execute("DELETE FROM messages_fts WHERE rowid = (SELECT rowid FROM messages WHERE id = ?1)", [id])?;
            conn.execute("DELETE FROM messages WHERE id = ?1", [id])?;
        }
        Ok(())
    }

    // ----------------------------------------------------------------- threads

    fn view_clause(view: &MailboxView, values: &mut Vec<Value>) -> String {
        match view {
            MailboxView::Unified { role } => match role {
                UnifiedRole::Inbox => "f.role = 'inbox'".into(),
                UnifiedRole::Unread => "f.role = 'inbox' AND m.seen = 0".into(),
                UnifiedRole::Flagged => "m.flagged = 1 AND COALESCE(f.role, '') NOT IN ('trash', 'junk')".into(),
                UnifiedRole::Drafts => "f.role = 'drafts'".into(),
                UnifiedRole::Sent => "f.role = 'sent'".into(),
            },
            MailboxView::Folder { folder_id, .. } => {
                values.push(Value::Text(folder_id.clone()));
                format!("m.folder_id = ?{}", values.len())
            }
        }
    }

    pub fn list_threads(&self, query: &ThreadQuery) -> Result<ThreadPage> {
        let mut values: Vec<Value> = Vec::new();
        let mut clauses = vec![Self::view_clause(&query.view, &mut values)];
        match query.filter {
            ListFilter::All => {}
            ListFilter::Unread => clauses.push("m.seen = 0".into()),
            ListFilter::Flagged => clauses.push("m.flagged = 1".into()),
            ListFilter::Attachments => clauses.push("m.attachments_json != '[]'".into()),
        }
        if let Some(search) = query.search.as_deref().and_then(fts_query) {
            values.push(Value::Text(search));
            clauses.push(format!(
                "m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?{})",
                values.len()
            ));
        }
        let limit = query.limit.clamp(1, 500);
        let offset: u32 = query.cursor.as_deref().and_then(|c| c.parse().ok()).unwrap_or(0);
        let group = if query.conversations { "m.thread_id" } else { "m.id" };

        let sql = format!(
            "SELECT {group}, MAX(m.date) AS last FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE {} GROUP BY {group} ORDER BY last DESC LIMIT {} OFFSET {offset}",
            clauses.join(" AND "),
            limit + 1
        );
        let keys: Vec<String> = {
            let conn = self.conn();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(values.iter()), |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let has_more = keys.len() > limit as usize;
        let mut threads = Vec::with_capacity(keys.len().min(limit as usize));
        for key in keys.into_iter().take(limit as usize) {
            let (id, messages) = if query.conversations {
                let messages = self.thread_messages(&key)?;
                (key, messages)
            } else {
                let messages = self.messages_by_ids(std::slice::from_ref(&key))?;
                (format!("m:{key}"), messages)
            };
            if let Some(summary) = summarize(&id, &messages) {
                threads.push(summary);
            }
        }
        Ok(ThreadPage { threads, next_cursor: has_more.then(|| (offset + limit).to_string()) })
    }

    pub fn get_thread(&self, thread_id: &str, conversations: bool) -> Result<ThreadDetail> {
        let messages = match thread_id.strip_prefix("m:") {
            Some(message_id) => self.messages_by_ids(&[message_id.to_string()])?,
            None => self.thread_messages(thread_id)?,
        };
        let thread = summarize(thread_id, &messages).ok_or_else(|| Error::not_found("Conversation not found"))?;
        let messages = if conversations || thread_id.starts_with("m:") {
            messages
        } else {
            messages.into_iter().last().into_iter().collect()
        };
        Ok(ThreadDetail { thread, messages })
    }

    const MESSAGE_COLUMNS: &'static str =
        "m.id, m.thread_id, m.account_id, m.folder_id, m.from_json, m.to_json, m.cc_json,
        m.reply_to_json, m.subject, m.date, m.seen, m.flagged, m.answered, m.draft, m.snippet, m.body_html,
        m.body_text, m.has_remote, m.attachments_json, m.message_id";

    fn message_from_row(row: &Row<'_>) -> rusqlite::Result<Message> {
        Ok(Message {
            id: row.get(0)?,
            thread_id: row.get(1)?,
            account_id: row.get(2)?,
            folder_id: row.get(3)?,
            from: serde_json::from_str(&row.get::<_, String>(4)?)
                .unwrap_or(Address { name: None, email: String::new() }),
            to: from_json(&row.get::<_, String>(5)?),
            cc: from_json(&row.get::<_, String>(6)?),
            reply_to: from_json(&row.get::<_, String>(7)?),
            subject: row.get(8)?,
            date: iso8601(row.get(9)?),
            flags: MessageFlags {
                seen: row.get(10)?,
                flagged: row.get(11)?,
                answered: row.get(12)?,
                draft: row.get(13)?,
            },
            snippet: row.get(14)?,
            body_html: row.get(15)?,
            body_text: row.get(16)?,
            has_remote_content: row.get(17)?,
            attachments: from_json(&row.get::<_, String>(18)?),
        })
    }

    /// All messages of a conversation, oldest first, without trash and duplicates
    /// of the same message in several folders.
    pub fn thread_messages(&self, thread_id: &str) -> Result<Vec<Message>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE m.thread_id = ?1 AND COALESCE(f.role, '') != 'trash' ORDER BY m.date",
            Self::MESSAGE_COLUMNS
        ))?;
        let mut seen_ids = HashSet::new();
        let mut out = Vec::new();
        let mut rows = stmt.query([thread_id])?;
        while let Some(row) = rows.next()? {
            let message_id: Option<String> = row.get(19)?;
            if let Some(mid) = message_id
                && !seen_ids.insert(mid)
            {
                continue;
            }
            out.push(Self::message_from_row(row)?);
        }
        Ok(out)
    }

    pub fn messages_by_ids(&self, ids: &[String]) -> Result<Vec<Message>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!("SELECT {} FROM messages m WHERE m.id = ?1", Self::MESSAGE_COLUMNS))?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(message) = stmt.query_row([id], Self::message_from_row).optional()? {
                out.push(message);
            }
        }
        Ok(out)
    }

    /// Message-ID and References of a stored message, for replying to it.
    pub fn threading_headers(&self, id: &str) -> Result<Option<(String, String)>> {
        let row: Option<(Option<String>, String)> = self
            .conn()
            .query_row("SELECT message_id, refs FROM messages WHERE id = ?1", [id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?;
        Ok(row.and_then(|(message_id, refs)| message_id.map(|mid| (mid, refs))))
    }

    // ---------------------------------------------------------------- contacts

    pub fn remember_contacts(&self, addresses: &[Address]) -> Result<()> {
        let conn = self.conn();
        for address in addresses.iter().filter(|a| !a.email.is_empty()) {
            conn.execute(
                "INSERT INTO contacts (email, name, times, last_used) VALUES (?1, ?2, 1, ?3)
                 ON CONFLICT (email) DO UPDATE SET times = times + 1,
                    name = COALESCE(excluded.name, contacts.name), last_used = excluded.last_used",
                params![address.email, address.name, crate::mime::now()],
            )?;
        }
        Ok(())
    }

    pub fn search_contacts(&self, query: &str, exclude: &[String]) -> Result<Vec<Contact>> {
        let conn = self.conn();
        let pattern = format!("%{}%", query.trim().replace('%', ""));
        let mut stmt = conn.prepare(
            "SELECT email, name, times, last_used FROM contacts
             WHERE email LIKE ?1 OR name LIKE ?1 ORDER BY times DESC, last_used DESC LIMIT 20",
        )?;
        let excluded: HashSet<String> = exclude.iter().map(|e| e.to_lowercase()).collect();
        let rows = stmt.query_map([pattern], |row| {
            Ok(Contact {
                email: row.get(0)?,
                name: row.get(1)?,
                times_contacted: row.get(2)?,
                last_used: Some(iso8601(row.get(3)?)),
            })
        })?;
        Ok(rows
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter(|c| !excluded.contains(&c.email.to_lowercase()))
            .take(8)
            .collect())
    }

    // ------------------------------------------------------------ addon storage

    pub fn addon_get(&self, addon_id: &str, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT value FROM addon_storage WHERE addon_id = ?1 AND key = ?2",
                params![addon_id, key],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn addon_set(&self, addon_id: &str, key: &str, value: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO addon_storage (addon_id, key, value) VALUES (?1, ?2, ?3)
             ON CONFLICT (addon_id, key) DO UPDATE SET value = excluded.value",
            params![addon_id, key, value],
        )?;
        Ok(())
    }
}

fn summarize(id: &str, messages: &[Message]) -> Option<ThreadSummary> {
    let last = messages.last()?;
    let mut participants: Vec<Address> = Vec::new();
    let mut seen = HashSet::new();
    for message in messages {
        if seen.insert(message.from.email.to_lowercase()) {
            participants.push(message.from.clone());
        }
    }
    let mut accounts = HashSet::new();
    let account_ids =
        messages.iter().filter(|m| accounts.insert(m.account_id.as_str())).map(|m| m.account_id.clone()).collect();
    Some(ThreadSummary {
        id: id.to_string(),
        account_ids,
        subject: messages[0].subject.clone(),
        participants,
        snippet: last.snippet.clone(),
        last_date: last.date.clone(),
        message_count: messages.len() as u32,
        unread_count: messages.iter().filter(|m| !m.flags.seen).count() as u32,
        flagged: messages.iter().any(|m| m.flags.flagged),
        has_attachments: messages.iter().any(|m| !m.attachments.is_empty()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mime::parse;

    fn store_with_account() -> (Store, String, String, String) {
        let store = Store::open_in_memory().unwrap();
        let account = AccountRecord {
            id: "acc".into(),
            name: "Test".into(),
            email: "mini@uwumail.dev".into(),
            display_name: "Mini".into(),
            color: AccountColor::Pink,
            auth: AuthKind::Password,
            username: "mini@uwumail.dev".into(),
            imap: ServerSettings { host: "imap.example".into(), port: 993, security: Security::Tls },
            smtp: ServerSettings { host: "smtp.example".into(), port: 465, security: Security::Tls },
            protocol: Protocol::Imap,
            jmap_url: None,
        };
        store.insert_account(&account).unwrap();
        let inbox = folder(&store, "INBOX", Some(FolderRole::Inbox), ".");
        let sent = folder(&store, "Sent", Some(FolderRole::Sent), ".");
        (store, "acc".into(), inbox, sent)
    }

    fn folder(store: &Store, path: &str, role: Option<FolderRole>, delimiter: &str) -> String {
        let name = path.rsplit(delimiter).next().unwrap_or(path);
        store
            .upsert_folder(
                "acc",
                &FolderInfo { path, name, role, delimiter: Some(delimiter), selectable: true, parent_ref: None },
            )
            .unwrap()
    }

    fn parent_names(store: &Store) -> Vec<(String, Option<String>)> {
        let folders = store.folders(Some("acc")).unwrap();
        let name_of = |id: &Option<String>| {
            id.as_ref().and_then(|id| folders.iter().find(|f| &f.id == id)).map(|f| f.path.clone())
        };
        let mut pairs: Vec<_> = folders.iter().map(|f| (f.path.clone(), name_of(&f.parent_id))).collect();
        pairs.sort();
        pairs
    }

    #[test]
    fn nests_folders_by_their_path() {
        let (store, _, _, _) = store_with_account();
        folder(&store, "Projekte", None, ".");
        folder(&store, "Projekte.UwUMail", None, ".");
        folder(&store, "Projekte.UwUMail.Bugs", None, ".");
        folder(&store, "INBOX.Rechnungen", None, ".");
        assert_eq!(
            parent_names(&store),
            vec![
                ("INBOX".into(), None),
                ("INBOX.Rechnungen".into(), Some("INBOX".into())),
                ("Projekte".into(), None),
                ("Projekte.UwUMail".into(), Some("Projekte".into())),
                ("Projekte.UwUMail.Bugs".into(), Some("Projekte.UwUMail".into())),
                ("Sent".into(), None),
            ]
        );
    }

    #[test]
    fn treats_an_inbox_namespace_as_top_level() {
        let store = Store::open_in_memory().unwrap();
        store
            .insert_account(&AccountRecord {
                id: "acc".into(),
                name: "Courier".into(),
                email: "a@b.example".into(),
                display_name: "A".into(),
                color: AccountColor::Pink,
                auth: AuthKind::Password,
                username: "a".into(),
                imap: ServerSettings { host: "h".into(), port: 993, security: Security::Tls },
                smtp: ServerSettings { host: "h".into(), port: 465, security: Security::Tls },
                protocol: Protocol::Imap,
                jmap_url: None,
            })
            .unwrap();
        folder(&store, "INBOX", Some(FolderRole::Inbox), ".");
        folder(&store, "INBOX.Sent", Some(FolderRole::Sent), ".");
        folder(&store, "INBOX.Kunden", None, ".");
        folder(&store, "INBOX.Kunden.Firma A", None, ".");
        assert_eq!(
            parent_names(&store),
            vec![
                ("INBOX".into(), None),
                ("INBOX.Kunden".into(), None),
                ("INBOX.Kunden.Firma A".into(), Some("INBOX.Kunden".into())),
                ("INBOX.Sent".into(), None),
            ]
        );
    }

    fn raw(id: &str, subject: &str, from: &str, reply_to: Option<&str>, body: &str, date: &str) -> Vec<u8> {
        let mut raw = format!(
            "From: {from}\r\nTo: mini@uwumail.dev\r\nSubject: {subject}\r\nDate: {date}\r\nMessage-ID: <{id}>\r\n"
        );
        if let Some(parent) = reply_to {
            raw.push_str(&format!("In-Reply-To: <{parent}>\r\nReferences: <{parent}>\r\n"));
        }
        raw.push_str(&format!("Content-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n"));
        raw.into_bytes()
    }

    fn insert(store: &Store, folder: &str, uid: u32, bytes: &[u8]) -> Option<String> {
        store
            .insert_message("acc", folder, uid, MessageFlags::default(), bytes.len() as u64, None, &parse(bytes))
            .unwrap()
    }

    #[test]
    fn groups_replies_into_conversations_even_out_of_order() {
        let (store, _, inbox, sent) = store_with_account();
        // The reply arrives before the message it answers.
        insert(
            &store,
            &inbox,
            2,
            &raw("b@x", "Re: Clip", "Leni <leni@x.example>", Some("a@x"), "Genau!", "Mon, 14 Sep 2026 10:00:00 +0000"),
        );
        insert(
            &store,
            &sent,
            1,
            &raw(
                "a@x",
                "Clip",
                "Mini <mini@uwumail.dev>",
                None,
                "Hast du den Clip gesehen?",
                "Mon, 14 Sep 2026 09:00:00 +0000",
            ),
        );

        let page = store
            .list_threads(&ThreadQuery {
                view: MailboxView::Unified { role: UnifiedRole::Inbox },
                filter: ListFilter::All,
                search: None,
                conversations: true,
                cursor: None,
                limit: 50,
            })
            .unwrap();
        assert_eq!(page.threads.len(), 1);
        let thread = &page.threads[0];
        assert_eq!(thread.message_count, 2);
        assert_eq!(thread.subject, "Clip");
        assert_eq!(thread.unread_count, 2);

        let detail = store.get_thread(&thread.id, true).unwrap();
        assert_eq!(detail.messages[0].body_text.as_deref().map(str::trim), Some("Hast du den Clip gesehen?"));
    }

    #[test]
    fn duplicate_uids_are_ignored() {
        let (store, _, inbox, _) = store_with_account();
        let bytes = raw("a@x", "Hi", "leni@x.example", None, "Hallo", "Mon, 14 Sep 2026 09:00:00 +0000");
        assert!(insert(&store, &inbox, 1, &bytes).is_some());
        assert!(insert(&store, &inbox, 1, &bytes).is_none());
    }

    #[test]
    fn full_text_search_finds_body_words_with_prefixes() {
        let (store, _, inbox, _) = store_with_account();
        insert(
            &store,
            &inbox,
            1,
            &raw(
                "a@x",
                "Spieleabend",
                "noah@x.example",
                None,
                "Ich bring Snacks mit",
                "Mon, 14 Sep 2026 09:00:00 +0000",
            ),
        );
        insert(
            &store,
            &inbox,
            2,
            &raw("b@x", "Rechnung", "bank@x.example", None, "Dein Kontoauszug", "Mon, 14 Sep 2026 08:00:00 +0000"),
        );

        let query = |text: &str| {
            store
                .list_threads(&ThreadQuery {
                    view: MailboxView::Unified { role: UnifiedRole::Inbox },
                    filter: ListFilter::All,
                    search: Some(text.into()),
                    conversations: false,
                    cursor: None,
                    limit: 50,
                })
                .unwrap()
                .threads
        };
        assert_eq!(query("snack").len(), 1);
        assert_eq!(query("konto").first().map(|t| t.subject.as_str()), Some("Rechnung"));
        assert!(query("\"unbalanced").is_empty());
    }

    #[test]
    fn flags_moves_and_deletes_update_the_cache() {
        let (store, _, inbox, _) = store_with_account();
        let archive = folder(&store, "Archive", Some(FolderRole::Archive), ".");
        let id = insert(
            &store,
            &inbox,
            7,
            &raw("a@x", "Hi", "leni@x.example", None, "Hallo", "Mon, 14 Sep 2026 09:00:00 +0000"),
        )
        .unwrap();

        store
            .apply_flag_change(std::slice::from_ref(&id), FlagChange { seen: Some(true), flagged: Some(true) })
            .unwrap();
        let folders = store.folders(Some("acc")).unwrap();
        assert_eq!(folders.iter().find(|f| f.id == inbox).unwrap().unread, 0);

        store.move_local(std::slice::from_ref(&id), &archive).unwrap();
        // When the archive syncs, the placeholder takes the real uid instead of duplicating.
        let bytes = raw("a@x", "Hi", "leni@x.example", None, "Hallo", "Mon, 14 Sep 2026 09:00:00 +0000");
        assert!(insert(&store, &archive, 3, &bytes).is_none());
        assert_eq!(store.max_uid(&archive).unwrap(), 3);

        assert_eq!(store.delete_uids(&archive, &[3]).unwrap(), 1);
        assert!(store.messages_by_ids(&[id]).unwrap().is_empty());
    }

    #[test]
    fn keeps_jmap_emails_by_server_id() {
        let (store, _, inbox, _) = store_with_account();
        let mailbox = |path: &str, parent_ref: Option<&str>| {
            store
                .upsert_folder(
                    "acc",
                    &FolderInfo { path, name: path, role: None, delimiter: None, selectable: true, parent_ref },
                )
                .unwrap()
        };
        let projects = mailbox("m1", None);
        let bugs = mailbox("m2", Some("m1"));
        let folders = store.folders(Some("acc")).unwrap();
        assert_eq!(folders.iter().find(|f| f.id == bugs).unwrap().parent_id.as_deref(), Some(projects.as_str()));

        let bytes = raw("a@x", "Hi", "leni@x.example", None, "Hallo", "Mon, 14 Sep 2026 09:00:00 +0000");
        let flags = MessageFlags { seen: true, ..MessageFlags::default() };
        let insert = |remote_id: &str| {
            store.insert_jmap_message("acc", &inbox, remote_id, "blob-1", flags, 42, None, &parse(&bytes)).unwrap()
        };
        let id = insert("e1").unwrap();
        assert!(insert("e1").is_none(), "the same server id is stored once");

        let known = store.remote_messages("acc").unwrap();
        assert_eq!(known["e1"].id, id);
        assert!(known["e1"].flags.seen);
        let location = store.locations(std::slice::from_ref(&id)).unwrap().pop().unwrap();
        assert_eq!((location.remote_id.as_deref(), location.blob_id.as_deref()), (Some("e1"), Some("blob-1")));

        assert!(store.update_remote_message(&id, &bugs, MessageFlags::default()).unwrap());
        assert!(!store.update_remote_message(&id, &bugs, MessageFlags::default()).unwrap());
        assert_eq!(store.messages_by_ids(std::slice::from_ref(&id)).unwrap()[0].folder_id, bugs);

        store.set_sync_state("acc", "Email", Some("s1")).unwrap();
        assert_eq!(store.sync_state("acc", "Email").unwrap().as_deref(), Some("s1"));
        store.clear_account_mail("acc").unwrap();
        assert!(store.sync_state("acc", "Email").unwrap().is_none());
        assert!(store.folders(Some("acc")).unwrap().is_empty());
    }

    #[test]
    fn contacts_are_learned_from_mail() {
        let (store, _, inbox, _) = store_with_account();
        insert(
            &store,
            &inbox,
            1,
            &raw("a@x", "Hi", "Leni Wanders <leni@x.example>", None, "Hallo", "Mon, 14 Sep 2026 09:00:00 +0000"),
        );
        let contacts = store.search_contacts("len", &["mini@uwumail.dev".into()]).unwrap();
        assert_eq!(contacts.len(), 1);
        assert_eq!(contacts[0].name.as_deref(), Some("Leni Wanders"));
    }
}
