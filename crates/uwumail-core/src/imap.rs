//! IMAP connections, folder discovery and incremental sync.

use std::collections::{HashMap, HashSet};
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;

use async_imap::types::{Fetch, Flag, NameAttribute};
use async_imap::{Authenticator, Client, Session};
use futures::TryStreamExt;
use rustls::ClientConfig;
use rustls::pki_types::ServerName;
use rustls_platform_verifier::BuilderVerifierExt;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use crate::error::{Error, Result};
use crate::mime;
use crate::model::{FolderRole, MessageFlags, Security, ServerSettings};
use crate::store::{FolderRecord, Store};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Newest messages fetched when a folder syncs for the first time.
pub const INITIAL_WINDOW: u32 = 400;
/// Messages larger than this are synced headers-only; the body loads on open.
const FULL_FETCH_LIMIT: u32 = 2 * 1024 * 1024;
const FETCH_BATCH: usize = 50;
const HEADER_QUERY: &str = "(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER])";
/// The start of the text, enough for a preview.
const PREVIEW_QUERY: &str = "(UID BODY.PEEK[TEXT]<0.4096>)";
/// Server search looks at this many of the newest matches per folder.
const SEARCH_LIMIT: usize = 200;

/// A plain or TLS connection, so one session type covers every security mode.
pub enum MailStream {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

impl std::fmt::Debug for MailStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Plain(_) => "MailStream::Plain",
            Self::Tls(_) => "MailStream::Tls",
        })
    }
}

impl AsyncRead for MailStream {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for MailStream {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_flush(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
        }
    }
}

pub type ImapSession = Session<MailStream>;

/// Credentials for one login.
pub enum Login<'a> {
    Password { username: &'a str, password: &'a str },
    OAuth { username: &'a str, access_token: &'a str },
}

struct XOAuth2(String);

impl Authenticator for XOAuth2 {
    type Response = String;

    fn process(&mut self, _challenge: &[u8]) -> Self::Response {
        // A second challenge means the server rejected the token; an empty
        // answer ends the exchange so the server reports the failure.
        std::mem::take(&mut self.0)
    }
}

pub fn install_crypto_provider() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

fn tls_connector() -> Result<TlsConnector> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    if let Some(config) = CONFIG.get() {
        return Ok(TlsConnector::from(config.clone()));
    }
    install_crypto_provider();
    let config = ClientConfig::builder()
        .with_platform_verifier()
        .map_err(|e| Error::internal(format!("TLS setup failed: {e}")))?
        .with_no_client_auth();
    Ok(TlsConnector::from(CONFIG.get_or_init(|| Arc::new(config)).clone()))
}

async fn tls(stream: TcpStream, host: &str) -> Result<MailStream> {
    let name =
        ServerName::try_from(host.to_string()).map_err(|_| Error::invalid(format!("Invalid server name {host}")))?;
    let stream = timeout(CONNECT_TIMEOUT, tls_connector()?.connect(name, stream))
        .await
        .map_err(|_| Error::connection(format!("{host} didn't finish the secure handshake.")))?
        .map_err(|e| Error::connection(format!("Secure connection to {host} failed: {e}")))?;
    Ok(MailStream::Tls(Box::new(stream)))
}

async fn greeting(client: &mut Client<MailStream>, host: &str) -> Result<()> {
    match timeout(CONNECT_TIMEOUT, client.read_response()).await {
        Ok(Ok(Some(_))) => Ok(()),
        _ => Err(Error::connection(format!("{host} didn't greet us like an IMAP server."))),
    }
}

pub async fn connect(settings: &ServerSettings) -> Result<Client<MailStream>> {
    let host = settings.host.as_str();
    let tcp = timeout(CONNECT_TIMEOUT, TcpStream::connect((host, settings.port)))
        .await
        .map_err(|_| Error::connection(format!("{host} didn't answer.")))?
        .map_err(|e| Error::connection(format!("Couldn't connect to {host}:{}: {e}", settings.port)))?;
    match settings.security {
        Security::Tls => {
            let mut client = Client::new(tls(tcp, host).await?);
            greeting(&mut client, host).await?;
            Ok(client)
        }
        Security::Starttls => {
            let mut client = Client::new(MailStream::Plain(tcp));
            greeting(&mut client, host).await?;
            client
                .run_command_and_check_ok("STARTTLS", None)
                .await
                .map_err(|_| Error::connection(format!("{host} doesn't support STARTTLS.")))?;
            let MailStream::Plain(tcp) = client.into_inner() else { unreachable!() };
            Ok(Client::new(tls(tcp, host).await?))
        }
        Security::None => {
            let mut client = Client::new(MailStream::Plain(tcp));
            greeting(&mut client, host).await?;
            Ok(client)
        }
    }
}

pub async fn login(settings: &ServerSettings, credentials: Login<'_>) -> Result<ImapSession> {
    let client = connect(settings).await?;
    let result = match credentials {
        Login::Password { username, password } => client.login(username, password).await,
        Login::OAuth { username, access_token } => {
            client.authenticate("XOAUTH2", XOAuth2(crate::oauth::xoauth2(username, access_token))).await
        }
    };
    result.map_err(|(error, _)| match error {
        async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_) => {
            Error::auth("The server rejected the username or password.")
        }
        other => other.into(),
    })
}

// ------------------------------------------------------------------- folders

#[derive(Debug, Clone)]
pub struct RemoteFolder {
    pub path: String,
    pub name: String,
    pub role: Option<FolderRole>,
    pub delimiter: Option<String>,
    /// False for containers that can hold folders but no messages.
    pub selectable: bool,
    /// Gmail's "All Mail" and similar virtual folders duplicate everything.
    pub skip_sync: bool,
}

impl RemoteFolder {
    /// Top level, or directly below INBOX: the only places where a folder
    /// called "Archiv" or "Spam" really is the system folder.
    fn is_near_root(&self) -> bool {
        let Some(delimiter) = self.delimiter.as_deref().filter(|d| !d.is_empty()) else { return true };
        let relative = match self.path.get(..5) {
            Some(head) if head.eq_ignore_ascii_case("INBOX") && self.path[5..].starts_with(delimiter) => {
                &self.path[5 + delimiter.len()..]
            }
            _ => self.path.as_str(),
        };
        !relative.contains(delimiter)
    }
}

fn role_from_name(path: &str, name: &str) -> Option<FolderRole> {
    if path.eq_ignore_ascii_case("INBOX") {
        return Some(FolderRole::Inbox);
    }
    let name = name.to_lowercase();
    let is = |candidates: &[&str]| candidates.contains(&name.as_str());
    if is(&["sent", "sent items", "sent messages", "sent mail", "gesendet", "gesendete objekte", "gesendete elemente"])
    {
        Some(FolderRole::Sent)
    } else if is(&["drafts", "draft", "entwürfe", "entwurf"]) {
        Some(FolderRole::Drafts)
    } else if is(&[
        "trash",
        "deleted",
        "deleted items",
        "deleted messages",
        "bin",
        "papierkorb",
        "gelöschte elemente",
        "gelöschte objekte",
    ]) {
        Some(FolderRole::Trash)
    } else if is(&["junk", "spam", "junk e-mail", "junk-e-mail", "junk email", "bulk mail"]) {
        Some(FolderRole::Junk)
    } else if is(&["archive", "archives", "archiv", "all mail"]) {
        Some(FolderRole::Archive)
    } else {
        None
    }
}

pub async fn list_folders(session: &mut ImapSession) -> Result<Vec<RemoteFolder>> {
    let names: Vec<_> = session.list(Some(""), Some("*")).await?.try_collect().await?;
    let mut folders = Vec::new();
    let mut special_roles = Vec::new();
    for name in &names {
        let attributes = name.attributes();
        let selectable = !attributes.iter().any(|a| {
            matches!(a, NameAttribute::NoSelect)
                || matches!(a, NameAttribute::Extension(ext) if ext.eq_ignore_ascii_case("\\NonExistent"))
        });
        let path = name.name().to_string();
        let display = decode_modified_utf7(match name.delimiter() {
            Some(delimiter) if !delimiter.is_empty() => path.rsplit(delimiter).next().unwrap_or(&path),
            _ => &path,
        });
        let special = if path.eq_ignore_ascii_case("INBOX") {
            Some(FolderRole::Inbox)
        } else {
            attributes.iter().find_map(|a| match a {
                NameAttribute::Sent => Some(FolderRole::Sent),
                NameAttribute::Drafts => Some(FolderRole::Drafts),
                NameAttribute::Trash => Some(FolderRole::Trash),
                NameAttribute::Junk => Some(FolderRole::Junk),
                NameAttribute::Archive => Some(FolderRole::Archive),
                _ => None,
            })
        };
        let is_all = attributes.iter().any(|a| matches!(a, NameAttribute::All | NameAttribute::Flagged));
        special_roles.push(if selectable { special } else { None });
        folders.push(RemoteFolder {
            name: display,
            path,
            role: None,
            delimiter: name.delimiter().map(String::from),
            selectable,
            skip_sync: is_all,
        });
    }

    // Special-use flags from the server win over guesses from folder names.
    let mut taken = HashSet::new();
    for (folder, special) in folders.iter_mut().zip(&special_roles) {
        if let Some(role) = special.filter(|r| taken.insert(*r)) {
            folder.role = Some(role);
        }
    }
    for folder in folders.iter_mut().filter(|f| f.role.is_none() && !f.skip_sync && f.selectable) {
        if folder.is_near_root() {
            folder.role = role_from_name(&folder.path, &folder.name).filter(|r| taken.insert(*r));
        }
    }
    for folder in folders.iter_mut().filter(|f| f.role == Some(FolderRole::Inbox)) {
        folder.name = "Inbox".into();
    }
    Ok(folders)
}

/// Decodes IMAP's modified UTF-7 folder names (RFC 3501 5.1.3), e.g. `Entw&APw-rfe` → `Entwürfe`.
pub fn decode_modified_utf7(input: &str) -> String {
    use base64::Engine as _;
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('-') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let encoded = &after[..end];
        if encoded.is_empty() {
            out.push('&');
        } else {
            let standard = encoded.replace(',', "/");
            let decoded =
                base64::engine::general_purpose::STANDARD_NO_PAD.decode(standard.as_bytes()).unwrap_or_default();
            let units: Vec<u16> = decoded.as_chunks::<2>().0.iter().map(|pair| u16::from_be_bytes(*pair)).collect();
            out.push_str(&String::from_utf16_lossy(&units));
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------------- sync

pub fn flags_of(fetch: &Fetch) -> MessageFlags {
    let mut flags = MessageFlags::default();
    for flag in fetch.flags() {
        match flag {
            Flag::Seen => flags.seen = true,
            Flag::Flagged => flags.flagged = true,
            Flag::Answered => flags.answered = true,
            Flag::Draft => flags.draft = true,
            _ => {}
        }
    }
    flags
}

fn uid_set(uids: &[u32]) -> String {
    uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",")
}

#[derive(Debug, Default)]
pub struct FolderSync {
    pub new_message_ids: Vec<String>,
    pub changed: bool,
    /// False on the very first sync of a folder, so an initial import doesn't ring.
    pub had_messages: bool,
}

/// Accounts whose server sent a partial fetch we couldn't read (GreenMail
/// leaves out a space there). They get no previews for header-only mail.
static NO_PREVIEWS: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// Stores messages by their headers, then adds a preview from the start of
/// their text where the server allows. The full body loads when one is
/// opened. Returns (uid, local id) of the messages that were new.
async fn store_headers(
    session: &mut ImapSession,
    store: &Store,
    folder: &FolderRecord,
    uids: &[u32],
) -> Result<Vec<(u32, String)>> {
    let mut added = Vec::new();
    let mut headers = HashMap::new();
    for chunk in uids.chunks(FETCH_BATCH) {
        let fetches: Vec<Fetch> = session.uid_fetch(uid_set(chunk), HEADER_QUERY).await?.try_collect().await?;
        for fetch in fetches {
            let (Some(uid), Some(header)) = (fetch.uid, fetch.header()) else { continue };
            let size = u64::from(fetch.size.unwrap_or(0));
            let date = fetch.internal_date().map(|d| d.timestamp());
            let parsed = mime::parse(header);
            if let Some(id) =
                store.insert_message(&folder.account_id, &folder.id, uid, flags_of(&fetch), size, date, &parsed)?
            {
                headers.insert(uid, header.to_vec());
                added.push((uid, id));
            }
        }
    }

    if added.is_empty() || NO_PREVIEWS.lock().unwrap().contains(&folder.account_id) {
        return Ok(added);
    }
    let ids: HashMap<u32, &String> = added.iter().map(|(uid, id)| (*uid, id)).collect();
    let new_uids: Vec<u32> = added.iter().map(|(uid, _)| *uid).collect();
    for chunk in new_uids.chunks(FETCH_BATCH) {
        let fetches = match session.uid_fetch(uid_set(chunk), PREVIEW_QUERY).await {
            Ok(stream) => stream.try_collect::<Vec<Fetch>>().await,
            Err(error) => Err(error),
        };
        let fetches = match fetches {
            Ok(fetches) => fetches,
            Err(error) => {
                // The connection may be broken now; the next sync reconnects and skips previews.
                NO_PREVIEWS.lock().unwrap().insert(folder.account_id.clone());
                return Err(error.into());
            }
        };
        for fetch in fetches {
            let (Some(uid), Some(text)) = (fetch.uid, fetch.text()) else { continue };
            let (Some(header), Some(id)) = (headers.get(&uid), ids.get(&uid)) else { continue };
            let snippet = mime::parse(&[header.as_slice(), text].concat()).snippet;
            store.set_snippet(id, &snippet)?;
        }
    }
    Ok(added)
}

/// Brings one folder of the local store up to date. Messages received before
/// `full_after` (Unix seconds) are stored as previews, like large ones.
pub async fn sync_folder(
    session: &mut ImapSession,
    store: &Store,
    folder: &FolderRecord,
    full_after: Option<i64>,
) -> Result<FolderSync> {
    let mailbox = session.select(&folder.path).await?;
    let validity = mailbox.uid_validity.unwrap_or(0);
    let mut result = FolderSync::default();

    if folder.uid_validity.is_some_and(|known| known != validity) {
        store.clear_folder(&folder.id)?;
        result.changed = true;
    }
    let max_uid = store.max_uid(&folder.id)?;
    result.had_messages = max_uid > 0;

    if mailbox.exists > 0 {
        // Step 1: which new messages exist and how big are they?
        let query = "(UID FLAGS RFC822.SIZE INTERNALDATE)";
        let listing: Vec<Fetch> = if max_uid == 0 {
            let start = mailbox.exists.saturating_sub(INITIAL_WINDOW - 1).max(1);
            session.fetch(format!("{start}:*"), query).await?.try_collect().await?
        } else {
            session.uid_fetch(format!("{}:*", max_uid + 1), query).await?.try_collect().await?
        };
        let mut small = Vec::new();
        let mut large = Vec::new();
        for fetch in listing.iter().filter(|f| f.uid.is_some_and(|uid| uid > max_uid)) {
            let uid = fetch.uid.unwrap_or_default();
            let old = full_after.zip(fetch.internal_date()).is_some_and(|(cutoff, date)| date.timestamp() < cutoff);
            if fetch.size.unwrap_or(0) <= FULL_FETCH_LIMIT && !old { small.push(uid) } else { large.push(uid) }
        }

        // Step 2: download, newest first so the inbox fills from the top.
        small.sort_unstable_by(|a, b| b.cmp(a));
        large.sort_unstable_by(|a, b| b.cmp(a));
        for chunk in small.chunks(FETCH_BATCH) {
            let query = "(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[])";
            let fetches: Vec<Fetch> = session.uid_fetch(uid_set(chunk), query).await?.try_collect().await?;
            for fetch in fetches {
                let (Some(uid), Some(raw)) = (fetch.uid, fetch.body()) else { continue };
                let inserted = store.insert_message(
                    &folder.account_id,
                    &folder.id,
                    uid,
                    flags_of(&fetch),
                    u64::from(fetch.size.unwrap_or(0)),
                    fetch.internal_date().map(|d| d.timestamp()),
                    &mime::parse(raw),
                )?;
                if let Some(id) = inserted {
                    result.new_message_ids.push(id);
                    result.changed = true;
                }
            }
        }
        for (_, id) in store_headers(session, store, folder, &large).await? {
            result.new_message_ids.push(id);
            result.changed = true;
        }
    }

    // Step 3: flag changes and deletions of what we already had.
    if max_uid > 0 {
        let current: HashMap<u32, MessageFlags> = if mailbox.exists == 0 {
            HashMap::new()
        } else {
            session
                .uid_fetch(format!("1:{max_uid}"), "(UID FLAGS)")
                .await?
                .try_collect::<Vec<Fetch>>()
                .await?
                .iter()
                .filter_map(|fetch| fetch.uid.map(|uid| (uid, flags_of(fetch))))
                .collect()
        };
        let mut gone = Vec::new();
        for stored in store.stored_flags(&folder.id)? {
            if stored.uid > max_uid {
                continue;
            }
            match current.get(&stored.uid) {
                Some(flags) if *flags != stored.flags => {
                    result.changed |= store.update_flags(&folder.id, stored.uid, *flags)?;
                }
                Some(_) => {}
                None => gone.push(stored.uid),
            }
        }
        if store.delete_uids(&folder.id, &gone)? > 0 {
            result.changed = true;
        }
    }

    store.set_folder_state(&folder.id, validity, mailbox.uid_next)?;
    Ok(result)
}

/// An IMAP quoted string.
fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Asks the server for messages in a folder that contain `text` anywhere,
/// including mail UwUMail never downloaded; those are stored as previews.
/// Returns the local ids of the matches, newest first.
pub async fn search_folder(
    session: &mut ImapSession,
    store: &Store,
    folder: &FolderRecord,
    text: &str,
) -> Result<Vec<String>> {
    session.select(&folder.path).await?;
    let criteria = format!("TEXT {}", quoted(text));
    let found = match session.uid_search(format!("CHARSET UTF-8 {criteria}")).await {
        Ok(found) => found,
        // Servers that only search in US-ASCII refuse the charset.
        Err(async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_)) => {
            session.uid_search(&criteria).await?
        }
        Err(error) => return Err(error.into()),
    };
    let mut uids: Vec<u32> = found.into_iter().collect();
    uids.sort_unstable_by(|a, b| b.cmp(a));
    uids.truncate(SEARCH_LIMIT);

    let mut known = store.ids_by_uid(&folder.id, &uids)?;
    let missing: Vec<u32> = uids.iter().copied().filter(|uid| !known.contains_key(uid)).collect();
    known.extend(store_headers(session, store, folder, &missing).await?);
    Ok(uids.into_iter().filter_map(|uid| known.remove(&uid)).collect())
}

/// Downloads the full message for something synced headers-only.
pub async fn fetch_body(session: &mut ImapSession, folder_path: &str, uid: u32) -> Result<Vec<u8>> {
    session.select(folder_path).await?;
    let fetches: Vec<Fetch> = session.uid_fetch(uid.to_string(), "(UID BODY.PEEK[])").await?.try_collect().await?;
    fetches
        .iter()
        .find_map(|f| f.body().map(<[u8]>::to_vec))
        .ok_or_else(|| Error::not_found("The server no longer has this message."))
}

pub async fn store_flags(session: &mut ImapSession, folder_path: &str, uids: &[u32], operation: &str) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    session.select(folder_path).await?;
    let _: Vec<Fetch> = session.uid_store(uid_set(uids), operation).await?.try_collect().await?;
    Ok(())
}

pub async fn move_messages(session: &mut ImapSession, from: &str, uids: &[u32], to: &str) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    let capabilities = session.capabilities().await?;
    session.select(from).await?;
    let set = uid_set(uids);
    if capabilities.has_str("MOVE") {
        session.uid_mv(&set, to).await?;
    } else {
        session.uid_copy(&set, to).await?;
        let _: Vec<Fetch> = session.uid_store(&set, "+FLAGS.SILENT (\\Deleted)").await?.try_collect().await?;
        if capabilities.has_str("UIDPLUS") {
            let _: Vec<u32> = session.uid_expunge(&set).await?.try_collect().await?;
        } else {
            let _: Vec<u32> = session.expunge().await?.try_collect().await?;
        }
    }
    Ok(())
}

pub async fn delete_permanently(session: &mut ImapSession, folder_path: &str, uids: &[u32]) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    let capabilities = session.capabilities().await?;
    session.select(folder_path).await?;
    let set = uid_set(uids);
    let _: Vec<Fetch> = session.uid_store(&set, "+FLAGS.SILENT (\\Deleted)").await?.try_collect().await?;
    if capabilities.has_str("UIDPLUS") {
        let _: Vec<u32> = session.uid_expunge(&set).await?.try_collect().await?;
    } else {
        let _: Vec<u32> = session.expunge().await?.try_collect().await?;
    }
    Ok(())
}

pub async fn append(session: &mut ImapSession, folder_path: &str, raw: &[u8], seen: bool) -> Result<()> {
    session.append(folder_path, seen.then_some("(\\Seen)"), None, raw).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_modified_utf7_folder_names() {
        assert_eq!(decode_modified_utf7("Entw&APw-rfe"), "Entwürfe");
        assert_eq!(decode_modified_utf7("Gel&APY-schte Elemente"), "Gelöschte Elemente");
        assert_eq!(decode_modified_utf7("Tom &- Jerry"), "Tom & Jerry");
        assert_eq!(decode_modified_utf7("INBOX"), "INBOX");
    }

    #[test]
    fn recognizes_common_folder_names() {
        assert_eq!(role_from_name("INBOX", "INBOX"), Some(FolderRole::Inbox));
        assert_eq!(role_from_name("Gesendete Elemente", "Gesendete Elemente"), Some(FolderRole::Sent));
        assert_eq!(role_from_name("INBOX.Spam", "Spam"), Some(FolderRole::Junk));
        assert_eq!(role_from_name("Rechnungen", "Rechnungen"), None);
    }
}
