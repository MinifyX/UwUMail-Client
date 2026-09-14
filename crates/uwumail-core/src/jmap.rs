//! JMAP (RFC 8620 core, RFC 8621 mail): finding the server, signing in,
//! method calls, blobs and push over EventSource.

use std::collections::HashMap;
use std::time::Duration;

use base64::Engine as _;
use serde_json::{Map, Value, json};
use tokio::time::timeout;
use url::Url;

use crate::error::{Error, ErrorCode, Result};

pub const CORE: &str = "urn:ietf:params:jmap:core";
pub const MAIL: &str = "urn:ietf:params:jmap:mail";
pub const SUBMISSION: &str = "urn:ietf:params:jmap:submission";

const PROBE_TIMEOUT: Duration = Duration::from_secs(6);
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const BLOB_TIMEOUT: Duration = Duration::from_secs(300);
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
        let limit = |key: &str, fallback: usize| {
            core.and_then(|c| c.get(key)).and_then(Value::as_u64).map_or(fallback, |n| n.clamp(1, 10_000) as usize)
        };
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
        let session = Session::parse(&document, &base)?;
        // A session fetched securely must not send the login on over plain HTTP.
        if base.scheme() == "https"
            && [&session.api_url, &session.download_url, &session.upload_url]
                .into_iter()
                .chain(session.event_source_url.as_ref())
                .any(|endpoint| !endpoint.starts_with("https://"))
        {
            return Err(Error::connection("The JMAP server asked for unencrypted connections. UwUMail refused."));
        }
        let mut client = Self { http: http.clone(), auth, session };

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

    /// Sends method calls in one request. Call ids are their positions.
    pub async fn call(&self, calls: Vec<(&str, Value)>) -> Result<Responses> {
        let method_calls: Vec<Value> = calls
            .into_iter()
            .enumerate()
            .map(|(index, (name, arguments))| json!([name, arguments, index.to_string()]))
            .collect();
        let body = json!({ "using": [CORE, MAIL, SUBMISSION], "methodCalls": method_calls });
        let response = self
            .http
            .post(&self.session.api_url)
            .header(reqwest::header::AUTHORIZATION, self.auth.header())
            .timeout(CALL_TIMEOUT)
            .json(&body)
            .send()
            .await?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(Error::auth("The mail server didn't accept the login anymore."));
        }
        if !status.is_success() {
            let detail = response.text().await.unwrap_or_default();
            return Err(Error::connection(format!("The mail server answered {status}. {}", short(&detail))));
        }
        let document: Value = response.json().await.map_err(|e| Error::connection(format!("Bad JMAP answer: {e}")))?;
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

    /// Downloads a blob, e.g. a whole message.
    pub async fn download(&self, blob_id: &str, name: &str, mime_type: &str) -> Result<Vec<u8>> {
        let url = fill(
            &self.session.download_url,
            &[("accountId", &self.session.account_id), ("blobId", blob_id), ("name", name), ("type", mime_type)],
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
        Ok(response.bytes().await?.to_vec())
    }

    /// Uploads data and returns its blob id.
    pub async fn upload(&self, bytes: Vec<u8>, mime_type: &str) -> Result<String> {
        let url = fill(&self.session.upload_url, &[("accountId", &self.session.account_id)]);
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
        let document: Value = response.json().await?;
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
        Ok(Some(Push { response, buffer: String::new() }))
    }
}

fn short(text: &str) -> String {
    text.chars().take(200).collect()
}

/// Whether credentials given for `from` may also go to `to`: same site (e.g.
/// `fastmail.com` → `api.fastmail.com`) and never from HTTPS down to HTTP.
fn may_send_credentials(from: &Url, to: &Url) -> bool {
    if from.scheme() == "https" && to.scheme() != "https" {
        return false;
    }
    let (Some(a), Some(b)) = (from.host_str(), to.host_str()) else { return false };
    if a.eq_ignore_ascii_case(b) {
        return true;
    }
    let site = |host: &str| psl::domain_str(&host.to_ascii_lowercase()).map(String::from);
    matches!((site(a), site(b)), (Some(x), Some(y)) if x == y)
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
        let document: Value =
            response.json().await.map_err(|_| Error::not_supported("There's no JMAP server at this address."))?;
        return Ok((document, landed));
    }
    Err(Error::auth("The user name or password is wrong."))
}

/// A server-sent event stream announcing state changes.
pub struct Push {
    response: reqwest::Response,
    buffer: String,
}

impl Push {
    /// Waits until the server reports that something changed.
    pub async fn changed(&mut self) -> Result<()> {
        loop {
            while let Some(end) = self.buffer.find("\n\n") {
                let event: String = self.buffer.drain(..end + 2).collect();
                if is_state_change(&event) {
                    return Ok(());
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
pub async fn discover(http: &reqwest::Client, domain: &str, imap_host: Option<&str>) -> Option<String> {
    let domain = domain.trim().to_ascii_lowercase();
    let host = imap_host.map(|h| h.trim().to_ascii_lowercase()).filter(|h| !h.is_empty());
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
    futures::future::join_all(probes).await.into_iter().flatten().next()
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
        let document: Map<String, Value> = response.json().await.ok()?;
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
