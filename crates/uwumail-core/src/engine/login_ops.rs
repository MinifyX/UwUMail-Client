//! A mailbox's own name, and "Sign in with UwUMail": an app password that a UwUMail server makes
//! for this device through a browser sign-in (see `crate::uwumail_login`).

use std::sync::LazyLock;

use super::*;
use crate::uwumail_login::{self, AppPassword, Clients};

/// Registrations at UwUMail servers, reused for a while (see `Clients`).
static CLIENTS: LazyLock<Clients> = LazyLock::new(Clients::default);

/// The longest mailbox name.
const MAX_ACCOUNT_NAME: usize = 100;

/// A mailbox name: trimmed, without control characters, at most 100 characters; `None` when empty.
pub(super) fn account_name(name: &str) -> Result<Option<String>> {
    let name: String = name.trim().chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if name.chars().count() > MAX_ACCOUNT_NAME {
        return Err(Error::invalid(format!("A mailbox name has at most {MAX_ACCOUNT_NAME} characters.")));
    }
    Ok(Some(name).filter(|n| !n.is_empty()))
}

impl Engine {
    /// Renames a mailbox; an empty name calls it by its address again.
    pub fn rename_account(&self, account_id: &str, name: &str) -> Result<()> {
        let account = self.inner.store.account(account_id)?;
        let name = account_name(name)?.unwrap_or(account.email);
        if !self.inner.store.set_account_name(account_id, &name)? {
            return Err(Error::not_found("This mailbox no longer exists."));
        }
        self.inner.emit(EngineEvent::AccountsChanged {});
        Ok(())
    }

    /// Where the browser sign-in answers: the app link where the platform has one (phones), the
    /// loopback otherwise. The sender is what `finish_sign_in` hands app links to.
    pub(super) fn sign_in_redirect(
        &self,
        app_link_allowed: bool,
    ) -> (oauth::Redirect, Option<tokio::sync::mpsc::Sender<String>>) {
        let app_link = self.inner.oauth_redirect.lock().unwrap().clone();
        match app_link.filter(|_| app_link_allowed) {
            Some(uri) => {
                let (sender, incoming) = tokio::sync::mpsc::channel(SIGN_IN_LINK_QUEUE);
                // A newer sign-in replaces an abandoned one.
                *self.inner.pending_sign_in.lock().unwrap() = Some(sender.clone());
                (oauth::Redirect::App { uri, incoming }, Some(sender))
            }
            None => (oauth::Redirect::Loopback, None),
        }
    }

    /// Done either way; a sign-in started meanwhile keeps its slot.
    pub(super) fn sign_in_finished(&self, waiting: Option<tokio::sync::mpsc::Sender<String>>) {
        if let Some(ours) = waiting {
            let mut pending = self.inner.pending_sign_in.lock().unwrap();
            if pending.as_ref().is_some_and(|sender| sender.same_channel(&ours)) {
                *pending = None;
            }
        }
    }

    /// Signs in with UwUMail at the server of a JMAP session address and returns the app password
    /// it made for this device.
    pub(super) async fn uwumail_app_password(
        &self,
        session_url: &str,
        login_hint: &str,
        name: &str,
    ) -> Result<AppPassword> {
        let http = uwumail_login::http_client()?;
        let meta = uwumail_login::metadata(&http, session_url).await.ok_or_else(|| {
            Error::not_supported("This server doesn't offer signing in with UwUMail. Enter an app password instead.")
        })?;
        // A UwUMail server takes the app link on every platform.
        let (redirect, waiting) = self.sign_in_redirect(true);
        let made =
            uwumail_login::sign_in(&http, &meta, &CLIENTS, name, login_hint, self.inner.open_url.as_ref(), redirect)
                .await;
        self.sign_in_finished(waiting);
        made
    }

    /// Whether a password mailbox's server signs in with UwUMail, for signing in again that way.
    pub async fn uwumail_login_available(&self, account_id: &str) -> Result<bool> {
        let account = self.inner.store.account(account_id)?;
        // A shared mailbox of a JMAP login signs in with that login.
        if account.auth != AuthKind::Password || self.inner.jmap_share_of(account_id).is_some() {
            return Ok(false);
        }
        let Some(url) = trusted_jmap_url(&account) else { return Ok(false) };
        let http = uwumail_login::http_client()?;
        Ok(uwumail_login::metadata(&http, url).await.is_some())
    }

    /// Signs a password mailbox in again with UwUMail: a new app password named `name` replaces the
    /// old password, once it works.
    pub async fn uwumail_sign_in_again(&self, account_id: &str, name: &str) -> Result<Account> {
        let account = self.inner.store.account(account_id)?;
        if account.auth != AuthKind::Password {
            return Err(Error::invalid("This mailbox signs in with Microsoft or Google."));
        }
        if self.inner.jmap_share_of(account_id).is_some() {
            return Err(Error::invalid("A shared mailbox signs in with the account it is shared with."));
        }
        let url = trusted_jmap_url(&account)
            .map(String::from)
            .ok_or_else(|| Error::not_supported("This mailbox isn't on a UwUMail server."))?;
        let made = self.uwumail_app_password(&url, &account.email, name).await?;
        let username = made.username.trim().to_string();
        // Only a password that works replaces the old one.
        let client = if account.protocol == Protocol::Jmap {
            Some(JmapClient::connect(&self.inner.http, &url, &username, &made.password).await?)
        } else {
            let mut session =
                imap::login(&account.imap, Login::Password { username: &username, password: &made.password }).await?;
            let _ = session.logout().await;
            None
        };
        self.stop_push_briefly(account_id).await;
        let runtime = self.inner.accounts.lock().unwrap().remove(account_id);
        if let Some(runtime) = runtime {
            if let Some(task) = runtime.task {
                task.abort();
            }
            if let Some(mut session) = runtime.commands.lock().await.take() {
                let _ = session.logout().await;
            }
        }
        self.inner.secrets.set(account_id, &Secret::Password { password: made.password })?;
        if username != account.username {
            self.inner.store.set_account_username(account_id, &username)?;
        }
        {
            let mut clients = self.inner.jmap.lock().await;
            match client {
                Some(client) => {
                    clients.insert(account_id.to_string(), Arc::new(client));
                }
                None => {
                    clients.remove(account_id);
                }
            }
            // Its shared mailboxes connect with the new password from now on, too.
            for child in self.inner.store.shared_children(account_id)? {
                if self.inner.jmap_share_of(&child).is_some() {
                    clients.remove(&child);
                    self.inner.wake(&child);
                }
            }
        }
        // Calendars and contacts sign in with it as well.
        self.inner.forget_cloud(account_id).await;
        self.inner.spawn_sync(account_id);
        self.inner.emit(EngineEvent::PushChanged { reregister: account.protocol == Protocol::Jmap });
        self.inner.calendar_changed(None);
        self.inner.emit(EngineEvent::ContactsChanged {});
        self.inner.emit(EngineEvent::AccountsChanged {});
        self.list_accounts()?
            .into_iter()
            .find(|a| a.id == account_id)
            .ok_or_else(|| Error::not_found("This mailbox no longer exists."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mailbox_names_are_trimmed_and_bounded() {
        assert_eq!(account_name("  Arbeit ").unwrap().as_deref(), Some("Arbeit"));
        assert_eq!(account_name("   ").unwrap(), None);
        assert_eq!(account_name("a\nb").unwrap().as_deref(), Some("a b"));
        assert!(account_name(&"x".repeat(101)).is_err());
    }
}
