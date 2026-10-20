//! Snooze: mail leaves for a folder named "Snoozed" and comes back, unread, to where it was.
//!
//! When it comes back is the page's to keep: a synced setting `snooze:<id>` names the mailbox,
//! the Message-ID, the folder it came from and the time. Every running device looks at those and
//! calls [`Engine::unsnooze`] for the ones that are due. The mail is found again by its
//! Message-ID in the Snoozed folder, so it doesn't matter that another device moved it already,
//! or that the server gave it a new uid: what isn't there any more counts as done.

use serde::{Deserialize, Serialize};

use super::*;

/// The folder snoozed mail waits in. Found by this name (any case) on every device.
pub const SNOOZED_FOLDER: &str = "Snoozed";
/// The longest Message-ID a snooze keeps (the line limit of RFC 5322).
pub const MAX_HEADER_ID: usize = 998;
/// How many rows of the Snoozed folder the list labels at most.
const MAX_LISTED: usize = 5000;

/// A message that went into the Snoozed folder, with what the snooze needs to bring it back.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnoozedMessage {
    pub id: String,
    pub account_id: String,
    /// The Message-ID header, without angle brackets.
    pub header_id: String,
    /// The folder it came from; `None` when it already was in the Snoozed folder.
    pub folder_id: Option<String>,
}

/// What [`Engine::unsnooze`] did.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UnsnoozeOutcome {
    /// The mail is back in its folder, unread.
    Moved,
    /// It isn't in the Snoozed folder (any more): someone else brought it back or moved it.
    Gone,
    /// This device doesn't know the mailbox's folders yet; try again later.
    Waiting,
}

/// The Snoozed folder among a mailbox's folders: by name, at the top first.
fn find_snoozed(folders: &[Folder]) -> Option<&Folder> {
    folders
        .iter()
        .filter(|folder| folder.selectable && folder.role.is_none() && folder.name.eq_ignore_ascii_case(SNOOZED_FOLDER))
        .min_by_key(|folder| folder.parent_id.is_some())
}

/// Whether `id` can be a snooze's Message-ID: 1–998 characters without controls, spaces or
/// angle brackets.
pub fn valid_header_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= MAX_HEADER_ID
        && !id.chars().any(|c| c.is_control() || c.is_whitespace() || c == '<' || c == '>')
}

impl Engine {
    /// Moves mail into the mailbox's Snoozed folder, which is made if it's missing. Mail without
    /// a Message-ID can't be found again on another device, so nothing moves when one lacks it.
    pub async fn snooze_messages(&self, message_ids: &[String]) -> Result<Vec<SnoozedMessage>> {
        let store = &self.inner.store;
        let locations = store.locations(message_ids)?;
        self.inner.refuse_read_only(&locations)?;
        if locations.iter().any(|location| !location.message_id.as_deref().is_some_and(valid_header_id)) {
            return Err(Error::invalid("This mail has no Message-ID, so it can't be snoozed."));
        }
        let mut snoozed = Vec::with_capacity(locations.len());
        for (account_id, messages) in by_account(&locations) {
            let folder_id = self.snoozed_folder(&account_id, true).await?.expect("made when missing");
            let ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
            self.move_messages(&ids, &folder_id).await?;
            snoozed.extend(messages.into_iter().map(|m| SnoozedMessage {
                folder_id: (m.folder_id != folder_id).then_some(m.folder_id),
                id: m.id,
                account_id: account_id.clone(),
                header_id: m.message_id.unwrap_or_default(),
            }));
        }
        Ok(snoozed)
    }

    /// Brings snoozed mail back: the mail with this Message-ID in the Snoozed folder of
    /// `account_id` turns unread and moves to the folder `folder_id` (the inbox when there's none,
    /// or it's gone).
    /// Over IMAP the server is asked by Message-ID, so a new uid or mail older than what the
    /// phone keeps comes back as well; JMAP looks there when the store doesn't have it.
    pub async fn unsnooze(
        &self,
        account_id: &str,
        header_id: &str,
        folder_id: Option<&str>,
    ) -> Result<UnsnoozeOutcome> {
        let store = &self.inner.store;
        if !valid_header_id(header_id) {
            return Err(Error::invalid("This isn't a Message-ID."));
        }
        let account = store.account(account_id)?;
        if store.folder_records(account_id)?.is_empty() {
            return Ok(UnsnoozeOutcome::Waiting);
        }
        let Some(snoozed_id) = self.snoozed_folder(account_id, false).await? else {
            return Ok(UnsnoozeOutcome::Gone);
        };
        let snoozed = store.folder(&snoozed_id)?;
        let target = match store
            .folder_records(account_id)?
            .into_iter()
            .find(|f| Some(f.id.as_str()) == folder_id && f.selectable)
        {
            Some(folder) if folder.id != snoozed.id => folder,
            _ => match store.folder_by_role(account_id, FolderRole::Inbox)? {
                Some(inbox) => inbox,
                None => return Ok(UnsnoozeOutcome::Waiting),
            },
        };

        let local = store.ids_by_header_id(&snoozed.id, header_id)?;
        if account.protocol == Protocol::Jmap && !local.is_empty() {
            // JMAP ids stay the same when mail moves, so what the store knows is enough.
            self.set_flags(&local, FlagChange { seen: Some(false), flagged: None }).await?;
            self.move_messages(&local, &target.id).await?;
            return Ok(UnsnoozeOutcome::Moved);
        }

        // IMAP uids change when mail moves, and the store may not have the mail at all (older
        // than what the phone keeps), so the server is asked by Message-ID.
        self.inner.refuse_read_only_account(account_id)?;
        let found = if account.protocol == Protocol::Jmap {
            let client = self.inner.jmap_client(account_id).await?;
            let ids = jmap_sync::emails_with_message_id(&client, &snoozed.path, header_id).await?;
            if !ids.is_empty() {
                jmap_sync::set_keywords(&client, &ids, &[("$seen", false)]).await?;
                jmap_sync::move_emails(&client, &ids, &target.path).await?;
            }
            !ids.is_empty()
        } else {
            let (from, to) = (snoozed.path.as_str(), target.path.as_str());
            with_session!(self.inner, account_id, |session| async {
                let uids = imap::uids_with_message_id(session, from, header_id).await?;
                imap::store_flags(session, from, &uids, "-FLAGS.SILENT (\\Seen)").await?;
                imap::move_messages(session, from, &uids, to).await?;
                Ok::<_, Error>(!uids.is_empty())
            })?
        };
        if found && !local.is_empty() {
            store.apply_flag_change(&local, FlagChange { seen: Some(false), flagged: None })?;
            store.move_local(&local, &target.id)?;
        }
        // Mail the store still had there but the server didn't went elsewhere; sync catches up.
        if found || !local.is_empty() {
            self.inner.emit(EngineEvent::MailChanged { account_id: account_id.to_string() });
            self.inner.wake(account_id);
        }
        Ok(if found { UnsnoozeOutcome::Moved } else { UnsnoozeOutcome::Gone })
    }

    /// List id and Message-ID of the mail in a folder, for "Snoozed until …" on its rows. Each
    /// message comes twice: under its conversation's id and under its own (`m:<id>`, the list's
    /// id when conversations are off).
    pub fn folder_header_ids(&self, folder_id: &str) -> Result<Vec<(String, String)>> {
        let rows = self.inner.store.header_ids_in_folder(folder_id, MAX_LISTED)?;
        Ok(rows
            .into_iter()
            .flat_map(|(thread_id, id, header_id)| [(thread_id, header_id.clone()), (format!("m:{id}"), header_id)])
            .collect())
    }

    /// The id of the mailbox's Snoozed folder; made on the server first when `create` is set.
    async fn snoozed_folder(&self, account_id: &str, create: bool) -> Result<Option<String>> {
        let folders = self.inner.store.folders(Some(account_id))?;
        if let Some(folder) = find_snoozed(&folders) {
            return Ok(Some(folder.id.clone()));
        }
        if !create {
            return Ok(None);
        }
        match self.create_folder(Some(account_id), SNOOZED_FOLDER, None).await {
            Ok(id) => Ok(Some(id)),
            // Made meanwhile, by a sync or another device: look again.
            Err(error) => {
                let folders = self.inner.store.folders(Some(account_id))?;
                find_snoozed(&folders).map(|folder| Some(folder.id.clone())).ok_or(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::FolderInfo;

    fn engine() -> (tempfile::TempDir, Engine) {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::new(EngineOptions {
            data_dir: dir.path().to_path_buf(),
            secrets: Arc::new(crate::secrets::MemorySecrets::default()),
            open_url: Arc::new(|_| {}),
            recognizer: None,
        })
        .unwrap();
        engine.inner.background_sync.store(false, Ordering::Relaxed);
        engine
            .inner
            .store
            .insert_account(&AccountRecord {
                id: "acc".into(),
                name: "Test".into(),
                email: "mini@uwumail.example".into(),
                display_name: "Mini".into(),
                color: AccountColor::Pink,
                auth: AuthKind::Password,
                username: "mini@uwumail.example".into(),
                imap: ServerSettings { host: "imap.uwumail.invalid".into(), port: 993, security: Security::Tls },
                smtp: ServerSettings { host: "smtp.uwumail.invalid".into(), port: 465, security: Security::Tls },
                protocol: Protocol::Imap,
                jmap_url: None,
            })
            .unwrap();
        (dir, engine)
    }

    fn folder(engine: &Engine, path: &str, role: Option<FolderRole>) -> String {
        let name = path.rsplit('.').next().unwrap();
        engine
            .inner
            .store
            .upsert_folder(
                "acc",
                &FolderInfo { path, name, role, delimiter: Some("."), selectable: true, parent_ref: None },
            )
            .unwrap()
    }

    #[tokio::test]
    async fn the_snoozed_folder_is_found_by_name_at_the_top_first() {
        let (_dir, engine) = engine();
        folder(&engine, "INBOX", Some(FolderRole::Inbox));
        let nested = folder(&engine, "INBOX.snoozed", None);
        let folders = engine.inner.store.folders(Some("acc")).unwrap();
        assert_eq!(find_snoozed(&folders).map(|f| f.id.clone()), Some(nested));
        let top = folder(&engine, "Snoozed", None);
        let folders = engine.inner.store.folders(Some("acc")).unwrap();
        assert_eq!(find_snoozed(&folders).map(|f| f.id.clone()), Some(top));
    }

    #[test]
    fn message_ids_are_checked() {
        assert!(valid_header_id("abc@uwumail.example"));
        assert!(!valid_header_id(""));
        assert!(!valid_header_id("a b"));
        assert!(!valid_header_id("<a@uwumail.example>"));
        assert!(!valid_header_id("a\r\nb"));
        assert!(!valid_header_id(&"a".repeat(MAX_HEADER_ID + 1)));
        assert!(valid_header_id(&"a".repeat(MAX_HEADER_ID)));
    }

    #[tokio::test]
    async fn unsnooze_waits_for_folders_and_knows_when_mail_is_gone() {
        let (_dir, engine) = engine();
        // A fresh device that hasn't listed the folders yet doesn't drop the snooze.
        assert_eq!(engine.unsnooze("acc", "a@uwumail.example", None).await.unwrap(), UnsnoozeOutcome::Waiting);
        folder(&engine, "INBOX", Some(FolderRole::Inbox));
        // No Snoozed folder: nothing waits there.
        assert_eq!(engine.unsnooze("acc", "a@uwumail.example", None).await.unwrap(), UnsnoozeOutcome::Gone);
        assert!(engine.unsnooze("acc", "a b", None).await.is_err());
        assert!(engine.unsnooze("nobody", "a@uwumail.example", None).await.is_err());
    }

    #[tokio::test]
    async fn mail_without_a_message_id_isnt_snoozed() {
        let (_dir, engine) = engine();
        let inbox = folder(&engine, "INBOX", Some(FolderRole::Inbox));
        let raw = b"From: a@uwumail.example\r\nSubject: hi\r\n\r\nbody\r\n";
        let parsed = crate::mime::parse(raw);
        let id = engine
            .inner
            .store
            .insert_message("acc", &inbox, 1, MessageFlags::default(), raw.len() as u64, None, &parsed)
            .unwrap()
            .unwrap();
        let error = engine.snooze_messages(&[id]).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
    }
}
