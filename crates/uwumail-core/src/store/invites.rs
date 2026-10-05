//! Invitations kept on this device (see `engine::invite_ops`): the attendee's copy of an event a
//! mailbox was invited to, where the mailbox has no calendar the app can write to (IMAP without
//! CalDAV, or a Microsoft or Google calendar that didn't take the invitation in by itself).
//! The app shows them as a read-only calendar "Invitations" of that mailbox.

use rusqlite::{OptionalExtension, params};

use super::Store;
use crate::error::Result;

/// The migration of this feature, appended to `MIGRATIONS`.
pub(super) const MIGRATION: &str = r#"
-- Invitations kept on this device: the iCalendar object of the attendee's copy, per mailbox and UID.
CREATE TABLE local_invites (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    uid TEXT NOT NULL,
    ics TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, uid)
);
"#;

/// Objects one mailbox keeps on this device at most; the oldest go first.
pub const MAX_LOCAL_INVITES: i64 = 2000;

impl Store {
    pub fn local_invite(&self, account_id: &str, uid: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT ics FROM local_invites WHERE account_id = ?1 AND uid = ?2",
                params![account_id, uid],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Keeps (or replaces) an object; past [`MAX_LOCAL_INVITES`] the least recently changed go.
    pub fn set_local_invite(&self, account_id: &str, uid: &str, ics: &str, now: i64) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO local_invites (account_id, uid, ics, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (account_id, uid) DO UPDATE SET ics = excluded.ics, updated_at = excluded.updated_at",
            params![account_id, uid, ics, now],
        )?;
        conn.execute(
            "DELETE FROM local_invites WHERE account_id = ?1 AND uid NOT IN
             (SELECT uid FROM local_invites WHERE account_id = ?1 ORDER BY updated_at DESC, uid LIMIT ?2)",
            params![account_id, MAX_LOCAL_INVITES],
        )?;
        Ok(())
    }

    pub fn delete_local_invite(&self, account_id: &str, uid: &str) -> Result<bool> {
        Ok(self
            .conn()
            .execute("DELETE FROM local_invites WHERE account_id = ?1 AND uid = ?2", params![account_id, uid])?
            > 0)
    }

    /// Every object a mailbox keeps here, as (UID, iCalendar text).
    pub fn local_invites(&self, account_id: &str) -> Result<Vec<(String, String)>> {
        let conn = self.conn();
        let mut statement = conn.prepare("SELECT uid, ics FROM local_invites WHERE account_id = ?1 ORDER BY uid")?;
        let rows = statement.query_map(params![account_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn has_local_invites(&self, account_id: &str) -> Result<bool> {
        Ok(self
            .conn()
            .query_row("SELECT 1 FROM local_invites WHERE account_id = ?1 LIMIT 1", params![account_id], |_| Ok(()))
            .optional()?
            .is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AccountColor, AuthKind, Protocol, Security, ServerSettings};
    use crate::store::AccountRecord;

    #[test]
    fn keeps_replaces_and_forgets_objects() {
        let store = Store::open_in_memory().unwrap();
        let server = ServerSettings { host: "mail.example.com".into(), port: 993, security: Security::Tls };
        store
            .insert_account(&AccountRecord {
                id: "a".into(),
                name: "A".into(),
                email: "mini@example.com".into(),
                display_name: "Mini".into(),
                color: AccountColor::Sky,
                auth: AuthKind::Password,
                username: "mini".into(),
                imap: server.clone(),
                smtp: server,
                protocol: Protocol::Imap,
                jmap_url: None,
            })
            .unwrap();
        assert!(!store.has_local_invites("a").unwrap());
        store.set_local_invite("a", "u1", "one", 1).unwrap();
        store.set_local_invite("a", "u1", "two", 2).unwrap();
        store.set_local_invite("a", "u2", "three", 3).unwrap();
        assert_eq!(store.local_invite("a", "u1").unwrap().as_deref(), Some("two"));
        assert_eq!(store.local_invites("a").unwrap().len(), 2);
        assert!(store.delete_local_invite("a", "u2").unwrap());
        assert!(!store.delete_local_invite("a", "u2").unwrap());
        assert!(store.local_invite("b", "u1").unwrap().is_none());
        store.delete_account("a").unwrap();
        assert!(!store.has_local_invites("a").unwrap(), "they go with their mailbox");
    }
}
