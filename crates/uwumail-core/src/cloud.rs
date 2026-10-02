//! Calendars and contacts of Microsoft and Google sign-ins: Microsoft Graph, Google Calendar and
//! Google People, over HTTPS with the mailbox's OAuth token. This module only makes the requests
//! and reads the answers; which token goes along is the engine's business (`engine::cloud_ops`),
//! and what the answers mean for the app is in `calendar::graph_cal`, `calendar::google_cal`,
//! `contacts::graph_contacts` and `contacts::google_people`.
//!
//! The token only ever goes to the provider's own API: the addresses are fixed, and a "next page"
//! link the API hands out is only followed while it stays under the same address.

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::Method;
use serde_json::Value;
use url::Url;

use crate::error::{Error, ErrorCode, Result};
use crate::model::OAuthProvider;
use crate::oauth::TokenEndpoint;

/// The biggest answer read; a calendar view or a page of contacts is far smaller.
const MAX_ANSWER: usize = 32 * 1024 * 1024;
/// Pages followed at most for one listing.
pub const MAX_PAGES: usize = 50;

/// Which API a request goes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Api {
    Graph,
    GoogleCalendar,
    GooglePeople,
}

impl Api {
    /// Which token it takes: Graph has its own, Google's covers both of its APIs.
    pub fn token(self) -> TokenKind {
        match self {
            Self::Graph => TokenKind::Graph,
            Self::GoogleCalendar | Self::GooglePeople => TokenKind::Google,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Graph => "Microsoft",
            Self::GoogleCalendar | Self::GooglePeople => "Google",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TokenKind {
    Graph,
    Google,
}

/// Where the APIs and the token endpoints are. Fixed outside of tests.
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub graph: Url,
    pub google_calendar: Url,
    pub google_people: Url,
    /// Token endpoints instead of the providers' own (tests only).
    pub microsoft_token: Option<TokenEndpoint>,
    pub google_token: Option<TokenEndpoint>,
}

impl Default for Endpoints {
    fn default() -> Self {
        let fixed = |url: &str| Url::parse(url).expect("a fixed API address");
        Self {
            graph: fixed("https://graph.microsoft.com/v1.0/"),
            google_calendar: fixed("https://www.googleapis.com/calendar/v3/"),
            google_people: fixed("https://people.googleapis.com/v1/"),
            microsoft_token: None,
            google_token: None,
        }
    }
}

impl Endpoints {
    pub fn base(&self, api: Api) -> &Url {
        match api {
            Api::Graph => &self.graph,
            Api::GoogleCalendar => &self.google_calendar,
            Api::GooglePeople => &self.google_people,
        }
    }

    pub fn token_endpoint(&self, provider: OAuthProvider) -> Result<TokenEndpoint> {
        let custom = match provider {
            OAuthProvider::Microsoft => &self.microsoft_token,
            OAuthProvider::Google => &self.google_token,
        };
        match custom {
            Some(endpoint) => Ok(endpoint.clone()),
            None => crate::oauth::token_endpoint(provider),
        }
    }
}

/// Everything but letters, digits and `-_.` is escaped in a path segment.
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.');

/// One piece of a path, escaped: ids from the API (or the app) can never add path segments.
pub fn segment(text: &str) -> String {
    utf8_percent_encode(text, SEGMENT).to_string()
}

/// Undoes [`segment`].
pub fn unsegment(text: &str) -> String {
    percent_encoding::percent_decode_str(text).decode_utf8_lossy().into_owned()
}

/// A request to an API: a path below its address (already escaped) and the query.
#[derive(Debug, Clone)]
pub struct Call {
    pub api: Api,
    pub method: Method,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub body: Option<Value>,
    /// Graph's `Prefer` headers: times in UTC, bodies as text.
    pub prefer: Option<&'static str>,
    /// A page link the API handed out, instead of `path` and `query`.
    pub next: Option<Url>,
}

impl Call {
    pub fn new(api: Api, method: Method, path: impl Into<String>) -> Self {
        Self { api, method, path: path.into(), query: Vec::new(), body: None, prefer: None, next: None }
    }

    pub fn get(api: Api, path: impl Into<String>) -> Self {
        Self::new(api, Method::GET, path)
    }

    pub fn query(mut self, key: &str, value: impl Into<String>) -> Self {
        self.query.push((key.to_string(), value.into()));
        self
    }

    pub fn body(mut self, body: Value) -> Self {
        self.body = Some(body);
        self
    }

    pub fn prefer(mut self, prefer: &'static str) -> Self {
        self.prefer = Some(prefer);
        self
    }

    /// The address this call goes to.
    pub fn url(&self, endpoints: &Endpoints) -> Result<Url> {
        let base = endpoints.base(self.api);
        if let Some(next) = &self.next {
            if !stays_under(base, next) {
                return Err(Error::invalid(format!("{} pointed somewhere else for the next page.", self.api.name())));
            }
            return Ok(next.clone());
        }
        let mut url = base.join(&self.path).map_err(|_| Error::internal("The API address couldn't be built."))?;
        if !stays_under(base, &url) {
            return Err(Error::invalid("That id makes no sense."));
        }
        if !self.query.is_empty() {
            url.query_pairs_mut().extend_pairs(self.query.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        }
        Ok(url)
    }
}

/// Whether `url` is on the same site as `base` and below its path.
pub fn stays_under(base: &Url, url: &Url) -> bool {
    url.origin() == base.origin()
        && url.path().starts_with(base.path())
        && !url.path().split('/').any(|part| part == ".." || part == "%2e%2e" || part == "%2E%2E")
}

/// What came back.
pub enum Answer {
    Done(Value),
    /// The token wasn't taken (expired or revoked): a fresh one may do.
    Unauthorized,
}

/// The client for the APIs: no redirects, so the bearer token only ever goes to the address
/// [`Call::url`] checked (a redirect would carry it on, or replay a change elsewhere).
fn client() -> Result<reqwest::Client> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = crate::tls::http_client()?
        .user_agent(concat!("UwUMail/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| Error::internal(format!("HTTP client setup failed: {e}")))?;
    Ok(CLIENT.get_or_init(|| client).clone())
}

/// Sends one call with a token.
pub async fn send(endpoints: &Endpoints, token: &str, call: &Call) -> Result<Answer> {
    let url = call.url(endpoints)?;
    let http = client()?;
    let mut request = http.request(call.method.clone(), url).bearer_auth(token).header("Accept", "application/json");
    if let Some(prefer) = call.prefer {
        request = request.header("Prefer", prefer);
    }
    if let Some(body) = &call.body {
        request = request.json(body);
    }
    let mut response = request.send().await?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > MAX_ANSWER {
            return Err(Error::connection(format!("{}'s answer is too big.", call.api.name())));
        }
        bytes.extend_from_slice(&chunk);
    }
    if status.as_u16() == 401 {
        return Ok(Answer::Unauthorized);
    }
    if !status.is_success() {
        return Err(api_error(call.api, status.as_u16(), &bytes));
    }
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Answer::Done(Value::Null));
    }
    serde_json::from_slice(&bytes)
        .map(Answer::Done)
        .map_err(|_| Error::connection(format!("{}'s answer isn't readable.", call.api.name())))
}

/// The plain words for what an API refused.
pub fn api_error(api: Api, status: u16, body: &[u8]) -> Error {
    let json: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let error = json.get("error").cloned().unwrap_or(Value::Null);
    let code = error.get("code").and_then(Value::as_str).unwrap_or_default().to_string();
    let message = error.get("message").and_then(Value::as_str).unwrap_or_default().to_string();
    // Google names the reason in `status`, `errors[].reason` and `details[].reason`.
    let mut reasons: Vec<String> = Vec::new();
    if let Some(status) = error.get("status").and_then(Value::as_str) {
        reasons.push(status.to_string());
    }
    for list in ["errors", "details"] {
        for entry in error.get(list).and_then(Value::as_array).into_iter().flatten() {
            if let Some(reason) = entry.get("reason").and_then(Value::as_str) {
                reasons.push(reason.to_string());
            }
        }
    }
    let has = |name: &str| reasons.iter().any(|reason| reason.eq_ignore_ascii_case(name)) || code == name;
    let name = api.name();
    match status {
        403 if has("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || has("insufficientPermissions") => {
            Error::sign_in_again("Sign in again to see calendar and contacts.")
        }
        403 if has("accessNotConfigured") || has("SERVICE_DISABLED") => Error::not_supported(
            "The Google Calendar or People API isn't switched on for this app's Google project (see docs/oauth.md).",
        ),
        403 if has("ErrorAccessDenied") || has("Authorization_RequestDenied") || has("ErrorItemNotFound") => {
            Error::new(
                ErrorCode::AuthFailed,
                format!("{name} doesn't give you access to this mailbox's calendar or contacts."),
            )
        }
        403 => Error::new(ErrorCode::AuthFailed, format!("{name} refused: {}", short(&message, &code))),
        404 | 410 => Error::not_found("This no longer exists."),
        409 | 412 => Error::invalid("This was changed elsewhere in the meantime. Please try again."),
        429 | 500..=599 => Error::connection(format!("{name} is busy right now. Please try again in a moment.")),
        400 if has("ErrorMailboxNotEnabledForRESTAPI") || has("MailboxNotEnabledForRESTAPI") => {
            Error::not_supported("This mailbox has no calendar or contacts at Microsoft.")
        }
        _ => Error::invalid(format!("{name} refused: {}", short(&message, &code))),
    }
}

fn short(message: &str, code: &str) -> String {
    let text = if message.trim().is_empty() { code } else { message.trim() };
    let mut text: String = text.chars().take(200).collect();
    if text.is_empty() {
        text = "no reason given".into();
    }
    text
}

/// Graph's next page, if it gave one.
pub fn graph_next(page: &Value) -> Option<Url> {
    page.get("@odata.nextLink").and_then(Value::as_str).and_then(|link| Url::parse(link).ok())
}

/// The items of a Graph list.
pub fn graph_items(page: &Value) -> impl Iterator<Item = &Value> {
    page.get("value").and_then(Value::as_array).into_iter().flatten()
}

/// A small HTTP/1.1 server on 127.0.0.1 for the tests of the Graph and Google backends: every
/// request is answered by the handler, and kept to look at afterwards.
#[cfg(test)]
pub(crate) mod fake {
    use std::sync::{Arc, Mutex};

    use serde_json::Value;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Debug, Clone)]
    pub struct Request {
        pub method: String,
        /// Path and query, as sent.
        pub target: String,
        pub headers: Vec<(String, String)>,
        pub body: String,
    }

    impl Request {
        pub fn path(&self) -> &str {
            self.target.split('?').next().unwrap_or_default()
        }

        pub fn query(&self, key: &str) -> Option<String> {
            let query = self.target.split_once('?')?.1;
            url::form_urlencoded::parse(query.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
        }

        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
        }

        pub fn json(&self) -> Value {
            serde_json::from_str(&self.body).unwrap_or(Value::Null)
        }

        pub fn form(&self, key: &str) -> Option<String> {
            url::form_urlencoded::parse(self.body.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
        }
    }

    pub struct Reply {
        pub status: u16,
        pub body: String,
    }

    impl Reply {
        pub fn json(value: Value) -> Self {
            Self { status: 200, body: value.to_string() }
        }

        pub fn status(status: u16, value: Value) -> Self {
            Self { status, body: value.to_string() }
        }

        pub fn empty() -> Self {
            Self { status: 204, body: String::new() }
        }
    }

    type Handler = dyn Fn(&Request) -> Reply + Send + Sync;

    pub struct Server {
        pub base: String,
        seen: Arc<Mutex<Vec<Request>>>,
        _task: tokio::task::JoinHandle<()>,
    }

    impl Server {
        pub async fn start(handler: impl Fn(&Request) -> Reply + Send + Sync + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let seen = Arc::new(Mutex::new(Vec::new()));
            let handler: Arc<Handler> = Arc::new(handler);
            let log = Arc::clone(&seen);
            let task = tokio::spawn(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else { return };
                    let (handler, log) = (Arc::clone(&handler), Arc::clone(&log));
                    tokio::spawn(async move {
                        let _ = serve(socket, handler, log).await;
                    });
                }
            });
            Self { base, seen, _task: task }
        }

        pub fn url(&self, path: &str) -> url::Url {
            url::Url::parse(&format!("{}{path}", self.base)).unwrap()
        }

        pub fn seen(&self) -> Vec<Request> {
            self.seen.lock().unwrap().clone()
        }

        pub fn count(&self, method: &str, path_start: &str) -> usize {
            self.seen().iter().filter(|r| r.method == method && r.path().starts_with(path_start)).count()
        }
    }

    async fn serve(
        mut socket: tokio::net::TcpStream,
        handler: Arc<Handler>,
        log: Arc<Mutex<Vec<Request>>>,
    ) -> std::io::Result<()> {
        let mut buffer = Vec::new();
        loop {
            // Head first, then as much body as it announces; keep-alive for the next request.
            let head_end = loop {
                if let Some(at) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                    break at;
                }
                let mut chunk = [0u8; 8192];
                let read = socket.read(&mut chunk).await?;
                if read == 0 {
                    return Ok(());
                }
                buffer.extend_from_slice(&chunk[..read]);
            };
            let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
            let mut lines = head.lines();
            let first = lines.next().unwrap_or_default().to_string();
            let mut parts = first.split_whitespace();
            let method = parts.next().unwrap_or_default().to_string();
            let target = parts.next().unwrap_or_default().to_string();
            let headers: Vec<(String, String)> = lines
                .filter_map(|line| line.split_once(':'))
                .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
                .collect();
            let length: usize = headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, v)| v.parse().ok())
                .unwrap_or(0);
            let body_start = head_end + 4;
            while buffer.len() < body_start + length {
                let mut chunk = [0u8; 8192];
                let read = socket.read(&mut chunk).await?;
                if read == 0 {
                    return Ok(());
                }
                buffer.extend_from_slice(&chunk[..read]);
            }
            let body = String::from_utf8_lossy(&buffer[body_start..body_start + length]).to_string();
            buffer.drain(..body_start + length);
            let request = Request { method, target, headers, body };
            let reply = handler(&request);
            log.lock().unwrap().push(request);
            let response = format!(
                "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                reply.status,
                reply.body.len(),
                reply.body
            );
            socket.write_all(response.as_bytes()).await?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_never_leave_the_api() {
        let endpoints = Endpoints::default();
        let call = Call::get(Api::Graph, format!("me/events/{}", segment("../../evil/x?y=1#z")));
        let url = call.url(&endpoints).unwrap();
        assert!(url.as_str().starts_with("https://graph.microsoft.com/v1.0/me/events/"), "{url}");
        assert_eq!(url.path_segments().unwrap().count(), 4, "{url}");
        assert_eq!(unsegment(&segment("a/b c+=d")), "a/b c+=d");

        let mut next = Call::get(Api::Graph, "");
        next.next = Some(Url::parse("https://evil.example/v1.0/me/events").unwrap());
        assert!(next.url(&endpoints).is_err());
        next.next = Some(Url::parse("https://graph.microsoft.com/v1.0/me/events?$skip=10").unwrap());
        assert!(next.url(&endpoints).is_ok());
        next.next = Some(Url::parse("https://graph.microsoft.com/beta/me/events").unwrap());
        assert!(next.url(&endpoints).is_err(), "only below the same address");
    }

    #[test]
    fn refusals_get_plain_words() {
        let google = br#"{"error":{"code":403,"message":"Request had insufficient authentication scopes.",
            "status":"PERMISSION_DENIED","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}"#;
        assert_eq!(api_error(Api::GoogleCalendar, 403, google).code, ErrorCode::SignInAgain);
        let disabled = br#"{"error":{"code":403,"errors":[{"reason":"accessNotConfigured"}]}}"#;
        assert_eq!(api_error(Api::GooglePeople, 403, disabled).code, ErrorCode::NotSupported);
        let denied = br#"{"error":{"code":"ErrorAccessDenied","message":"Access is denied."}}"#;
        assert!(api_error(Api::Graph, 403, denied).message.contains("doesn't give you access"));
        assert_eq!(api_error(Api::Graph, 404, b"").code, ErrorCode::NotFound);
        assert_eq!(api_error(Api::Graph, 503, b"").code, ErrorCode::ConnectionFailed);
    }
}
