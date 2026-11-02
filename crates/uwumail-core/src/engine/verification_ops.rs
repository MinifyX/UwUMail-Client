//! Sign-in codes a UwUMail server found in the mail of a JMAP account (see `jmap_verification`).
//!
//! The codes still valid are asked for after a sync that changed mail, after the first sync and
//! when the earliest code ran out (there is no `queryChanges`: the list changes as codes expire).
//! They are kept in memory only: a code is a secret for minutes, so it never goes to disk.

use chrono::{DateTime, Utc};

use super::*;
use crate::jmap_verification::{self, VerificationCode};
use crate::notify;

/// The codes of an account as last asked.
#[derive(Default)]
pub(super) struct CodeCache {
    by_account: HashMap<String, Vec<VerificationCode>>,
}

impl CodeCache {
    /// Whether the account's list has to be asked for again at `now`.
    fn due(&self, account_id: &str, now: DateTime<Utc>) -> bool {
        match self.by_account.get(account_id) {
            None => true,
            Some(codes) => codes.iter().any(|code| !code.valid_at(now)),
        }
    }
}

impl Engine {
    /// The sign-in codes still valid in every account, newest first. Empty for accounts whose
    /// server doesn't find codes; mails no longer here (deleted, account removed) drop out.
    pub fn verification_codes(&self) -> Result<Vec<VerificationCode>> {
        let now = Utc::now();
        let codes: Vec<VerificationCode> = {
            let cache = self.inner.verification_codes.lock().unwrap();
            cache.by_account.values().flatten().filter(|code| code.valid_at(now)).cloned().collect()
        };
        if codes.is_empty() {
            return Ok(codes);
        }
        let ids: Vec<String> = codes.iter().map(|code| code.email_id.clone()).collect();
        let present: HashSet<String> =
            self.inner.store.messages_by_ids(&ids)?.into_iter().map(|message| message.id).collect();
        let mut codes: Vec<VerificationCode> =
            codes.into_iter().filter(|code| present.contains(&code.email_id)).collect();
        // Newest first across accounts: the latest to expire came last.
        codes.sort_by(|a, b| b.expires_at.cmp(&a.expires_at));
        Ok(codes)
    }

    /// The codes still valid of these mails (e.g. those of a `MailReceived`), for notifications.
    pub fn verification_codes_for(&self, message_ids: &[String]) -> Vec<VerificationCode> {
        let now = Utc::now();
        let cache = self.inner.verification_codes.lock().unwrap();
        message_ids
            .iter()
            .filter_map(|id| cache.by_account.values().flatten().find(|code| &code.email_id == id))
            .filter(|code| code.valid_at(now))
            .cloned()
            .collect()
    }

    /// The notification of a new mail with a sign-in code, if it has one that can be shown.
    /// `None` notifies the mail as usual.
    pub fn code_notification(
        &self,
        prefs: &notify::NotifyPrefs,
        message_id: &str,
        platform: notify::NotifyPlatform,
    ) -> Option<(VerificationCode, notify::CodeNotification)> {
        let code = self.verification_codes_for(std::slice::from_ref(&message_id.to_string())).pop()?;
        let note =
            notify::code_notification(prefs, &code.sender, &code.for_notification(), platform, Utc::now().timestamp())?;
        Some((code, note))
    }
}

impl Inner {
    /// Asks the server for the account's codes when that's due: `mail_changed` after a sync that
    /// brought or changed mail. A failure only leaves the old list; mail syncs on.
    pub(super) async fn refresh_verification_codes(&self, client: &JmapClient, account_id: &str, mail_changed: bool) {
        if !client.session.verification {
            return;
        }
        let due = mail_changed || self.verification_codes.lock().unwrap().due(account_id, Utc::now());
        if !due {
            return;
        }
        match self.load_verification_codes(client, account_id).await {
            Ok(codes) => {
                self.verification_codes.lock().unwrap().by_account.insert(account_id.to_string(), codes);
            }
            Err(error) => tracing::info!("Couldn't ask for the sign-in codes of {account_id}: {error}"),
        }
    }

    async fn load_verification_codes(&self, client: &JmapClient, account_id: &str) -> Result<Vec<VerificationCode>> {
        let found = jmap_verification::fetch(client, &client.session.account_id).await?;
        if found.is_empty() {
            return Ok(Vec::new());
        }
        let remote: Vec<String> = found.iter().map(|(id, _)| id.clone()).collect();
        let local = self.store.ids_by_remote(account_id, &remote)?;
        let ids: Vec<String> = local.values().cloned().collect();
        let messages: HashMap<String, Message> =
            self.store.messages_by_ids(&ids)?.into_iter().map(|message| (message.id.clone(), message)).collect();
        // Only mail this device has: the bar and the reader point at it.
        Ok(found
            .iter()
            .filter_map(|(remote_id, code)| {
                let message = messages.get(local.get(remote_id)?)?;
                let sender = notify::notification_sender(message.from.name.as_deref(), &message.from.email);
                Some(VerificationCode::new(account_id, &message.id, &message.thread_id, sender, code))
            })
            .collect())
    }

    /// Forgets the codes of an account (removed, or signed out).
    pub(super) fn forget_verification_codes(&self, account_id: &str) {
        self.verification_codes.lock().unwrap().by_account.remove(account_id);
    }
}
