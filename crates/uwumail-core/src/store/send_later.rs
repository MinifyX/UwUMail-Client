//! The outbox's mail sent later on purpose (see `send_later`). It shares the `outbox` table with
//! the "undo send" window; `later` tells the two apart, and `attempts` counts tries that couldn't
//! reach the server.

use rusqlite::{OptionalExtension, params};

use super::Store;
use crate::error::Result;

/// The migration of this feature, appended to `MIGRATIONS`.
pub(super) const MIGRATION: &str = r#"
-- Send later: mail the person scheduled (not just their undo window), and how often its server
-- couldn't be reached when its time came.
ALTER TABLE outbox ADD COLUMN later INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
"#;

/// An outbox entry taken out to be sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TakenSend {
    pub id: String,
    pub account_id: String,
    pub message_json: String,
    pub later: bool,
    pub attempts: u32,
}

/// A scheduled entry as the list shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaterSend {
    pub id: String,
    pub account_id: String,
    pub message_json: String,
    pub send_at: i64,
    pub attempts: u32,
}

impl Store {
    /// Queues a mail sent later on purpose; `send_at` in Unix milliseconds.
    pub fn insert_later_outbox(
        &self,
        id: &str,
        account_id: &str,
        message_json: &str,
        send_at: i64,
        attempts: u32,
    ) -> Result<()> {
        self.conn().execute(
            "INSERT INTO outbox (id, account_id, message_json, send_at, later, attempts) VALUES (?1, ?2, ?3, ?4, 1, ?5)",
            params![id, account_id, message_json, send_at, attempts],
        )?;
        Ok(())
    }

    /// Takes out every entry due at `now`, each only once and only while it is still due: an
    /// entry moved to a later time in the meantime stays.
    pub fn take_due_outbox(&self, now: i64) -> Result<Vec<TakenSend>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "DELETE FROM outbox WHERE send_at <= ?1 RETURNING id, account_id, message_json, later, attempts, send_at",
        )?;
        let mut rows: Vec<(TakenSend, i64)> = stmt
            .query_map([now], |row| {
                Ok((
                    TakenSend {
                        id: row.get(0)?,
                        account_id: row.get(1)?,
                        message_json: row.get(2)?,
                        later: row.get::<_, i64>(3)? != 0,
                        attempts: row.get(4)?,
                    },
                    row.get(5)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        rows.sort_by_key(|(_, send_at)| *send_at);
        Ok(rows.into_iter().map(|(taken, _)| taken).collect())
    }

    /// When the next entry is due, if any.
    pub fn next_outbox_at(&self) -> Result<Option<i64>> {
        Ok(self.conn().query_row("SELECT MIN(send_at) FROM outbox", [], |row| row.get(0))?)
    }

    /// The mail scheduled on purpose, soonest first.
    pub fn later_outbox(&self) -> Result<Vec<LaterSend>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, account_id, message_json, send_at, attempts FROM outbox WHERE later = 1 ORDER BY send_at",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(LaterSend {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    message_json: row.get(2)?,
                    send_at: row.get(3)?,
                    attempts: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub fn later_outbox_count(&self) -> Result<usize> {
        let count: i64 = self.conn().query_row("SELECT COUNT(*) FROM outbox WHERE later = 1", [], |row| row.get(0))?;
        Ok(usize::try_from(count).unwrap_or(usize::MAX))
    }

    /// Gives a scheduled entry of this account a new time. False when it is gone (sent or taken).
    pub fn reschedule_later_outbox(&self, id: &str, account_id: &str, send_at: i64) -> Result<bool> {
        Ok(self.conn().execute(
            "UPDATE outbox SET send_at = ?3, attempts = 0 WHERE id = ?1 AND account_id = ?2 AND later = 1",
            params![id, account_id, send_at],
        )? > 0)
    }

    /// Takes a scheduled entry of this account out, once, e.g. to stop or edit it.
    pub fn take_later_outbox(&self, id: &str, account_id: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row(
                "DELETE FROM outbox WHERE id = ?1 AND account_id = ?2 AND later = 1 RETURNING message_json",
                params![id, account_id],
                |row| row.get(0),
            )
            .optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;
    use crate::store::AccountRecord;

    const NOW: i64 = 1_790_000_000_000;
    const MINUTE: i64 = 60_000;

    fn store() -> Store {
        let store = Store::open_in_memory().unwrap();
        for id in ["acc", "other"] {
            store
                .insert_account(&AccountRecord {
                    id: id.into(),
                    name: "Test".into(),
                    email: format!("{id}@uwumail.example"),
                    display_name: "Mini".into(),
                    color: AccountColor::Pink,
                    auth: AuthKind::Password,
                    username: format!("{id}@uwumail.example"),
                    imap: ServerSettings { host: "imap.example".into(), port: 993, security: Security::Tls },
                    smtp: ServerSettings { host: "smtp.example".into(), port: 465, security: Security::Tls },
                    protocol: Protocol::Imap,
                    jmap_url: None,
                })
                .unwrap();
        }
        store
    }

    fn ids(taken: &[TakenSend]) -> Vec<&str> {
        taken.iter().map(|t| t.id.as_str()).collect()
    }

    #[test]
    fn scheduled_mail_goes_at_its_time_and_not_before() {
        let store = store();
        store.insert_later_outbox("monday", "acc", "{}", NOW + 3 * MINUTE, 0).unwrap();
        store.insert_outbox("undo", "acc", "{}", NOW + 10_000).unwrap();
        store.insert_later_outbox("evening", "acc", "{}", NOW + 2 * MINUTE, 0).unwrap();

        assert_eq!(store.next_outbox_at().unwrap(), Some(NOW + 10_000));
        assert!(store.take_due_outbox(NOW).unwrap().is_empty(), "nothing is due yet");
        let undo = store.take_due_outbox(NOW + 10_000).unwrap();
        assert_eq!(ids(&undo), ["undo"]);
        assert!(!undo[0].later, "the undo window isn't in the scheduled list");

        let later: Vec<String> = store.later_outbox().unwrap().into_iter().map(|l| l.id).collect();
        assert_eq!(later, ["evening", "monday"], "soonest first");
        assert_eq!(store.later_outbox_count().unwrap(), 2);

        // The clock jumps (a computer woke up): both go, in order, and only once.
        let due = store.take_due_outbox(NOW + 60 * MINUTE).unwrap();
        assert_eq!(ids(&due), ["evening", "monday"]);
        assert!(due.iter().all(|t| t.later));
        assert!(store.take_due_outbox(NOW + 60 * MINUTE).unwrap().is_empty());
        assert_eq!(store.next_outbox_at().unwrap(), None);
    }

    #[test]
    fn missed_times_go_on_the_next_start() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("uwumail.db");
        {
            let store = Store::open(&path).unwrap();
            store
                .insert_account(&AccountRecord {
                    id: "acc".into(),
                    name: "Test".into(),
                    email: "acc@uwumail.example".into(),
                    display_name: "Mini".into(),
                    color: AccountColor::Pink,
                    auth: AuthKind::Password,
                    username: "acc@uwumail.example".into(),
                    imap: ServerSettings { host: "imap.example".into(), port: 993, security: Security::Tls },
                    smtp: ServerSettings { host: "smtp.example".into(), port: 465, security: Security::Tls },
                    protocol: Protocol::Imap,
                    jmap_url: None,
                })
                .unwrap();
            store.insert_later_outbox("while-closed", "acc", r#"{"subject":"Hi"}"#, NOW + MINUTE, 0).unwrap();
        }
        // UwUMail was closed over the time and starts a day later.
        let store = Store::open(&path).unwrap();
        let next = store.next_outbox_at().unwrap().unwrap();
        assert!(next <= NOW + 86_400_000);
        let due = store.take_due_outbox(NOW + 86_400_000).unwrap();
        assert_eq!(ids(&due), ["while-closed"]);
        assert_eq!(due[0].message_json, r#"{"subject":"Hi"}"#);
    }

    #[test]
    fn a_new_time_moves_it_and_a_taken_one_is_gone() {
        let store = store();
        store.insert_later_outbox("s1", "acc", "{}", NOW + 2 * MINUTE, 3).unwrap();
        assert!(!store.reschedule_later_outbox("s1", "other", NOW + 90 * MINUTE).unwrap(), "only its own account");
        assert!(store.reschedule_later_outbox("s1", "acc", NOW + 90 * MINUTE).unwrap());
        assert!(store.take_due_outbox(NOW + 60 * MINUTE).unwrap().is_empty(), "moved later");
        assert_eq!(store.later_outbox().unwrap()[0].attempts, 0, "a new time starts over");

        // "Send now" is a new time of now.
        assert!(store.reschedule_later_outbox("s1", "acc", NOW).unwrap());
        assert_eq!(ids(&store.take_due_outbox(NOW).unwrap()), ["s1"]);
        assert!(!store.reschedule_later_outbox("s1", "acc", NOW).unwrap(), "already sent");

        store.insert_later_outbox("s2", "acc", "{\"x\":1}", NOW + 2 * MINUTE, 0).unwrap();
        store.insert_outbox("undo", "acc", "{}", NOW + 10_000).unwrap();
        assert_eq!(store.take_later_outbox("undo", "acc").unwrap(), None, "the undo window has its own way back");
        assert!(!store.reschedule_later_outbox("undo", "acc", NOW + 90 * MINUTE).unwrap());
        assert_eq!(store.take_later_outbox("s2", "other").unwrap(), None);
        assert_eq!(store.take_later_outbox("s2", "acc").unwrap().as_deref(), Some("{\"x\":1}"));
        assert_eq!(store.take_later_outbox("s2", "acc").unwrap(), None, "stopping and sending never both get it");
        assert!(store.take_due_outbox(NOW + 60 * MINUTE).unwrap().iter().all(|t| t.id != "s2"));
    }

    #[test]
    fn removing_the_mailbox_removes_its_scheduled_mail() {
        let store = store();
        store.insert_later_outbox("s1", "acc", "{}", NOW + 2 * MINUTE, 0).unwrap();
        store.insert_later_outbox("s2", "other", "{}", NOW + 2 * MINUTE, 0).unwrap();
        store.delete_account("acc").unwrap();
        let left: Vec<String> = store.later_outbox().unwrap().into_iter().map(|l| l.account_id).collect();
        assert_eq!(left, ["other"]);
    }
}
