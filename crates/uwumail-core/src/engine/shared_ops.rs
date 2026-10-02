//! Shared mailboxes in Microsoft 365, nested under the account whose sign-in opens them: found
//! through Autodiscover (see `shared`), added by address, sorted under their account, removed.
//!
//! A shared mailbox is an account like any other (sync, counters, notifications, unified inbox,
//! sending as itself) with one difference: it has no secret of its own. Its token is the one of
//! the account it is nested under (`Inner::credential`).

use super::*;
use crate::shared::{self, Discovery};
use crate::store::AccountLink;

/// How often each account is searched for shared mailboxes without being asked.
const SHARED_SEARCH_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// `shared_state` of a personal Microsoft account, which has no shared mailboxes.
pub(super) const PERSONAL: &str = "personal";

/// Every account in the order the sidebar shows them: each shared mailbox right after its account.
pub(super) fn nested_order(records: Vec<AccountRecord>, links: &HashMap<String, AccountLink>) -> Vec<AccountRecord> {
    let parent_of = |record: &AccountRecord| -> Option<String> {
        let parent = links.get(&record.id)?.parent_id.clone()?;
        // Only one level, and only under an account that is there.
        let parent_is_top = records.iter().any(|r| r.id == parent && r.id != record.id)
            && links.get(&parent).is_none_or(|link| link.parent_id.is_none());
        parent_is_top.then_some(parent)
    };
    let parents: Vec<Option<String>> = records.iter().map(parent_of).collect();
    let mut ordered = Vec::with_capacity(records.len());
    let mut children: Vec<(String, AccountRecord)> = Vec::new();
    let mut top = Vec::new();
    for (record, parent) in records.into_iter().zip(parents) {
        match parent {
            Some(parent) => children.push((parent, record)),
            None => top.push(record),
        }
    }
    for record in top {
        let id = record.id.clone();
        ordered.push(record);
        let (mine, rest): (Vec<_>, Vec<_>) = children.into_iter().partition(|(parent, _)| *parent == id);
        children = rest;
        ordered.extend(mine.into_iter().map(|(_, record)| record));
    }
    ordered
}

/// Whether this Microsoft account can have shared mailboxes under it: a work or school account
/// that isn't a shared mailbox nested under another one.
///
/// A shared mailbox added on its own (its person isn't in UwUMail) counts too: its sign-in is a
/// person's and opens their other shared mailboxes just the same.
fn is_person_account(record: &AccountRecord, link: &AccountLink) -> bool {
    record.auth == AuthKind::Microsoft
        && link.parent_id.is_none()
        && !shared::is_personal_address(&record.email)
        && link.shared_state.as_deref() != Some(PERSONAL)
}

/// What the account settings show about the search for shared mailboxes.
pub(super) fn shared_search_of(record: &AccountRecord, link: &AccountLink) -> Option<SharedSearch> {
    is_person_account(record, link)
        .then(|| link.shared_state.as_deref().and_then(SharedSearch::parse).unwrap_or(SharedSearch::Pending))
}

/// Searches every account for shared mailboxes when the app starts and then about once a day.
/// Each search is a single small request; one that fails changes nothing.
pub(super) fn start_shared_search(engine: Engine) {
    let runtime = engine.inner.runtime.clone();
    runtime.spawn(async move {
        loop {
            let due: Vec<String> = engine
                .inner
                .store
                .accounts()
                .unwrap_or_default()
                .into_iter()
                .filter(|record| {
                    let link = engine.inner.store.account_link(&record.id).unwrap_or_default();
                    is_person_account(record, &link)
                })
                .map(|record| record.id)
                .collect();
            for id in due {
                if let Err(error) = engine.search_shared(&id, false).await {
                    tracing::info!("No search for the shared mailboxes of {id}: {error}");
                }
            }
            tokio::time::sleep(SHARED_SEARCH_EVERY / 4).await;
        }
    });
}

impl Inner {
    /// The account whose secret opens `account_id`: the account a shared mailbox is nested
    /// under, otherwise the account itself.
    ///
    /// Only a Microsoft mailbox opens with another Microsoft account's sign-in: whatever the row
    /// says, a password or a Google sign-in never goes to another mailbox's servers.
    pub(super) fn secret_holder(&self, account_id: &str) -> String {
        let microsoft = |id: &str| self.store.account(id).is_ok_and(|record| record.auth == AuthKind::Microsoft);
        self.store
            .account_link(account_id)
            .ok()
            .and_then(|link| link.parent_id)
            .filter(|parent| parent != account_id && microsoft(parent) && microsoft(account_id))
            .unwrap_or_else(|| account_id.to_string())
    }

    /// Notes whose sign-in a Microsoft account's token is, the first time one comes in, and sorts
    /// shared mailboxes under their account when that tells which. Returns the ids nested now.
    pub(super) fn note_sign_in(&self, account: &AccountRecord, access_token: &str) -> Vec<String> {
        let Ok(link) = self.store.account_link(&account.id) else { return Vec::new() };
        if link.sign_in_as.is_some() {
            return Vec::new();
        }
        let owner = shared::token_owner(access_token);
        let _ = self.store.set_account_sign_in_as(&account.id, owner.address.as_deref().unwrap_or(""));
        if owner.is_personal() {
            let _ = self.store.set_shared_search(&account.id, PERSONAL, crate::mime::now());
        }
        self.nest_by_sign_in()
    }

    /// Nests standalone shared mailboxes under the account whose sign-in opens them. Their own
    /// copy of the sign-in goes: the account's is used from now on.
    pub(super) fn nest_by_sign_in(&self) -> Vec<String> {
        match self.store.nest_shared_by_sign_in() {
            Ok(pairs) if !pairs.is_empty() => {
                for (child, parent) in &pairs {
                    tracing::info!("Shared mailbox {child} now opens with the sign-in of {parent}");
                    let _ = self.secrets.delete(child);
                }
                self.emit(EngineEvent::AccountsChanged {});
                pairs.into_iter().map(|(child, _)| child).collect()
            }
            Ok(_) => Vec::new(),
            Err(error) => {
                tracing::warn!("Couldn't sort shared mailboxes under their accounts: {error}");
                Vec::new()
            }
        }
    }
}

impl Engine {
    /// Sorts shared mailboxes added before nesting existed under their account, where it is
    /// already known whose sign-in opens them. The others follow with their next token.
    pub(super) fn nest_shared_mailboxes(&self) {
        let nested = self.inner.nest_by_sign_in();
        if !nested.is_empty() {
            let inner = Arc::clone(&self.inner);
            self.inner.runtime.spawn(async move {
                let mut tokens = inner.tokens.lock().await;
                for id in nested {
                    tokens.remove(&id);
                }
            });
        }
    }

    /// The browser sign-in, through the app link where there is one.
    pub(super) async fn browser_sign_in(&self, provider: OAuthProvider, login_hint: &str) -> Result<oauth::Tokens> {
        let mut waiting = None;
        let app_link = self.inner.oauth_redirect.lock().unwrap().clone();
        let redirect = match app_link.filter(|_| oauth::takes_app_link(provider)) {
            Some(uri) => {
                let (sender, incoming) = tokio::sync::mpsc::channel(SIGN_IN_LINK_QUEUE);
                // A newer sign-in replaces an abandoned one.
                waiting = Some(sender.clone());
                *self.inner.pending_sign_in.lock().unwrap() = Some(sender);
                oauth::Redirect::App { uri, incoming }
            }
            None => oauth::Redirect::Loopback,
        };
        let tokens =
            oauth::sign_in(&self.inner.http, provider, login_hint, self.inner.open_url.as_ref(), redirect).await;
        if let Some(ours) = waiting {
            let mut pending = self.inner.pending_sign_in.lock().unwrap();
            // Done either way; a sign-in started meanwhile keeps its slot.
            if pending.as_ref().is_some_and(|sender| sender.same_channel(&ours)) {
                *pending = None;
            }
        }
        tokens
    }

    /// After a Microsoft account was added: note whose sign-in it is, sort shared mailboxes
    /// under it, and look for the shared mailboxes of a person's account.
    pub(super) fn after_microsoft_sign_in(&self, record: &AccountRecord, access_token: &str) {
        self.inner.note_sign_in(record, access_token);
        let link = self.inner.store.account_link(&record.id).unwrap_or_default();
        if is_person_account(record, &link) {
            let engine = self.clone();
            let id = record.id.clone();
            self.inner.runtime.spawn(async move {
                if let Err(error) = engine.search_shared(&id, true).await {
                    tracing::info!("No search for the shared mailboxes of {id}: {error}");
                }
            });
        }
    }

    /// Searches a Microsoft 365 account for its shared mailboxes now ("Search again").
    pub async fn find_shared_mailboxes(&self, account_id: &str) -> Result<SharedSearchResult> {
        self.search_shared(account_id, true).await
    }

    /// The person's own Microsoft 365 account `account_id`, or why it can't have shared mailboxes.
    fn person_account(&self, account_id: &str) -> Result<(AccountRecord, AccountLink)> {
        let record =
            self.inner.store.account(account_id).map_err(|_| Error::not_found("This mailbox no longer exists."))?;
        let link = self.inner.store.account_link(account_id)?;
        if !is_person_account(&record, &link) {
            return Err(Error::not_supported("Only Microsoft 365 work or school accounts have shared mailboxes."));
        }
        Ok((record, link))
    }

    async fn microsoft_token(&self, record: &AccountRecord) -> Result<String> {
        match self.inner.credential(record).await? {
            Credential::Token(token) => Ok(token),
            Credential::Password(_) => Err(Error::not_supported("This mailbox doesn't sign in with Microsoft.")),
        }
    }

    /// Asks Autodiscover for the account's shared mailboxes and adds the new ones. Without
    /// `force`, an account searched within the last day isn't asked again.
    pub(super) async fn search_shared(&self, account_id: &str, force: bool) -> Result<SharedSearchResult> {
        let _one_at_a_time = self.inner.shared_lock.lock().await;
        let (parent, link) = self.person_account(account_id)?;
        let current = link.shared_state.as_deref().and_then(SharedSearch::parse).unwrap_or(SharedSearch::Pending);
        let recent =
            link.shared_checked_at.is_some_and(|at| crate::mime::now() - at < SHARED_SEARCH_EVERY.as_secs() as i64);
        if !force && recent {
            return Ok(SharedSearchResult { state: current, added: Vec::new() });
        }
        let token = self.microsoft_token(&parent).await?;
        let owner = shared::token_owner(&token);
        if owner.is_personal() {
            self.inner.store.set_shared_search(account_id, PERSONAL, crate::mime::now())?;
            self.inner.emit(EngineEvent::AccountsChanged {});
            return Err(Error::not_supported("Personal Microsoft accounts have no shared mailboxes."));
        }
        let url = self.inner.autodiscover_url.lock().unwrap().clone();
        let (state, added) = match shared::discover(&url, &parent.email, &token).await {
            Discovery::NeedsSignIn => (SharedSearch::NeedsSignIn, Vec::new()),
            Discovery::Unavailable => (SharedSearch::Unavailable, Vec::new()),
            Discovery::Found(found) => {
                let person = self.inner.store.account_link(account_id)?.signed_in_as().map(String::from);
                let mut added = Vec::new();
                for mailbox in found {
                    let own = mailbox.email.eq_ignore_ascii_case(&parent.email)
                        || person.as_deref().is_some_and(|p| p.eq_ignore_ascii_case(&mailbox.email));
                    if own || self.inner.store.is_shared_dismissed(account_id, &mailbox.email)? {
                        continue;
                    }
                    if let Some(id) = self.adopt_found(&parent, &mailbox)? {
                        added.push(id);
                    }
                }
                (SharedSearch::Done, added)
            }
        };
        self.inner.store.set_shared_search(account_id, state.as_str(), crate::mime::now())?;
        if !added.is_empty() {
            self.inner.emit(EngineEvent::MailChanged { account_id: account_id.to_string() });
        }
        self.inner.emit(EngineEvent::AccountsChanged {});
        let accounts = self.list_accounts()?;
        let added = accounts.into_iter().filter(|account| added.contains(&account.id)).collect();
        Ok(SharedSearchResult { state, added })
    }

    /// Adds a mailbox Autodiscover found under `parent`, or nests the standalone account that
    /// already is that shared mailbox. `None` when it is here already in some other way.
    fn adopt_found(&self, parent: &AccountRecord, mailbox: &shared::FoundMailbox) -> Result<Option<String>> {
        let store = &self.inner.store;
        let links = store.account_links()?;
        let existing = store.accounts()?.into_iter().find(|a| a.email.eq_ignore_ascii_case(&mailbox.email));
        let Some(existing) = existing else {
            return self.insert_shared(parent, &mailbox.email, &mailbox.display_name).map(Some);
        };
        let link = links.get(&existing.id).cloned().unwrap_or_default();
        // Only a standalone Microsoft mailbox opened with this account's sign-in is one to nest;
        // anything else is a mailbox of its own that happens to be shared with this person too.
        let person = links.get(&parent.id).and_then(|l| l.signed_in_as().map(String::from));
        let opened_by_parent = link.signed_in_as().is_some_and(|p| {
            !p.eq_ignore_ascii_case(&existing.email)
                && (p.eq_ignore_ascii_case(&parent.email)
                    || person.as_deref().is_some_and(|q| q.eq_ignore_ascii_case(p)))
        });
        let has_children = links.values().any(|l| l.parent_id.as_deref() == Some(existing.id.as_str()));
        if existing.auth == AuthKind::Microsoft && link.parent_id.is_none() && opened_by_parent && !has_children {
            store.set_account_parent(&existing.id, Some(&parent.id))?;
            let _ = self.inner.secrets.delete(&existing.id);
            return Ok(Some(existing.id));
        }
        Ok(None)
    }

    /// Saves a shared mailbox of `parent` and starts syncing it. It has no secret: it opens with
    /// the parent's sign-in.
    fn insert_shared(&self, parent: &AccountRecord, email: &str, display_name: &str) -> Result<String> {
        let (_, domain) = autoconfig::split_email(email)?;
        let id = uuid::Uuid::new_v4().to_string();
        let record = AccountRecord {
            id: id.clone(),
            name: domain,
            email: email.to_string(),
            display_name: display_name.trim().to_string(),
            color: parent.color,
            auth: AuthKind::Microsoft,
            username: email.to_string(),
            // The same Exchange Online servers, checked when the parent was added.
            imap: parent.imap.clone(),
            smtp: parent.smtp.clone(),
            protocol: Protocol::Imap,
            jmap_url: None,
        };
        self.inner.store.insert_account(&record)?;
        if let Err(error) = self.inner.store.set_account_parent(&id, Some(&parent.id)) {
            let _ = self.inner.store.delete_account(&id);
            return Err(error);
        }
        self.inner.spawn_sync(&id);
        Ok(id)
    }

    /// Adds a shared mailbox by address under the Microsoft 365 account `parent_id`, after
    /// checking that the account's sign-in opens it.
    pub async fn add_shared_mailbox(
        &self,
        parent_id: &str,
        email: &str,
        display_name: Option<&str>,
    ) -> Result<Account> {
        let email = email.trim();
        if !shared::is_mailbox_address(email) {
            return Err(Error::invalid("That doesn't look like an email address."));
        }
        let (local, _) = autoconfig::split_email(email)?;
        let local = local.to_string();
        let (parent, _) = self.person_account(parent_id)?;
        if self.inner.store.accounts()?.iter().any(|a| a.email.eq_ignore_ascii_case(email)) {
            return Err(Error::invalid("This mailbox is already in UwUMail."));
        }
        let token = self.microsoft_token(&parent).await?;
        let mut session = imap::login(&parent.imap, Login::OAuth { username: email, access_token: &token })
            .await
            .map_err(|error| {
                if error.code == ErrorCode::AuthFailed {
                    Error::auth(format!(
                        "{} can't open {email}. Is it a shared mailbox you have full access to?",
                        parent.email
                    ))
                } else {
                    error
                }
            })?;
        let _ = session.logout().await;
        self.inner.store.undismiss_shared(parent_id, email)?;
        let name = display_name.map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&local);
        let id = self.insert_shared(&parent, email, name)?;
        self.inner.emit(EngineEvent::MailChanged { account_id: id.clone() });
        self.inner.emit(EngineEvent::AccountsChanged {});
        self.list_accounts()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or_else(|| Error::internal("The new mailbox disappeared."))
    }

    /// Removes a mailbox. A Microsoft account's shared mailboxes go with it, unless `keep_shared`:
    /// then they stay as mailboxes of their own, each with a copy of the sign-in. A shared mailbox
    /// removed on its own isn't brought back by the next search.
    pub async fn remove_account_with(&self, account_id: &str, keep_shared: bool) -> Result<()> {
        let store = &self.inner.store;
        let link = store.account_link(account_id)?;
        if let Some(parent) = link.parent_id.as_deref()
            && let Ok(record) = store.account(account_id)
            && store.account(parent).is_ok()
        {
            store.dismiss_shared(parent, &record.email)?;
        }
        let children = store.shared_children(account_id)?;
        if keep_shared && !children.is_empty() {
            let secret = self.inner.secrets.get(account_id)?;
            let person = store
                .account(account_id)
                .ok()
                .map(|parent| link.signed_in_as().map(String::from).unwrap_or(parent.email));
            for child in &children {
                self.inner.secrets.set(child, &secret)?;
                store.set_account_parent(child, None)?;
                // From now on its own sign-in opens its calendars and contacts.
                self.inner.forget_cloud(child).await;
                // Added again later, the account takes them back under it.
                if let Some(person) = &person {
                    store.set_account_sign_in_as(child, person)?;
                }
            }
        } else {
            for child in &children {
                self.remove_one_account(child).await?;
            }
        }
        self.remove_one_account(account_id).await
    }

    /// Signs in again in the browser, for a sign-in that expired or lacks a permission UwUMail
    /// asks for now (finding shared mailboxes needs Exchange access). For a shared mailbox it is
    /// the sign-in of its account. Then searches for shared mailboxes again.
    pub async fn sign_in_again(&self, account_id: &str) -> Result<Account> {
        let holder_id = self.inner.secret_holder(account_id);
        let holder = self.inner.store.account(&holder_id)?;
        let provider = match holder.auth {
            AuthKind::Microsoft => OAuthProvider::Microsoft,
            AuthKind::Google => OAuthProvider::Google,
            AuthKind::Password => return Err(Error::invalid("This mailbox signs in with a password.")),
        };
        autoconfig::check_oauth_servers(provider, &[&holder.imap, &holder.smtp])?;
        let link = self.inner.store.account_link(&holder_id)?;
        let person = link.signed_in_as().map(String::from);
        let tokens = self.browser_sign_in(provider, person.as_deref().unwrap_or(&holder.email)).await?;
        let refresh_token = tokens
            .refresh_token
            .clone()
            .ok_or_else(|| Error::auth("The provider didn't allow offline access. Please try again."))?;
        if provider == OAuthProvider::Microsoft
            && let (Some(person), Some(now)) = (&person, shared::token_owner(&tokens.access_token).address)
            && !now.eq_ignore_ascii_case(person)
        {
            return Err(Error::auth(format!("That was the sign-in of {now}. Please sign in as {person}.")));
        }
        let mut session = imap::login(
            &holder.imap,
            Login::OAuth {
                username: oauth_mailbox(&holder.username, &holder.email),
                access_token: &tokens.access_token,
            },
        )
        .await?;
        let _ = session.logout().await;
        {
            // Under the mail tokens' lock: a refresh running meanwhile could replace the refresh token.
            let mut mail_tokens = self.inner.tokens.lock().await;
            self.inner.secrets.set(&holder_id, &Secret::OAuth { refresh_token })?;
            mail_tokens.insert(holder_id.clone(), (tokens.access_token.clone(), Instant::now() + tokens.expires_in));
        }
        if provider == OAuthProvider::Microsoft {
            self.after_microsoft_sign_in(&holder, &tokens.access_token);
        }
        let children = self.inner.store.shared_children(&holder_id)?;
        // Calendars and contacts look again with the new permissions.
        self.inner.forget_cloud(&holder_id).await;
        for child in &children {
            self.inner.forget_cloud(child).await;
        }
        if holder_id != account_id {
            self.inner.forget_cloud(account_id).await;
        }
        self.sync_now(Some(&holder_id));
        for child in &children {
            self.sync_now(Some(child));
        }
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
    use base64::Engine as _;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn engine() -> (tempfile::TempDir, Engine, Arc<crate::secrets::MemorySecrets>) {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(crate::secrets::MemorySecrets::default());
        let engine = Engine::new(EngineOptions {
            data_dir: dir.path().to_path_buf(),
            secrets: secrets.clone(),
            open_url: Arc::new(|_| {}),
            recognizer: None,
        })
        .unwrap();
        // Nothing here may reach Exchange Online.
        engine.inner.background_sync.store(false, Ordering::Relaxed);
        (dir, engine, secrets)
    }

    fn microsoft(id: &str, email: &str) -> AccountRecord {
        AccountRecord {
            id: id.into(),
            name: "contoso.example".into(),
            email: email.into(),
            display_name: id.into(),
            color: AccountColor::Violet,
            auth: AuthKind::Microsoft,
            username: email.into(),
            imap: ServerSettings { host: "outlook.office365.com".into(), port: 993, security: Security::Tls },
            smtp: ServerSettings { host: "smtp.office365.com".into(), port: 587, security: Security::Starttls },
            protocol: Protocol::Imap,
            jmap_url: None,
        }
    }

    /// A Microsoft account with a token that stays valid for the test, so nothing goes to Microsoft.
    async fn signed_in(engine: &Engine, secrets: &crate::secrets::MemorySecrets, id: &str, email: &str) {
        engine.inner.store.insert_account(&microsoft(id, email)).unwrap();
        secrets.set(id, &Secret::OAuth { refresh_token: format!("refresh-{id}") }).unwrap();
        engine
            .inner
            .tokens
            .lock()
            .await
            .insert(id.into(), (format!("token-{id}"), Instant::now() + Duration::from_secs(3600)));
    }

    /// A fake Autodiscover that answers every request with `status` and `body`, and hands each
    /// request it got to the test.
    async fn autodiscover(status: u16, body: String) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/autodiscover/autodiscover.xml", listener.local_addr().unwrap());
        let (seen, requests) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = Vec::new();
                let mut buffer = [0u8; 8192];
                // Head and body: until the body Content-Length names has arrived.
                loop {
                    let n = socket.read(&mut buffer).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..n]);
                    let text = String::from_utf8_lossy(&request).to_string();
                    if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                        let length = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().to_string())
                            })
                            .and_then(|v| v.parse::<usize>().ok())
                            .unwrap_or(0);
                        if rest.len() >= length {
                            break;
                        }
                    }
                }
                let _ = seen.send(String::from_utf8_lossy(&request).to_string());
                let answer = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(answer.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        (url, requests)
    }

    fn answer(mailboxes: &[(&str, &str)]) -> String {
        let entries: String = mailboxes
            .iter()
            .map(|(name, email)| {
                format!(
                    "<AlternativeMailbox><Type>Delegate</Type><DisplayName>{name}</DisplayName>\
                     <SmtpAddress>{email}</SmtpAddress><OwnerSmtpAddress>{email}</OwnerSmtpAddress></AlternativeMailbox>"
                )
            })
            .collect();
        format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <User><AutoDiscoverSMTPAddress>alex@contoso.example</AutoDiscoverSMTPAddress></User>
    <Account><AccountType>email</AccountType><Action>settings</Action>
      <AlternativeMailbox><Type>Archive</Type><DisplayName>Archive</DisplayName>
        <SmtpAddress>archive+1@contoso.example</SmtpAddress></AlternativeMailbox>
      {entries}
    </Account>
  </Response>
</Autodiscover>"#
        )
    }

    #[tokio::test]
    async fn found_shared_mailboxes_are_nested_and_dismissed_ones_stay_away() {
        let (_dir, engine, secrets) = engine();
        signed_in(&engine, &secrets, "alex", "alex@contoso.example").await;
        let (url, mut requests) = autodiscover(
            200,
            answer(&[("Team Vertrieb", "vertrieb@contoso.example"), ("Info", "info@contoso.example")]),
        )
        .await;
        *engine.inner.autodiscover_url.lock().unwrap() = url;

        let result = engine.find_shared_mailboxes("alex").await.unwrap();
        assert_eq!(result.state, SharedSearch::Done);
        let added: Vec<_> = result.added.iter().map(|a| (a.email.as_str(), a.display_name.as_str())).collect();
        assert_eq!(added, vec![("vertrieb@contoso.example", "Team Vertrieb"), ("info@contoso.example", "Info")]);
        let request = requests.recv().await.unwrap();
        assert!(request.starts_with("POST /autodiscover/autodiscover.xml"), "{request}");
        assert!(request.contains("authorization: Bearer token-alex"), "{request}");
        assert!(request.contains("<EMailAddress>alex@contoso.example</EMailAddress>"), "{request}");

        // Listed right under their account, with its color, and no secret of their own.
        let accounts = engine.list_accounts().unwrap();
        let order: Vec<_> = accounts.iter().map(|a| (a.email.as_str(), a.parent_id.as_deref())).collect();
        assert_eq!(
            order,
            vec![
                ("alex@contoso.example", None),
                ("vertrieb@contoso.example", Some("alex")),
                ("info@contoso.example", Some("alex")),
            ]
        );
        assert_eq!(accounts[0].shared_search, Some(SharedSearch::Done));
        assert_eq!(accounts[1].shared_search, None);
        assert!(accounts.iter().all(|a| a.color == AccountColor::Violet));
        let vertrieb = accounts[1].id.clone();
        assert!(secrets.get(&vertrieb).is_err());
        // Their token is the account's.
        let record = engine.inner.store.account(&vertrieb).unwrap();
        assert!(matches!(engine.inner.credential(&record).await.unwrap(), Credential::Token(t) if t == "token-alex"));

        // Removed by hand, it isn't brought back; the other one isn't added twice.
        engine.remove_account(&vertrieb).await.unwrap();
        let again = engine.find_shared_mailboxes("alex").await.unwrap();
        assert!(again.added.is_empty(), "{:?}", again.added);
        let emails: Vec<_> = engine.list_accounts().unwrap().into_iter().map(|a| a.email).collect();
        assert_eq!(emails, vec!["alex@contoso.example", "info@contoso.example"]);
        // Not asked again within a day unless asked to.
        let quiet = engine.search_shared("alex", false).await.unwrap();
        assert_eq!(quiet.state, SharedSearch::Done);
        assert_eq!(requests.len(), 1, "only the forced search asked again");
    }

    #[tokio::test]
    async fn a_refused_token_finds_nothing_and_asks_for_a_new_sign_in() {
        let (_dir, engine, secrets) = engine();
        signed_in(&engine, &secrets, "alex", "alex@contoso.example").await;
        let (url, _requests) = autodiscover(401, String::new()).await;
        *engine.inner.autodiscover_url.lock().unwrap() = url;
        let result = engine.find_shared_mailboxes("alex").await.unwrap();
        assert_eq!(result.state, SharedSearch::NeedsSignIn);
        assert!(result.added.is_empty());
        let accounts = engine.list_accounts().unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].shared_search, Some(SharedSearch::NeedsSignIn));
        // Mail is untouched: the account still has its sign-in.
        assert!(secrets.get("alex").is_ok());

        // Something that isn't Autodiscover any more: nothing found either.
        let (url, _requests) = autodiscover(200, "<html>gone</html>".into()).await;
        *engine.inner.autodiscover_url.lock().unwrap() = url;
        assert_eq!(engine.find_shared_mailboxes("alex").await.unwrap().state, SharedSearch::Unavailable);
    }

    #[tokio::test]
    async fn personal_and_other_accounts_are_not_searched() {
        let (_dir, engine, secrets) = engine();
        // Nothing listens there: any request would fail the test with a connection error state.
        *engine.inner.autodiscover_url.lock().unwrap() = "http://127.0.0.1:9/autodiscover".into();
        signed_in(&engine, &secrets, "mini", "mini@outlook.com").await;
        let error = engine.find_shared_mailboxes("mini").await.unwrap_err();
        assert_eq!(error.code, ErrorCode::NotSupported);
        assert_eq!(engine.list_accounts().unwrap()[0].shared_search, None);

        // A company address whose token says it's a personal account.
        let claims = format!(r#"{{"upn":"kim@contoso.example","tid":"{}"}}"#, crate::shared::CONSUMER_TENANT);
        let token = format!("x.{}.y", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims));
        signed_in(&engine, &secrets, "kim", "kim@contoso.example").await;
        engine.inner.tokens.lock().await.insert("kim".into(), (token, Instant::now() + Duration::from_secs(3600)));
        assert_eq!(engine.find_shared_mailboxes("kim").await.unwrap_err().code, ErrorCode::NotSupported);
        let kim = engine.list_accounts().unwrap().into_iter().find(|a| a.id == "kim").unwrap();
        assert_eq!(kim.shared_search, None, "remembered as personal");

        let error = engine.add_shared_mailbox("mini", "team@contoso.example", None).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::NotSupported);
    }

    #[tokio::test]
    async fn a_shared_mailbox_added_before_moves_under_its_person_with_the_next_token() {
        let (_dir, engine, secrets) = engine();
        signed_in(&engine, &secrets, "alex", "alex@contoso.example").await;
        // Added by hand as a mailbox of its own, with the sign-in of Alex.
        engine.inner.store.insert_account(&microsoft("team", "team@contoso.example")).unwrap();
        secrets.set("team", &Secret::OAuth { refresh_token: "refresh-team".into() }).unwrap();
        assert_eq!(engine.list_accounts().unwrap()[1].parent_id, None);

        let claims = r#"{"upn":"alex@contoso.example","tid":"t"}"#;
        let token = format!("x.{}.y", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims));
        let nested = engine.inner.note_sign_in(&engine.inner.store.account("team").unwrap(), &token);
        assert_eq!(nested, vec!["team".to_string()]);
        let accounts = engine.list_accounts().unwrap();
        assert_eq!(accounts[1].parent_id.as_deref(), Some("alex"));
        assert_eq!(accounts[1].id, "team", "same mailbox, same cache");
        assert!(secrets.get("team").is_err(), "the account's sign-in opens it now");
        // Known from then on, so the next start nests without a token.
        assert_eq!(
            engine.inner.store.account_link("team").unwrap().sign_in_as.as_deref(),
            Some("alex@contoso.example")
        );
    }

    #[tokio::test]
    async fn removing_an_account_takes_its_shared_mailboxes_or_leaves_them_working() {
        let (_dir, engine, secrets) = engine();
        signed_in(&engine, &secrets, "alex", "alex@contoso.example").await;
        let parent = engine.inner.store.account("alex").unwrap();
        let team = engine.insert_shared(&parent, "team@contoso.example", "Team").unwrap();
        let info = engine.insert_shared(&parent, "info@contoso.example", "Info").unwrap();
        engine.remove_account_with("alex", true).await.unwrap();
        let accounts = engine.list_accounts().unwrap();
        assert_eq!(accounts.len(), 2);
        assert!(accounts.iter().all(|a| a.parent_id.is_none()));
        assert!(
            matches!(secrets.get(&team).unwrap(), Secret::OAuth { refresh_token } if refresh_token == "refresh-alex")
        );
        assert!(secrets.get(&info).is_ok());

        // Alex comes back: they go under the account again.
        signed_in(&engine, &secrets, "alex2", "alex@contoso.example").await;
        engine.inner.store.set_account_sign_in_as("alex2", "alex@contoso.example").unwrap();
        engine.nest_shared_mailboxes();
        let accounts = engine.list_accounts().unwrap();
        assert!(accounts.iter().skip(1).all(|a| a.parent_id.as_deref() == Some("alex2")), "{accounts:?}");

        // The default: they go with it.
        engine.remove_account("alex2").await.unwrap();
        assert!(engine.list_accounts().unwrap().is_empty());
        assert!(secrets.get(&team).is_err());
    }

    #[tokio::test]
    async fn a_found_mailbox_already_here_is_nested_only_when_this_sign_in_opens_it() {
        let (_dir, engine, secrets) = engine();
        // Where sign-in names aren't the mail addresses: Alex signs in as alex@, mails as alex.muster@.
        signed_in(&engine, &secrets, "alex", "alex.muster@contoso.example").await;
        engine.inner.store.set_account_sign_in_as("alex", "alex@contoso.example").unwrap();
        // The team mailbox, added on its own earlier with Alex's sign-in.
        signed_in(&engine, &secrets, "team", "team@contoso.example").await;
        engine.inner.store.set_account_sign_in_as("team", "alex@contoso.example").unwrap();
        // Kim's own mailbox, which Alex has access to as well.
        signed_in(&engine, &secrets, "kim", "kim@contoso.example").await;
        engine.inner.store.set_account_sign_in_as("kim", "kim@contoso.example").unwrap();
        engine.nest_shared_mailboxes();
        assert!(engine.list_accounts().unwrap().iter().all(|a| a.parent_id.is_none()), "nothing tells yet");

        let (url, _requests) =
            autodiscover(200, answer(&[("Team", "team@contoso.example"), ("Kim", "kim@contoso.example")])).await;
        *engine.inner.autodiscover_url.lock().unwrap() = url;
        let result = engine.find_shared_mailboxes("alex").await.unwrap();
        assert_eq!(result.added.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["team"]);
        let accounts = engine.list_accounts().unwrap();
        let order: Vec<_> = accounts.iter().map(|a| (a.id.as_str(), a.parent_id.as_deref())).collect();
        assert_eq!(order, [("alex", None), ("team", Some("alex")), ("kim", None)]);
        assert!(secrets.get("team").is_err());
        assert!(secrets.get("kim").is_ok());
    }

    #[test]
    fn nested_listing_keeps_each_shared_mailbox_under_its_account() {
        let records = vec![
            microsoft("a", "a@contoso.example"),
            microsoft("s1", "s1@contoso.example"),
            microsoft("b", "b@contoso.example"),
            microsoft("s2", "s2@contoso.example"),
            microsoft("orphan", "o@contoso.example"),
        ];
        let child = |parent: &str| AccountLink { parent_id: Some(parent.into()), ..Default::default() };
        let links: HashMap<String, AccountLink> =
            [("s1".to_string(), child("b")), ("s2".to_string(), child("a")), ("orphan".to_string(), child("gone"))]
                .into_iter()
                .collect();
        let order: Vec<String> = nested_order(records, &links).into_iter().map(|r| r.id).collect();
        assert_eq!(order, ["a", "s2", "b", "s1", "orphan"]);
    }
}
