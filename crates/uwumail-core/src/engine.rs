//! The engine ties store, secrets, IMAP and SMTP together and runs one
//! background sync task per account.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{Mutex as AsyncMutex, Notify, OwnedMutexGuard, broadcast};
use tokio::task::JoinHandle;

use crate::attachments::{self, AttachmentCache, AttachmentFile};
use crate::error::{Error, ErrorCode, Result};
use crate::imap::{self, ImapSession, Login};
use crate::jmap::Client as JmapClient;
use crate::jmap::StateChange;
use crate::mail_images::MailImages;
use crate::model::*;
use crate::pictures::{SenderPicture, SenderPictures};
use crate::secrets::{Secret, SecretStore};
use crate::smtp::{self, SmtpAuth, Threading};
use crate::store::{AccountRecord, FolderInfo, FolderRecord, MessageLocation, Store};
use crate::{autoconfig, calendar, contacts, folders, mime, oauth};
use crate::{jmap_settings, jmap_sieve, jmap_sync};

const FULL_SYNC_EVERY: Duration = Duration::from_secs(5 * 60);
const IDLE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// The JMAP type of the shared settings.
const USER_SETTINGS: &str = "UserSettings";
/// JMAP types whose changes are nothing for the mail.
const NOT_MAIL: [&str; 7] =
    [USER_SETTINGS, "Calendar", "CalendarEvent", "ParticipantIdentity", "AddressBook", "ContactCard", "SieveScript"];
/// JMAP servers without push are asked for changes this often.
const JMAP_POLL_EVERY: Duration = Duration::from_secs(60);
/// Server search over IMAP asks at most this many folders per mailbox.
const SEARCH_FOLDERS: usize = 25;
/// The longest "undo send" wait the page may ask for.
const MAX_SEND_DELAY: u64 = 60;
/// JMAP identities are asked for at most this often per account.
const IDENTITIES_EVERY: Duration = Duration::from_secs(10 * 60);
/// Sign-in links waiting to be looked at; more at once only comes from someone flooding the link.
const SIGN_IN_LINK_QUEUE: usize = 8;
/// How long a search that found no CalDAV or CardDAV server keeps the calendar or the contacts from
/// being offered at start. Afterwards they are offered once more, so a server added since is noticed.
const DAV_NONE_REMEMBERED: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// Whether a search that found no DAV server, at `at` (unix seconds), still counts.
fn dav_none_recent(at: Option<i64>) -> bool {
    at.is_some_and(|at| now_millis() / 1000 - at < DAV_NONE_REMEMBERED.as_secs() as i64)
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

pub type UrlOpener = Arc<dyn Fn(&str) + Send + Sync>;

pub struct EngineOptions {
    pub data_dir: PathBuf,
    pub secrets: Arc<dyn SecretStore>,
    pub open_url: UrlOpener,
}

#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

struct Runtime {
    status: AccountStatus,
    wake: Arc<Notify>,
    task: Option<JoinHandle<()>>,
    commands: Arc<AsyncMutex<Option<ImapSession>>>,
}

impl Runtime {
    fn new() -> Self {
        Self {
            status: AccountStatus::Idle,
            wake: Arc::new(Notify::new()),
            task: None,
            commands: Arc::new(AsyncMutex::new(None)),
        }
    }
}

struct Inner {
    store: Store,
    secrets: Arc<dyn SecretStore>,
    http: reqwest::Client,
    events: broadcast::Sender<EngineEvent>,
    open_url: UrlOpener,
    runtime: tokio::runtime::Handle,
    accounts: Mutex<HashMap<String, Runtime>>,
    tokens: AsyncMutex<HashMap<String, (String, Instant)>>,
    attachments: AttachmentCache,
    pictures: SenderPictures,
    mail_images: MailImages,
    /// (account id, path) of folders created by UwUMail, with when.
    created_folders: Mutex<HashMap<(String, String), Instant>>,
    /// Signed-in JMAP connections by account id.
    jmap: AsyncMutex<HashMap<String, Arc<JmapClient>>>,
    /// Mail from the last this many days is kept complete; older mail as
    /// previews. 0 keeps everything.
    offline_days: AtomicU32,
    /// When each JMAP account's identities were last fetched.
    identities_checked: Mutex<HashMap<String, Instant>>,
    /// The app link OAuth providers send the browser back to (Android); loopback when unset.
    oauth_redirect: Mutex<Option<String>>,
    /// The sign-in waiting for that link. It gets every such link and picks its own by `state`.
    pending_sign_in: Mutex<Option<tokio::sync::mpsc::Sender<String>>>,
    /// Where each account's calendars live (JMAP, a CalDAV home, or nowhere).
    calendar_sources: AsyncMutex<HashMap<String, calendar::SourceState>>,
    /// Each account's calendars, with when they were read.
    calendar_lists: Mutex<HashMap<String, (Instant, Vec<calendar::CalendarEntry>)>>,
    /// Where each account's contacts live (JMAP, a CardDAV home, or nowhere).
    contacts_sources: AsyncMutex<HashMap<String, contacts::SourceState>>,
    /// Each account's address books, with when they were read.
    address_book_lists: Mutex<HashMap<String, (Instant, Vec<contacts::BookEntry>)>>,
    /// Each account's contact cards, with when they were read.
    contact_card_lists: Mutex<HashMap<String, (Instant, Vec<contacts::RemoteCard>)>>,
}

enum Credential {
    Password(String),
    Token(String),
}

/// Runs an IMAP command on the account's command connection and reconnects
/// once if the connection turned out to be dead.
macro_rules! with_session {
    ($inner:expr, $account:expr, |$session:ident| $body:expr) => {{
        let mut attempt = 0;
        loop {
            let mut guard = $inner.command_session($account).await?;
            let $session = guard.as_mut().expect("command session is connected");
            match $body.await {
                Ok(value) => break Ok::<_, Error>(value),
                Err(error) if error.code == ErrorCode::ConnectionFailed && attempt == 0 => {
                    *guard = None;
                    attempt += 1;
                }
                Err(error) => {
                    if error.code == ErrorCode::ConnectionFailed {
                        *guard = None;
                    }
                    break Err(error);
                }
            }
        }
    }};
}

mod calendar_ops;
mod contacts_ops;
mod folder_ops;

impl Engine {
    /// Must be called inside a Tokio runtime.
    pub fn new(options: EngineOptions) -> Result<Self> {
        std::fs::create_dir_all(&options.data_dir)
            .map_err(|e| Error::internal(format!("Couldn't create the data folder: {e}")))?;
        let store = Store::open(&options.data_dir.join("uwumail.db"))?;
        let http = crate::tls::http_client()?
            .user_agent(concat!("UwUMail/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| Error::internal(format!("HTTP client setup failed: {e}")))?;
        let (events, _) = broadcast::channel(256);
        Ok(Self {
            inner: Arc::new(Inner {
                store,
                secrets: options.secrets,
                http,
                events,
                open_url: options.open_url,
                runtime: tokio::runtime::Handle::current(),
                accounts: Mutex::new(HashMap::new()),
                tokens: AsyncMutex::new(HashMap::new()),
                attachments: AttachmentCache::new(&options.data_dir),
                pictures: SenderPictures::new(&options.data_dir)?,
                mail_images: MailImages::new()?,
                created_folders: Mutex::new(HashMap::new()),
                jmap: AsyncMutex::new(HashMap::new()),
                offline_days: AtomicU32::new(0),
                identities_checked: Mutex::new(HashMap::new()),
                oauth_redirect: Mutex::new(None),
                pending_sign_in: Mutex::new(None),
                calendar_sources: AsyncMutex::new(HashMap::new()),
                calendar_lists: Mutex::new(HashMap::new()),
                contacts_sources: AsyncMutex::new(HashMap::new()),
                address_book_lists: Mutex::new(HashMap::new()),
                contact_card_lists: Mutex::new(HashMap::new()),
            }),
        })
    }

    /// Signs in through an app link instead of a loopback listener, for platforms where the
    /// app may pause while the browser is in front (Android: `app.uwumail://oauth`).
    pub fn use_oauth_app_link(&self, uri: &str) {
        *self.inner.oauth_redirect.lock().unwrap() = Some(uri.to_string());
    }

    /// Hands the URL the app was opened with to the waiting sign-in. Returns false when it isn't
    /// the sign-in link or nothing is waiting. Any app or web page can open the link, so the
    /// sign-in keeps waiting until a link with its own `state` arrives (see `oauth::sign_in`).
    pub fn finish_sign_in(&self, url: &str) -> bool {
        let expected = self.inner.oauth_redirect.lock().unwrap().clone();
        if !expected.is_some_and(|uri| url.starts_with(&format!("{uri}?"))) {
            return false;
        }
        match self.inner.pending_sign_in.lock().unwrap().as_ref() {
            // A full queue means someone is flooding the link; the real one comes with the browser.
            Some(waiting) => waiting.try_send(url.to_string()).is_ok(),
            None => false,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        self.inner.events.subscribe()
    }

    /// Starts background sync for every saved account, and sends what was
    /// still waiting in the outbox when UwUMail last stopped.
    pub fn start(&self) -> Result<()> {
        for account in self.inner.store.accounts()? {
            self.inner.spawn_sync(&account.id);
        }
        for (id, send_at) in self.inner.store.outbox()? {
            self.schedule_send(id, send_at);
        }
        Ok(())
    }

    pub fn list_accounts(&self) -> Result<Vec<Account>> {
        let accounts = self.inner.accounts.lock().unwrap();
        Ok(self
            .inner
            .store
            .accounts()?
            .into_iter()
            .map(|record| {
                let status = accounts.get(&record.id).map(|r| r.status.clone()).unwrap_or(AccountStatus::Idle);
                let mut protocols = Vec::new();
                if !record.imap.host.is_empty() && !record.smtp.host.is_empty() {
                    protocols.push(Protocol::Imap);
                }
                if record.jmap_url.is_some() && record.auth == AuthKind::Password {
                    protocols.push(Protocol::Jmap);
                }
                Account {
                    id: record.id,
                    name: record.name,
                    email: record.email,
                    display_name: record.display_name,
                    color: record.color,
                    auth: record.auth,
                    status,
                    protocol: record.protocol,
                    protocols,
                }
            })
            .collect())
    }

    /// Every address UwUMail can send from: each mailbox's own, then its aliases.
    pub fn list_identities(&self) -> Result<Vec<Identity>> {
        let mut identities: Vec<Identity> = self
            .inner
            .store
            .accounts()?
            .into_iter()
            .map(|account| Identity {
                id: account.id.clone(),
                account_id: account.id,
                email: account.email,
                name: account.display_name,
                primary: true,
                from_server: false,
            })
            .collect();
        // Each mailbox's aliases right after its own address.
        let aliases = self.inner.store.identities()?;
        let mut grouped = Vec::with_capacity(identities.len() + aliases.len());
        for own in identities.drain(..) {
            let account_id = own.account_id.clone();
            grouped.push(own);
            grouped.extend(aliases.iter().filter(|alias| alias.account_id == account_id).cloned());
        }
        Ok(grouped)
    }

    /// Adds an alias typed in by hand; whether the server accepts it shows when sending.
    pub fn add_identity(&self, account_id: &str, email: &str, name: &str) -> Result<Identity> {
        let account = self.inner.store.account(account_id)?;
        let email = email.trim();
        email
            .parse::<lettre::Address>()
            .map_err(|_| Error::invalid(format!("\"{email}\" isn't a valid email address.")))?;
        if email.eq_ignore_ascii_case(&account.email) {
            return Err(Error::invalid("That's already this mailbox's own address."));
        }
        let name = name.trim();
        let id = self
            .inner
            .store
            .insert_identity(&account.id, email, name)?
            .ok_or_else(|| Error::invalid("This address is already set up."))?;
        Ok(Identity {
            id,
            account_id: account.id,
            email: email.to_string(),
            name: name.to_string(),
            primary: false,
            from_server: false,
        })
    }

    /// The name shown with an address; for a mailbox's own address that's its display name.
    pub fn rename_identity(&self, identity_id: &str, name: &str) -> Result<()> {
        let name = name.trim();
        if self.inner.store.accounts()?.iter().any(|a| a.id == identity_id) {
            return self.inner.store.set_account_display_name(identity_id, name);
        }
        if !self.inner.store.rename_identity(identity_id, name)? {
            return Err(Error::not_found("This address no longer exists."));
        }
        Ok(())
    }

    pub fn remove_identity(&self, identity_id: &str) -> Result<()> {
        if !self.inner.store.delete_identity(identity_id)? {
            return Err(Error::invalid("Addresses from the mail server are managed there."));
        }
        Ok(())
    }

    pub fn list_signatures(&self) -> Result<Vec<Signature>> {
        self.inner.store.signatures()
    }

    /// Adds or updates a signature for one of the sender addresses.
    pub fn save_signature(&self, mut signature: Signature) -> Result<Signature> {
        const MAX_SIGNATURE: usize = 1024 * 1024;
        if signature.html.len() > MAX_SIGNATURE {
            return Err(Error::invalid("This signature is too big. Try a smaller picture."));
        }
        let email = signature.email.trim().to_string();
        let identity = self
            .list_identities()?
            .into_iter()
            .find(|identity| identity.email.eq_ignore_ascii_case(&email))
            .ok_or_else(|| Error::invalid("This sender address isn't set up."))?;
        signature.email = identity.email;
        signature.name = signature.name.trim().to_string();
        if signature.id.is_empty() {
            signature.id = uuid::Uuid::new_v4().to_string();
        }
        self.inner.store.save_signature(&signature)?;
        Ok(signature)
    }

    /// Stores a signature that came from the settings sync, as it came: its address may not be
    /// set up on this device (yet). The page has cleaned its HTML already.
    pub fn put_synced_signature(&self, mut signature: Signature) -> Result<Signature> {
        const MAX_SIGNATURE: usize = 1024 * 1024;
        let valid_id = (1..=64).contains(&signature.id.len())
            && signature.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if !valid_id {
            return Err(Error::invalid("This signature id makes no sense."));
        }
        if signature.html.len() > MAX_SIGNATURE {
            return Err(Error::invalid("This signature is too big. Try a smaller picture."));
        }
        signature.email = signature.email.trim().to_string();
        signature.name = signature.name.trim().chars().take(100).collect();
        self.inner.store.save_signature(&signature)?;
        Ok(signature)
    }

    pub fn delete_signature(&self, signature_id: &str) -> Result<()> {
        if !self.inner.store.delete_signature(signature_id)? {
            return Err(Error::not_found("This signature no longer exists."));
        }
        Ok(())
    }

    /// The From address for a message: the chosen identity of the account, or its own address.
    fn sender_for(&self, account: &AccountRecord, from_email: Option<&str>) -> Result<Address> {
        let Some(email) = from_email.filter(|email| !email.eq_ignore_ascii_case(&account.email)) else {
            return Ok(sender(account));
        };
        let identity = self
            .inner
            .store
            .identities()?
            .into_iter()
            .find(|i| i.account_id == account.id && i.email.eq_ignore_ascii_case(email))
            .ok_or_else(|| Error::invalid("This sender address isn't set up for this mailbox."))?;
        let name = Some(identity.name).filter(|n| !n.is_empty()).or_else(|| Some(account.display_name.clone()));
        Ok(Address { name: name.filter(|n| !n.is_empty()), email: identity.email })
    }

    pub async fn discover_settings(&self, email: &str) -> Result<DiscoveredSettings> {
        autoconfig::discover(&self.inner.http, email).await
    }

    /// The page an administrator opens to allow UwUMail for a whole company,
    /// for a mailbox whose sign-in ended in [`ErrorCode::AdminConsentRequired`].
    ///
    /// [`ErrorCode::AdminConsentRequired`]: crate::error::ErrorCode::AdminConsentRequired
    pub fn microsoft_admin_consent_url(&self, email: &str) -> Result<String> {
        let (_, domain) = autoconfig::split_email(email)?;
        oauth::admin_consent_url(&domain)
    }

    pub async fn add_account(&self, new: NewAccount) -> Result<Account> {
        let (_, domain) = autoconfig::split_email(&new.email)?;
        let jmap_url = new.jmap_url.as_deref().map(str::trim).filter(|url| !url.is_empty()).map(String::from);
        let wants_jmap = new.protocol == Protocol::Jmap && new.auth == AuthKind::Password;
        let has_imap = !new.imap.host.trim().is_empty() && !new.smtp.host.trim().is_empty();
        if wants_jmap && jmap_url.is_none() {
            return Err(Error::invalid("The JMAP address is missing."));
        }
        if !wants_jmap && !has_imap {
            return Err(Error::invalid("Server addresses are missing."));
        }
        if self.inner.store.accounts()?.iter().any(|a| a.email.eq_ignore_ascii_case(new.email.trim())) {
            return Err(Error::invalid("This mailbox is already in UwUMail."));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let mut record = AccountRecord {
            id: id.clone(),
            name: domain,
            email: new.email.trim().to_string(),
            display_name: new.display_name.trim().to_string(),
            color: new.color,
            auth: new.auth,
            username: new.username.trim().to_string(),
            imap: new.imap.clone(),
            smtp: new.smtp.clone(),
            protocol: if wants_jmap { Protocol::Jmap } else { Protocol::Imap },
            jmap_url: jmap_url.clone().filter(|_| new.auth == AuthKind::Password),
        };

        let secret = match new.auth {
            AuthKind::Password => {
                let password = new
                    .password
                    .clone()
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| Error::invalid("Enter your password."))?;
                let check_imap = async |record: &AccountRecord| -> Result<()> {
                    let mut session =
                        imap::login(&record.imap, Login::Password { username: &record.username, password: &password })
                            .await?;
                    let _ = session.logout().await;
                    Ok(())
                };
                match (wants_jmap, &jmap_url) {
                    (true, Some(url)) => {
                        match JmapClient::connect(&self.inner.http, url, &record.username, &password).await {
                            Ok(client) => {
                                self.inner.jmap.lock().await.insert(id.clone(), Arc::new(client));
                            }
                            // Something that only looked like JMAP: use IMAP when that works.
                            Err(error) if has_imap => {
                                tracing::warn!("JMAP sign-in failed, trying IMAP: {error}");
                                record.protocol = Protocol::Imap;
                                if check_imap(&record).await.is_err() {
                                    return Err(error);
                                }
                                record.jmap_url = None;
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    _ => check_imap(&record).await?,
                }
                Secret::Password { password }
            }
            AuthKind::Microsoft | AuthKind::Google => {
                let provider =
                    if new.auth == AuthKind::Microsoft { OAuthProvider::Microsoft } else { OAuthProvider::Google };
                // Before the browser opens: the token must not be able to go anywhere else.
                autoconfig::check_oauth_servers(provider, &[&record.imap, &record.smtp])?;
                let mut waiting = None;
                let redirect = match self.inner.oauth_redirect.lock().unwrap().clone() {
                    Some(uri) => {
                        let (sender, incoming) = tokio::sync::mpsc::channel(SIGN_IN_LINK_QUEUE);
                        // A newer sign-in replaces an abandoned one.
                        waiting = Some(sender.clone());
                        *self.inner.pending_sign_in.lock().unwrap() = Some(sender);
                        oauth::Redirect::App { uri, incoming }
                    }
                    None => oauth::Redirect::Loopback,
                };
                // Whose sign-in page to show: the mailbox owner, or the person who has
                // access to a shared mailbox.
                let sign_in_as =
                    new.sign_in_as.as_deref().map(str::trim).filter(|a| !a.is_empty()).unwrap_or(&record.email);
                let tokens =
                    oauth::sign_in(&self.inner.http, provider, sign_in_as, self.inner.open_url.as_ref(), redirect)
                        .await;
                if let Some(ours) = waiting {
                    let mut pending = self.inner.pending_sign_in.lock().unwrap();
                    // Done either way; a sign-in started meanwhile keeps its slot.
                    if pending.as_ref().is_some_and(|sender| sender.same_channel(&ours)) {
                        *pending = None;
                    }
                }
                let tokens = tokens?;
                let refresh_token = tokens
                    .refresh_token
                    .clone()
                    .ok_or_else(|| Error::auth("The provider didn't allow offline access. Please try again."))?;
                let mut session = imap::login(
                    &record.imap,
                    Login::OAuth {
                        username: oauth_mailbox(&record.username, &record.email),
                        access_token: &tokens.access_token,
                    },
                )
                .await?;
                let _ = session.logout().await;
                self.inner
                    .tokens
                    .lock()
                    .await
                    .insert(id.clone(), (tokens.access_token, Instant::now() + tokens.expires_in));
                Secret::OAuth { refresh_token }
            }
        };

        self.inner.secrets.set(&id, &secret)?;
        if let Err(error) = self.inner.store.insert_account(&record) {
            let _ = self.inner.secrets.delete(&id);
            return Err(error);
        }
        self.inner.spawn_sync(&id);
        self.inner.emit(EngineEvent::MailChanged { account_id: id.clone() });
        self.list_accounts()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or_else(|| Error::internal("The new mailbox disappeared."))
    }

    pub async fn remove_account(&self, account_id: &str) -> Result<()> {
        let runtime = self.inner.accounts.lock().unwrap().remove(account_id);
        if let Some(runtime) = runtime {
            if let Some(task) = runtime.task {
                task.abort();
            }
            if let Some(mut session) = runtime.commands.lock().await.take() {
                let _ = session.logout().await;
            }
        }
        self.inner.tokens.lock().await.remove(account_id);
        self.inner.jmap.lock().await.remove(account_id);
        self.inner.calendar_sources.lock().await.remove(account_id);
        self.inner.calendar_lists.lock().unwrap().remove(account_id);
        self.inner.contacts_sources.lock().await.remove(account_id);
        self.inner.forget_contacts(account_id);
        self.remove_cached_attachments(account_id)?;
        self.inner.store.delete_account(account_id)?;
        self.inner.secrets.delete(account_id)?;
        self.inner.emit(EngineEvent::MailChanged { account_id: account_id.to_string() });
        Ok(())
    }

    /// Attachment files stay on disk after their mail is gone from the database, so they go first.
    fn remove_cached_attachments(&self, account_id: &str) -> Result<()> {
        for message_id in self.inner.store.account_message_ids(account_id)? {
            self.inner.attachments.remove_message(&message_id);
        }
        Ok(())
    }

    /// Switches an account between IMAP/SMTP and JMAP. The local cache is
    /// rebuilt, because the two protocols identify messages differently.
    pub async fn set_protocol(&self, account_id: &str, protocol: Protocol) -> Result<Account> {
        let account = self.inner.store.account(account_id)?;
        let available = self.list_accounts()?.into_iter().find(|a| a.id == account_id).map(|a| a.protocols);
        if !available.is_some_and(|protocols| protocols.contains(&protocol)) {
            return Err(Error::invalid("This mailbox can't use that protocol."));
        }
        if account.protocol != protocol {
            if protocol == Protocol::Jmap {
                let url = account.jmap_url.as_deref().unwrap_or_default();
                let Secret::Password { password } = self.inner.secrets.get(account_id)? else {
                    return Err(Error::invalid("This mailbox can't use that protocol."));
                };
                let client = JmapClient::connect(&self.inner.http, url, &account.username, &password).await?;
                self.inner.jmap.lock().await.insert(account_id.to_string(), Arc::new(client));
            }
            let runtime = self.inner.accounts.lock().unwrap().remove(account_id);
            if let Some(runtime) = runtime {
                if let Some(task) = runtime.task {
                    task.abort();
                }
                if let Some(mut session) = runtime.commands.lock().await.take() {
                    let _ = session.logout().await;
                }
            }
            self.remove_cached_attachments(account_id)?;
            self.inner.store.clear_account_mail(account_id)?;
            self.inner.store.set_account_protocol(account_id, protocol)?;
            self.inner.spawn_sync(account_id);
            self.inner.emit(EngineEvent::MailChanged { account_id: account_id.to_string() });
        }
        self.list_accounts()?
            .into_iter()
            .find(|a| a.id == account_id)
            .ok_or_else(|| Error::not_found("This mailbox no longer exists."))
    }

    pub fn sync_now(&self, account_id: Option<&str>) {
        let accounts = self.inner.accounts.lock().unwrap();
        for (id, runtime) in accounts.iter() {
            if account_id.is_none_or(|wanted| wanted == id) {
                runtime.wake.notify_one();
            }
        }
    }

    pub fn list_folders(&self, account_id: Option<&str>) -> Result<Vec<Folder>> {
        self.inner.store.folders(account_id)
    }

    pub fn list_threads(&self, query: &ThreadQuery) -> Result<ThreadPage> {
        self.inner.store.list_threads(query)
    }

    /// Keeps mail from the last `days` complete and older mail as previews
    /// (sender, subject, preview; the body loads when opened). `None` keeps
    /// everything. Bodies already stored that are now too old are dropped.
    pub fn set_offline_days(&self, days: Option<u32>) -> Result<()> {
        self.inner.offline_days.store(days.unwrap_or(0), Ordering::Relaxed);
        if let Some(cutoff) = self.inner.full_after() {
            self.inner.store.forget_bodies_before(cutoff)?;
        }
        Ok(())
    }

    /// Searches on the servers for `query.search`, also in mail that was never
    /// downloaded, which then joins the local store as previews. Looks in the
    /// view's folder, or everywhere but trash and junk for unified views, and
    /// only in the query's mailboxes when it names some.
    pub async fn search_server(&self, query: &ThreadQuery) -> Result<ThreadPage> {
        let text = query.search.as_deref().map(str::trim).filter(|text| !text.is_empty());
        let Some(text) = text else { return Err(Error::invalid("Enter something to search for.")) };
        let mut found = Vec::new();
        for account in self.inner.store.accounts()? {
            if query.account_ids.as_ref().is_some_and(|ids| !ids.contains(&account.id)) {
                continue;
            }
            let folder_view = match &query.view {
                MailboxView::Folder { account_id, folder_id } if *account_id == account.id => Some(folder_id.clone()),
                MailboxView::Folder { .. } => continue,
                MailboxView::Unified { .. } => None,
            };
            let result = if account.protocol == Protocol::Jmap {
                self.search_jmap(&account.id, text, folder_view.as_deref()).await
            } else {
                self.search_imap(&account.id, text, folder_view.as_deref()).await
            };
            match result {
                Ok(ids) => found.extend(ids),
                // One unreachable mailbox shouldn't hide the others' results.
                Err(error) => tracing::warn!("Server search in {} failed: {error}", account.email),
            }
        }
        self.inner.store.list_threads_of(query, &found)
    }

    async fn search_jmap(&self, account_id: &str, text: &str, folder_id: Option<&str>) -> Result<Vec<String>> {
        let client = self.inner.jmap_client(account_id).await?;
        let mailbox = match folder_id {
            Some(id) => Some(self.inner.store.folder(id)?.path),
            None => None,
        };
        jmap_sync::search(&client, &self.inner.store, account_id, text, mailbox.as_deref()).await
    }

    async fn search_imap(&self, account_id: &str, text: &str, folder_id: Option<&str>) -> Result<Vec<String>> {
        let folders: Vec<FolderRecord> = match folder_id {
            Some(id) => vec![self.inner.store.folder(id)?],
            None => self
                .inner
                .store
                .folder_records(account_id)?
                .into_iter()
                .filter(|f| f.selectable && !matches!(f.role, Some(FolderRole::Trash | FolderRole::Junk)))
                .take(SEARCH_FOLDERS)
                .collect(),
        };
        let mut ids = Vec::new();
        for folder in &folders {
            ids.extend(with_session!(self.inner, account_id, |session| imap::search_folder(
                session,
                &self.inner.store,
                folder,
                text
            ))?);
        }
        Ok(ids)
    }

    /// Loads a conversation and downloads bodies that were synced headers-only.
    pub async fn get_thread(&self, thread_id: &str, conversations: bool) -> Result<ThreadDetail> {
        let detail = self.inner.store.get_thread(thread_id, conversations)?;
        let missing: Vec<String> = detail
            .messages
            .iter()
            .filter(|m| !self.inner.store.has_body(&m.id).unwrap_or(true))
            .map(|m| m.id.clone())
            .collect();
        if missing.is_empty() {
            return Ok(detail);
        }
        for location in self.inner.store.locations(&missing)? {
            let raw = match &location.blob_id {
                Some(blob) => {
                    let client = self.inner.jmap_client(&location.account_id).await?;
                    client.download(blob, "message.eml", "message/rfc822").await?
                }
                None => {
                    let Ok(uid) = u32::try_from(location.uid) else { continue };
                    with_session!(self.inner, &location.account_id, |session| imap::fetch_body(
                        session,
                        &location.folder_path,
                        uid
                    ))?
                }
            };
            self.inner.store.set_body(&location.id, &mime::parse(&raw))?;
        }
        self.inner.store.get_thread(thread_id, conversations)
    }

    pub async fn set_flags(&self, message_ids: &[String], change: FlagChange) -> Result<()> {
        let locations = self.inner.store.locations(message_ids)?;
        self.inner.store.apply_flag_change(message_ids, change)?;
        self.inner.emit_changed(&locations);
        for (account_id, remote_ids) in group_remote(&locations) {
            let keywords: Vec<(&str, bool)> = [("$seen", change.seen), ("$flagged", change.flagged)]
                .into_iter()
                .filter_map(|(keyword, value)| value.map(|on| (keyword, on)))
                .collect();
            let client = self.inner.jmap_client(&account_id).await?;
            jmap_sync::set_keywords(&client, &remote_ids, &keywords).await?;
        }
        for ((account_id, path), uids) in group_by_folder(&locations) {
            if let Some(seen) = change.seen {
                let op = if seen { "+FLAGS.SILENT (\\Seen)" } else { "-FLAGS.SILENT (\\Seen)" };
                with_session!(self.inner, &account_id, |session| imap::store_flags(session, &path, &uids, op))?;
            }
            if let Some(flagged) = change.flagged {
                let op = if flagged { "+FLAGS.SILENT (\\Flagged)" } else { "-FLAGS.SILENT (\\Flagged)" };
                with_session!(self.inner, &account_id, |session| imap::store_flags(session, &path, &uids, op))?;
            }
        }
        Ok(())
    }

    /// Moves mail into the archive. Returns what moved and from where, for undoing.
    pub async fn archive(&self, message_ids: &[String]) -> Result<Vec<MovedMessage>> {
        self.inner.move_to(message_ids, MoveTarget::Role(FolderRole::Archive)).await
    }

    /// Moves mail into the trash. What's already there stays and isn't returned.
    pub async fn trash(&self, message_ids: &[String]) -> Result<Vec<MovedMessage>> {
        self.inner.move_to(message_ids, MoveTarget::Role(FolderRole::Trash)).await
    }

    /// Deletes mail in the trash for good, on the server too. Mail that isn't in
    /// the trash (anymore) is left alone. Returns how many messages were deleted.
    pub async fn delete_forever(&self, message_ids: &[String]) -> Result<usize> {
        self.inner.delete_forever(message_ids).await
    }

    /// Moves mail into another folder of the same mailbox.
    pub async fn move_messages(&self, message_ids: &[String], folder_id: &str) -> Result<Vec<MovedMessage>> {
        self.inner.move_to(message_ids, MoveTarget::Folder(folder_id.to_string())).await
    }

    /// "Spam" moves mail into the junk folder, "not spam" back to the inbox. Servers that learn
    /// from it get the `$Junk` / `$NotJunk` keywords too.
    pub async fn mark_spam(&self, message_ids: &[String], spam: bool) -> Result<Vec<MovedMessage>> {
        let locations = self.inner.store.locations(message_ids)?;
        for (account_id, remote_ids) in group_remote(&locations) {
            let client = self.inner.jmap_client(&account_id).await?;
            let _ = jmap_sync::set_keywords(&client, &remote_ids, &[("$junk", spam), ("$notjunk", !spam)]).await;
        }
        for ((account_id, path), uids) in group_by_folder(&locations) {
            let (add, remove) = if spam { ("$Junk", "$NotJunk") } else { ("$NotJunk", "$Junk") };
            // Servers without custom keywords refuse this; moving still works.
            let _ = with_session!(self.inner, &account_id, |session| imap::store_flags(
                session,
                &path,
                &uids,
                &format!("+FLAGS.SILENT ({add})")
            ));
            let _ = with_session!(self.inner, &account_id, |session| imap::store_flags(
                session,
                &path,
                &uids,
                &format!("-FLAGS.SILENT ({remove})")
            ));
        }
        let role = if spam { FolderRole::Junk } else { FolderRole::Inbox };
        self.inner.move_to(message_ids, MoveTarget::Role(role)).await
    }

    /// Unsubscribes from the list a mail came from: with one click where the sender allows it,
    /// otherwise by mail, otherwise the sender's page is for the app to open.
    pub async fn unsubscribe(&self, message_id: &str) -> Result<UnsubscribeOutcome> {
        let message = self
            .inner
            .store
            .messages_by_ids(&[message_id.to_string()])?
            .pop()
            .ok_or_else(|| Error::not_found("This message no longer exists."))?;
        let options =
            message.unsubscribe.clone().ok_or_else(|| Error::invalid("This mail has no way to unsubscribe."))?;

        if options.one_click
            && let Some(url) = options.url.as_deref().and_then(|url| url::Url::parse(url).ok())
            && crate::pictures::is_public_web_url(&url)
        {
            // No redirects: a public link must not be able to send the request into the local network.
            // Through the privacy proxy when one is set: the list learns about it anyway, just not from where.
            static ONE_CLICK: crate::tls::PrivacyClient = crate::tls::PrivacyClient::new(|builder| {
                builder
                    .user_agent(crate::mail_images::AGENT)
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(20))
            });
            let answer = ONE_CLICK
                .get()
                .await?
                .post(url)
                .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body("List-Unsubscribe=One-Click")
                .send()
                .await;
            match answer {
                Ok(response) if response.status().is_success() => return Ok(UnsubscribeOutcome::Done),
                Ok(response) => tracing::warn!("One-click unsubscribe answered {}", response.status()),
                Err(error) => tracing::warn!("One-click unsubscribe failed: {error}"),
            }
        }

        if let Some(target) = options.mailto.as_deref().and_then(unsubscribe_mail) {
            let identities = self.list_identities()?;
            let addressed: Vec<String> = message.to.iter().chain(&message.cc).map(|a| a.email.to_lowercase()).collect();
            // From the address the newsletter was sent to, if that's one of the mailbox's.
            let from_email = identities
                .iter()
                .find(|i| i.account_id == message.account_id && addressed.contains(&i.email.to_lowercase()))
                .map(|i| i.email.clone());
            // Never the header's own body: the mail goes out under the reader's name, and a
            // stranger's text has no place in it.
            let text = "unsubscribe".to_string();
            self.send(OutgoingMessage {
                account_id: message.account_id.clone(),
                to: vec![Address { name: None, email: target.address }],
                cc: vec![],
                bcc: vec![],
                subject: target.subject,
                html: mime::text_to_html(&text),
                text,
                in_reply_to: None,
                attachments: vec![],
                draft_key: None,
                from_email,
            })
            .await?;
            return Ok(UnsubscribeOutcome::Done);
        }

        match options.url {
            Some(url) => Ok(UnsubscribeOutcome::OpenPage { url }),
            None => Err(Error::invalid("This mail has no way to unsubscribe that works.")),
        }
    }

    /// Inbox mail from an address, e.g. a newsletter's earlier issues.
    pub fn inbox_messages_from(&self, email: &str) -> Result<Vec<String>> {
        self.inner.store.inbox_messages_from(email)
    }

    /// Blocked senders: the app's own list, whose new mail it moves into junk, and what each account keeps on
    /// its UwUMail server. A server that can't be reached leaves out its entries.
    pub async fn blocked_senders(&self) -> Result<Vec<BlockedSender>> {
        let mut blocked: Vec<BlockedSender> = self
            .inner
            .store
            .blocked_senders()?
            .into_iter()
            .map(|entry| BlockedSender { entry, account_id: None, server_id: None })
            .collect();
        for account in self.inner.store.accounts()? {
            if account.protocol != Protocol::Jmap {
                continue;
            }
            let listed = async {
                let client = self.inner.jmap_client(&account.id).await?;
                if !client.session.sender_lists {
                    return Ok(Vec::new());
                }
                jmap_sync::server_blocked_senders(&client).await
            }
            .await;
            match listed {
                Ok(listed) => blocked.extend(listed.into_iter().map(|(id, entry)| BlockedSender {
                    entry,
                    account_id: Some(account.id.clone()),
                    server_id: Some(id),
                })),
                Err(error) => tracing::warn!("Couldn't read the blocked senders on the server: {error}"),
            }
        }
        Ok(blocked)
    }

    /// Blocks an address or `@domain`. For an account on a UwUMail server the server keeps the entry, so it
    /// holds while the app is closed and on every device; otherwise this app does.
    pub async fn block_sender(&self, entry: &str, account_id: Option<&str>) -> Result<BlockedSender> {
        let entry = entry.trim().to_lowercase();
        let valid = match entry.strip_prefix('@') {
            Some(domain) => domain.contains('.') && matches!(url::Host::parse(domain), Ok(url::Host::Domain(_))),
            None => entry.parse::<lettre::Address>().is_ok(),
        };
        if !valid {
            return Err(Error::invalid(format!("\"{entry}\" isn't an address or @domain.")));
        }
        if let Some(account_id) = account_id
            && self.inner.store.account(account_id)?.protocol == Protocol::Jmap
        {
            let client = self.inner.jmap_client(account_id).await?;
            if client.session.sender_lists {
                let (id, entry) = jmap_sync::block_on_server(&client, &entry).await?;
                return Ok(BlockedSender { entry, account_id: Some(account_id.to_string()), server_id: Some(id) });
            }
        }
        self.inner.store.block_sender(&entry)?;
        Ok(BlockedSender { entry, account_id: None, server_id: None })
    }

    /// The accounts whose UwUMail server keeps settings for its apps, for the settings sync.
    /// Accounts that can't be reached right now are left out.
    pub async fn settings_sync_accounts(&self) -> Result<Vec<String>> {
        let mut found = Vec::new();
        for account in self.inner.store.accounts()? {
            if account.protocol != Protocol::Jmap {
                continue;
            }
            match self.inner.jmap_client(&account.id).await {
                Ok(client) if client.session.user_settings => found.push(account.id),
                Ok(_) => {}
                Err(error) => tracing::debug!("Couldn't ask {} about its settings: {error}", account.id),
            }
        }
        Ok(found)
    }

    /// The accounts whose UwUMail server runs mail rules (JMAP with Sieve scripts). Accounts that
    /// can't be reached right now are left out.
    pub async fn rule_accounts(&self) -> Result<Vec<String>> {
        let mut found = Vec::new();
        for account in self.inner.store.accounts()? {
            if account.protocol != Protocol::Jmap {
                continue;
            }
            match self.inner.jmap_client(&account.id).await {
                Ok(client) if client.session.sieve_account_id.is_some() => found.push(account.id),
                Ok(_) => {}
                Err(error) => tracing::debug!("Couldn't ask {} about mail rules: {error}", account.id),
            }
        }
        Ok(found)
    }

    /// The account the rules belong to: the one asked for, or the first that has rules.
    async fn rules_client(&self, account_id: Option<&str>) -> Result<Arc<JmapClient>> {
        let account_id = match account_id {
            Some(id) => id.to_string(),
            None => self
                .rule_accounts()
                .await?
                .into_iter()
                .next()
                .ok_or_else(|| Error::not_supported("None of your mailboxes can keep mail rules."))?,
        };
        if self.inner.store.account(&account_id)?.protocol != Protocol::Jmap {
            return Err(Error::not_supported("Mail rules need a mailbox on a UwUMail server."));
        }
        let client = self.inner.jmap_client(&account_id).await?;
        if client.session.sieve_account_id.is_none() {
            return Err(Error::not_supported("This mail server doesn't keep mail rules."));
        }
        Ok(client)
    }

    /// The script called "UwUMail" and whether the server runs it.
    pub async fn mail_rules(&self, account_id: Option<&str>) -> Result<MailRules> {
        jmap_sieve::load(&*self.rules_client(account_id).await?).await
    }

    /// Uploads the script as "UwUMail" and makes it the one the server runs.
    pub async fn save_mail_rules(&self, script: &str, account_id: Option<&str>) -> Result<()> {
        jmap_sieve::save(&*self.rules_client(account_id).await?, script).await
    }

    /// What the server finds wrong with a script, or `None`.
    pub async fn validate_mail_rules(&self, script: &str, account_id: Option<&str>) -> Result<Option<String>> {
        jmap_sieve::validate(&*self.rules_client(account_id).await?, script).await
    }

    /// The settings an account's UwUMail server keeps for all devices of the login.
    pub async fn user_settings(&self, account_id: &str) -> Result<UserSettings> {
        let client = self.inner.jmap_client(account_id).await?;
        jmap_settings::load(&client).await
    }

    /// Sets keys of the shared settings (`null` removes one); with `if_in_state` only if nothing
    /// else was written since.
    pub async fn save_user_settings(
        &self,
        account_id: &str,
        changes: &serde_json::Map<String, serde_json::Value>,
        if_in_state: Option<&str>,
    ) -> Result<UserSettingsSaved> {
        let client = self.inner.jmap_client(account_id).await?;
        jmap_settings::save(&client, changes, if_in_state).await
    }

    pub async fn unblock_sender(&self, sender: &BlockedSender) -> Result<()> {
        match (&sender.account_id, &sender.server_id) {
            (Some(account_id), Some(id)) => {
                let client = self.inner.jmap_client(account_id).await?;
                jmap_sync::unblock_on_server(&client, id).await
            }
            _ => self.inner.store.unblock_sender(&sender.entry),
        }
    }

    fn threading_for(&self, in_reply_to: Option<&str>) -> Result<Option<Threading>> {
        Ok(match in_reply_to {
            Some(id) => self
                .inner
                .store
                .threading_headers(id)?
                .map(|(parent_message_id, references)| Threading { parent_message_id, references }),
            None => None,
        })
    }

    /// Saves what the composer has into the account's Drafts folder and removes the draft's
    /// earlier version. The returned key identifies the draft for the next save.
    pub async fn save_draft(&self, draft: OutgoingMessage) -> Result<SavedDraft> {
        let account = self.inner.store.account(&draft.account_id)?;
        let key = match draft.draft_key.as_deref() {
            Some(key) if smtp::is_draft_key(key) => key.to_string(),
            Some(_) => return Err(Error::invalid("This draft can't be saved.")),
            None => smtp::new_message_id(&account.email),
        };
        let threading = self.threading_for(draft.in_reply_to.as_deref())?;
        let from = self.sender_for(&account, draft.from_email.as_deref())?;
        let message = smtp::build(&smtp::Mail {
            from: &from,
            to: &draft.to,
            cc: &draft.cc,
            bcc: &draft.bcc,
            subject: &draft.subject,
            text: &draft.text,
            html: &draft.html,
            threading: threading.as_ref(),
            attachments: &draft.attachments,
            message_id: Some(&key),
            draft: true,
        })?;
        let raw = message.formatted();

        if account.protocol == Protocol::Jmap {
            let client = self.inner.jmap_client(&account.id).await?;
            jmap_sync::save_draft(&client, &self.inner.store, &account.id, raw, &key).await?;
            self.inner.wake(&account.id);
        } else {
            let folder = self.inner.ensure_folder(&account.id, FolderRole::Drafts).await?;
            with_session!(self.inner, &account.id, |session| imap::append(
                session,
                &folder.path,
                &raw,
                Some("(\\Seen \\Draft)")
            ))?;
            let uids = with_session!(self.inner, &account.id, |session| imap::uids_with_message_id(
                session,
                &folder.path,
                &key
            ))?;
            if let Some((&newest, older)) = uids.split_last() {
                with_session!(self.inner, &account.id, |session| imap::delete_permanently(
                    session,
                    &folder.path,
                    older
                ))?;
                self.inner.store.delete_uids(&folder.id, older)?;
                let flags = MessageFlags { seen: true, draft: true, ..MessageFlags::default() };
                let size = raw.len() as u64;
                self.inner.store.insert_message(
                    &account.id,
                    &folder.id,
                    newest,
                    flags,
                    size,
                    Some(mime::now()),
                    &mime::parse(&raw),
                )?;
            }
            self.inner.emit(EngineEvent::MailChanged { account_id: account.id.clone() });
        }
        Ok(SavedDraft { draft_key: key, saved_at: mime::iso8601(mime::now()) })
    }

    /// Removes every saved version of a draft.
    pub async fn delete_draft(&self, account_id: &str, draft_key: &str) -> Result<()> {
        if !smtp::is_draft_key(draft_key) {
            return Err(Error::invalid("This draft can't be deleted."));
        }
        let account = self.inner.store.account(account_id)?;
        let Some(folder) = self.inner.store.folder_by_role(account_id, FolderRole::Drafts)? else { return Ok(()) };
        if account.protocol == Protocol::Jmap {
            let client = self.inner.jmap_client(account_id).await?;
            jmap_sync::delete_draft(&client, &self.inner.store, account_id, draft_key).await?;
            self.inner.wake(account_id);
        } else {
            let uids = with_session!(self.inner, account_id, |session| imap::uids_with_message_id(
                session,
                &folder.path,
                draft_key
            ))?;
            with_session!(self.inner, account_id, |session| imap::delete_permanently(session, &folder.path, &uids))?;
        }
        // Also what the last sync brought in, so the draft disappears right away.
        let local = self.inner.store.ids_by_header_id(&folder.id, draft_key)?;
        self.inner.store.delete_messages(&local)?;
        self.inner.emit(EngineEvent::MailChanged { account_id: account_id.to_string() });
        Ok(())
    }

    /// A draft from the Drafts folder with everything needed to keep writing it.
    pub async fn open_draft(&self, message_id: &str) -> Result<DraftContent> {
        let message = self
            .inner
            .store
            .messages_by_ids(&[message_id.to_string()])?
            .pop()
            .ok_or_else(|| Error::not_found("This draft no longer exists."))?;
        let location = self
            .inner
            .store
            .locations(&[message_id.to_string()])?
            .pop()
            .ok_or_else(|| Error::not_found("This draft no longer exists."))?;
        let folder = self.inner.store.folder(&location.folder_id)?;
        if !message.flags.draft && folder.role != Some(FolderRole::Drafts) {
            return Err(Error::invalid("This message isn't a draft."));
        }
        let raw = self.inner.raw_message(&location).await?;
        let parsed = mime::parse(&raw);
        let parts = mime::draft_parts(&raw);
        let in_reply_to = match &parsed.in_reply_to {
            Some(parent) => self.inner.store.message_by_header_id(&location.account_id, parent)?,
            None => None,
        };
        let html =
            parsed.html.clone().unwrap_or_else(|| mime::text_to_html(parsed.text.as_deref().unwrap_or_default()));
        Ok(DraftContent {
            from_email: parsed.from.as_ref().map(|from| from.email.clone()),
            account_id: location.account_id,
            draft_key: parsed.message_id.filter(|id| smtp::is_draft_key(id)),
            to: parsed.to,
            cc: parsed.cc,
            bcc: parts.bcc,
            subject: parsed.subject,
            html,
            in_reply_to,
            attachments: parts.attachments,
        })
    }

    /// Sends after `delay_seconds`, unless [`Engine::cancel_send`] comes first. The message
    /// waits in the database, so closing the window or even UwUMail doesn't lose it.
    pub fn queue_send(&self, outgoing: OutgoingMessage, delay_seconds: u64) -> Result<QueuedSend> {
        let account = self.inner.store.account(&outgoing.account_id)?;
        // Mistakes like a broken address show now, not after the wait.
        let from = self.sender_for(&account, outgoing.from_email.as_deref())?;
        smtp::build(&smtp::Mail {
            from: &from,
            to: &outgoing.to,
            cc: &outgoing.cc,
            bcc: &outgoing.bcc,
            subject: &outgoing.subject,
            text: &outgoing.text,
            html: &outgoing.html,
            threading: None,
            attachments: &outgoing.attachments,
            message_id: None,
            draft: false,
        })?;
        let id = uuid::Uuid::new_v4().to_string();
        let delay = i64::try_from(delay_seconds.min(MAX_SEND_DELAY)).unwrap_or(0) * 1000;
        let send_at = now_millis() + delay;
        self.inner.store.insert_outbox(&id, &account.id, &serde_json::to_string(&outgoing)?, send_at)?;
        self.schedule_send(id.clone(), send_at);
        Ok(QueuedSend { id, send_at: mime::iso8601(send_at / 1000) })
    }

    /// Takes a queued message back before it goes out.
    pub fn cancel_send(&self, send_id: &str) -> Result<OutgoingMessage> {
        match self.inner.store.take_outbox(send_id)? {
            Some((_, json)) => Ok(serde_json::from_str(&json)?),
            None => Err(Error::invalid("This mail is already on its way.")),
        }
    }

    fn schedule_send(&self, send_id: String, send_at: i64) {
        let engine = self.clone();
        self.inner.runtime.spawn(async move {
            let wait = u64::try_from(send_at - now_millis()).unwrap_or(0);
            tokio::time::sleep(Duration::from_millis(wait)).await;
            engine.deliver(&send_id).await;
        });
    }

    async fn deliver(&self, send_id: &str) {
        let (account_id, json) = match self.inner.store.take_outbox(send_id) {
            Ok(Some(taken)) => taken,
            // Undone in the meantime.
            Ok(None) => return,
            Err(error) => {
                tracing::warn!("Couldn't read the outbox: {error}");
                return;
            }
        };
        let message: OutgoingMessage = match serde_json::from_str(&json) {
            Ok(message) => message,
            Err(error) => {
                tracing::warn!("A queued message couldn't be read: {error}");
                return;
            }
        };
        match self.send(message.clone()).await {
            Ok(()) => self.inner.emit(EngineEvent::SendDone { send_id: send_id.to_string(), account_id }),
            Err(error) => {
                // Nothing written gets lost: it waits in Drafts.
                if let Err(draft_error) = self.save_draft(message.clone()).await {
                    tracing::warn!("Couldn't keep the unsent message as a draft: {draft_error}");
                }
                self.inner.emit(EngineEvent::SendFailed {
                    send_id: send_id.to_string(),
                    account_id,
                    reason: error.message,
                    message: Box::new(message),
                });
            }
        }
    }

    pub async fn send(&self, outgoing: OutgoingMessage) -> Result<()> {
        let account = self.inner.store.account(&outgoing.account_id)?;
        let threading = self.threading_for(outgoing.in_reply_to.as_deref())?;
        let from = self.sender_for(&account, outgoing.from_email.as_deref())?;
        let message = smtp::build(&smtp::Mail {
            from: &from,
            to: &outgoing.to,
            cc: &outgoing.cc,
            bcc: &outgoing.bcc,
            subject: &outgoing.subject,
            text: &outgoing.text,
            html: &outgoing.html,
            threading: threading.as_ref(),
            attachments: &outgoing.attachments,
            message_id: None,
            draft: false,
        })?;

        let recipients: Vec<Address> = outgoing.to.iter().chain(&outgoing.cc).chain(&outgoing.bcc).cloned().collect();
        if account.protocol == Protocol::Jmap {
            let client = self.inner.jmap_client(&account.id).await?;
            let envelope: Vec<String> = recipients.iter().map(|a| a.email.clone()).collect();
            jmap_sync::send(&client, &self.inner.store, &account.id, message.formatted(), &from.email, &envelope)
                .await?;
        } else {
            let auth = match self.inner.credential(&account).await? {
                Credential::Password(password) => SmtpAuth::Password(password),
                Credential::Token(token) => SmtpAuth::OAuth(token),
            };
            let username = match &auth {
                SmtpAuth::Password(_) => account.username.clone(),
                SmtpAuth::OAuth(_) => oauth_mailbox(&account.username, &account.email).to_string(),
            };
            smtp::send(&account.smtp, &username, auth, &message).await?;

            // Gmail and Microsoft file sent mail themselves.
            let provider_saves_sent = account.auth != AuthKind::Password
                || ["gmail.com", "googlemail.com", "office365.com", "outlook.com"]
                    .iter()
                    .any(|h| account.smtp.host.ends_with(h));
            if !provider_saves_sent
                && let Some(sent) = self.inner.store.folder_by_role(&account.id, FolderRole::Sent)?
            {
                let raw = message.formatted();
                if let Err(error) = with_session!(self.inner, &account.id, |session| imap::append(
                    session,
                    &sent.path,
                    &raw,
                    Some("(\\Seen)")
                )) {
                    tracing::warn!("Couldn't store the sent message: {error}");
                }
            }
        }

        if let Some(key) = &outgoing.draft_key
            && let Err(error) = self.delete_draft(&account.id, key).await
        {
            tracing::warn!("Couldn't remove the draft of a sent message: {error}");
        }

        if let Some(original) = &outgoing.in_reply_to {
            let locations = self.inner.store.locations(std::slice::from_ref(original))?;
            for (account_id, remote_ids) in group_remote(&locations) {
                if let Ok(client) = self.inner.jmap_client(&account_id).await {
                    let _ = jmap_sync::set_keywords(&client, &remote_ids, &[("$answered", true)]).await;
                }
            }
            for ((account_id, path), uids) in group_by_folder(&locations) {
                let _ = with_session!(self.inner, &account_id, |session| imap::store_flags(
                    session,
                    &path,
                    &uids,
                    "+FLAGS.SILENT (\\Answered)"
                ));
            }
        }

        self.inner.store.remember_contacts(&recipients)?;
        self.inner.wake(&account.id);
        Ok(())
    }

    /// The file of an attachment, downloaded from the server on first use.
    pub async fn attachment(&self, attachment_id: &str) -> Result<AttachmentFile> {
        let (message_id, index) = attachments::parse_id(attachment_id)?;
        let message = self
            .inner
            .store
            .messages_by_ids(std::slice::from_ref(&message_id))?
            .pop()
            .ok_or_else(|| Error::not_found("This message no longer exists."))?;
        let known =
            message.attachments.get(index).ok_or_else(|| Error::not_found("This attachment no longer exists."))?;
        if let Some(path) = self.inner.attachments.cached(&message_id, index) {
            // Files cached by older versions don't carry the mark yet.
            attachments::mark_from_internet(&path);
            // The name on disk is what the system goes by when the file is opened.
            let on_disk = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
            return Ok(AttachmentFile {
                dangerous: attachments::is_dangerous(&known.filename) || attachments::is_dangerous(&on_disk),
                path,
                filename: known.filename.clone(),
                mime_type: known.mime_type.clone(),
                size: known.size,
            });
        }
        let location = self
            .inner
            .store
            .locations(std::slice::from_ref(&message_id))?
            .pop()
            .ok_or_else(|| Error::not_found("This message no longer exists."))?;
        let raw = self.inner.raw_message(&location).await?;
        let file = self.inner.attachments.store_from_raw(&message_id, index, &raw)?;
        // A mail's other embedded images are asked for right after; one download for all of them.
        for (other, attachment) in message.attachments.iter().enumerate() {
            if other != index && attachment.inline && self.inner.attachments.cached(&message_id, other).is_none() {
                let _ = self.inner.attachments.store_from_raw(&message_id, other, &raw);
            }
        }
        Ok(file)
    }

    /// The complete message as an `.eml` file, named after its subject.
    pub async fn message_file(&self, message_id: &str) -> Result<AttachmentFile> {
        let message = self
            .inner
            .store
            .messages_by_ids(&[message_id.to_string()])?
            .pop()
            .ok_or_else(|| Error::not_found("This message no longer exists."))?;
        let location = self
            .inner
            .store
            .locations(&[message_id.to_string()])?
            .pop()
            .ok_or_else(|| Error::not_found("This message no longer exists."))?;
        let raw = self.inner.raw_message(&location).await?;
        let subject = message.subject.trim();
        let filename = format!("{}.eml", if subject.is_empty() { "Mail" } else { subject });
        let path = self.inner.attachments.store_message(message_id, &filename, &raw)?;
        Ok(AttachmentFile {
            path,
            filename: attachments::safe_filename(&filename),
            mime_type: "message/rfc822".into(),
            size: raw.len() as u64,
            dangerous: false,
        })
    }

    /// Copies an attachment to a place the user picked.
    pub async fn save_attachment(&self, attachment_id: &str, destination: &std::path::Path) -> Result<()> {
        let file = self.attachment(attachment_id).await?;
        std::fs::copy(&file.path, destination)
            .map(|_| ())
            .map_err(|e| Error::invalid(format!("Couldn't save to {}: {e}", destination.display())))
    }

    /// Where attachment files are cached, for the webview's file access scope.
    pub fn attachment_dir(&self) -> std::path::PathBuf {
        self.inner.attachments.dir().to_path_buf()
    }

    /// The brand logo or website icon for a company address, fetched once per domain. With a UwUMail
    /// server among the accounts, that server looks it up, whichever account the mail came to: the
    /// picture is the company's either way, and the company never sees this device.
    pub async fn sender_picture(&self, email: &str) -> Result<Option<SenderPicture>> {
        let server = self.inner.picture_server().await;
        self.inner.pictures.get(email, server).await
    }

    /// A remote picture of a mail, with its type. A UwUMail server fetches it for its own accounts;
    /// every other one fetches it from here, through the privacy proxy when one is set. `None` when it
    /// can't be had.
    pub async fn mail_image(&self, account_id: Option<&str>, url: &str) -> Option<(String, Vec<u8>)> {
        if let Some(account_id) = account_id
            && self.inner.store.account(account_id).is_ok_and(|account| account.protocol == Protocol::Jmap)
            && let Ok(client) = self.inner.jmap_client(account_id).await
            && client.session.image_url.is_some()
        {
            return client.remote_image(url).await.ok().flatten();
        }
        let bytes = self.inner.mail_images.get(url).await?;
        let media_type =
            crate::pictures::sniff_image(&bytes).map_or("application/octet-stream", |format| match format {
                "svg" => "image/svg+xml",
                "jpg" => "image/jpeg",
                "png" => "image/png",
                "gif" => "image/gif",
                "webp" => "image/webp",
                _ => "application/octet-stream",
            });
        Some((media_type.to_string(), bytes))
    }

    /// The proxy for requests that tell a sender something about the reader: remote pictures, sender
    /// pictures and one-click unsubscribes. Empty for none.
    pub fn set_privacy_proxy(&self, proxy: &str) -> Result<()> {
        crate::tls::set_privacy_proxy(proxy)
    }

    pub fn clear_sender_pictures(&self) -> Result<()> {
        self.inner.pictures.clear()
    }

    /// Where sender pictures are cached, for the webview's file access scope.
    pub fn picture_dir(&self) -> std::path::PathBuf {
        self.inner.pictures.dir().to_path_buf()
    }

    /// Messages by id, e.g. to describe new mail in a notification.
    pub fn messages(&self, message_ids: &[String]) -> Result<Vec<Message>> {
        self.inner.store.messages_by_ids(message_ids)
    }

    pub fn search_contacts(&self, query: &str) -> Result<Vec<Contact>> {
        let own: Vec<String> = self.inner.store.accounts()?.into_iter().map(|a| a.email).collect();
        self.inner.store.search_contacts(query, &own)
    }
}

/// The mailbox an OAuth login opens, which is not always the account that signed
/// in: a shared mailbox in Microsoft 365 is opened with its own address and the
/// token of the person who has access to it. The username carries that address;
/// older accounts whose username is a bare login name keep using their own.
fn oauth_mailbox<'a>(username: &'a str, email: &'a str) -> &'a str {
    if username.contains('@') { username } else { email }
}

fn sender(account: &AccountRecord) -> Address {
    Address { name: Some(account.display_name.clone()).filter(|n| !n.is_empty()), email: account.email.clone() }
}

enum MoveTarget {
    /// The account's folder for a role, created when missing.
    Role(FolderRole),
    /// A folder by its local id.
    Folder(String),
}

/// Whether mail from `email` is blocked by an address or `@domain` entry (subdomains included).
pub fn is_blocked(entries: &[String], email: &str) -> bool {
    let email = email.trim().to_lowercase();
    let domain = email.rsplit_once('@').map(|(_, d)| d).unwrap_or_default();
    entries.iter().any(|entry| match entry.strip_prefix('@') {
        Some(blocked) => domain == blocked || domain.ends_with(&format!(".{blocked}")),
        None => *entry == email,
    })
}

/// Messages by account.
fn by_account(locations: &[MessageLocation]) -> HashMap<String, Vec<MessageLocation>> {
    let mut groups: HashMap<String, Vec<MessageLocation>> = HashMap::new();
    for location in locations {
        groups.entry(location.account_id.clone()).or_default().push(location.clone());
    }
    groups
}

fn local_ids(locations: &[MessageLocation]) -> Vec<String> {
    locations.iter().map(|location| location.id.clone()).collect()
}

fn remote_ids(locations: &[MessageLocation]) -> Vec<String> {
    locations.iter().filter_map(|location| location.remote_id.clone()).collect()
}

/// JMAP email ids by account.
fn group_remote(locations: &[MessageLocation]) -> HashMap<String, Vec<String>> {
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for location in locations {
        if let Some(remote_id) = &location.remote_id {
            groups.entry(location.account_id.clone()).or_default().push(remote_id.clone());
        }
    }
    groups
}

/// IMAP uids by account and folder.
fn group_by_folder(locations: &[MessageLocation]) -> HashMap<(String, String), Vec<u32>> {
    let mut groups: HashMap<(String, String), Vec<u32>> = HashMap::new();
    for location in locations.iter().filter(|l| l.remote_id.is_none()) {
        if let Ok(uid) = u32::try_from(location.uid)
            && uid > 0
        {
            groups.entry((location.account_id.clone(), location.folder_path.clone())).or_default().push(uid);
        }
    }
    groups
}

impl Inner {
    /// The complete message from the server.
    async fn raw_message(&self, location: &MessageLocation) -> Result<Vec<u8>> {
        if let Some(blob) = &location.blob_id {
            let client = self.jmap_client(&location.account_id).await?;
            return client.download(blob, "message.eml", "message/rfc822").await;
        }
        let uid = u32::try_from(location.uid)
            .ok()
            .filter(|uid| *uid > 0)
            .ok_or_else(|| Error::connection("The message is still being moved. Try again in a moment."))?;
        with_session!(self, &location.account_id, |session| imap::fetch_body(session, &location.folder_path, uid))
    }

    /// Mail received before this (Unix seconds) is kept as a preview.
    fn full_after(&self) -> Option<i64> {
        let days = self.offline_days.load(Ordering::Relaxed);
        (days > 0).then(|| crate::mime::now() - i64::from(days) * 24 * 60 * 60)
    }

    fn emit(&self, event: EngineEvent) {
        let _ = self.events.send(event);
    }

    fn emit_changed(&self, locations: &[MessageLocation]) {
        let accounts: HashSet<&str> = locations.iter().map(|l| l.account_id.as_str()).collect();
        for account_id in accounts {
            self.emit(EngineEvent::MailChanged { account_id: account_id.to_string() });
        }
    }

    fn set_status(&self, account_id: &str, status: AccountStatus) {
        if let Some(runtime) = self.accounts.lock().unwrap().get_mut(account_id) {
            if runtime.status == status {
                return;
            }
            runtime.status = status.clone();
        }
        self.emit(EngineEvent::AccountStatus { account_id: account_id.to_string(), status });
    }

    fn wake(&self, account_id: &str) {
        if let Some(runtime) = self.accounts.lock().unwrap().get(account_id) {
            runtime.wake.notify_one();
        }
    }

    fn spawn_sync(self: &Arc<Self>, account_id: &str) {
        let mut accounts = self.accounts.lock().unwrap();
        let runtime = accounts.entry(account_id.to_string()).or_insert_with(Runtime::new);
        if runtime.task.is_some() {
            return;
        }
        let inner = Arc::clone(self);
        let id = account_id.to_string();
        let wake = runtime.wake.clone();
        runtime.task = Some(self.runtime.spawn(async move { sync_loop(inner, id, wake).await }));
    }

    async fn credential(&self, account: &AccountRecord) -> Result<Credential> {
        match self.secrets.get(&account.id)? {
            Secret::Password { password } => Ok(Credential::Password(password)),
            Secret::OAuth { refresh_token } => {
                let provider =
                    if account.auth == AuthKind::Microsoft { OAuthProvider::Microsoft } else { OAuthProvider::Google };
                // Every token goes to these two servers; an account saved before this check must not
                // keep sending them elsewhere.
                autoconfig::check_oauth_servers(provider, &[&account.imap, &account.smtp])?;
                let mut tokens = self.tokens.lock().await;
                if let Some((token, expires)) = tokens.get(&account.id)
                    && *expires > Instant::now() + Duration::from_secs(60)
                {
                    return Ok(Credential::Token(token.clone()));
                }
                let fresh = oauth::refresh(&self.http, provider, &refresh_token).await?;
                if let Some(rotated) = &fresh.refresh_token
                    && *rotated != refresh_token
                {
                    self.secrets.set(&account.id, &Secret::OAuth { refresh_token: rotated.clone() })?;
                }
                tokens.insert(account.id.clone(), (fresh.access_token.clone(), Instant::now() + fresh.expires_in));
                Ok(Credential::Token(fresh.access_token))
            }
        }
    }

    async fn login(&self, account: &AccountRecord) -> Result<ImapSession> {
        match self.credential(account).await? {
            Credential::Password(password) => {
                imap::login(&account.imap, Login::Password { username: &account.username, password: &password }).await
            }
            Credential::Token(token) => {
                let mailbox = oauth_mailbox(&account.username, &account.email);
                imap::login(&account.imap, Login::OAuth { username: mailbox, access_token: &token }).await
            }
        }
    }

    /// A signed-in UwUMail server that looks up sender pictures, if one of the accounts is on one.
    async fn picture_server(&self) -> Option<Arc<JmapClient>> {
        for account in self.store.accounts().ok()? {
            if account.protocol != Protocol::Jmap {
                continue;
            }
            if let Ok(client) = self.jmap_client(&account.id).await
                && client.session.picture_url.is_some()
            {
                return Some(client);
            }
        }
        None
    }

    /// The signed-in JMAP connection of an account, connecting if needed.
    async fn jmap_client(&self, account_id: &str) -> Result<Arc<JmapClient>> {
        let mut clients = self.jmap.lock().await;
        if let Some(client) = clients.get(account_id) {
            return Ok(Arc::clone(client));
        }
        let account = self.store.account(account_id)?;
        let url = account.jmap_url.as_deref().ok_or_else(|| Error::invalid("This mailbox has no JMAP address."))?;
        let Secret::Password { password } = self.secrets.get(account_id)? else {
            return Err(Error::not_supported("JMAP needs a password or app token."));
        };
        let client = Arc::new(JmapClient::connect(&self.http, url, &account.username, &password).await?);
        clients.insert(account_id.to_string(), Arc::clone(&client));
        Ok(client)
    }

    /// Moves mail over IMAP or JMAP. Mail already in the target folder stays where it is.
    async fn move_to(&self, message_ids: &[String], target: MoveTarget) -> Result<Vec<MovedMessage>> {
        let locations = self.store.locations(message_ids)?;
        let mut moved = Vec::new();
        for (account_id, messages) in by_account(&locations) {
            let jmap = self.store.account(&account_id)?.protocol == Protocol::Jmap;
            let folder = match &target {
                MoveTarget::Role(role) if jmap => {
                    let client = self.jmap_client(&account_id).await?;
                    let folder = jmap_sync::ensure_mailbox(&client, &self.store, &account_id, *role).await?;
                    self.created_folders
                        .lock()
                        .unwrap()
                        .insert((account_id.clone(), folder.path.clone()), Instant::now());
                    folder
                }
                MoveTarget::Role(role) => self.ensure_folder(&account_id, *role).await?,
                MoveTarget::Folder(id) => {
                    let folder = self.store.folder(id)?;
                    if folder.account_id != account_id {
                        return Err(Error::invalid("Mail can only move to folders of its own mailbox."));
                    }
                    if !folder.selectable {
                        return Err(Error::invalid("This folder can't hold mail."));
                    }
                    folder
                }
            };
            let to_move: Vec<MessageLocation> = messages.into_iter().filter(|m| m.folder_id != folder.id).collect();
            moved
                .extend(to_move.iter().map(|m| MovedMessage { id: m.id.clone(), from_folder_id: m.folder_id.clone() }));
            if jmap {
                self.move_jmap(&account_id, &to_move, &folder).await?;
                continue;
            }

            self.store.move_local(&local_ids(&to_move), &folder.id)?;
            for ((account, path), uids) in group_by_folder(&to_move) {
                with_session!(self, &account, |session| imap::move_messages(session, &path, &uids, &folder.path))?;
            }
            self.wake(&account_id);
        }
        self.emit_changed(&locations);
        Ok(moved)
    }

    /// New inbox mail from senders the app blocks goes straight into junk; returns the rest.
    async fn drop_blocked(&self, messages: Vec<Message>) -> Vec<Message> {
        let blocked = match self.store.blocked_senders() {
            Ok(blocked) if !blocked.is_empty() => blocked,
            _ => return messages,
        };
        let (dropped, kept): (Vec<_>, Vec<_>) =
            messages.into_iter().partition(|message| is_blocked(&blocked, &message.from.email));
        if !dropped.is_empty() {
            let ids: Vec<String> = dropped.into_iter().map(|message| message.id).collect();
            if let Err(error) = Box::pin(self.move_to(&ids, MoveTarget::Role(FolderRole::Junk))).await {
                tracing::warn!("Couldn't move mail from blocked senders into junk: {error}");
            }
        }
        kept
    }

    async fn move_jmap(&self, account_id: &str, to_move: &[MessageLocation], target: &FolderRecord) -> Result<()> {
        if !to_move.is_empty() {
            let client = self.jmap_client(account_id).await?;
            jmap_sync::move_emails(&client, &remote_ids(to_move), &target.path).await?;
            self.store.set_folder(&local_ids(to_move), &target.id)?;
        }
        self.wake(account_id);
        Ok(())
    }

    /// Deletes mail in the trash for good, first on the server, then here. Mail
    /// elsewhere stays, so an outdated view can never delete it by accident.
    async fn delete_forever(&self, message_ids: &[String]) -> Result<usize> {
        let locations = self.store.locations(message_ids)?;
        let mut deleted = 0;
        for (account_id, messages) in by_account(&locations) {
            let Some(trash) = self.store.folder_by_role(&account_id, FolderRole::Trash)? else { continue };
            let doomed: Vec<MessageLocation> = messages.into_iter().filter(|m| m.folder_id == trash.id).collect();
            if doomed.is_empty() {
                continue;
            }
            if self.store.account(&account_id)?.protocol == Protocol::Jmap {
                let client = self.jmap_client(&account_id).await?;
                jmap_sync::destroy_emails(&client, &remote_ids(&doomed)).await?;
            } else {
                let mut uids: Vec<u32> = Vec::new();
                for message in &doomed {
                    match u32::try_from(message.uid).ok().filter(|uid| *uid > 0) {
                        Some(uid) => uids.push(uid),
                        // Just moved here: the trash hasn't synced yet, so the server's uid is unknown.
                        None => {
                            let message_id = message.message_id.as_deref().ok_or_else(|| {
                                Error::connection("The message is still being moved. Try again in a moment.")
                            })?;
                            uids.extend(with_session!(self, &account_id, |session| imap::uids_with_message_id(
                                session,
                                &trash.path,
                                message_id
                            ))?);
                        }
                    }
                }
                with_session!(self, &account_id, |session| imap::delete_permanently(session, &trash.path, &uids))?;
            }
            self.store.delete_messages(&local_ids(&doomed))?;
            deleted += doomed.len();
            self.wake(&account_id);
        }
        self.emit_changed(&locations);
        Ok(deleted)
    }

    async fn command_session(&self, account_id: &str) -> Result<OwnedMutexGuard<Option<ImapSession>>> {
        let commands = {
            let mut accounts = self.accounts.lock().unwrap();
            accounts.entry(account_id.to_string()).or_insert_with(Runtime::new).commands.clone()
        };
        let mut guard = commands.lock_owned().await;
        if guard.is_none() {
            let account = self.store.account(account_id)?;
            *guard = Some(self.login(&account).await?);
        }
        Ok(guard)
    }

    /// Finds the folder for a role, creating it on the server if needed.
    async fn ensure_folder(&self, account_id: &str, role: FolderRole) -> Result<FolderRecord> {
        if let Some(folder) = self.store.folder_by_role(account_id, role)? {
            return Ok(folder);
        }
        let name = match role {
            FolderRole::Archive => "Archive",
            FolderRole::Trash => "Trash",
            FolderRole::Sent => "Sent",
            FolderRole::Drafts => "Drafts",
            FolderRole::Junk => "Junk",
            FolderRole::Inbox => "INBOX",
        };
        // Servers that keep every folder below INBOX need the new one there too.
        let existing = self.store.folder_records(account_id)?;
        let namespace = folders::inbox_namespace(existing.iter().map(|f| (f.path.as_str(), f.delimiter.as_deref())));
        let path = match &namespace {
            Some(delimiter) => format!("INBOX{delimiter}{name}"),
            None => name.to_string(),
        };
        with_session!(self, account_id, |session| async { session.create(&path).await.map_err(Error::from) })
            .or_else(|error| if error.message.to_lowercase().contains("exist") { Ok(()) } else { Err(error) })?;
        self.created_folders.lock().unwrap().insert((account_id.to_string(), path.clone()), Instant::now());
        let id = self.store.upsert_folder(
            account_id,
            &FolderInfo {
                path: &path,
                name,
                role: Some(role),
                delimiter: namespace.as_deref(),
                selectable: true,
                parent_ref: None,
            },
        )?;
        self.store.folder(&id)
    }

    /// A folder UwUMail just created may be missing from a listing that started
    /// before; sync keeps these paths (and the mail just moved into them).
    fn recently_created(&self, account_id: &str) -> HashSet<String> {
        let mut created = self.created_folders.lock().unwrap();
        created.retain(|_, at| at.elapsed() < Duration::from_secs(120));
        created.keys().filter(|(id, _)| id == account_id).map(|(_, path)| path.clone()).collect()
    }

    async fn sync_jmap(&self, client: &JmapClient, account_id: &str) -> Result<()> {
        let identities_due = {
            let mut checked = self.identities_checked.lock().unwrap();
            let due = checked.get(account_id).is_none_or(|at| at.elapsed() >= IDENTITIES_EVERY);
            if due {
                checked.insert(account_id.to_string(), Instant::now());
            }
            due
        };
        if identities_due {
            match jmap_sync::identities(client).await {
                Ok(found) => {
                    self.store.replace_server_identities(account_id, &found)?;
                }
                Err(error) => tracing::warn!("Couldn't load the sending identities: {error}"),
            }
        }
        let keep = self.recently_created(account_id);
        let folders_changed = jmap_sync::sync_mailboxes(client, &self.store, account_id, &keep).await?;
        let result = jmap_sync::sync_emails(client, &self.store, account_id, self.full_after()).await?;
        if !result.new_message_ids.is_empty() {
            let inbox = self.store.folder_by_role(account_id, FolderRole::Inbox)?.map(|f| f.id);
            let arrived: Vec<Message> = self
                .store
                .messages_by_ids(&result.new_message_ids)?
                .into_iter()
                .filter(|m| Some(&m.folder_id) == inbox.as_ref())
                .collect();
            let arrived = self.drop_blocked(arrived).await;
            let unseen: Vec<String> =
                arrived.into_iter().filter(|m| !m.flags.seen && result.had_messages).map(|m| m.id).collect();
            if !unseen.is_empty() {
                self.emit(EngineEvent::MailReceived { account_id: account_id.to_string(), message_ids: unseen });
            }
        }
        if folders_changed || result.changed {
            self.emit(EngineEvent::MailChanged { account_id: account_id.to_string() });
        }
        self.set_status(account_id, AccountStatus::Idle);
        Ok(())
    }

    async fn sync_folders(&self, session: &mut ImapSession, account: &AccountRecord) -> Result<Vec<FolderRecord>> {
        let remote = imap::list_folders(session).await?;
        let mut paths = HashSet::new();
        for folder in remote.iter().filter(|f| !f.skip_sync) {
            self.store.upsert_folder(
                &account.id,
                &FolderInfo {
                    path: &folder.path,
                    name: &folder.name,
                    role: folder.role,
                    delimiter: folder.delimiter.as_deref(),
                    selectable: folder.selectable,
                    parent_ref: None,
                },
            )?;
            paths.insert(folder.path.clone());
        }
        paths.extend(self.recently_created(&account.id));
        self.store.retain_folders(&account.id, &paths)?;
        let mut folders: Vec<FolderRecord> =
            self.store.folder_records(&account.id)?.into_iter().filter(|f| f.selectable).collect();
        folders.sort_by_key(|f| match f.role {
            Some(FolderRole::Inbox) => 0,
            Some(FolderRole::Sent) => 1,
            Some(FolderRole::Drafts) => 2,
            Some(FolderRole::Archive) => 3,
            None => 4,
            Some(FolderRole::Junk) => 5,
            Some(FolderRole::Trash) => 6,
        });
        Ok(folders)
    }

    async fn sync_one(&self, session: &mut ImapSession, folder: &FolderRecord) -> Result<bool> {
        let result = imap::sync_folder(session, &self.store, folder, self.full_after()).await?;
        if folder.role == Some(FolderRole::Inbox) && !result.new_message_ids.is_empty() {
            let arrived = self.drop_blocked(self.store.messages_by_ids(&result.new_message_ids)?).await;
            let unseen: Vec<String> =
                arrived.into_iter().filter(|m| !m.flags.seen && result.had_messages).map(|m| m.id).collect();
            if !unseen.is_empty() {
                self.emit(EngineEvent::MailReceived { account_id: folder.account_id.clone(), message_ids: unseen });
            }
        }
        Ok(result.changed)
    }

    async fn full_sync(&self, session: &mut ImapSession, account: &AccountRecord) -> Result<()> {
        let folders = self.sync_folders(session, account).await?;
        let total = folders.len().max(1) as f32;
        for (index, folder) in folders.iter().enumerate() {
            self.set_status(&account.id, AccountStatus::Syncing { progress: Some(index as f32 / total) });
            if self.sync_one(session, folder).await? {
                self.emit(EngineEvent::MailChanged { account_id: account.id.clone() });
            }
        }
        self.set_status(&account.id, AccountStatus::Idle);
        Ok(())
    }
}

async fn sync_loop(inner: Arc<Inner>, account_id: String, wake: Arc<Notify>) {
    let mut failures: u32 = 0;
    loop {
        match run_account(&inner, &account_id, &wake).await {
            Ok(()) => return,
            Err(error) => {
                if inner.store.account(&account_id).is_err() {
                    return;
                }
                failures = failures.saturating_add(1);
                tracing::warn!("Sync of {account_id} failed: {error}");
                // Sign in to JMAP again next time, in case the session changed.
                inner.jmap.lock().await.remove(&account_id);
                let status = match error.code {
                    ErrorCode::ConnectionFailed => AccountStatus::Offline,
                    _ => AccountStatus::Error { message: error.message.clone() },
                };
                inner.set_status(&account_id, status);
                let delay = Duration::from_secs((5u64 << failures.min(6)).min(300));
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = wake.notified() => {}
                }
            }
        }
    }
}

/// JMAP: sync, then wait for a push, a wake-up or the next regular check.
async fn run_jmap_account(inner: &Inner, account_id: &str, wake: &Notify) -> Result<()> {
    inner.set_status(account_id, AccountStatus::Syncing { progress: None });
    let client = inner.jmap_client(account_id).await?;
    inner.sync_jmap(&client, account_id).await?;
    let mut push = None;
    loop {
        if push.is_none() {
            push = client.push().await.unwrap_or_else(|error| {
                tracing::warn!("No push for {account_id}, checking every minute: {error}");
                None
            });
            // Catch what changed while the push connection was being opened.
            if push.is_some() {
                inner.sync_jmap(&client, account_id).await?;
                // The page reads the shared settings again too: it may have changes waiting.
                if client.session.user_settings {
                    inner.emit(EngineEvent::SettingsChanged { account_id: account_id.to_string(), state: None });
                }
            }
        }
        let outcome = tokio::select! {
            changed = async {
                match push.as_mut() {
                    Some(stream) => stream.changed().await,
                    None => {
                        tokio::time::sleep(JMAP_POLL_EVERY).await;
                        Ok(StateChange::default())
                    }
                }
            } => changed,
            _ = wake.notified() => Ok(StateChange::default()),
            _ = tokio::time::sleep(FULL_SYNC_EVERY) => Ok(StateChange::default()),
        };
        match outcome {
            Ok(change) => {
                if client.session.user_settings && change.may_have_changed(USER_SETTINGS) {
                    let state = change.state_of(USER_SETTINGS).map(String::from);
                    inner.emit(EngineEvent::SettingsChanged { account_id: account_id.to_string(), state });
                }
                // Only what a push names: a quiet minute or a wake-up isn't a calendar change.
                if change.state_of("Calendar").is_some() || change.state_of("CalendarEvent").is_some() {
                    if change.state_of("Calendar").is_some() {
                        inner.calendar_lists.lock().unwrap().remove(account_id);
                    }
                    inner.emit(EngineEvent::CalendarChanged {});
                }
                if change.state_of("AddressBook").is_some() || change.state_of("ContactCard").is_some() {
                    inner.forget_contacts(account_id);
                    inner.emit(EngineEvent::ContactsChanged {});
                }
                // Settings, calendars and rules alone are nothing for the mail.
                if change.only(&NOT_MAIL) {
                    continue;
                }
            }
            Err(error) => {
                tracing::debug!("Push for {account_id} ended: {error}");
                push = None;
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                    _ = wake.notified() => {}
                }
            }
        }
        inner.sync_jmap(&client, account_id).await?;
    }
}

async fn run_account(inner: &Inner, account_id: &str, wake: &Notify) -> Result<()> {
    let Ok(account) = inner.store.account(account_id) else { return Ok(()) };
    if account.protocol == Protocol::Jmap {
        return run_jmap_account(inner, account_id, wake).await;
    }
    inner.set_status(account_id, AccountStatus::Syncing { progress: None });
    let mut session = inner.login(&account).await?;
    inner.full_sync(&mut session, &account).await?;
    let mut last_full = Instant::now();

    loop {
        let Some(inbox) = inner.store.folder_by_role(account_id, FolderRole::Inbox)? else {
            tokio::select! {
                _ = tokio::time::sleep(FULL_SYNC_EVERY) => {}
                _ = wake.notified() => {}
            }
            inner.full_sync(&mut session, &account).await?;
            continue;
        };

        session.select(&inbox.path).await?;
        let mut idle = session.idle();
        idle.init().await?;
        let next_full = tokio::time::Instant::from_std(last_full + FULL_SYNC_EVERY);
        let full = {
            let (wait, stop) = idle.wait_with_timeout(IDLE_TIMEOUT);
            tokio::pin!(wait);
            let full = tokio::select! {
                response = &mut wait => {
                    response?;
                    false
                }
                _ = wake.notified() => true,
                _ = tokio::time::sleep_until(next_full) => true,
            };
            if full {
                // Interrupt IDLE cleanly before sending DONE.
                drop(stop);
                let _ = wait.await;
            }
            full
        };
        session = idle.done().await?;

        if full || last_full.elapsed() >= FULL_SYNC_EVERY {
            inner.full_sync(&mut session, &account).await?;
            last_full = Instant::now();
        } else if inner.sync_one(&mut session, &inbox).await? {
            inner.emit(EngineEvent::MailChanged { account_id: account_id.to_string() });
        }
    }
}

/// What unsubscribing by mail sends.
#[derive(Debug, PartialEq, Eq)]
struct UnsubscribeMail {
    address: String,
    subject: String,
}

const UNSUBSCRIBE_SUBJECT_LIMIT: usize = 200;

/// Reads the `mailto:` form of `List-Unsubscribe`.
///
/// Every part of that header was written by whoever sent the mail, and what comes out of it is a
/// message sent from the reader's own account. So only two pieces are taken, and both are held to
/// something: one address that really is a single address, and a subject on one line (list
/// managers match on it). The body is never taken. The web app's `unsubscribeMail` follows the
/// same rules, and so does the dialog that names the address before anything is sent.
fn unsubscribe_mail(mailto: &str) -> Option<UnsubscribeMail> {
    let target = url::Url::parse(mailto).ok()?;
    if target.scheme() != "mailto" {
        return None;
    }
    let address = percent_encoding::percent_decode_str(target.path()).decode_utf8().ok()?.trim().to_string();
    // One recipient, and nothing in it that could turn into a second one or into a header of its own.
    if address.contains(|c: char| c == ',' || c.is_whitespace() || c.is_control() || "<>;\"".contains(c))
        || address.parse::<lettre::Address>().is_err()
    {
        return None;
    }
    // A domain name with a dot, like the dialog wants before it names the address: never an IP
    // address or a bare host name, which the dialog wouldn't show.
    let domain = address.rsplit_once('@').map(|(_, domain)| domain).unwrap_or_default();
    if domain.starts_with('[') || domain.split('.').count() < 2 || domain.split('.').any(str::is_empty) {
        return None;
    }
    let subject = target
        .query_pairs()
        .find(|(key, _)| key.eq_ignore_ascii_case("subject"))
        .map(|(_, value)| value.split_whitespace().collect::<Vec<_>>().join(" "))
        .map(|subject| subject.chars().take(UNSUBSCRIBE_SUBJECT_LIMIT).collect::<String>())
        .filter(|subject| !subject.is_empty())
        .unwrap_or_else(|| "unsubscribe".to_string());
    Some(UnsubscribeMail { address, subject })
}

#[cfg(test)]
mod tests {

    #[test]
    fn unsubscribing_by_mail_takes_one_address_and_a_subject() {
        let mail = |address: &str, subject: &str| {
            Some(UnsubscribeMail { address: address.to_string(), subject: subject.to_string() })
        };
        assert_eq!(unsubscribe_mail("mailto:leave@list.example"), mail("leave@list.example", "unsubscribe"));
        assert_eq!(
            unsubscribe_mail("mailto:leave@list.example?subject=unsubscribe%20a1b2"),
            mail("leave@list.example", "unsubscribe a1b2")
        );
        // Never text somebody else wrote.
        let target = unsubscribe_mail("mailto:leave@list.example?subject=bye&body=I%20quit%2C%20and%20here%20is%20why");
        assert_eq!(target, mail("leave@list.example", "bye"));
    }

    #[test]
    fn unsubscribing_by_mail_keeps_the_subject_to_one_short_line() {
        let subject = |mailto: &str| unsubscribe_mail(mailto).unwrap().subject;
        assert_eq!(subject("mailto:leave@list.example?subject=one%0D%0Atwo"), "one two");
        assert_eq!(subject(&format!("mailto:leave@list.example?subject={}", "x".repeat(500))).chars().count(), 200);
        assert_eq!(subject(&format!("mailto:leave@list.example?subject={}", "ü".repeat(300))), "ü".repeat(200));
        assert_eq!(subject("mailto:leave@list.example?subject=%20%20"), "unsubscribe");
    }

    #[test]
    fn unsubscribing_by_mail_refuses_anything_but_one_plain_address() {
        for mailto in [
            // A second recipient smuggled into the header.
            "mailto:leave@list.example,boss@work.example",
            "mailto:leave@list.example%2Cboss@work.example",
            // A line break, which would become a header of its own further down the line.
            "mailto:leave@list.example%0D%0Abcc:boss@work.example",
            "mailto:Name%20%3Cleave@list.example%3E",
            // A domain without a dot or an IP address: the dialog, which names the address first,
            // wouldn't show it, so nothing may be sent there either.
            "mailto:leave@intranet",
            "mailto:leave@[192.0.2.1]",
            "mailto:leave@list.example.",
            "mailto:not-an-address",
            "mailto:",
            "https://list.example/leave",
            "javascript:alert(1)",
            "not a url at all",
        ] {
            assert_eq!(unsubscribe_mail(mailto), None, "{mailto}");
        }
    }

    #[test]
    fn shared_mailboxes_sign_in_under_their_own_address() {
        // A shared mailbox in Microsoft 365: opened with its address, someone else"s token.
        assert_eq!(oauth_mailbox("team@example-company.de", "alex@example-company.de"), "team@example-company.de");
        // Accounts whose username is a bare login name keep using their own address,
        // because XOAUTH2 needs an address there.
        assert_eq!(oauth_mailbox("alex", "alex@example-company.de"), "alex@example-company.de");
    }
    use super::*;

    #[tokio::test]
    async fn app_link_sign_in_only_takes_its_own_link() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::new(EngineOptions {
            data_dir: dir.path().to_path_buf(),
            secrets: Arc::new(crate::secrets::MemorySecrets::default()),
            open_url: Arc::new(|_| {}),
        })
        .unwrap();
        assert!(!engine.finish_sign_in("app.uwumail://oauth?code=1&state=2"), "no app link set up");
        engine.use_oauth_app_link("app.uwumail://oauth");
        let (sender, mut receiver) = tokio::sync::mpsc::channel(SIGN_IN_LINK_QUEUE);
        *engine.inner.pending_sign_in.lock().unwrap() = Some(sender);
        assert!(!engine.finish_sign_in("https://evil.example/?code=1"));
        assert!(!engine.finish_sign_in("app.uwumail://oauthx?code=1"));
        // A forged link doesn't use up the slot: the real one still gets through afterwards.
        assert!(engine.finish_sign_in("app.uwumail://oauth?code=evil&state=guess"));
        assert!(engine.finish_sign_in("app.uwumail://oauth?code=1&state=2"));
        assert_eq!(receiver.recv().await.unwrap(), "app.uwumail://oauth?code=evil&state=guess");
        assert_eq!(receiver.recv().await.unwrap(), "app.uwumail://oauth?code=1&state=2");
        // Flooding only fills the small queue.
        let flood = (0..100).filter(|_| engine.finish_sign_in("app.uwumail://oauth?state=x")).count();
        assert_eq!(flood, SIGN_IN_LINK_QUEUE);
    }

    #[tokio::test]
    async fn oauth_tokens_only_go_to_the_providers_servers() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(crate::secrets::MemorySecrets::default());
        let opened = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = opened.clone();
        let engine = Engine::new(EngineOptions {
            data_dir: dir.path().to_path_buf(),
            secrets: secrets.clone(),
            open_url: Arc::new(move |url| seen.lock().unwrap().push(url.to_string())),
        })
        .unwrap();
        let lookalike = ServerSettings { host: "outlook.example.org".into(), port: 993, security: Security::Tls };
        let microsoft_smtp =
            ServerSettings { host: "smtp.office365.com".into(), port: 587, security: Security::Starttls };

        // What a discovery answer from someone other than Microsoft could suggest.
        let new = NewAccount {
            display_name: "Alex".into(),
            email: "alex@example.org".into(),
            auth: AuthKind::Microsoft,
            password: None,
            imap: lookalike.clone(),
            smtp: microsoft_smtp.clone(),
            username: "alex@example.org".into(),
            color: AccountColor::Sky,
            protocol: Protocol::Imap,
            jmap_url: None,
            sign_in_as: None,
        };
        let error = engine.add_account(new).await.unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::InvalidInput, "{error:?}");
        assert!(opened.lock().unwrap().is_empty(), "the sign-in page never opened");

        // A mailbox saved that way earlier doesn't get a token either, not even a fresh one.
        let record = AccountRecord {
            id: "m".into(),
            name: "Work".into(),
            email: "alex@example.org".into(),
            display_name: "Alex".into(),
            color: AccountColor::Sky,
            auth: AuthKind::Microsoft,
            username: "alex@example.org".into(),
            imap: lookalike,
            smtp: microsoft_smtp,
            protocol: Protocol::Imap,
            jmap_url: None,
        };
        engine.inner.store.insert_account(&record).unwrap();
        secrets.set("m", &Secret::OAuth { refresh_token: "r".into() }).unwrap();
        engine
            .inner
            .tokens
            .lock()
            .await
            .insert("m".into(), ("cached".into(), Instant::now() + Duration::from_secs(3600)));
        let error = engine.inner.credential(&record).await.err().unwrap();
        assert_eq!(error.code, crate::error::ErrorCode::InvalidInput, "{error:?}");
    }

    #[test]
    fn blocks_addresses_and_whole_domains() {
        let blocked = vec!["spam@shop.example".to_string(), "@werbung.example".to_string()];
        assert!(is_blocked(&blocked, "Spam@Shop.example"));
        assert!(!is_blocked(&blocked, "hilfe@shop.example"));
        assert!(is_blocked(&blocked, "news@werbung.example"));
        assert!(is_blocked(&blocked, "news@mail.werbung.example"), "subdomains too");
        assert!(!is_blocked(&blocked, "leni@keinewerbung.example"));
    }
}
