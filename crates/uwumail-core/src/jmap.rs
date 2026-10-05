//! JMAP (RFC 8620 core, RFC 8621 mail): finding the server, signing in,
//! method calls, blobs and push over EventSource.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{Map, Value, json};
use tokio::time::timeout;
use url::Url;

use crate::error::{Error, ErrorCode, Result};
use crate::mail_images::RemoteImageSize;

pub const CORE: &str = "urn:ietf:params:jmap:core";
pub const MAIL: &str = "urn:ietf:params:jmap:mail";
pub const SUBMISSION: &str = "urn:ietf:params:jmap:submission";
/// A UwUMail server's allowed and blocked senders (UwUMail-Server docs/jmap-senders.md).
pub const SENDERS: &str = "urn:uwumail:jmap:senders";
/// A UwUMail server's settings document shared by the webmail and the apps (UwUMail-Server docs/jmap-settings.md).
pub const SETTINGS: &str = "urn:uwumail:jmap:settings";
/// Sieve scripts (RFC 9661): mail rules on a UwUMail server.
pub const SIEVE: &str = "urn:ietf:params:jmap:sieve";
/// Calendars and events (draft-ietf-jmap-calendars).
pub const CALENDARS: &str = "urn:ietf:params:jmap:calendars";
/// A UwUMail server that fetches a mail's remote pictures and sender logos for its readers
/// (UwUMail-Server docs/jmap-remote.md), so their senders never see who reads.
pub const REMOTE: &str = "urn:uwumail:jmap:remote";
/// Address books and contact cards (RFC 9610).
pub const CONTACTS: &str = "urn:ietf:params:jmap:contacts";
/// A UwUMail server that reads the text in a mail's pictures (UwUMail-Server docs/jmap-image-text.md).
pub const IMAGETEXT: &str = "urn:uwumail:jmap:imagetext";
/// Our own: birthday events of other calendars moved into the contacts (`Birthdays/scan`,
/// `Birthdays/import`), from UwUMail-Server 0.18 on. Its birthdays calendar comes with it.
pub const BIRTHDAYS: &str = "urn:uwumail:jmap:birthdays";
/// The key a server signs its Web Push messages with (VAPID, RFC 9749).
/// UwUMail's AI assistant (the server's docs/jmap-assist.md).
pub const ASSIST: &str = "urn:uwumail:jmap:assist";
pub const WEBPUSH_VAPID: &str = "urn:ietf:params:jmap:webpush-vapid";
/// Signatures per domain and company signatures (`SignatureSettings/get`/`set`, UwUMail-Server
/// docs/jmap-signatures.md), from UwUMail-Server 0.22 on.
pub const SIGNATURES: &str = "urn:uwumail:jmap:signatures";
/// Masked addresses (Fastmail's MaskedEmail extension, which UwUMail Server speaks; its
/// docs/jmap-masked-email.md).
pub const MASKED: &str = "https://www.fastmail.com/dev/maskedemail";
/// The own profile picture on a UwUMail server (`ProfilePicture`, its docs/profile-pictures.md).
pub const PROFILE: &str = "urn:uwumail:jmap:profile";
/// The people of the server, to share calendars with (draft-ietf-jmap-sharing).
pub const PRINCIPALS: &str = "urn:ietf:params:jmap:principals";

const PROBE_TIMEOUT: Duration = Duration::from_secs(6);
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// The server tells picture sizes as it fetches the pictures; the reader stops waiting sooner.
const SIZES_TIMEOUT: Duration = Duration::from_secs(30);
/// The most addresses one picture sizes request may ask about; the server refuses more.
pub const MAX_SIZE_URLS: usize = 200;
/// The longest line of the picture sizes answer taken.
const MAX_SIZE_LINE: usize = 16 * 1024;
const BLOB_TIMEOUT: Duration = Duration::from_secs(300);
/// The largest API answer taken; read in pieces, so a server can't fill the memory (audit C-14).
const MAX_ANSWER: usize = 64 * 1024 * 1024;
/// The largest session resource or discovery answer taken.
const MAX_SESSION: usize = 4 * 1024 * 1024;
/// The largest blob downloaded, e.g. a whole message with its attachments.
pub const MAX_BLOB: usize = 256 * 1024 * 1024;
/// The largest picture a server fetched for us, as for pictures fetched here (audit EG-3).
const MAX_PICTURE: usize = 10 * 1024 * 1024;
/// Of an error answer, only the start is read.
const MAX_ERROR_TEXT: usize = 16 * 1024;
/// An EventSource connection lives this long before it's opened again.
const PUSH_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);
const PUSH_PING_SECONDS: u64 = 60;
/// Without even a ping for this long, the push connection is considered dead.
const PUSH_SILENCE: Duration = Duration::from_secs(3 * PUSH_PING_SECONDS);

/// Providers that offer JMAP but don't announce it where RFC 8620 looks.
const KNOWN_SESSIONS: &[(&str, &str)] = &[
    ("fastmail.com", "https://api.fastmail.com/jmap/session"),
    ("fastmail.fm", "https://api.fastmail.com/jmap/session"),
    ("messagingengine.com", "https://api.fastmail.com/jmap/session"),
];

#[derive(Debug, Clone)]
pub enum Auth {
    Basic {
        username: String,
        password: String,
    },
    /// API tokens, e.g. from Fastmail.
    Bearer {
        token: String,
    },
}

impl Auth {
    fn header(&self) -> String {
        match self {
            Self::Basic { username, password } => {
                let pair = base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
                format!("Basic {pair}")
            }
            Self::Bearer { token } => format!("Bearer {token}"),
        }
    }
}

/// What the session resource tells us, with every URL made absolute.
#[derive(Debug, Clone)]
pub struct Session {
    pub api_url: String,
    pub download_url: String,
    pub upload_url: String,
    pub event_source_url: Option<String>,
    pub account_id: String,
    pub submission_account_id: Option<String>,
    pub max_objects_in_get: usize,
    pub max_calls_in_request: usize,
    pub username: String,
    /// The server keeps a list of blocked senders for this login (a UwUMail server).
    pub sender_lists: bool,
    /// The server keeps this login's settings for all its devices (a UwUMail server).
    pub user_settings: bool,
    /// The account whose Sieve scripts (mail rules) this login may manage, if the server has them.
    pub sieve_account_id: Option<String>,
    /// The account whose calendars this login sees, if the server has JMAP calendars.
    pub calendar_account_id: Option<String>,
    /// Where the server fetches remote pictures (`{accountId}`, `{url}`) and sender pictures
    /// (`{accountId}`, `{email}`) for us, if it does.
    pub image_url: Option<String>,
    pub picture_url: Option<String>,
    /// Where the server tells the sizes of remote pictures before they load (`{accountId}`), if it does.
    pub image_sizes_url: Option<String>,
    /// The account whose address books this login sees, if the server has JMAP Contacts.
    pub contacts_account_id: Option<String>,
    /// The account whose birthdays the server moves out of calendars into contacts
    /// (`urn:uwumail:jmap:birthdays`); such a server also keeps the birthdays calendar and reminders.
    pub birthdays_account_id: Option<String>,
    /// The server's VAPID public key (base64url, uncompressed P-256), if it signs its Web Push
    /// messages (RFC 9749).
    pub vapid_key: Option<String>,
    /// The server reads the text in a mail's pictures (`Email/imageText`, a UwUMail server).
    pub image_text: bool,
    /// The account whose signatures per domain this login manages (`urn:uwumail:jmap:signatures`).
    pub signatures_account_id: Option<String>,
    /// The session's `state`: API answers carry it as `sessionState`, and a different one there
    /// means the session changed (RFC 8620 §2).
    pub state: Option<String>,
    /// The server's AI assistant for this login's own account, if it has one.
    pub assist: Option<AssistSession>,
    /// The own account's masked address capability (`domains`, `defaultDomain`), if the server
    /// makes masked addresses; an empty object from servers that don't say where.
    pub masked: Option<Value>,
    /// The own account's profile picture capability (`maxSize`, `mayBePublic`), if it has one.
    pub profile: Option<Value>,
    /// The server lists its people for sharing; `own_principal_id` is the login's own.
    pub principals: bool,
    pub own_principal_id: Option<String>,
}

/// What a session says about UwUMail's AI assistant.
#[derive(Debug, Clone)]
pub struct AssistSession {
    /// Where `Assist/compose` and `Assist/summarize` stream.
    pub stream_url: Option<String>,
    /// The own account's capability object: `features`, `mayAddProviders`, the limits.
    pub options: Value,
}

impl Session {
    pub fn parse(document: &Value, base: &Url) -> Result<Self> {
        let invalid = || Error::invalid("The server's JMAP session is incomplete.");
        let text = |key: &str| document.get(key).and_then(Value::as_str);
        let capabilities = document.get("capabilities").and_then(Value::as_object).ok_or_else(invalid)?;
        if !capabilities.contains_key(MAIL) {
            return Err(Error::not_supported("This server offers JMAP, but not for mail."));
        }
        let primary = document.get("primaryAccounts").and_then(Value::as_object);
        let account_id = primary
            .and_then(|p| p.get(MAIL))
            .and_then(Value::as_str)
            .ok_or_else(|| Error::not_supported("This JMAP login has no mail account."))?
            .to_string();
        let core = capabilities.get(CORE);
        // An extension's own primary account, or the mail account when the server names none.
        let extension_account = |capability: &str| {
            capabilities.contains_key(capability).then(|| {
                primary
                    .and_then(|p| p.get(capability))
                    .and_then(Value::as_str)
                    .map_or_else(|| account_id.clone(), String::from)
            })
        };
        let sieve_account_id = extension_account(SIEVE);
        let calendar_account_id = extension_account(CALENDARS);
        let remote = capabilities.get(REMOTE);
        let remote_url = |key: &str| remote.and_then(|r| r.get(key)).and_then(Value::as_str).map(|u| absolute(base, u));
        let contacts_account_id = extension_account(CONTACTS);
        let birthdays_account_id = extension_account(BIRTHDAYS);
        let signatures_account_id = extension_account(SIGNATURES);
        let limit = |key: &str, fallback: usize| {
            core.and_then(|c| c.get(key)).and_then(Value::as_u64).map_or(fallback, |n| n.clamp(1, 10_000) as usize)
        };
        let assist = capabilities.get(ASSIST).map(|capability| AssistSession {
            stream_url: capability.get("streamUrl").and_then(Value::as_str).map(|u| absolute(base, u)),
            options: document
                .get("accounts")
                .and_then(|accounts| accounts.get(&account_id))
                .and_then(|account| account.get("accountCapabilities"))
                .and_then(|capabilities| capabilities.get(ASSIST))
                .cloned()
                .unwrap_or(Value::Null),
        });
        // An extension's object in the own account's `accountCapabilities`; `{}` when the session
        // only names the capability.
        let own_capability = |capability: &str| {
            capabilities.contains_key(capability).then(|| {
                document
                    .get("accounts")
                    .and_then(|accounts| accounts.get(&account_id))
                    .and_then(|account| account.get("accountCapabilities"))
                    .and_then(|capabilities| capabilities.get(capability))
                    .filter(|value| value.is_object())
                    .or_else(|| capabilities.get(capability).filter(|value| value.is_object()))
                    .cloned()
                    .unwrap_or_else(|| json!({}))
            })
        };
        let masked = own_capability(MASKED);
        let profile = own_capability(PROFILE);
        let principals = own_capability(PRINCIPALS);
        let own_principal_id = principals
            .as_ref()
            .and_then(|capability| capability.get("currentUserPrincipalId"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 255)
            .map(String::from);
        Ok(Self {
            api_url: absolute(base, text("apiUrl").ok_or_else(invalid)?),
            download_url: absolute(base, text("downloadUrl").ok_or_else(invalid)?),
            upload_url: absolute(base, text("uploadUrl").ok_or_else(invalid)?),
            event_source_url: text("eventSourceUrl").filter(|u| !u.is_empty()).map(|u| absolute(base, u)),
            submission_account_id: capabilities
                .contains_key(SUBMISSION)
                .then(|| primary.and_then(|p| p.get(SUBMISSION)).and_then(Value::as_str).map(String::from))
                .flatten(),
            account_id,
            max_objects_in_get: limit("maxObjectsInGet", 500),
            max_calls_in_request: limit("maxCallsInRequest", 16),
            username: text("username").unwrap_or_default().to_string(),
            sender_lists: capabilities.contains_key(SENDERS),
            user_settings: capabilities.contains_key(SETTINGS),
            sieve_account_id,
            calendar_account_id,
            image_url: remote_url("imageUrl"),
            picture_url: remote_url("pictureUrl"),
            image_sizes_url: remote_url("imageSizesUrl"),
            contacts_account_id,
            birthdays_account_id,
            vapid_key: capabilities
                .get(WEBPUSH_VAPID)
                .and_then(|vapid| vapid.get("applicationServerKey"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .map(String::from),
            image_text: capabilities.contains_key(IMAGETEXT),
            signatures_account_id,
            state: text("state").map(String::from),
            assist,
            masked,
            profile,
            principals: principals.is_some(),
            own_principal_id,
        })
    }

    /// The same session with every URL moved from one origin to another.
    fn rebased(&self, from: &str, to: &str) -> Self {
        let move_url = |url: &str| match url.strip_prefix(from) {
            Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{to}{rest}"),
            _ => url.to_string(),
        };
        Self {
            api_url: move_url(&self.api_url),
            download_url: move_url(&self.download_url),
            upload_url: move_url(&self.upload_url),
            event_source_url: self.event_source_url.as_deref().map(move_url),
            image_url: self.image_url.as_deref().map(move_url),
            picture_url: self.picture_url.as_deref().map(move_url),
            image_sizes_url: self.image_sizes_url.as_deref().map(move_url),
            assist: self.assist.as_ref().map(|assist| AssistSession {
                stream_url: assist.stream_url.as_deref().map(move_url),
                options: assist.options.clone(),
            }),
            ..self.clone()
        }
    }
}

/// URL templates may be relative to the session resource. They contain
/// `{placeholders}`, so they're joined as text rather than with `Url::join`.
fn absolute(base: &Url, template: &str) -> String {
    if template.contains("://") {
        return template.to_string();
    }
    let origin = base.origin().ascii_serialization();
    if template.starts_with('/') {
        return format!("{origin}{template}");
    }
    let path = base.path();
    let directory = &path[..path.rfind('/').map_or(0, |i| i + 1)];
    format!("{origin}{directory}{template}")
}

fn origin_of(url: &str) -> Option<String> {
    Url::parse(url).ok().map(|u| u.origin().ascii_serialization())
}

/// Fills a URL template such as `{accountId}/{blobId}/{name}?type={type}`.
fn fill(template: &str, values: &[(&str, &str)]) -> String {
    const COMPONENT: &percent_encoding::AsciiSet =
        &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');
    let mut out = template.to_string();
    for (key, value) in values {
        out = out.replace(&format!("{{{key}}}"), &percent_encoding::utf8_percent_encode(value, COMPONENT).to_string());
    }
    out
}

/// A JMAP method error, e.g. `cannotCalculateChanges`.
#[derive(Debug, Clone)]
pub struct MethodError {
    pub kind: String,
    pub description: String,
}

impl From<MethodError> for Error {
    fn from(error: MethodError) -> Self {
        let message = if error.description.is_empty() {
            format!("The mail server refused the request ({}).", error.kind)
        } else {
            format!("The mail server refused the request ({}): {}", error.kind, error.description)
        };
        match error.kind.as_str() {
            "forbidden" | "accountNotFound" => Error::auth(message),
            "overQuota" | "tooLarge" | "invalidArguments" | "invalidProperties" => Error::invalid(message),
            _ => Error::internal(message),
        }
    }
}

/// Answers to one request, looked up by call id.
#[derive(Debug)]
pub struct Responses(Vec<(String, Value, String)>);

impl Responses {
    /// The whole arguments of an `error` answer to call `id`, for extra fields like `retryAfter`.
    pub fn error_arguments(&self, id: usize) -> Option<&Value> {
        let id = id.to_string();
        self.0.iter().find(|(name, _, call)| *call == id && name == "error").map(|(_, arguments, _)| arguments)
    }

    /// The arguments of the answer to call `id`. A call can have more than one
    /// answer (e.g. an implicit `Email/set`); this is the one named `method`.
    pub fn get(&self, id: usize, method: &str) -> std::result::Result<&Value, MethodError> {
        let id = id.to_string();
        for (name, arguments, call) in &self.0 {
            if *call != id {
                continue;
            }
            if name == "error" {
                return Err(MethodError {
                    kind: arguments.get("type").and_then(Value::as_str).unwrap_or("serverFail").to_string(),
                    description: arguments.get("description").and_then(Value::as_str).unwrap_or_default().to_string(),
                });
            }
            if name == method {
                return Ok(arguments);
            }
        }
        Err(MethodError { kind: "serverFail".into(), description: format!("No answer to {method}.") })
    }
}

/// Problems with individual objects in a `/set` answer (`notCreated`, `notUpdated`, `notDestroyed`).
pub fn set_errors(arguments: &Value) -> Option<MethodError> {
    ["notCreated", "notUpdated", "notDestroyed"].iter().find_map(|key| {
        let failures = arguments.get(*key)?.as_object()?;
        let (_, first) = failures.iter().next()?;
        Some(MethodError {
            kind: first.get("type").and_then(Value::as_str).unwrap_or("serverFail").to_string(),
            description: first.get("description").and_then(Value::as_str).unwrap_or_default().to_string(),
        })
    })
}

/// A signed-in JMAP connection. Cheap to share; requests run over HTTP/2 or keep-alive.
pub struct Client {
    http: reqwest::Client,
    auth: Auth,
    pub session: Session,
    /// The `sessionState` of the latest API answer.
    latest_session_state: std::sync::Mutex<Option<String>>,
}

impl Client {
    /// Signs in with a password, or with the password as an API token when the
    /// server doesn't accept it as a password.
    pub async fn connect(http: &reqwest::Client, session_url: &str, username: &str, password: &str) -> Result<Self> {
        let url = Url::parse(session_url.trim())
            .ok()
            .filter(|u| matches!(u.scheme(), "https" | "http"))
            .ok_or_else(|| Error::invalid("The JMAP address isn't a valid web address."))?;
        let basic = Auth::Basic { username: username.to_string(), password: password.to_string() };
        let (auth, (document, base)) = match fetch_session(http, &url, &basic).await {
            Err(error) if error.code == ErrorCode::AuthFailed => {
                let bearer = Auth::Bearer { token: password.to_string() };
                let found = fetch_session(http, &url, &bearer).await?;
                (bearer, found)
            }
            other => (basic, other?),
        };
        let session = checked_endpoints(Session::parse(&document, &base)?, &url, &base)?;
        let mut client = Self { http: http.clone(), auth, session, latest_session_state: Default::default() };

        // Self-hosted servers often announce a public name that isn't reachable
        // from here (a reverse proxy, a LAN address, a test setup). Fall back to
        // the address the user gave us, which evidently works.
        if let Err(error) = client.echo().await {
            let (Some(announced), Some(working)) = (origin_of(&client.session.api_url), origin_of(base.as_str()))
            else {
                return Err(error);
            };
            if error.code != ErrorCode::ConnectionFailed || announced == working {
                return Err(error);
            }
            client.session = client.session.rebased(&announced, &working);
            client.echo().await?;
        }
        Ok(client)
    }

    async fn echo(&self) -> Result<()> {
        self.call(vec![("Core/echo", json!({ "ping": true }))]).await?.get(0, "Core/echo")?;
        Ok(())
    }

    pub fn account_id(&self) -> &str {
        &self.session.account_id
    }

    /// The accounts of this login that UwUMail reads: mail, and calendars, contacts and rules
    /// where the server keeps those in other accounts.
    pub fn account_ids(&self) -> Vec<&str> {
        let session = &self.session;
        let mut ids = vec![session.account_id.as_str()];
        for id in [&session.calendar_account_id, &session.contacts_account_id, &session.sieve_account_id]
            .into_iter()
            .flatten()
        {
            if !ids.contains(&id.as_str()) {
                ids.push(id);
            }
        }
        ids
    }

    /// Whether an API answer named another session state than the session this client read, so
    /// the session (e.g. its push key) may have changed since.
    pub fn session_outdated(&self) -> bool {
        let latest = self.latest_session_state.lock().unwrap();
        matches!((latest.as_deref(), self.session.state.as_deref()), (Some(latest), Some(known)) if latest != known)
    }

    /// Sends method calls in one request. Call ids are their positions.
    pub async fn call(&self, calls: Vec<(&str, Value)>) -> Result<Responses> {
        self.call_within(calls, CALL_TIMEOUT).await
    }

    /// Like [`call`](Self::call), for methods the server may take longer for, e.g. reading pictures.
    pub async fn call_within(&self, calls: Vec<(&str, Value)>, limit: Duration) -> Result<Responses> {
        let method_calls: Vec<Value> = calls
            .into_iter()
            .enumerate()
            .map(|(index, (name, arguments))| json!([name, arguments, index.to_string()]))
            .collect();
        let mut using = vec![CORE, MAIL, SUBMISSION];
        // Servers refuse capabilities they don't know, so ours only goes to servers that offer it.
        if self.session.sender_lists {
            using.push(SENDERS);
        }
        if self.session.user_settings {
            using.push(SETTINGS);
        }
        if self.session.sieve_account_id.is_some() {
            using.push(SIEVE);
        }
        if self.session.calendar_account_id.is_some() {
            using.push(CALENDARS);
        }
        if self.session.contacts_account_id.is_some() {
            using.push(CONTACTS);
        }
        if self.session.image_text {
            using.push(IMAGETEXT);
        }
        if self.session.birthdays_account_id.is_some() {
            using.push(BIRTHDAYS);
        }
        if self.session.assist.is_some() {
            using.push(ASSIST);
        }
        if self.session.signatures_account_id.is_some() {
            using.push(SIGNATURES);
        }
        if self.session.masked.is_some() {
            using.push(MASKED);
        }
        if self.session.profile.is_some() {
            using.push(PROFILE);
        }
        if self.session.principals {
            using.push(PRINCIPALS);
        }
        let body = json!({ "using": using, "methodCalls": method_calls });
        let response = self
            .http
            .post(&self.session.api_url)
            .header(reqwest::header::AUTHORIZATION, self.auth.header())
            .timeout(limit)
            .json(&body)
            .send()
            .await?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(Error::auth("The mail server didn't accept the login anymore."));
        }
        if !status.is_success() {
            let detail = read_start(response, MAX_ERROR_TEXT).await;
            return Err(Error::connection(format!("The mail server answered {status}. {}", short(&detail))));
        }
        let body = read_limited(response, MAX_ANSWER).await?;
        let document: Value =
            serde_json::from_slice(&body).map_err(|e| Error::connection(format!("Bad JMAP answer: {e}")))?;
        if let Some(state) = document.get("sessionState").and_then(Value::as_str) {
            *self.latest_session_state.lock().unwrap() = Some(state.to_string());
        }
        let answers = document
            .get("methodResponses")
            .and_then(Value::as_array)
            .ok_or_else(|| Error::connection("The mail server's answer had no method responses."))?;
        Ok(Responses(
            answers
                .iter()
                .filter_map(|answer| {
                    let parts = answer.as_array()?;
                    Some((
                        parts.first()?.as_str()?.to_string(),
                        parts.get(1)?.clone(),
                        parts.get(2)?.as_str()?.to_string(),
                    ))
                })
                .collect(),
        ))
    }

    /// Posts a method to the assistant's stream endpoint with this login; the answer is
    /// `text/event-stream` (docs/jmap-assist.md "Streaming").
    pub async fn post_assist_stream(&self, url: &str, method: &str, arguments: Value) -> Result<reqwest::Response> {
        self.check_on_site(url)?;
        let body = json!({ "using": [CORE, ASSIST], "method": method, "arguments": arguments });
        let response = self
            .http
            .post(url)
            .header(reqwest::header::AUTHORIZATION, self.auth.header())
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .timeout(std::time::Duration::from_secs(200))
            .json(&body)
            .send()
            .await?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(Error::auth("The mail server didn't accept the login anymore."));
        }
        if status == reqwest::StatusCode::BAD_REQUEST {
            return Err(Error::assist("invalidArguments", "The server didn't take the request."));
        }
        if !status.is_success() {
            return Err(Error::connection(format!("The mail server answered {status}.")));
        }
        Ok(response)
    }

    /// Downloads a blob, e.g. a whole message.
    pub async fn download(&self, blob_id: &str, name: &str, mime_type: &str) -> Result<Vec<u8>> {
        self.download_for(&self.session.account_id, blob_id, name, mime_type).await
    }

    /// Downloads a blob of another account of the login, e.g. the one that keeps its Sieve scripts.
    pub async fn download_for(&self, account_id: &str, blob_id: &str, name: &str, mime_type: &str) -> Result<Vec<u8>> {
        self.download_within(account_id, blob_id, name, mime_type, MAX_BLOB).await
    }

    /// Like [`download_for`](Self::download_for), refused as soon as it grows beyond `limit` bytes.
    pub async fn download_within(
        &self,
        account_id: &str,
        blob_id: &str,
        name: &str,
        mime_type: &str,
        limit: usize,
    ) -> Result<Vec<u8>> {
        let url = fill(
            &self.session.download_url,
            &[("accountId", account_id), ("blobId", blob_id), ("name", name), ("type", mime_type)],
        );
        let response = self
            .http
            .get(url)
            .header(reqwest::header::AUTHORIZATION, self.auth.header())
            .timeout(BLOB_TIMEOUT)
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(Error::not_found("This message no longer exists on the server."));
        }
        if !response.status().is_success() {
            return Err(Error::connection(format!("Download failed with {}.", response.status())));
        }
        read_limited(response, limit).await
    }

    /// A mail's remote picture, fetched by the server so its sender never sees the reader: its type
    /// and bytes, `None` when the server can't do that or the picture isn't there.
    pub async fn remote_image(&self, url: &str) -> Result<Option<(String, Vec<u8>)>> {
        let Some(template) = &self.session.image_url else { return Ok(None) };
        let target = fill(template, &[("accountId", &self.session.account_id), ("url", url)]);
        let Some((_, bytes)) = self.get_from_server(&target).await? else { return Ok(None) };
        // The type comes from the bytes, never from the server: only pictures reach the reader (EG-2).
        let Some(media_type) = crate::mail_images::image_media_type(&bytes) else { return Ok(None) };
        Ok(Some((media_type.to_string(), bytes)))
    }

    /// The sizes of a mail's remote pictures, asked of the server before they load
    /// (`imageSizesUrl`): `on_size` gets each asked address once, as soon as the server knows it.
    /// At most [`MAX_SIZE_URLS`] addresses are asked; an error when the server can't be asked.
    pub async fn image_sizes(&self, urls: &[String], mut on_size: impl FnMut(RemoteImageSize)) -> Result<()> {
        let Some(template) = &self.session.image_sizes_url else {
            return Err(Error::not_supported("This server tells no picture sizes."));
        };
        let target = fill(template, &[("accountId", &self.session.account_id)]);
        let (Ok(api), Ok(to)) = (Url::parse(&self.session.api_url), Url::parse(&target)) else {
            return Err(Error::invalid("The server announced an address that is not one."));
        };
        if !may_send_credentials(&api, &to) {
            return Err(Error::invalid("The server announced an address on another site."));
        }
        let mut asked = Vec::new();
        for url in urls {
            if asked.len() == MAX_SIZE_URLS {
                break;
            }
            if !asked.contains(url) {
                asked.push(url.clone());
            }
        }
        if asked.is_empty() {
            return Ok(());
        }
        let mut response = self
            .http
            .post(to)
            .header(reqwest::header::AUTHORIZATION, self.auth.header())
            .header(reqwest::header::ACCEPT, "application/x-ndjson")
            .json(&json!({ "urls": asked }))
            .timeout(SIZES_TIMEOUT)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(Error::connection(format!("The picture sizes answered {}.", response.status())));
        }
        let mut lines = SizeLines::new(asked);
        while !lines.done() {
            let Some(chunk) = response.chunk().await? else { break };
            lines.feed(&chunk, &mut on_size)?;
        }
        Ok(())
    }

    /// The logo or website icon the server keeps for a company sender: whether it is a `logo` and its
    /// bytes. `Ok(None)` when the server has none; an error when it could not be asked.
    pub async fn sender_picture(&self, email: &str) -> Result<Option<(bool, Vec<u8>)>> {
        let Some(template) = &self.session.picture_url else {
            return Err(Error::not_supported("No sender pictures here."));
        };
        let target = fill(template, &[("accountId", &self.session.account_id), ("email", email)]);
        let Some((headers, bytes)) = self.get_from_server(&target).await? else { return Ok(None) };
        let logo = headers.get("x-picture-kind").is_some_and(|kind| kind.as_bytes() == b"logo");
        Ok(Some((logo, bytes)))
    }

    /// An authenticated GET on the server's own site, never elsewhere: `None` for a 404.
    async fn get_from_server(&self, target: &str) -> Result<Option<(reqwest::header::HeaderMap, Vec<u8>)>> {
        let to = self.check_on_site(target)?;
        let response = self
            .http
            .get(to)
            .header(reqwest::header::AUTHORIZATION, self.auth.header())
            .timeout(CALL_TIMEOUT)
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(Error::connection(format!("The server answered {}.", response.status())));
        }
        let headers = response.headers().clone();
        Ok(Some((headers, read_limited(response, MAX_PICTURE).await?)))
    }

    /// An address the server announced, if it is on the site of the API, where the login may go.
    fn check_on_site(&self, target: &str) -> Result<Url> {
        let (Ok(api), Ok(to)) = (Url::parse(&self.session.api_url), Url::parse(target)) else {
            return Err(Error::invalid("The server announced an address that is not one."));
        };
        if !may_send_credentials(&api, &to) {
            return Err(Error::invalid("The server announced an address on another site."));
        }
        Ok(to)
    }

    /// Uploads data and returns its blob id.
    pub async fn upload(&self, bytes: Vec<u8>, mime_type: &str) -> Result<String> {
        self.upload_for(&self.session.account_id, bytes, mime_type).await
    }

    /// Uploads data into another account of the login.
    pub async fn upload_for(&self, account_id: &str, bytes: Vec<u8>, mime_type: &str) -> Result<String> {
        let url = fill(&self.session.upload_url, &[("accountId", account_id)]);
        let response = self
            .http
            .post(url)
            .header(reqwest::header::AUTHORIZATION, self.auth.header())
            .header(reqwest::header::CONTENT_TYPE, mime_type)
            .timeout(BLOB_TIMEOUT)
            .body(bytes)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(Error::connection(format!("Upload failed with {}.", response.status())));
        }
        let document: Value = serde_json::from_slice(&read_limited(response, MAX_SESSION).await?)
            .map_err(|_| Error::connection("The upload answer had no blob id."))?;
        document
            .get("blobId")
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| Error::connection("The upload answer had no blob id."))
    }

    /// Opens the push connection, if the server offers one.
    pub async fn push(&self) -> Result<Option<Push>> {
        let Some(template) = &self.session.event_source_url else { return Ok(None) };
        let ping = PUSH_PING_SECONDS.to_string();
        let url = fill(template, &[("types", "*"), ("closeafter", "no"), ("ping", &ping)]);
        let response = self
            .http
            .get(url)
            .header(reqwest::header::AUTHORIZATION, self.auth.header())
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .timeout(PUSH_LIFETIME)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(Error::connection(format!("Push failed with {}.", response.status())));
        }
        Ok(Some(Push { response, buffer: String::new(), account_id: self.session.account_id.clone() }))
    }
}

fn short(text: &str) -> String {
    text.chars().take(200).collect()
}

/// An answer's body, refused as soon as it grows beyond `limit` bytes.
async fn read_limited(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    let too_big = || Error::connection("The mail server's answer is too big.");
    if response.content_length().is_some_and(|length| length > limit as u64) {
        return Err(too_big());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > limit {
            return Err(too_big());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// The start of an answer's body as text, for an error message; whatever can't be read is left out.
async fn read_start(mut response: reqwest::Response, limit: usize) -> String {
    let mut body = Vec::new();
    while body.len() < limit {
        match response.chunk().await {
            Ok(Some(chunk)) => body.extend_from_slice(&chunk),
            _ => break,
        }
    }
    body.truncate(limit);
    String::from_utf8_lossy(&body).into_owned()
}

/// Whether credentials given for `from` may also go to `to`: same site (e.g.
/// `fastmail.com` → `api.fastmail.com`) and never from HTTPS down to HTTP.
/// The picture sizes answer (`application/x-ndjson`), read line by line as it comes: every asked
/// address once, anything else left out.
struct SizeLines {
    pending: HashSet<String>,
    buffer: Vec<u8>,
}

impl SizeLines {
    fn new(asked: Vec<String>) -> Self {
        Self { pending: asked.into_iter().collect(), buffer: Vec::new() }
    }

    fn done(&self) -> bool {
        self.pending.is_empty()
    }

    fn feed(&mut self, chunk: &[u8], on_size: &mut impl FnMut(RemoteImageSize)) -> Result<()> {
        self.buffer.extend_from_slice(chunk);
        while let Some(end) = self.buffer.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).collect();
            if let Some(size) = self.parse(&line) {
                on_size(size);
            }
        }
        if self.buffer.len() > MAX_SIZE_LINE {
            return Err(Error::invalid("The server's picture sizes are not what they should be."));
        }
        Ok(())
    }

    fn parse(&mut self, line: &[u8]) -> Option<RemoteImageSize> {
        if line.len() > MAX_SIZE_LINE {
            return None;
        }
        let value: Value = serde_json::from_slice(line).ok()?;
        let url = value.get("url")?.as_str()?;
        let url = self.pending.take(url)?;
        if value.get("failed").and_then(Value::as_bool) == Some(true) {
            return Some(RemoteImageSize::failed(&url));
        }
        let side = |key: &str| value.get(key).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
        Some(match (side("width"), side("height")) {
            // Only both or neither: half a size says nothing about the shape.
            (Some(width), Some(height)) => {
                RemoteImageSize { url, width: Some(width), height: Some(height), failed: false }
            }
            _ => RemoteImageSize::unknown(&url),
        })
    }
}

/// A session whose login goes only where the address the person gave (`asked`) leads: the session
/// resource on its site, and every endpoint on the site of the session resource (`base`), never from
/// HTTPS down to HTTP. Endpoints under another name than the session's (a server behind a reverse
/// proxy announcing its public name) move to the address that answered; any other site is refused
/// (security audit 2026-09-23, CC-11).
fn checked_endpoints(session: Session, asked: &Url, base: &Url) -> Result<Session> {
    if !may_send_credentials(asked, base) {
        return Err(Error::auth(format!(
            "The server sent the sign-in to {}, which isn't part of {}. UwUMail didn't send your password there.",
            base.host_str().unwrap_or("another address"),
            asked.host_str().unwrap_or("the server"),
        )));
    }
    let on_site = |endpoint: &str| Url::parse(endpoint).is_ok_and(|to| may_send_credentials(base, &to));
    let mut session = session;
    if !on_site(&session.api_url)
        && let (Some(announced), Some(working)) = (origin_of(&session.api_url), origin_of(base.as_str()))
    {
        session = session.rebased(&announced, &working);
    }
    let endpoints = [&session.api_url, &session.download_url, &session.upload_url];
    if endpoints.into_iter().chain(session.event_source_url.as_ref()).any(|endpoint| !on_site(endpoint)) {
        return Err(Error::connection(
            "The JMAP server named addresses on another site or without encryption for your login. UwUMail refused.",
        ));
    }
    Ok(session)
}

fn may_send_credentials(from: &Url, to: &Url) -> bool {
    if from.scheme() == "https" && to.scheme() != "https" {
        return false;
    }
    let (Some(a), Some(b)) = (from.host_str(), to.host_str()) else { return false };
    if a.eq_ignore_ascii_case(b) {
        return true;
    }
    // An IP address is a site of its own: read as names, 192.0.2.1 and 198.51.100.1 would share "0.1"
    // (as audit C-9 found for CalDAV).
    let site = crate::calendar::dav::site;
    site(a) == site(b) && !site(a).is_empty()
}

/// GETs the session resource. Redirects that change the host drop the
/// Authorization header; they're followed again with it only within the same site.
async fn fetch_session(http: &reqwest::Client, url: &Url, auth: &Auth) -> Result<(Value, Url)> {
    let mut target = url.clone();
    for _ in 0..3 {
        let response = http
            .get(target.clone())
            .header(reqwest::header::AUTHORIZATION, auth.header())
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(CALL_TIMEOUT)
            .send()
            .await?;
        let status = response.status();
        let landed = response.url().clone();
        if (status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN) && landed != target
        {
            if !may_send_credentials(url, &landed) {
                return Err(Error::auth(format!(
                    "The server sent the sign-in to {}, which isn't part of {}. UwUMail didn't send your password there.",
                    landed.host_str().unwrap_or("another address"),
                    url.host_str().unwrap_or("the server"),
                )));
            }
            target = landed;
            continue;
        }
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(Error::auth("The user name or password is wrong."));
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(Error::not_supported("There's no JMAP server at this address."));
        }
        if !status.is_success() {
            return Err(Error::connection(format!("The JMAP server answered {status}.")));
        }
        let body = read_limited(response, MAX_SESSION).await?;
        let document: Value = serde_json::from_slice(&body)
            .map_err(|_| Error::not_supported("There's no JMAP server at this address."))?;
        return Ok((document, landed));
    }
    Err(Error::auth("The user name or password is wrong."))
}

/// A server-sent event stream announcing state changes.
pub struct Push {
    response: reqwest::Response,
    buffer: String,
    account_id: String,
}

/// What a push said changed for the account.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StateChange {
    /// The new state per type, e.g. `Email` → `s12`. `None` when the event couldn't be read, so
    /// anything may have changed.
    pub types: Option<HashMap<String, String>>,
}

impl StateChange {
    /// The new state of `kind`, if the push named it.
    pub fn state_of(&self, kind: &str) -> Option<&str> {
        self.types.as_ref().and_then(|types| types.get(kind)).map(String::as_str)
    }

    /// Whether `kind` may have changed: named, or the event didn't say.
    pub fn may_have_changed(&self, kind: &str) -> bool {
        self.types.as_ref().is_none_or(|types| types.contains_key(kind))
    }

    /// Whether only these types changed (and the event said so).
    pub fn only(&self, kinds: &[&str]) -> bool {
        self.types.as_ref().is_some_and(|types| types.keys().all(|kind| kinds.contains(&kind.as_str())))
    }
}

impl Push {
    /// Waits until the server reports that something changed, and says what.
    pub async fn changed(&mut self) -> Result<StateChange> {
        loop {
            while let Some(end) = self.buffer.find("\n\n") {
                let event: String = self.buffer.drain(..end + 2).collect();
                if is_state_change(&event) {
                    return Ok(state_change(&event, &self.account_id));
                }
            }
            let chunk = timeout(PUSH_SILENCE, self.response.chunk())
                .await
                .map_err(|_| Error::connection("The push connection went quiet."))??
                .ok_or_else(|| Error::connection("The push connection closed."))?;
            self.buffer.push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));
            if self.buffer.len() > 1024 * 1024 {
                self.buffer.clear();
            }
        }
    }
}

/// The changed types of one account in a `StateChange` event block.
pub fn state_change(event: &str, account_id: &str) -> StateChange {
    let data: String =
        event.lines().filter_map(|line| line.strip_prefix("data:")).map(str::trim_start).collect::<Vec<_>>().join("\n");
    let Ok(document) = serde_json::from_str::<Value>(&data) else { return StateChange::default() };
    let Some(changed) = document.get("changed").and_then(Value::as_object) else { return StateChange::default() };
    let types = changed
        .get(account_id)
        .and_then(Value::as_object)
        .map(|types| {
            types.iter().filter_map(|(kind, state)| Some((kind.clone(), state.as_str()?.to_string()))).collect()
        })
        .unwrap_or_default();
    StateChange { types: Some(types) }
}

/// Whether one server-sent event block is a JMAP `StateChange`.
pub fn is_state_change(event: &str) -> bool {
    let mut name = "message";
    let mut data = String::new();
    for line in event.lines() {
        if let Some(value) = line.strip_prefix("event:") {
            name = value.trim();
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push_str(value.trim_start());
        }
    }
    name == "state" || (name == "message" && data.contains("StateChange"))
}

/// Finds the JMAP session URL for an address without signing in, or `None`.
/// Only HTTPS addresses are probed; a server that asks for a login counts.
///
/// The answer becomes where the password goes, and the site the calendar and address book trust
/// with it, so only an answer on the site of one of `mail_hosts` (the IMAP and SMTP servers) is
/// taken. The places asked (the mail domain's website, its SRV record) and wherever they redirect
/// to are chosen by others: a website operator or a forged DNS answer must not be able to name a
/// server of theirs (security audit 2026-09-23, CC-7).
pub async fn discover(http: &reqwest::Client, domain: &str, mail_hosts: &[&str]) -> Option<String> {
    let domain = domain.trim().to_ascii_lowercase();
    let host = mail_hosts.first().map(|h| h.trim().to_ascii_lowercase()).filter(|h| !h.is_empty());
    for (known, session) in KNOWN_SESSIONS {
        let matches = |name: &str| name == *known || name.ends_with(&format!(".{known}"));
        if matches(&domain) || host.as_deref().is_some_and(matches) {
            return Some((*session).to_string());
        }
    }

    let mut candidates: Vec<String> = Vec::new();
    if let Some(resolver) = crate::autoconfig::resolver().await
        && let Some((target, port)) = crate::autoconfig::srv(&resolver, &format!("_jmap._tcp.{domain}.")).await
    {
        candidates.push(if port == 443 {
            format!("https://{target}/.well-known/jmap")
        } else {
            format!("https://{target}:{port}/.well-known/jmap")
        });
    }
    for name in [Some(domain.clone()), host, Some(format!("mail.{domain}")), Some(format!("jmap.{domain}"))]
        .into_iter()
        .flatten()
    {
        let url = format!("https://{name}/.well-known/jmap");
        if !candidates.contains(&url) {
            candidates.push(url);
        }
    }

    let probes = candidates.iter().map(|url| probe(http, url));
    let mut found = futures::future::join_all(probes).await.into_iter().flatten();
    found.find(|landed| on_mail_site(landed, mail_hosts))
}

/// Whether a discovered session address is an HTTPS address on the site of one of the mail servers.
pub fn on_mail_site(url: &str, mail_hosts: &[&str]) -> bool {
    let Ok(url) = Url::parse(url) else { return false };
    let Some(host) = url.host_str().filter(|_| url.scheme() == "https") else { return false };
    let site = crate::calendar::dav::site(host);
    mail_hosts.iter().map(|h| h.trim()).filter(|h| !h.is_empty()).any(|h| crate::calendar::dav::site(h) == site)
}

async fn probe(http: &reqwest::Client, url: &str) -> Option<String> {
    let response = http.get(url).timeout(PROBE_TIMEOUT).send().await.ok()?;
    let status = response.status();
    let landed = response.url().to_string();
    let asks_for_login = (status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN)
        && response.headers().contains_key(reqwest::header::WWW_AUTHENTICATE);
    if asks_for_login {
        return Some(landed);
    }
    if status.is_success() {
        let body = read_limited(response, MAX_SESSION).await.ok()?;
        let document: Map<String, Value> = serde_json::from_slice(&body).ok()?;
        return document
            .get("capabilities")
            .and_then(Value::as_object)
            .is_some_and(|c| c.contains_key(CORE))
            .then_some(landed);
    }
    None
}

/// Message flags from JMAP keywords.
pub fn flags_from_keywords(keywords: Option<&Value>) -> crate::model::MessageFlags {
    let has = |name: &str| {
        keywords.and_then(Value::as_object).is_some_and(|map| {
            map.iter().any(|(key, value)| key.eq_ignore_ascii_case(name) && value.as_bool() == Some(true))
        })
    };
    crate::model::MessageFlags {
        seen: has("$seen"),
        flagged: has("$flagged"),
        answered: has("$answered"),
        draft: has("$draft"),
    }
}

/// The own keywords among JMAP keywords (lower case, without the `$` system ones), e.g. labels.
pub fn own_keywords(keywords: Option<&Value>) -> Vec<String> {
    keywords
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter(|(key, value)| value.as_bool() == Some(true) && !key.starts_with('$') && key.len() <= 64)
                .map(|(key, _)| key.to_lowercase())
                .collect()
        })
        .unwrap_or_default()
}

/// A folder role from a JMAP mailbox role.
pub fn role_from_jmap(role: Option<&str>) -> Option<crate::model::FolderRole> {
    use crate::model::FolderRole;
    Some(match role?.to_ascii_lowercase().as_str() {
        "inbox" => FolderRole::Inbox,
        "sent" => FolderRole::Sent,
        "drafts" => FolderRole::Drafts,
        "archive" => FolderRole::Archive,
        "trash" => FolderRole::Trash,
        "junk" => FolderRole::Junk,
        _ => return None,
    })
}

/// Rebuilds a header block from JMAP's raw `headers` property, for messages too big to download while syncing.
pub fn header_block(headers: &[Value]) -> Vec<u8> {
    let mut out = String::new();
    for header in headers {
        let (Some(name), Some(value)) =
            (header.get("name").and_then(Value::as_str), header.get("value").and_then(Value::as_str))
        else {
            continue;
        };
        out.push_str(name);
        out.push(':');
        out.push_str(value);
        out.push_str("\r\n");
    }
    out.push_str("\r\n");
    out.into_bytes()
}

/// Groups ids by account for requests that address many emails.
pub fn chunks<T: Clone>(items: &[T], size: usize) -> Vec<Vec<T>> {
    items.chunks(size.max(1)).map(<[T]>::to_vec).collect()
}

/// `{ "id": { patch } }` for Email/set updates.
pub fn patch_all(ids: &[String], patch: &Value) -> Value {
    Value::Object(ids.iter().map(|id| (id.clone(), patch.clone())).collect())
}

/// Picks one local folder for an email that JMAP may keep in several mailboxes.
pub fn primary_mailbox<'a, F>(
    mailbox_ids: Option<&Value>,
    folders: &'a HashMap<String, F>,
    role_of: impl Fn(&F) -> Option<crate::model::FolderRole>,
) -> Option<&'a F> {
    use crate::model::FolderRole;
    let rank = |role: Option<FolderRole>| match role {
        Some(FolderRole::Trash) => 0,
        Some(FolderRole::Junk) => 1,
        Some(FolderRole::Inbox) => 2,
        None => 3,
        Some(FolderRole::Drafts) => 4,
        Some(FolderRole::Sent) => 5,
        Some(FolderRole::Archive) => 6,
    };
    let mut ids: Vec<&String> = mailbox_ids?
        .as_object()?
        .iter()
        .filter(|(_, member)| member.as_bool() == Some(true))
        .map(|(id, _)| id)
        .filter(|id| folders.contains_key(*id))
        .collect();
    ids.sort_by_key(|id| (rank(role_of(&folders[*id])), (*id).clone()));
    ids.first().map(|id| &folders[*id])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::FolderRole;

    #[test]
    fn resolves_relative_session_urls() {
        let base = Url::parse("http://127.0.0.1:18080/jmap/session").unwrap();
        assert_eq!(absolute(&base, "/jmap/"), "http://127.0.0.1:18080/jmap/");
        assert_eq!(absolute(&base, "upload/{accountId}/"), "http://127.0.0.1:18080/jmap/upload/{accountId}/");
        assert_eq!(absolute(&base, "https://api.example/jmap/"), "https://api.example/jmap/");
        assert_eq!(
            fill(
                "/download/{accountId}/{blobId}/{name}?accept={type}",
                &[("accountId", "u1"), ("blobId", "b 2"), ("name", "a/b.eml"), ("type", "message/rfc822")]
            ),
            "/download/u1/b%202/a%2Fb.eml?accept=message%2Frfc822"
        );
    }

    #[test]
    fn reads_a_session_and_moves_it_to_a_reachable_origin() {
        let document = json!({
            "capabilities": { CORE: { "maxObjectsInGet": 250, "maxCallsInRequest": 8 }, MAIL: {}, SUBMISSION: {} },
            "primaryAccounts": { MAIL: "c", SUBMISSION: "c" },
            "username": "mini@uwumail.test",
            "apiUrl": "https://mail.uwumail.test/jmap/",
            "downloadUrl": "https://mail.uwumail.test/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
            "uploadUrl": "https://mail.uwumail.test/jmap/upload/{accountId}/",
            "eventSourceUrl": "https://mail.uwumail.test/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}",
            "state": "x"
        });
        let base = Url::parse("http://127.0.0.1:18080/jmap/session").unwrap();
        let session = Session::parse(&document, &base).unwrap();
        assert_eq!(session.account_id, "c");
        assert_eq!(session.submission_account_id.as_deref(), Some("c"));
        assert_eq!(session.max_objects_in_get, 250);
        let moved = session.rebased("https://mail.uwumail.test", "http://127.0.0.1:18080");
        assert_eq!(moved.api_url, "http://127.0.0.1:18080/jmap/");
        assert!(moved.event_source_url.unwrap().starts_with("http://127.0.0.1:18080/jmap/eventsource/"));

        let no_mail = json!({ "capabilities": { CORE: {} }, "apiUrl": "/", "downloadUrl": "/", "uploadUrl": "/" });
        assert_eq!(Session::parse(&no_mail, &base).unwrap_err().code, ErrorCode::NotSupported);
        assert_eq!(session.image_url, None, "an ordinary server fetches no pictures for us");
    }

    #[test]
    fn discovery_only_takes_a_session_on_the_mail_servers_site() {
        let mail = ["imap.mailhost.example", "smtp.mailhost.example"];
        assert!(on_mail_site("https://mailhost.example/.well-known/jmap", &mail));
        assert!(on_mail_site("https://jmap.mailhost.example/jmap/session", &mail));
        // Where the mail domain's website or a forged SRV record may point.
        assert!(!on_mail_site("https://shop.example/.well-known/jmap", &mail));
        assert!(!on_mail_site("https://login.elsewhere.example/jmap/session", &mail));
        // Never unencrypted, not even on the right site.
        assert!(!on_mail_site("http://jmap.mailhost.example/jmap/session", &mail));
        assert!(!on_mail_site("https://192.0.2.1/jmap/session", &["192.0.2.2"]));
        assert!(!on_mail_site("not a url", &mail));
    }

    #[test]
    fn a_uwumail_server_fetches_pictures_for_us() {
        let document = json!({
            "capabilities": { CORE: {}, MAIL: {}, REMOTE: {
                "imageUrl": "/jmap/image/{accountId}?url={url}",
                "pictureUrl": "https://mail.uwumail.test/jmap/picture/{accountId}?email={email}"
            } },
            "primaryAccounts": { MAIL: "a1" },
            "apiUrl": "/jmap/api", "downloadUrl": "/d", "uploadUrl": "/u"
        });
        let base = Url::parse("https://mail.uwumail.test/jmap/session").unwrap();
        let session = Session::parse(&document, &base).unwrap();
        let image = fill(
            session.image_url.as_deref().unwrap(),
            &[("accountId", "a1"), ("url", "https://cdn.example/a.png?w=1")],
        );
        assert_eq!(image, "https://mail.uwumail.test/jmap/image/a1?url=https%3A%2F%2Fcdn.example%2Fa.png%3Fw%3D1");
        let moved = session.rebased("https://mail.uwumail.test", "http://127.0.0.1:18080");
        assert!(moved.picture_url.unwrap().starts_with("http://127.0.0.1:18080/jmap/picture/"));
        assert_eq!(session.image_sizes_url, None, "a server of before 0.18 tells no sizes");

        let mut remote = document.clone();
        remote["capabilities"][REMOTE]["imageSizesUrl"] = json!("/jmap/image/{accountId}/sizes");
        let session = Session::parse(&remote, &base).unwrap();
        let sizes = fill(session.image_sizes_url.as_deref().unwrap(), &[("accountId", "a1")]);
        assert_eq!(sizes, "https://mail.uwumail.test/jmap/image/a1/sizes");
    }

    #[test]
    fn picture_sizes_are_taken_line_by_line_and_once_each() {
        let asked = vec![
            "https://cdn.example/a.png".to_string(),
            "https://t.example/p.gif".to_string(),
            "https://cdn.example/c.svg".to_string(),
        ];
        let mut lines = SizeLines::new(asked);
        let mut sizes = Vec::new();
        let mut take = |size| sizes.push(size);
        // Split anywhere, also inside a line and inside a multi-byte character.
        let answer = "{\"url\":\"https://cdn.example/a.png\",\"width\":1200,\"height\":600}\n\
            {\"url\":\"https://elsewhere.example/x.png\",\"width\":1,\"height\":1}\n\
            not json\n\
            {\"url\":\"https://cdn.example/a.png\",\"width\":1,\"height\":1,\"note\":\"ü\"}\n\
            {\"url\":\"https://t.example/p.gif\",\"failed\":true}\n\
            {\"url\":\"https://cdn.example/c.svg\",\"width\":300,\"height\":null}\n";
        for chunk in answer.as_bytes().chunks(7) {
            lines.feed(chunk, &mut take).unwrap();
        }
        assert!(lines.done());
        assert_eq!(
            sizes,
            vec![
                RemoteImageSize {
                    url: "https://cdn.example/a.png".into(),
                    width: Some(1200),
                    height: Some(600),
                    failed: false
                },
                RemoteImageSize::failed("https://t.example/p.gif"),
                RemoteImageSize::unknown("https://cdn.example/c.svg"),
            ]
        );

        let mut endless = SizeLines::new(vec!["https://cdn.example/a.png".into()]);
        let long = vec![b'x'; MAX_SIZE_LINE + 1];
        assert!(endless.feed(&long, &mut |_| {}).is_err(), "a line without end is no answer");
    }

    #[test]
    fn keeps_credentials_within_the_site() {
        let url = |s: &str| Url::parse(s).unwrap();
        assert!(may_send_credentials(
            &url("https://fastmail.com/.well-known/jmap"),
            &url("https://api.fastmail.com/jmap/session")
        ));
        assert!(may_send_credentials(
            &url("http://127.0.0.1:8080/.well-known/jmap"),
            &url("http://127.0.0.1:8080/jmap/session")
        ));
        assert!(!may_send_credentials(&url("https://mail.example.com/"), &url("http://mail.example.com/jmap")));
        assert!(!may_send_credentials(&url("https://mail.example.com/"), &url("https://collector.example.net/jmap")));
        assert!(!may_send_credentials(&url("https://a.github.io/"), &url("https://b.github.io/")));
        assert!(!may_send_credentials(&url("http://192.0.2.1/jmap"), &url("http://198.51.100.1/jmap")));
        assert!(!may_send_credentials(&url("http://127.0.0.1:8080/"), &url("http://127.0.0.2:8080/")));
    }

    #[test]
    fn finds_method_errors_by_call_id() {
        let responses = Responses(vec![
            ("Email/changes".into(), json!({ "newState": "2" }), "0".into()),
            ("error".into(), json!({ "type": "cannotCalculateChanges" }), "1".into()),
            ("EmailSubmission/set".into(), json!({ "created": {} }), "2".into()),
            ("Email/set".into(), json!({ "updated": {} }), "2".into()),
        ]);
        assert_eq!(responses.get(0, "Email/changes").unwrap()["newState"], "2");
        assert_eq!(responses.get(1, "Email/get").unwrap_err().kind, "cannotCalculateChanges");
        assert!(responses.get(2, "Email/set").is_ok());
        let failed = json!({ "notUpdated": { "m1": { "type": "notFound" } } });
        assert_eq!(set_errors(&failed).unwrap().kind, "notFound");
        assert!(set_errors(&json!({ "updated": { "m1": null } })).is_none());
    }

    #[test]
    fn recognizes_push_events() {
        assert!(is_state_change("event: state\ndata: {\"@type\":\"StateChange\",\"changed\":{}}\n\n"));
        assert!(is_state_change("data: {\"@type\":\"StateChange\"}\n\n"));
        assert!(!is_state_change("event: ping\ndata: {\"interval\":60}\n\n"));
    }

    #[test]
    fn reads_what_a_push_says_changed() {
        let event = "event: state\ndata: {\"@type\":\"StateChange\",\"changed\":{\"a1\":{\"UserSettings\":\"43\"},\"a2\":{\"Email\":\"9\"}}}\n\n";
        let change = state_change(event, "a1");
        assert_eq!(change.state_of("UserSettings"), Some("43"));
        assert!(change.may_have_changed("UserSettings"));
        assert!(!change.may_have_changed("Email"));
        assert!(change.only(&["UserSettings"]));

        // Another account's change is nothing for this one.
        let other = state_change(event, "a3");
        assert!(!other.may_have_changed("Email") && other.only(&["UserSettings"]));

        // An event that can't be read may mean anything.
        let unreadable = state_change("data: {\"@type\":\"StateChange\"\n\n", "a1");
        assert!(unreadable.may_have_changed("Email") && !unreadable.only(&["UserSettings"]));
    }

    #[test]
    fn notices_the_settings_extension() {
        let base = Url::parse("https://mail.uwumail.test/jmap/session").unwrap();
        let mut document = json!({
            "capabilities": { CORE: {}, MAIL: {}, SETTINGS: {} },
            "primaryAccounts": { MAIL: "a1" },
            "apiUrl": "/jmap/api", "downloadUrl": "/jmap/download", "uploadUrl": "/jmap/upload",
        });
        assert!(Session::parse(&document, &base).unwrap().user_settings);
        document["capabilities"].as_object_mut().unwrap().remove(SETTINGS);
        assert!(!Session::parse(&document, &base).unwrap().user_settings);
    }

    #[test]
    fn notices_signatures_per_domain() {
        let base = Url::parse("https://mail.uwumail.test/jmap/session").unwrap();
        let mut document = json!({
            "capabilities": { CORE: {}, MAIL: {}, SIGNATURES: { "maxSize": 262_144 } },
            "primaryAccounts": { MAIL: "a1" },
            "apiUrl": "/jmap/api", "downloadUrl": "/jmap/download", "uploadUrl": "/jmap/upload",
        });
        assert_eq!(Session::parse(&document, &base).unwrap().signatures_account_id.as_deref(), Some("a1"));
        document["primaryAccounts"][SIGNATURES] = json!("a2");
        assert_eq!(Session::parse(&document, &base).unwrap().signatures_account_id.as_deref(), Some("a2"));
        document["capabilities"].as_object_mut().unwrap().remove(SIGNATURES);
        assert!(Session::parse(&document, &base).unwrap().signatures_account_id.is_none());
    }

    #[test]
    fn notices_rules_and_calendars() {
        let base = Url::parse("https://mail.uwumail.test/jmap/session").unwrap();
        let mut document = json!({
            "capabilities": { CORE: {}, MAIL: {}, SIEVE: { "implementation": "UwUMail Server" }, CALENDARS: {} },
            "primaryAccounts": { MAIL: "a1", SIEVE: "a1", CALENDARS: "c9" },
            "apiUrl": "/jmap/api", "downloadUrl": "/jmap/download", "uploadUrl": "/jmap/upload",
        });
        let session = Session::parse(&document, &base).unwrap();
        assert_eq!(session.sieve_account_id.as_deref(), Some("a1"));
        assert_eq!(session.calendar_account_id.as_deref(), Some("c9"));
        // Without its own primary account an extension uses the mail account.
        document["primaryAccounts"].as_object_mut().unwrap().remove(CALENDARS);
        assert_eq!(Session::parse(&document, &base).unwrap().calendar_account_id.as_deref(), Some("a1"));
        document["capabilities"].as_object_mut().unwrap().remove(SIEVE);
        assert_eq!(Session::parse(&document, &base).unwrap().sieve_account_id, None);
    }

    #[test]
    fn reads_the_push_key_and_session_state() {
        let base = Url::parse("https://mail.uwumail.test/jmap/session").unwrap();
        let key = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"; // gitleaks:allow (public test key)
        let mut document = json!({
            "capabilities": { CORE: {}, MAIL: {}, WEBPUSH_VAPID: { "applicationServerKey": key } },
            "primaryAccounts": { MAIL: "a1", CALENDARS: "c9" },
            "apiUrl": "/jmap/api", "downloadUrl": "/jmap/download", "uploadUrl": "/jmap/upload",
            "state": "75128aab4b1b",
        });
        let session = Session::parse(&document, &base).unwrap();
        assert_eq!(session.vapid_key.as_deref(), Some(key));
        assert_eq!(session.state.as_deref(), Some("75128aab4b1b"));
        document["capabilities"].as_object_mut().unwrap().remove(WEBPUSH_VAPID);
        assert_eq!(Session::parse(&document, &base).unwrap().vapid_key, None, "push without a key is plain Web Push");
    }

    #[test]
    fn notices_contacts() {
        let base = Url::parse("https://mail.uwumail.test/jmap/session").unwrap();
        let mut document = json!({
            "capabilities": { CORE: {}, MAIL: {}, CONTACTS: {} },
            "primaryAccounts": { MAIL: "a1", CONTACTS: "k7" },
            "apiUrl": "/jmap/api", "downloadUrl": "/jmap/download", "uploadUrl": "/jmap/upload",
        });
        assert_eq!(Session::parse(&document, &base).unwrap().contacts_account_id.as_deref(), Some("k7"));
        document["capabilities"].as_object_mut().unwrap().remove(CONTACTS);
        assert_eq!(Session::parse(&document, &base).unwrap().contacts_account_id, None);
    }

    #[test]
    fn maps_keywords_roles_and_mailboxes() {
        let flags = flags_from_keywords(Some(&json!({ "$seen": true, "$Flagged": true, "$draft": false })));
        assert!(flags.seen && flags.flagged && !flags.draft && !flags.answered);
        assert_eq!(role_from_jmap(Some("Trash")), Some(FolderRole::Trash));
        assert_eq!(role_from_jmap(Some("important")), None);

        let folders: HashMap<String, Option<FolderRole>> = [
            ("a".to_string(), Some(FolderRole::Inbox)),
            ("b".to_string(), Some(FolderRole::Trash)),
            ("c".to_string(), None),
            ("s".to_string(), Some(FolderRole::Sent)),
        ]
        .into();
        let pick = |ids: Value| primary_mailbox(Some(&ids), &folders, |role| *role).copied();
        assert_eq!(pick(json!({ "c": true, "a": true })), Some(Some(FolderRole::Inbox)));
        assert_eq!(pick(json!({ "a": true, "b": true })), Some(Some(FolderRole::Trash)));
        assert_eq!(pick(json!({ "s": true, "c": true })), Some(None));
        assert_eq!(pick(json!({ "unknown": true })), None);
    }

    #[test]
    fn rebuilds_header_blocks() {
        let headers = [
            json!({ "name": "Subject", "value": " Hallo" }),
            json!({ "name": "From", "value": " Leni <leni@uwumail.test>" }),
        ];
        let parsed = crate::mime::parse(&header_block(&headers));
        assert_eq!(parsed.subject, "Hallo");
        assert_eq!(parsed.from.unwrap().email, "leni@uwumail.test");
        assert!(!parsed.has_body);
    }
}
