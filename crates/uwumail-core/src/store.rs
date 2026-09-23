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
    r#"
-- Mail waiting for its "undo send" time. It survives a restart and goes out then.
CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_json TEXT NOT NULL,
    send_at INTEGER NOT NULL
);
"#,
    r#"
-- More addresses to send from: aliases from the server (server_id set) or added by hand.
CREATE TABLE identities (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    server_id TEXT,
    UNIQUE (account_id, email)
);
"#,
    r#"
-- Signatures per sender address; kept on this device.
CREATE TABLE signatures (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL,
    html TEXT NOT NULL,
    for_new INTEGER NOT NULL DEFAULT 0,
    for_replies INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
"#,
    r#"
-- Addresses and @domains whose new mail goes straight to the trash.
CREATE TABLE blocked_senders (
    entry TEXT PRIMARY KEY COLLATE NOCASE,
    created_at INTEGER NOT NULL
);
"#,
    r#"
-- How newsletters say to unsubscribe, as JSON.
ALTER TABLE messages ADD COLUMN unsubscribe_json TEXT;
"#,
    r#"
-- Blind copies: only known for mail this account sent itself.
ALTER TABLE messages ADD COLUMN bcc_json TEXT NOT NULL DEFAULT '[]';
"#,
    r#"
-- Calendars over CalDAV: an address typed in by hand, and what CalDAV itself can't keep
-- (hidden calendars, the default one). Events themselves stay on the server.
ALTER TABLE accounts ADD COLUMN caldav_url TEXT;
CREATE TABLE calendar_prefs (
    calendar_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    hidden INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0
);
"#,
];

/// What this device remembers about one calendar.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CalendarPrefs {
    pub hidden: bool,
    pub is_default: bool,
}

/// Prefix of the conversation ids the trash lists: those conversations hold only
/// their trashed messages, while everywhere else they leave them out.
const TRASHED_THREAD: &str = "trash:";

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

    pub fn set_account_display_name(&self, id: &str, display_name: &str) -> Result<()> {
        self.conn().execute("UPDATE accounts SET display_name = ?1 WHERE id = ?2", params![display_name, id])?;
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

    /// The CalDAV address typed in by hand for an account.
    pub fn caldav_url(&self, account_id: &str) -> Result<Option<String>> {
        Ok(self.conn().query_row("SELECT caldav_url FROM accounts WHERE id = ?1", [account_id], |row| row.get(0))?)
    }

    pub fn set_caldav_url(&self, account_id: &str, url: Option<&str>) -> Result<()> {
        self.conn().execute("UPDATE accounts SET caldav_url = ?1 WHERE id = ?2", params![url, account_id])?;
        Ok(())
    }

    pub fn calendar_prefs(&self, account_id: &str) -> Result<std::collections::HashMap<String, CalendarPrefs>> {
        let conn = self.conn();
        let mut statement =
            conn.prepare("SELECT calendar_id, hidden, is_default FROM calendar_prefs WHERE account_id = ?1")?;
        let rows = statement.query_map([account_id], |row| {
            Ok((row.get::<_, String>(0)?, CalendarPrefs { hidden: row.get(1)?, is_default: row.get(2)? }))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn set_calendar_hidden(&self, account_id: &str, calendar_id: &str, hidden: bool) -> Result<()> {
        self.conn().execute(
            "INSERT INTO calendar_prefs (calendar_id, account_id, hidden) VALUES (?1, ?2, ?3)
             ON CONFLICT (calendar_id) DO UPDATE SET hidden = excluded.hidden",
            params![calendar_id, account_id, hidden],
        )?;
        Ok(())
    }

    /// Makes one calendar of the account the default; the others stop being it.
    pub fn set_default_calendar(&self, account_id: &str, calendar_id: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute("UPDATE calendar_prefs SET is_default = 0 WHERE account_id = ?1", [account_id])?;
        conn.execute(
            "INSERT INTO calendar_prefs (calendar_id, account_id, is_default) VALUES (?1, ?2, 1)
             ON CONFLICT (calendar_id) DO UPDATE SET is_default = 1",
            params![calendar_id, account_id],
        )?;
        Ok(())
    }

    pub fn forget_calendar(&self, calendar_id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM calendar_prefs WHERE calendar_id = ?1", [calendar_id])?;
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

    /// Ids of every cached message of an account, e.g. to clear their attachment files.
    pub fn account_message_ids(&self, account_id: &str) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut statement = conn.prepare("SELECT id FROM messages WHERE account_id = ?1")?;
        let ids = statement.query_map([account_id], |row| row.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(ids)
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

    /// Gives a folder a new name and path; folders inside it (paths below `old_path` plus the
    /// delimiter) move along, like the server moves them.
    pub fn rename_folder(&self, folder_id: &str, new_path: &str, name: &str) -> Result<()> {
        let folder = self.folder(folder_id)?;
        let conn = self.conn();
        conn.execute("UPDATE folders SET path = ?1, name = ?2 WHERE id = ?3", params![new_path, name, folder_id])?;
        if let Some(delimiter) = folder.delimiter.filter(|d| !d.is_empty()) {
            let old_prefix = format!("{}{delimiter}", folder.path);
            let new_prefix = format!("{new_path}{delimiter}");
            conn.execute(
                "UPDATE folders SET path = ?1 || substr(path, length(?2) + 1)
                 WHERE account_id = ?3 AND substr(path, 1, length(?2)) = ?2",
                params![new_prefix, old_prefix, folder.account_id],
            )?;
        }
        Ok(())
    }

    pub fn set_folder_name(&self, folder_id: &str, name: &str) -> Result<()> {
        self.conn().execute("UPDATE folders SET name = ?1 WHERE id = ?2", params![name, folder_id])?;
        Ok(())
    }

    /// Forgets a folder and its cached mail.
    pub fn delete_folder(&self, folder_id: &str) -> Result<()> {
        self.clear_folder(folder_id)?;
        self.conn().execute("DELETE FROM folders WHERE id = ?1", [folder_id])?;
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

    /// Local ids of the given uids in a folder, for those already stored.
    pub fn ids_by_uid(&self, folder_id: &str, uids: &[u32]) -> Result<std::collections::HashMap<u32, String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT id FROM messages WHERE folder_id = ?1 AND uid = ?2")?;
        let mut found = std::collections::HashMap::new();
        for uid in uids {
            if let Some(id) = stmt.query_row(params![folder_id, uid], |row| row.get::<_, String>(0)).optional()? {
                found.insert(*uid, id);
            }
        }
        Ok(found)
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
                content_id: a.content_id.clone(),
            })
            .collect();

        tx.execute(
            "INSERT INTO messages (id, account_id, folder_id, uid, message_id, in_reply_to, refs, thread_id, subject,
                from_json, to_json, cc_json, reply_to_json, date, seen, flagged, answered, draft, snippet, size,
                has_body, body_html, body_text, has_remote, attachments_json, remote_id, blob_id, unsubscribe_json, bcc_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29)",
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
                parsed.unsubscribe.as_ref().map(json).transpose()?,
                json(&parsed.bcc)?,
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
                content_id: a.content_id.clone(),
            })
            .collect();
        tx.execute(
            "UPDATE messages SET has_body = 1, body_html = ?1, body_text = ?2, has_remote = ?3, snippet = ?4,
                attachments_json = ?5, unsubscribe_json = COALESCE(?7, unsubscribe_json) WHERE id = ?6",
            params![
                parsed.html,
                parsed.text,
                parsed.has_remote_content,
                parsed.snippet,
                json(&attachments)?,
                id,
                parsed.unsubscribe.as_ref().map(json).transpose()?
            ],
        )?;
        let from: Address = serde_json::from_str(&from_json)?;
        Self::index(&tx, rowid, parsed, &from)?;
        tx.commit()?;
        Ok(())
    }

    /// The preview line of a message stored headers-only.
    pub fn set_snippet(&self, id: &str, snippet: &str) -> Result<()> {
        self.conn().execute("UPDATE messages SET snippet = ?1 WHERE id = ?2", params![snippet, id])?;
        Ok(())
    }

    /// Drops the downloaded bodies of messages from before `cutoff` (Unix
    /// seconds) to save space; subject, preview and search index stay, and
    /// the body loads again when such a message is opened.
    pub fn forget_bodies_before(&self, cutoff: i64) -> Result<usize> {
        Ok(self.conn().execute(
            "UPDATE messages SET has_body = 0, body_html = NULL, body_text = NULL
             WHERE has_body = 1 AND date < ?1",
            [cutoff],
        )?)
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

    /// The local id of a message by its Message-ID header, preferring anything but drafts.
    pub fn message_by_header_id(&self, account_id: &str, header_id: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id
                 WHERE m.account_id = ?1 AND m.message_id = ?2
                 ORDER BY COALESCE(f.role, '') = 'drafts' LIMIT 1",
                params![account_id, header_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Inbox mail from an address, e.g. to archive a newsletter's old issues.
    pub fn inbox_messages_from(&self, email: &str) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE f.role = 'inbox' AND lower(json_extract(m.from_json, '$.email')) = lower(?1)",
        )?;
        let ids = stmt.query_map([email.trim()], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(ids)
    }

    /// Local ids of the messages in a folder with this Message-ID header.
    pub fn ids_by_header_id(&self, folder_id: &str, header_id: &str) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT id FROM messages WHERE folder_id = ?1 AND message_id = ?2")?;
        let ids = stmt.query_map(params![folder_id, header_id], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(ids)
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

    /// Whether a view is an account's trash folder.
    fn shows_trash(&self, view: &MailboxView) -> Result<bool> {
        let MailboxView::Folder { folder_id, .. } = view else { return Ok(false) };
        let role: Option<Option<String>> = self
            .conn()
            .query_row("SELECT role FROM folders WHERE id = ?1", [folder_id], |row| row.get(0))
            .optional()?;
        Ok(role.flatten().as_deref() == Some(FolderRole::Trash.as_str()))
    }

    pub fn list_threads(&self, query: &ThreadQuery) -> Result<ThreadPage> {
        self.threads(query, None)
    }

    /// The conversations of the given messages, e.g. server search results,
    /// with the query's filter but regardless of view and local search.
    pub fn list_threads_of(&self, query: &ThreadQuery, message_ids: &[String]) -> Result<ThreadPage> {
        self.threads(query, Some(message_ids))
    }

    /// `?n, ?n+1, …` for each id, whose values join `values`.
    fn placeholders(ids: &[String], values: &mut Vec<Value>) -> String {
        ids.iter()
            .map(|id| {
                values.push(Value::Text(id.clone()));
                format!("?{}", values.len())
            })
            .collect::<Vec<_>>()
            .join(", ")
    }

    fn threads(&self, query: &ThreadQuery, only: Option<&[String]>) -> Result<ThreadPage> {
        let nothing = || Ok(ThreadPage { threads: Vec::new(), next_cursor: None });
        let mut values: Vec<Value> = Vec::new();
        let mut clauses = Vec::new();
        match only {
            Some([]) => return nothing(),
            Some(ids) => clauses.push(format!("m.id IN ({})", Self::placeholders(ids, &mut values))),
            None => clauses.push(Self::view_clause(&query.view, &mut values)),
        }
        match query.account_ids.as_deref() {
            Some([]) => return nothing(),
            Some(ids) => clauses.push(format!("m.account_id IN ({})", Self::placeholders(ids, &mut values))),
            None => {}
        }
        match query.filter {
            ListFilter::All => {}
            ListFilter::Unread => clauses.push("m.seen = 0".into()),
            ListFilter::Flagged => clauses.push("m.flagged = 1".into()),
            ListFilter::Attachments => clauses.push("m.attachments_json != '[]'".into()),
        }
        if let Some(search) = query.search.as_deref().and_then(fts_query).filter(|_| only.is_none()) {
            values.push(Value::Text(search));
            clauses.push(format!(
                "m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?{})",
                values.len()
            ));
        }
        let limit = query.limit.clamp(1, 500);
        let offset: u32 = query.cursor.as_deref().and_then(|c| c.parse().ok()).unwrap_or(0);
        let group = if query.conversations { "m.thread_id" } else { "m.id" };
        let trash = self.shows_trash(&query.view)?;

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
                let messages = self.thread_messages(&key, trash)?;
                (if trash { format!("{TRASHED_THREAD}{key}") } else { key }, messages)
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
        let messages = if let Some(message_id) = thread_id.strip_prefix("m:") {
            self.messages_by_ids(&[message_id.to_string()])?
        } else if let Some(trashed) = thread_id.strip_prefix(TRASHED_THREAD) {
            self.thread_messages(trashed, true)?
        } else {
            self.thread_messages(thread_id, false)?
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
        m.body_text, m.has_remote, m.attachments_json, m.message_id, m.unsubscribe_json, m.bcc_json";

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
            bcc: from_json(&row.get::<_, String>(21)?),
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
            unsubscribe: row.get::<_, Option<String>>(20)?.and_then(|text| serde_json::from_str(&text).ok()),
        })
    }

    /// The messages of a conversation, oldest first, without duplicates of the same message
    /// in several folders: only those in the trash, or all but those.
    pub fn thread_messages(&self, thread_id: &str, trashed: bool) -> Result<Vec<Message>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE m.thread_id = ?1 AND (COALESCE(f.role, '') = 'trash') = ?2 ORDER BY m.date",
            Self::MESSAGE_COLUMNS
        ))?;
        let mut seen_ids = HashSet::new();
        let mut out = Vec::new();
        let mut rows = stmt.query(params![thread_id, trashed])?;
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

    // -------------------------------------------------------------- identities

    /// Stored identities (not the accounts' own addresses), by account.
    pub fn identities(&self) -> Result<Vec<Identity>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT i.id, i.account_id, i.email, i.name, i.server_id IS NOT NULL FROM identities i
             JOIN accounts a ON a.id = i.account_id
             WHERE i.email != a.email COLLATE NOCASE ORDER BY a.created_at, i.email",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Identity {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    email: row.get(2)?,
                    name: row.get(3)?,
                    primary: false,
                    from_server: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Adds an address typed in by hand. Returns `None` when the account already has it.
    pub fn insert_identity(&self, account_id: &str, email: &str, name: &str) -> Result<Option<String>> {
        let id = uuid::Uuid::new_v4().to_string();
        let inserted = self.conn().execute(
            "INSERT OR IGNORE INTO identities (id, account_id, email, name) VALUES (?1, ?2, ?3, ?4)",
            params![id, account_id, email, name],
        )?;
        Ok((inserted > 0).then_some(id))
    }

    pub fn rename_identity(&self, id: &str, name: &str) -> Result<bool> {
        Ok(self.conn().execute("UPDATE identities SET name = ?1 WHERE id = ?2", params![name, id])? > 0)
    }

    /// Removes an address added by hand; the server's own ones stay.
    pub fn delete_identity(&self, id: &str) -> Result<bool> {
        Ok(self.conn().execute("DELETE FROM identities WHERE id = ?1 AND server_id IS NULL", [id])? > 0)
    }

    /// Makes the server's identities of an account match `found` (server id, email, name).
    /// An address that was added by hand becomes the server's; names typed here stay.
    pub fn replace_server_identities(&self, account_id: &str, found: &[(String, String, String)]) -> Result<bool> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut changed = 0;
        for (server_id, email, name) in found {
            changed += tx.execute(
                "INSERT INTO identities (id, account_id, email, name, server_id) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (account_id, email) DO UPDATE SET server_id = excluded.server_id,
                    name = CASE WHEN identities.name = '' THEN excluded.name ELSE identities.name END
                 WHERE identities.server_id IS NOT excluded.server_id OR identities.name = ''",
                params![uuid::Uuid::new_v4().to_string(), account_id, email, name, server_id],
            )?;
        }
        let keep: Vec<&str> = found.iter().map(|(server_id, _, _)| server_id.as_str()).collect();
        let stale: Vec<String> = {
            let mut stmt =
                tx.prepare("SELECT id, server_id FROM identities WHERE account_id = ?1 AND server_id IS NOT NULL")?;
            let rows = stmt.query_map([account_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
            rows.filter_map(|row| row.ok())
                .filter(|(_, server_id)| !keep.contains(&server_id.as_str()))
                .map(|(id, _)| id)
                .collect()
        };
        for id in &stale {
            changed += tx.execute("DELETE FROM identities WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(changed > 0)
    }

    // --------------------------------------------------------- blocked senders

    pub fn blocked_senders(&self) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT entry FROM blocked_senders ORDER BY entry")?;
        let rows = stmt.query_map([], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub fn block_sender(&self, entry: &str) -> Result<()> {
        self.conn().execute(
            "INSERT OR IGNORE INTO blocked_senders (entry, created_at) VALUES (?1, ?2)",
            params![entry, crate::mime::now()],
        )?;
        Ok(())
    }

    pub fn unblock_sender(&self, entry: &str) -> Result<()> {
        self.conn().execute("DELETE FROM blocked_senders WHERE entry = ?1", [entry])?;
        Ok(())
    }

    // -------------------------------------------------------------- signatures

    pub fn signatures(&self) -> Result<Vec<Signature>> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT id, email, name, html, for_new, for_replies FROM signatures ORDER BY email, created_at")?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Signature {
                    id: row.get(0)?,
                    email: row.get(1)?,
                    name: row.get(2)?,
                    html: row.get(3)?,
                    for_new: row.get(4)?,
                    for_replies: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Adds or updates a signature; being the default for new mail or replies moves over from
    /// the address's other signatures.
    pub fn save_signature(&self, signature: &Signature) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        if signature.for_new {
            tx.execute("UPDATE signatures SET for_new = 0 WHERE email = ?1", [&signature.email])?;
        }
        if signature.for_replies {
            tx.execute("UPDATE signatures SET for_replies = 0 WHERE email = ?1", [&signature.email])?;
        }
        tx.execute(
            "INSERT INTO signatures (id, email, name, html, for_new, for_replies, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (id) DO UPDATE SET email = excluded.email, name = excluded.name, html = excluded.html,
                for_new = excluded.for_new, for_replies = excluded.for_replies",
            params![
                signature.id,
                signature.email,
                signature.name,
                signature.html,
                signature.for_new,
                signature.for_replies,
                crate::mime::now()
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_signature(&self, id: &str) -> Result<bool> {
        Ok(self.conn().execute("DELETE FROM signatures WHERE id = ?1", [id])? > 0)
    }

    // ------------------------------------------------------------------ outbox

    /// Queues a message; `send_at` in Unix milliseconds.
    pub fn insert_outbox(&self, id: &str, account_id: &str, message_json: &str, send_at: i64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO outbox (id, account_id, message_json, send_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, account_id, message_json, send_at],
        )?;
        Ok(())
    }

    /// Removes a queued message and hands it over, once: to whoever sends it or undoes it first.
    pub fn take_outbox(&self, id: &str) -> Result<Option<(String, String)>> {
        Ok(self
            .conn()
            .query_row("DELETE FROM outbox WHERE id = ?1 RETURNING account_id, message_json", [id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?)
    }

    /// Every queued message with its send time.
    pub fn outbox(&self) -> Result<Vec<(String, i64)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT id, send_at FROM outbox ORDER BY send_at")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
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
        has_draft: messages.iter().any(|m| m.flags.draft),
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
    fn remembers_caldav_addresses_and_calendar_choices() {
        let (store, account, _, _) = store_with_account();
        assert_eq!(store.caldav_url(&account).unwrap(), None);
        store.set_caldav_url(&account, Some("https://dav.example.org/")).unwrap();
        assert_eq!(store.caldav_url(&account).unwrap().as_deref(), Some("https://dav.example.org/"));

        store.set_calendar_hidden(&account, "acc:/cal/a/", true).unwrap();
        store.set_default_calendar(&account, "acc:/cal/a/").unwrap();
        store.set_default_calendar(&account, "acc:/cal/b/").unwrap();
        let prefs = store.calendar_prefs(&account).unwrap();
        assert_eq!(prefs["acc:/cal/a/"], CalendarPrefs { hidden: true, is_default: false });
        assert_eq!(prefs["acc:/cal/b/"], CalendarPrefs { hidden: false, is_default: true });
        store.forget_calendar("acc:/cal/a/").unwrap();
        assert!(!store.calendar_prefs(&account).unwrap().contains_key("acc:/cal/a/"));
        store.delete_account(&account).unwrap();
        assert!(store.calendar_prefs(&account).unwrap().is_empty());
    }

    #[test]
    fn renaming_a_folder_moves_the_folders_inside_along() {
        let (store, _, _, _) = store_with_account();
        let projects = folder(&store, "Projekte", None, ".");
        folder(&store, "Projekte.UwUMail", None, ".");
        folder(&store, "Projekte.UwUMail.Bugs", None, ".");
        // Only real children move, not a folder that merely starts with the same letters.
        folder(&store, "Projektewoche", None, ".");
        store.rename_folder(&projects, "Arbeit", "Arbeit").unwrap();
        assert_eq!(
            parent_names(&store),
            vec![
                ("Arbeit".into(), None),
                ("Arbeit.UwUMail".into(), Some("Arbeit".into())),
                ("Arbeit.UwUMail.Bugs".into(), Some("Arbeit.UwUMail".into())),
                ("INBOX".into(), None),
                ("Projektewoche".into(), None),
                ("Sent".into(), None),
            ]
        );
        store.delete_folder(&projects).unwrap();
        assert!(store.folder(&projects).is_err());
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
                account_ids: None,
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
    fn keeps_the_blind_copies_of_sent_mail() {
        let (store, _, _, sent) = store_with_account();
        let bytes =
            b"From: Mini <mini@uwumail.dev>\r\nTo: leni@x.example\r\nBcc: Ben <ben@y.example>, chef@z.example\r\n\
Reply-To: antwort@uwumail.dev\r\nSubject: Geheim\r\nDate: Mon, 14 Sep 2026 09:00:00 +0000\r\nMessage-ID: <bcc@x>\r\n\
Content-Type: text/plain; charset=utf-8\r\n\r\nPsst\r\n";
        insert(&store, &sent, 1, bytes);
        let page = store
            .list_threads(&ThreadQuery {
                view: MailboxView::Unified { role: UnifiedRole::Sent },
                filter: ListFilter::All,
                search: None,
                conversations: true,
                account_ids: None,
                cursor: None,
                limit: 50,
            })
            .unwrap();
        let detail = store.get_thread(&page.threads[0].id, true).unwrap();
        let message = &detail.messages[0];
        let bcc: Vec<_> = message.bcc.iter().map(|a| (a.name.as_deref(), a.email.as_str())).collect();
        assert_eq!(bcc, vec![(Some("Ben"), "ben@y.example"), (None, "chef@z.example")]);
        assert_eq!(message.reply_to[0].email, "antwort@uwumail.dev");
        let json = serde_json::to_value(message).unwrap();
        assert_eq!(json["bcc"][0]["email"], "ben@y.example");
    }

    #[test]
    fn the_trash_shows_the_trashed_part_of_a_conversation() {
        let (store, _, inbox, sent) = store_with_account();
        let trash = folder(&store, "Trash", Some(FolderRole::Trash), ".");
        insert(
            &store,
            &sent,
            1,
            &raw(
                "a@x",
                "Clip",
                "Mini <mini@uwumail.dev>",
                None,
                "Hast du ihn gesehen?",
                "Mon, 14 Sep 2026 09:00:00 +0000",
            ),
        );
        let reply = insert(
            &store,
            &inbox,
            2,
            &raw("b@x", "Re: Clip", "Leni <leni@x.example>", Some("a@x"), "Genau!", "Mon, 14 Sep 2026 10:00:00 +0000"),
        )
        .unwrap();
        store.move_local(std::slice::from_ref(&reply), &trash).unwrap();

        let list = |folder_id: &str| {
            store
                .list_threads(&ThreadQuery {
                    view: MailboxView::Folder { account_id: "acc".into(), folder_id: folder_id.into() },
                    filter: ListFilter::All,
                    search: None,
                    conversations: true,
                    account_ids: None,
                    cursor: None,
                    limit: 50,
                })
                .unwrap()
                .threads
        };
        // What's left of the conversation doesn't show the trashed reply.
        let kept = list(&sent);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].message_count, 1);
        assert_eq!(store.get_thread(&kept[0].id, true).unwrap().messages.len(), 1);

        // The trash shows just the reply, and opens just the reply.
        let trashed = list(&trash);
        assert_eq!(trashed.len(), 1);
        assert_eq!(trashed[0].message_count, 1);
        assert_ne!(trashed[0].id, kept[0].id);
        let detail = store.get_thread(&trashed[0].id, true).unwrap();
        assert_eq!(detail.thread.subject, "Re: Clip");
        assert_eq!(detail.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), [reply.as_str()]);
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
                    account_ids: None,
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
    fn unified_views_can_leave_out_mailboxes() {
        let (store, _, inbox, _) = store_with_account();
        store
            .insert_account(&AccountRecord {
                id: "biz".into(),
                name: "Studio".into(),
                email: "mini@studio.example".into(),
                display_name: "Mini".into(),
                color: AccountColor::Violet,
                auth: AuthKind::Password,
                username: "mini@studio.example".into(),
                imap: ServerSettings { host: "imap.example".into(), port: 993, security: Security::Tls },
                smtp: ServerSettings { host: "smtp.example".into(), port: 465, security: Security::Tls },
                protocol: Protocol::Imap,
                jmap_url: None,
            })
            .unwrap();
        let studio_inbox = store
            .upsert_folder(
                "biz",
                &FolderInfo {
                    path: "INBOX",
                    name: "INBOX",
                    role: Some(FolderRole::Inbox),
                    delimiter: Some("."),
                    selectable: true,
                    parent_ref: None,
                },
            )
            .unwrap();
        insert(
            &store,
            &inbox,
            1,
            &raw("a@x", "Spieleabend", "noah@x.example", None, "Freitag?", "Mon, 14 Sep 2026 09:00:00 +0000"),
        );
        let offer = raw("b@x", "Angebot", "emma@x.example", None, "Freitag passt", "Mon, 14 Sep 2026 10:00:00 +0000");
        store
            .insert_message("biz", &studio_inbox, 1, MessageFlags::default(), offer.len() as u64, None, &parse(&offer))
            .unwrap();

        let subjects = |account_ids: Option<Vec<String>>, search: Option<&str>| -> Vec<String> {
            let query = ThreadQuery {
                view: MailboxView::Unified { role: UnifiedRole::Inbox },
                filter: ListFilter::All,
                search: search.map(Into::into),
                conversations: true,
                account_ids,
                cursor: None,
                limit: 50,
            };
            store.list_threads(&query).unwrap().threads.into_iter().map(|t| t.subject).collect()
        };
        assert_eq!(subjects(None, None), vec!["Angebot", "Spieleabend"]);
        assert_eq!(subjects(Some(vec!["biz".into()]), None), vec!["Angebot"]);
        assert_eq!(subjects(Some(vec!["acc".into()]), Some("freitag")), vec!["Spieleabend"]);
        // A workspace without mailboxes shows nothing rather than everything.
        assert!(subjects(Some(Vec::new()), None).is_empty());
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

    #[test]
    fn keeps_hand_made_and_server_identities_apart() {
        let (store, account, _, _) = store_with_account();
        assert!(store.insert_identity(&account, "hallo@uwumail.dev", "Mini vom Studio").unwrap().is_some());
        assert!(store.insert_identity(&account, "HALLO@uwumail.dev", "doppelt").unwrap().is_none());
        // The own address never shows up twice.
        store.insert_identity(&account, "mini@uwumail.dev", "Mini").unwrap();
        assert_eq!(store.identities().unwrap().len(), 1);

        let server = |list: &[(&str, &str, &str)]| -> Vec<(String, String, String)> {
            list.iter().map(|(a, b, c)| (a.to_string(), b.to_string(), c.to_string())).collect()
        };
        store
            .replace_server_identities(
                &account,
                &server(&[("s1", "hallo@uwumail.dev", "Server"), ("s2", "news@uwumail.dev", "News")]),
            )
            .unwrap();
        let identities = store.identities().unwrap();
        let hallo = identities.iter().find(|i| i.email == "hallo@uwumail.dev").unwrap();
        assert!(hallo.from_server, "the server now manages the address typed in before");
        assert_eq!(hallo.name, "Mini vom Studio", "but the name typed here stays");
        assert!(!store.delete_identity(&hallo.id).unwrap(), "server identities can't be removed here");

        store.replace_server_identities(&account, &server(&[("s1", "hallo@uwumail.dev", "Server")])).unwrap();
        assert!(store.identities().unwrap().iter().all(|i| i.email != "news@uwumail.dev"));
    }

    #[test]
    fn one_default_signature_per_address() {
        let store = Store::open_in_memory().unwrap();
        let signature = |id: &str, email: &str, for_new: bool, for_replies: bool| Signature {
            id: id.into(),
            email: email.into(),
            name: id.into(),
            html: format!("<p>{id}</p>"),
            for_new,
            for_replies,
        };
        store.save_signature(&signature("lang", "mini@uwumail.dev", true, true)).unwrap();
        store.save_signature(&signature("studio", "hallo@uwumail.dev", true, false)).unwrap();
        store.save_signature(&signature("kurz", "MINI@uwumail.dev", false, true)).unwrap();
        let all = store.signatures().unwrap();
        let get = |id: &str| all.iter().find(|s| s.id == id).unwrap().clone();
        assert!(get("lang").for_new && !get("lang").for_replies, "replies moved to the short one");
        assert!(get("kurz").for_replies);
        assert!(get("studio").for_new, "other addresses keep their defaults");

        store.save_signature(&Signature { html: "<p>Neu</p>".into(), ..get("lang") }).unwrap();
        assert_eq!(store.signatures().unwrap().len(), 3, "saving again updates");
        assert!(store.delete_signature("kurz").unwrap());
        assert_eq!(store.signatures().unwrap().len(), 2);
    }

    #[test]
    fn a_queued_message_is_taken_only_once() {
        let (store, account, _, _) = store_with_account();
        store.insert_outbox("q1", &account, "{}", 1_000).unwrap();
        store.insert_outbox("q2", &account, "{}", 500).unwrap();
        assert_eq!(store.outbox().unwrap(), vec![("q2".to_string(), 500), ("q1".to_string(), 1_000)]);
        assert_eq!(store.take_outbox("q1").unwrap(), Some((account.clone(), "{}".to_string())));
        assert_eq!(store.take_outbox("q1").unwrap(), None, "undo and sending can never both get it");
        store.delete_account(&account).unwrap();
        assert!(store.outbox().unwrap().is_empty(), "removing the mailbox empties its outbox");
    }
}
