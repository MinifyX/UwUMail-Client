//! Shared mailboxes nested under the Microsoft account whose sign-in opens them (see `shared`).
//!
//! Kept next to the account rows rather than in `AccountRecord`: a shared mailbox is an account
//! like any other everywhere else.

use std::collections::HashMap;

use rusqlite::{OptionalExtension, params};

use super::{AccountRecord, Store};
use crate::error::Result;
use crate::model::AuthKind;

/// The migration of this feature, appended to `MIGRATIONS`.
pub(super) const MIGRATION: &str = r#"
-- Shared mailboxes: the Microsoft account a shared mailbox is opened with (its sign-in, no secret
-- of its own), who an account's sign-in belongs to ('' when that couldn't be read), when the
-- account was last searched for shared mailboxes and how that went, and the found ones the
-- person removed, which a search doesn't bring back.
ALTER TABLE accounts ADD COLUMN parent_id TEXT;
ALTER TABLE accounts ADD COLUMN sign_in_as TEXT;
ALTER TABLE accounts ADD COLUMN shared_checked_at INTEGER;
ALTER TABLE accounts ADD COLUMN shared_state TEXT;
CREATE TABLE shared_dismissed (
    parent_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (parent_id, email)
);
"#;

/// How an account relates to shared mailboxes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AccountLink {
    /// For a shared mailbox: the account it is opened with.
    pub parent_id: Option<String>,
    /// Whose sign-in the account's token is; `Some("")` when that couldn't be read.
    pub sign_in_as: Option<String>,
    /// When it was last searched for shared mailboxes (unix seconds).
    pub shared_checked_at: Option<i64>,
    /// How that search went: `done`, `needsSignIn`, `unavailable` or `personal`.
    pub shared_state: Option<String>,
}

impl AccountLink {
    /// The sign-in's address, when known.
    pub fn signed_in_as(&self) -> Option<&str> {
        self.sign_in_as.as_deref().filter(|address| !address.is_empty())
    }
}

/// Which standalone Microsoft mailboxes are really shared mailboxes of another account here:
/// their sign-in belongs to someone else, and that someone's own address is a Microsoft account
/// here. Pairs of (shared mailbox, account it goes under).
///
/// Only the address counts. Where sign-in names differ from mail addresses, a person's own
/// mailbox looks like one opened by someone else too; the search for shared mailboxes sorts
/// those out (it knows which mailboxes are shared with whom).
pub fn shared_by_sign_in(accounts: &[(AccountRecord, AccountLink)]) -> Vec<(String, String)> {
    let microsoft_top =
        |(record, link): &&(AccountRecord, AccountLink)| record.auth == AuthKind::Microsoft && link.parent_id.is_none();
    let has_children = |id: &str| accounts.iter().any(|(_, link)| link.parent_id.as_deref() == Some(id));
    let mut pairs = Vec::new();
    for (record, link) in accounts.iter().filter(microsoft_top) {
        let Some(person) = link.signed_in_as() else { continue };
        if person.eq_ignore_ascii_case(&record.email) || has_children(&record.id) {
            continue;
        }
        // The account's own sign-in must be that person's too, where it is known: the shared
        // mailbox loses its own copy of the sign-in and uses the account's from then on.
        let parent = accounts.iter().filter(microsoft_top).find(|(other, other_link)| {
            other.id != record.id
                && other.email.eq_ignore_ascii_case(person)
                && other_link.signed_in_as().is_none_or(|own| own.eq_ignore_ascii_case(person))
        });
        if let Some((parent, _)) = parent {
            pairs.push((record.id.clone(), parent.id.clone()));
        }
    }
    pairs
}

fn link_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AccountLink> {
    Ok(AccountLink {
        parent_id: row.get("parent_id")?,
        sign_in_as: row.get("sign_in_as")?,
        shared_checked_at: row.get("shared_checked_at")?,
        shared_state: row.get("shared_state")?,
    })
}

impl Store {
    /// Every account's link, by account id.
    pub fn account_links(&self) -> Result<HashMap<String, AccountLink>> {
        let conn = self.conn();
        let mut statement =
            conn.prepare("SELECT id, parent_id, sign_in_as, shared_checked_at, shared_state FROM accounts")?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>("id")?, link_from_row(row)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn account_link(&self, id: &str) -> Result<AccountLink> {
        Ok(self
            .conn()
            .query_row(
                "SELECT parent_id, sign_in_as, shared_checked_at, shared_state FROM accounts WHERE id = ?1",
                [id],
                link_from_row,
            )
            .optional()?
            .unwrap_or_default())
    }

    pub fn set_account_parent(&self, id: &str, parent_id: Option<&str>) -> Result<()> {
        self.conn().execute("UPDATE accounts SET parent_id = ?1 WHERE id = ?2", params![parent_id, id])?;
        Ok(())
    }

    pub fn set_account_sign_in_as(&self, id: &str, address: &str) -> Result<()> {
        self.conn().execute("UPDATE accounts SET sign_in_as = ?1 WHERE id = ?2", params![address, id])?;
        Ok(())
    }

    pub fn set_shared_search(&self, id: &str, state: &str, at: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE accounts SET shared_state = ?1, shared_checked_at = ?2 WHERE id = ?3",
            params![state, at, id],
        )?;
        Ok(())
    }

    /// The shared mailboxes of `parent_id`, oldest first.
    pub fn shared_children(&self, parent_id: &str) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut statement = conn.prepare("SELECT id FROM accounts WHERE parent_id = ?1 ORDER BY created_at")?;
        let ids = statement.query_map([parent_id], |row| row.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(ids)
    }

    /// Remembers that the person removed this shared mailbox of `parent_id`.
    pub fn dismiss_shared(&self, parent_id: &str, email: &str) -> Result<()> {
        self.conn().execute(
            "INSERT OR IGNORE INTO shared_dismissed (parent_id, email) VALUES (?1, ?2)",
            params![parent_id, email],
        )?;
        Ok(())
    }

    /// Added again by hand: no longer dismissed.
    pub fn undismiss_shared(&self, parent_id: &str, email: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM shared_dismissed WHERE parent_id = ?1 AND email = ?2", params![parent_id, email])?;
        Ok(())
    }

    pub fn is_shared_dismissed(&self, parent_id: &str, email: &str) -> Result<bool> {
        Ok(self
            .conn()
            .query_row(
                "SELECT 1 FROM shared_dismissed WHERE parent_id = ?1 AND email = ?2",
                params![parent_id, email],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// Nests standalone Microsoft mailboxes under the account whose sign-in opens them (see
    /// [`shared_by_sign_in`]). Returns the ids of the ones nested now; their mail, folders and
    /// settings stay as they are.
    pub fn nest_shared_by_sign_in(&self) -> Result<Vec<(String, String)>> {
        let links = self.account_links()?;
        let accounts: Vec<(AccountRecord, AccountLink)> = self
            .accounts()?
            .into_iter()
            .map(|record| {
                let link = links.get(&record.id).cloned().unwrap_or_default();
                (record, link)
            })
            .collect();
        let pairs = shared_by_sign_in(&accounts);
        for (child, parent) in &pairs {
            self.set_account_parent(child, Some(parent))?;
        }
        Ok(pairs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    fn record(id: &str, email: &str, auth: AuthKind) -> AccountRecord {
        AccountRecord {
            id: id.into(),
            name: "contoso.example".into(),
            email: email.into(),
            display_name: id.into(),
            color: AccountColor::Sky,
            auth,
            username: email.into(),
            imap: ServerSettings { host: "outlook.office365.com".into(), port: 993, security: Security::Tls },
            smtp: ServerSettings { host: "smtp.office365.com".into(), port: 587, security: Security::Starttls },
            protocol: Protocol::Imap,
            jmap_url: None,
        }
    }

    #[test]
    fn a_manually_added_shared_mailbox_moves_under_its_person() {
        let store = Store::open_in_memory().unwrap();
        store.insert_account(&record("alex", "alex@contoso.example", AuthKind::Microsoft)).unwrap();
        store.insert_account(&record("team", "team@contoso.example", AuthKind::Microsoft)).unwrap();
        store.insert_account(&record("other", "kim@contoso.example", AuthKind::Microsoft)).unwrap();
        store.insert_account(&record("pw", "pw@mail.example", AuthKind::Password)).unwrap();
        store
            .upsert_folder(
                "team",
                &crate::store::FolderInfo {
                    path: "INBOX",
                    name: "INBOX",
                    role: Some(FolderRole::Inbox),
                    delimiter: Some("/"),
                    selectable: true,
                    parent_ref: None,
                },
            )
            .unwrap();

        // Nobody knows yet whose sign-in opens the team mailbox: nothing moves.
        assert!(store.nest_shared_by_sign_in().unwrap().is_empty());
        // Its own sign-in, and one that couldn't be read, move nothing either.
        store.set_account_sign_in_as("other", "KIM@contoso.example").unwrap();
        store.set_account_sign_in_as("alex", "").unwrap();
        assert!(store.nest_shared_by_sign_in().unwrap().is_empty());

        store.set_account_sign_in_as("team", "Alex@Contoso.example").unwrap();
        assert_eq!(store.nest_shared_by_sign_in().unwrap(), vec![("team".to_string(), "alex".to_string())]);
        assert_eq!(store.account_link("team").unwrap().parent_id.as_deref(), Some("alex"));
        assert_eq!(store.shared_children("alex").unwrap(), vec!["team".to_string()]);
        // Same id, same folders: nothing was rebuilt.
        assert_eq!(store.account("team").unwrap().email, "team@contoso.example");
        assert_eq!(store.folders(Some("team")).unwrap().len(), 1);
        // Done once.
        assert!(store.nest_shared_by_sign_in().unwrap().is_empty());
    }

    #[test]
    fn only_the_persons_own_address_takes_a_shared_mailbox() {
        let alex = (record("alex", "alex@contoso.example", AuthKind::Microsoft), AccountLink::default());
        let team = (
            record("team", "team@contoso.example", AuthKind::Microsoft),
            AccountLink { sign_in_as: Some("alex@contoso.example".into()), ..Default::default() },
        );
        assert_eq!(shared_by_sign_in(&[alex.clone(), team.clone()]), vec![("team".into(), "alex".into())]);
        // Sign-in names that aren't mail addresses: two mailboxes with the same sign-in, and
        // nothing tells which one is the person's. Neither moves.
        let muster = (
            record("alex", "alex.muster@contoso.example", AuthKind::Microsoft),
            AccountLink { sign_in_as: Some("alex@contoso.example".into()), ..Default::default() },
        );
        assert!(shared_by_sign_in(&[muster, team.clone()]).is_empty());
        // A Google or password account never takes a shared mailbox.
        let google = (record("alex", "alex@contoso.example", AuthKind::Google), AccountLink::default());
        assert!(shared_by_sign_in(&[google, team.clone()]).is_empty());
        // An account with that address whose own sign-in is someone else's (Kim opens Alex's
        // mailbox) doesn't take it: its token isn't Alex's.
        let kims = (
            record("alex", "alex@contoso.example", AuthKind::Microsoft),
            AccountLink { sign_in_as: Some("kim@contoso.example".into()), ..Default::default() },
        );
        assert!(shared_by_sign_in(&[kims, team.clone()]).is_empty());
        // A mailbox that already has shared ones under it stays where it is.
        let child = (
            record("c", "c@contoso.example", AuthKind::Microsoft),
            AccountLink { parent_id: Some("team".into()), ..Default::default() },
        );
        assert!(shared_by_sign_in(&[alex, team, child]).is_empty());
    }

    #[test]
    fn dismissed_mailboxes_are_remembered_per_account() {
        let store = Store::open_in_memory().unwrap();
        store.insert_account(&record("alex", "alex@contoso.example", AuthKind::Microsoft)).unwrap();
        store.dismiss_shared("alex", "team@contoso.example").unwrap();
        store.dismiss_shared("alex", "team@contoso.example").unwrap();
        assert!(store.is_shared_dismissed("alex", "TEAM@contoso.example").unwrap());
        store.undismiss_shared("alex", "Team@Contoso.example").unwrap();
        assert!(!store.is_shared_dismissed("alex", "team@contoso.example").unwrap());
        store.dismiss_shared("alex", "team@contoso.example").unwrap();
        store.delete_account("alex").unwrap();
        // Gone with the account.
        store.insert_account(&record("alex", "alex@contoso.example", AuthKind::Microsoft)).unwrap();
        assert!(!store.is_shared_dismissed("alex", "team@contoso.example").unwrap());
    }
}
