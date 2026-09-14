//! The engine ties store, secrets, IMAP and SMTP together and runs one
//! background sync task per account.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{Mutex as AsyncMutex, Notify, OwnedMutexGuard, broadcast};
use tokio::task::JoinHandle;

use crate::attachments::{self, AttachmentCache, AttachmentFile};
use crate::error::{Error, ErrorCode, Result};
use crate::imap::{self, ImapSession, Login};
use crate::model::*;
use crate::secrets::{Secret, SecretStore};
use crate::smtp::{self, SmtpAuth, Threading};
use crate::store::{AccountRecord, FolderInfo, FolderRecord, MessageLocation, Store};
use crate::{autoconfig, mime, oauth};

const FULL_SYNC_EVERY: Duration = Duration::from_secs(5 * 60);
const IDLE_TIMEOUT: Duration = Duration::from_secs(20 * 60);

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

impl Engine {
    /// Must be called inside a Tokio runtime.
    pub fn new(options: EngineOptions) -> Result<Self> {
        imap::install_crypto_provider();
        std::fs::create_dir_all(&options.data_dir)
            .map_err(|e| Error::internal(format!("Couldn't create the data folder: {e}")))?;
        let store = Store::open(&options.data_dir.join("uwumail.db"))?;
        let http = reqwest::Client::builder()
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
            }),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        self.inner.events.subscribe()
    }

    /// Starts background sync for every saved account.
    pub fn start(&self) -> Result<()> {
        for account in self.inner.store.accounts()? {
            self.inner.spawn_sync(&account.id);
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
                Account {
                    id: record.id,
                    name: record.name,
                    email: record.email,
                    display_name: record.display_name,
                    color: record.color,
                    auth: record.auth,
                    status,
                }
            })
            .collect())
    }

    pub async fn discover_settings(&self, email: &str) -> Result<DiscoveredSettings> {
        autoconfig::discover(&self.inner.http, email).await
    }

    pub async fn add_account(&self, new: NewAccount) -> Result<Account> {
        let (_, domain) = autoconfig::split_email(&new.email)?;
        if new.imap.host.trim().is_empty() || new.smtp.host.trim().is_empty() {
            return Err(Error::invalid("Server addresses are missing."));
        }
        if self.inner.store.accounts()?.iter().any(|a| a.email.eq_ignore_ascii_case(new.email.trim())) {
            return Err(Error::invalid("This mailbox is already in UwUMail."));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let record = AccountRecord {
            id: id.clone(),
            name: domain,
            email: new.email.trim().to_string(),
            display_name: new.display_name.trim().to_string(),
            color: new.color,
            auth: new.auth,
            username: new.username.trim().to_string(),
            imap: new.imap.clone(),
            smtp: new.smtp.clone(),
        };

        let secret = match new.auth {
            AuthKind::Password => {
                let password = new
                    .password
                    .clone()
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| Error::invalid("Enter your password."))?;
                let mut session =
                    imap::login(&record.imap, Login::Password { username: &record.username, password: &password })
                        .await?;
                let _ = session.logout().await;
                Secret::Password { password }
            }
            AuthKind::Microsoft | AuthKind::Google => {
                let provider =
                    if new.auth == AuthKind::Microsoft { OAuthProvider::Microsoft } else { OAuthProvider::Google };
                let tokens =
                    oauth::sign_in(&self.inner.http, provider, &record.email, self.inner.open_url.as_ref()).await?;
                let refresh_token = tokens
                    .refresh_token
                    .clone()
                    .ok_or_else(|| Error::auth("The provider didn't allow offline access. Please try again."))?;
                let mut session = imap::login(
                    &record.imap,
                    Login::OAuth { username: &record.email, access_token: &tokens.access_token },
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
        self.inner.store.delete_account(account_id)?;
        self.inner.secrets.delete(account_id)?;
        self.inner.emit(EngineEvent::MailChanged { account_id: account_id.to_string() });
        Ok(())
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
            let Ok(uid) = u32::try_from(location.uid) else { continue };
            let raw = with_session!(self.inner, &location.account_id, |session| imap::fetch_body(
                session,
                &location.folder_path,
                uid
            ))?;
            self.inner.store.set_body(&location.id, &mime::parse(&raw))?;
        }
        self.inner.store.get_thread(thread_id, conversations)
    }

    pub async fn set_flags(&self, message_ids: &[String], change: FlagChange) -> Result<()> {
        let locations = self.inner.store.locations(message_ids)?;
        self.inner.store.apply_flag_change(message_ids, change)?;
        self.inner.emit_changed(&locations);
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

    pub async fn archive(&self, message_ids: &[String]) -> Result<()> {
        self.move_to_role(message_ids, FolderRole::Archive).await
    }

    pub async fn trash(&self, message_ids: &[String]) -> Result<()> {
        self.move_to_role(message_ids, FolderRole::Trash).await
    }

    async fn move_to_role(&self, message_ids: &[String], role: FolderRole) -> Result<()> {
        let locations = self.inner.store.locations(message_ids)?;
        let mut by_account: HashMap<String, Vec<MessageLocation>> = HashMap::new();
        for location in &locations {
            by_account.entry(location.account_id.clone()).or_default().push(location.clone());
        }
        for (account_id, messages) in by_account {
            let target = self.inner.ensure_folder(&account_id, role).await?;
            let (already_there, to_move): (Vec<_>, Vec<_>) =
                messages.into_iter().partition(|m| m.folder_id == target.id);

            if role == FolderRole::Trash && !already_there.is_empty() {
                // Deleting from the trash deletes for real.
                let ids: Vec<String> = already_there.iter().map(|m| m.id.clone()).collect();
                self.inner.store.delete_messages(&ids)?;
                for ((account, path), uids) in group_by_folder(&already_there) {
                    with_session!(self.inner, &account, |session| imap::delete_permanently(session, &path, &uids))?;
                }
            }

            let ids: Vec<String> = to_move.iter().map(|m| m.id.clone()).collect();
            self.inner.store.move_local(&ids, &target.id)?;
            for ((account, path), uids) in group_by_folder(&to_move) {
                with_session!(self.inner, &account, |session| imap::move_messages(
                    session,
                    &path,
                    &uids,
                    &target.path
                ))?;
            }
            self.inner.wake(&account_id);
        }
        self.inner.emit_changed(&locations);
        Ok(())
    }

    pub async fn send(&self, outgoing: OutgoingMessage) -> Result<()> {
        let account = self.inner.store.account(&outgoing.account_id)?;
        let threading = match &outgoing.in_reply_to {
            Some(id) => self
                .inner
                .store
                .threading_headers(id)?
                .map(|(parent_message_id, references)| Threading { parent_message_id, references }),
            None => None,
        };
        let from = Address {
            name: Some(account.display_name.clone()).filter(|n| !n.is_empty()),
            email: account.email.clone(),
        };
        let message = smtp::build(
            &from,
            &outgoing.to,
            &outgoing.cc,
            &outgoing.bcc,
            &outgoing.subject,
            &outgoing.text,
            &outgoing.html,
            threading.as_ref(),
            &outgoing.attachments,
        )?;

        let auth = match self.inner.credential(&account).await? {
            Credential::Password(password) => SmtpAuth::Password(password),
            Credential::Token(token) => SmtpAuth::OAuth(token),
        };
        let username =
            if account.auth == AuthKind::Password { account.username.clone() } else { account.email.clone() };
        smtp::send(&account.smtp, &username, auth, &message).await?;

        // Gmail and Microsoft file sent mail themselves.
        let provider_saves_sent = account.auth != AuthKind::Password
            || ["gmail.com", "googlemail.com", "office365.com", "outlook.com"]
                .iter()
                .any(|h| account.smtp.host.ends_with(h));
        if !provider_saves_sent && let Some(sent) = self.inner.store.folder_by_role(&account.id, FolderRole::Sent)? {
            let raw = message.formatted();
            if let Err(error) =
                with_session!(self.inner, &account.id, |session| imap::append(session, &sent.path, &raw, true))
            {
                tracing::warn!("Couldn't store the sent message: {error}");
            }
        }

        if let Some(original) = &outgoing.in_reply_to {
            let locations = self.inner.store.locations(std::slice::from_ref(original))?;
            for ((account_id, path), uids) in group_by_folder(&locations) {
                let _ = with_session!(self.inner, &account_id, |session| imap::store_flags(
                    session,
                    &path,
                    &uids,
                    "+FLAGS.SILENT (\\Answered)"
                ));
            }
        }

        let recipients: Vec<Address> = outgoing.to.iter().chain(&outgoing.cc).chain(&outgoing.bcc).cloned().collect();
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
            return Ok(AttachmentFile {
                path,
                filename: known.filename.clone(),
                mime_type: known.mime_type.clone(),
                size: known.size,
                dangerous: attachments::is_dangerous(&known.filename),
            });
        }
        let location = self
            .inner
            .store
            .locations(std::slice::from_ref(&message_id))?
            .pop()
            .ok_or_else(|| Error::not_found("This message no longer exists."))?;
        let uid = u32::try_from(location.uid)
            .ok()
            .filter(|uid| *uid > 0)
            .ok_or_else(|| Error::connection("The message is still being moved. Try again in a moment."))?;
        let raw = with_session!(self.inner, &location.account_id, |session| imap::fetch_body(
            session,
            &location.folder_path,
            uid
        ))?;
        self.inner.attachments.store_from_raw(&message_id, index, &raw)
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

    /// Messages by id, e.g. to describe new mail in a notification.
    pub fn messages(&self, message_ids: &[String]) -> Result<Vec<Message>> {
        self.inner.store.messages_by_ids(message_ids)
    }

    pub fn search_contacts(&self, query: &str) -> Result<Vec<Contact>> {
        let own: Vec<String> = self.inner.store.accounts()?.into_iter().map(|a| a.email).collect();
        self.inner.store.search_contacts(query, &own)
    }
}

fn group_by_folder(locations: &[MessageLocation]) -> HashMap<(String, String), Vec<u32>> {
    let mut groups: HashMap<(String, String), Vec<u32>> = HashMap::new();
    for location in locations {
        if let Ok(uid) = u32::try_from(location.uid)
            && uid > 0
        {
            groups.entry((location.account_id.clone(), location.folder_path.clone())).or_default().push(uid);
        }
    }
    groups
}

impl Inner {
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
                let mut tokens = self.tokens.lock().await;
                if let Some((token, expires)) = tokens.get(&account.id)
                    && *expires > Instant::now() + Duration::from_secs(60)
                {
                    return Ok(Credential::Token(token.clone()));
                }
                let provider =
                    if account.auth == AuthKind::Microsoft { OAuthProvider::Microsoft } else { OAuthProvider::Google };
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
                imap::login(&account.imap, Login::OAuth { username: &account.email, access_token: &token }).await
            }
        }
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
        let namespace = existing.iter().find_map(|f| f.delimiter.clone()).filter(|delimiter| {
            let others: Vec<_> = existing.iter().filter(|f| !f.path.eq_ignore_ascii_case("INBOX")).collect();
            !others.is_empty() && others.iter().all(|f| f.path.starts_with(&format!("INBOX{delimiter}")))
        });
        let path = match &namespace {
            Some(delimiter) => format!("INBOX{delimiter}{name}"),
            None => name.to_string(),
        };
        with_session!(self, account_id, |session| async { session.create(&path).await.map_err(Error::from) })
            .or_else(|error| if error.message.to_lowercase().contains("exist") { Ok(()) } else { Err(error) })?;
        let id = self.store.upsert_folder(
            account_id,
            &FolderInfo { path: &path, name, role: Some(role), delimiter: namespace.as_deref(), selectable: true },
        )?;
        self.store.folder(&id)
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
                },
            )?;
            paths.insert(folder.path.clone());
        }
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
        let result = imap::sync_folder(session, &self.store, folder).await?;
        if folder.role == Some(FolderRole::Inbox) && result.had_messages && !result.new_message_ids.is_empty() {
            let unseen: Vec<String> = self
                .store
                .messages_by_ids(&result.new_message_ids)?
                .into_iter()
                .filter(|m| !m.flags.seen)
                .map(|m| m.id)
                .collect();
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

async fn run_account(inner: &Inner, account_id: &str, wake: &Notify) -> Result<()> {
    let Ok(account) = inner.store.account(account_id) else { return Ok(()) };
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
