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

/// Security review 0.10 (SL-3, SL-4, SL-5): an entry stays in the outbox until its mail is sent
/// or safely somewhere else. `claimed_at` marks one being sent right now; `held` one that waits
/// for the person and never goes on its own (`failed`: it couldn't be sent and Drafts couldn't
/// take it; `unsure`: it may have gone out), `held_reason` says why.
pub(super) const HOLD_MIGRATION: &str = r#"
ALTER TABLE outbox ADD COLUMN claimed_at INTEGER;
ALTER TABLE outbox ADD COLUMN held TEXT;
ALTER TABLE outbox ADD COLUMN held_reason TEXT;
"#;

/// `held`: it couldn't be sent, and Drafts couldn't take it either.
pub const HELD_FAILED: &str = "failed";
/// `held`: sending broke off when it may already have gone out.
pub const HELD_UNSURE: &str = "unsure";

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
    /// [`HELD_FAILED`] or [`HELD_UNSURE`] when it waits for the person.
    pub held: Option<String>,
    pub held_reason: Option<String>,
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

    /// Claims every entry due at `now` to be sent, each only once and only while it is still due:
    /// an entry moved to a later time in the meantime stays. A claimed entry stays in the outbox
    /// until [`finish_outbox`](Self::finish_outbox), [`retry_outbox`](Self::retry_outbox) or
    /// [`hold_outbox`](Self::hold_outbox), so a quit or crash while sending never loses it.
    pub fn take_due_outbox(&self, now: i64) -> Result<Vec<TakenSend>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "UPDATE outbox SET claimed_at = ?1 WHERE claimed_at IS NULL AND held IS NULL AND send_at <= ?1
             RETURNING id, account_id, message_json, later, attempts, send_at",
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

    /// A claimed entry went out (or is safe in Drafts): it leaves the outbox.
    pub fn finish_outbox(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM outbox WHERE id = ?1", [id])?;
        Ok(())
    }

    /// A claimed entry couldn't reach its server: it waits again until `send_at`.
    pub fn retry_outbox(&self, id: &str, send_at: i64, attempts: u32) -> Result<bool> {
        Ok(self.conn().execute(
            "UPDATE outbox SET claimed_at = NULL, send_at = ?2, attempts = ?3 WHERE id = ?1 AND claimed_at IS NOT NULL",
            params![id, send_at, attempts],
        )? > 0)
    }

    /// A claimed entry waits for the person ([`HELD_FAILED`] or [`HELD_UNSURE`]) and never goes
    /// on its own; it is listed with the scheduled mail, also when it was an "undo send" one.
    pub fn hold_outbox(&self, id: &str, held: &str, reason: &str) -> Result<bool> {
        Ok(self.conn().execute(
            "UPDATE outbox SET claimed_at = NULL, held = ?2, held_reason = ?3, later = 1 WHERE id = ?1",
            params![id, held, reason],
        )? > 0)
    }

    /// Entries still claimed when UwUMail starts were being sent when it stopped: they may have
    /// gone out, so they are held ([`HELD_UNSURE`]) instead of sent again. How many there were.
    pub fn release_claimed_outbox(&self, reason: &str) -> Result<usize> {
        Ok(self.conn().execute(
            "UPDATE outbox SET claimed_at = NULL, held = ?1, held_reason = ?2, later = 1 WHERE claimed_at IS NOT NULL",
            params![HELD_UNSURE, reason],
        )?)
    }

    /// When the next entry is due, if any (held and claimed ones aren't).
    pub fn next_outbox_at(&self) -> Result<Option<i64>> {
        Ok(self.conn().query_row(
            "SELECT MIN(send_at) FROM outbox WHERE claimed_at IS NULL AND held IS NULL",
            [],
            |row| row.get(0),
        )?)
    }

    /// The mail scheduled on purpose or held for the person, soonest first; not what is being
    /// sent right now.
    pub fn later_outbox(&self) -> Result<Vec<LaterSend>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, account_id, message_json, send_at, attempts, held, held_reason FROM outbox
             WHERE later = 1 AND claimed_at IS NULL ORDER BY send_at",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(LaterSend {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    message_json: row.get(2)?,
                    send_at: row.get(3)?,
                    attempts: row.get(4)?,
                    held: row.get(5)?,
                    held_reason: row.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub fn later_outbox_count(&self) -> Result<usize> {
        let count: i64 = self.conn().query_row("SELECT COUNT(*) FROM outbox WHERE later = 1", [], |row| row.get(0))?;
        Ok(usize::try_from(count).unwrap_or(usize::MAX))
    }

    /// Gives a scheduled entry of this account a new time; a held one goes again (the person
    /// asked for it). False when it is gone or being sent.
    pub fn reschedule_later_outbox(&self, id: &str, account_id: &str, send_at: i64) -> Result<bool> {
        Ok(self.conn().execute(
            "UPDATE outbox SET send_at = ?3, attempts = 0, held = NULL, held_reason = NULL
             WHERE id = ?1 AND account_id = ?2 AND later = 1 AND claimed_at IS NULL",
            params![id, account_id, send_at],
        )? > 0)
    }

    /// Holds a scheduled entry of this account back (or lets it go again with `None`), e.g. while
    /// stopping it writes Drafts. False when it is gone or being sent.
    pub fn set_later_held(&self, id: &str, account_id: &str, held: Option<&str>, reason: Option<&str>) -> Result<bool> {
        Ok(self.conn().execute(
            "UPDATE outbox SET held = ?3, held_reason = ?4
             WHERE id = ?1 AND account_id = ?2 AND later = 1 AND claimed_at IS NULL",
            params![id, account_id, held, reason],
        )? > 0)
    }

    /// Takes a scheduled entry of this account out, once, e.g. to stop or edit it; never one
    /// being sent.
    pub fn take_later_outbox(&self, id: &str, account_id: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row(
                "DELETE FROM outbox WHERE id = ?1 AND account_id = ?2 AND later = 1 AND claimed_at IS NULL
                 RETURNING message_json",
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

    #[test]
    fn an_entry_stays_while_it_is_sent_and_leaves_only_when_done() {
        let store = store();
        store.insert_later_outbox("s1", "acc", "{}", NOW, 0).unwrap();
        store.insert_outbox("undo", "acc", "{}", NOW).unwrap();
        let taken = store.take_due_outbox(NOW).unwrap();
        assert_eq!(ids(&taken), ["s1", "undo"]);
        // Claimed: not taken twice, not listed, not due, and nobody else can take or move it.
        assert!(store.take_due_outbox(NOW + MINUTE).unwrap().is_empty());
        assert!(store.later_outbox().unwrap().is_empty());
        assert_eq!(store.next_outbox_at().unwrap(), None);
        assert_eq!(store.take_later_outbox("s1", "acc").unwrap(), None);
        assert!(!store.reschedule_later_outbox("s1", "acc", NOW + 90 * MINUTE).unwrap());
        assert_eq!(store.take_outbox("undo").unwrap(), None, "undo can't take one being sent");
        assert_eq!(store.outbox().unwrap().len(), 2, "both still there while being sent");

        // Couldn't reach its server: due again later. Went out: gone.
        assert!(store.retry_outbox("s1", NOW + 2 * MINUTE, 1).unwrap());
        assert_eq!(store.later_outbox().unwrap()[0].attempts, 1);
        store.finish_outbox("undo").unwrap();
        assert_eq!(ids(&store.take_due_outbox(NOW + 2 * MINUTE).unwrap()), ["s1"]);
        store.finish_outbox("s1").unwrap();
        assert!(store.outbox().unwrap().is_empty());
    }

    #[test]
    fn a_mail_being_sent_when_uwumail_stopped_is_held_not_sent_again() {
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
            store.insert_later_outbox("s1", "acc", r#"{"subject":"Hi"}"#, NOW, 0).unwrap();
            store.insert_outbox("undo", "acc", "{}", NOW).unwrap();
            assert_eq!(store.take_due_outbox(NOW).unwrap().len(), 2);
            // UwUMail quits (tray, shutdown, crash) while both are on their way.
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(store.release_claimed_outbox("stopped").unwrap(), 2);
        let held = store.later_outbox().unwrap();
        assert_eq!(held.len(), 2, "both kept, also the undo-send one, and listed");
        assert!(held.iter().all(|entry| entry.held.as_deref() == Some(HELD_UNSURE)));
        assert_eq!(held[0].held_reason.as_deref(), Some("stopped"));
        assert!(store.take_due_outbox(NOW + 60 * MINUTE).unwrap().is_empty(), "never sent again on its own");
        assert_eq!(store.next_outbox_at().unwrap(), None);
        // The person decides: send it again.
        assert!(store.reschedule_later_outbox("s1", "acc", NOW + MINUTE).unwrap());
        assert_eq!(store.later_outbox().unwrap().iter().find(|e| e.id == "s1").unwrap().held, None);
        assert_eq!(ids(&store.take_due_outbox(NOW + MINUTE).unwrap()), ["s1"]);
    }

    #[test]
    fn a_held_entry_waits_for_the_person() {
        let store = store();
        store.insert_outbox("undo", "acc", "{}", NOW).unwrap();
        store.take_due_outbox(NOW).unwrap();
        // Drafts couldn't take it either: it stays, as scheduled mail.
        assert!(store.hold_outbox("undo", HELD_FAILED, "offline").unwrap());
        let listed = store.later_outbox().unwrap();
        assert_eq!(listed[0].held.as_deref(), Some(HELD_FAILED));
        assert!(store.take_due_outbox(NOW + 60 * MINUTE).unwrap().is_empty());

        // Held while stopping writes Drafts; let go again when that fails.
        store.insert_later_outbox("s1", "acc", "{}", NOW + MINUTE, 0).unwrap();
        assert!(store.set_later_held("s1", "acc", Some(HELD_FAILED), Some("stopping")).unwrap());
        assert!(store.take_due_outbox(NOW + 60 * MINUTE).unwrap().is_empty(), "not sent while held");
        assert!(store.set_later_held("s1", "acc", None, None).unwrap());
        assert_eq!(ids(&store.take_due_outbox(NOW + 60 * MINUTE).unwrap()), ["s1"]);
        assert!(!store.set_later_held("s1", "acc", None, None).unwrap(), "not while being sent");
    }
}
