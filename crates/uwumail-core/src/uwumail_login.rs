//! "Sign in with UwUMail": a UwUMail server hands a mail app an app password through a browser
//! sign-in, so nobody has to make one in the portal and type it in.
//!
//! The server is an OAuth authorization server (its docs/oauth.md). The app registers itself
//! (RFC 7591), signs in with PKCE and the scope `app-password`, and trades the access token once
//! for a named app password at `POST /oauth/app-password`. The server then ends that sign-in, so
//! all the app keeps is the app password, which it uses like any password over JMAP, IMAP, SMTP and
//! DAV: the person sees and revokes it under *Security* in the portal like the ones made there.
//!
//! The token, the code and the verifier only ever go to the server's own address (its metadata
//! has to name endpoints on the origin of the JMAP server it was found for), never through a
//! redirect.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use url::Url;

use crate::error::{Error, Result};
use crate::oauth::{self, Receiver, Redirect, Refused};

/// The scope that lets an access token make one app password.
pub const SCOPE: &str = "app-password";
/// Where the browser comes back to on a computer; the port is picked per sign-in, which the server
/// allows for loopback addresses (RFC 8252 section 7.3).
const LOOPBACK: &str = "http://127.0.0.1";
const LOOPBACK_PATH: &str = "/oauth";
/// The longest app password name the server takes.
pub const MAX_NAME: usize = 80;
const METADATA_TIMEOUT: Duration = Duration::from_secs(4);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Metadata, registrations and tokens are small; a bigger answer isn't one.
const MAX_ANSWER: usize = 64 * 1024;
/// How long a registration is used again. The server forgets an app nobody allowed in after a
/// day; an unknown `client_id` only shows an error page, so a stale one must never be sent.
const CLIENT_REUSE: Duration = Duration::from_secs(60 * 60);

/// What a UwUMail server says about its sign-in (RFC 8414), checked to stay on its own origin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerMetadata {
    /// `https://host[:port]`, no trailing slash.
    pub issuer: String,
    pub authorization_endpoint: Url,
    pub token_endpoint: Url,
    pub registration_endpoint: Url,
}

impl ServerMetadata {
    /// Where the access token becomes an app password.
    pub fn app_password_endpoint(&self) -> String {
        format!("{}/oauth/app-password", self.issuer)
    }
}

#[derive(Deserialize)]
struct RawMetadata {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

/// The app password the server made.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppPassword {
    #[serde(default)]
    pub id: serde_json::Value,
    pub name: String,
    /// The login for Basic auth over JMAP, IMAP, SMTP and DAV.
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub scopes: Vec<String>,
}

/// `https://host[:port]` of an address, only for HTTPS.
fn https_origin(url: &Url) -> Option<String> {
    (url.scheme() == "https" && url.host_str().is_some() && url.username().is_empty() && url.password().is_none())
        .then(|| url.origin().ascii_serialization())
}

/// Checks the metadata of the server at `origin`: it offers app passwords, and every endpoint is
/// on that same origin.
pub fn check_metadata(origin: &str, body: &[u8]) -> Option<ServerMetadata> {
    let raw: RawMetadata = serde_json::from_slice(body).ok()?;
    if !raw.scopes_supported.iter().any(|scope| scope == SCOPE) {
        return None;
    }
    let issuer = raw.issuer.trim_end_matches('/').to_string();
    if issuer != origin {
        return None;
    }
    let on_origin = |endpoint: &str| {
        let url = Url::parse(endpoint).ok()?;
        (https_origin(&url).as_deref() == Some(origin)).then_some(url)
    };
    Some(ServerMetadata {
        authorization_endpoint: on_origin(&raw.authorization_endpoint)?,
        token_endpoint: on_origin(&raw.token_endpoint)?,
        registration_endpoint: on_origin(raw.registration_endpoint.as_deref()?)?,
        issuer,
    })
}

/// Reads at most `limit` bytes of an answer.
async fn read_limited(mut response: reqwest::Response, limit: usize) -> Option<Vec<u8>> {
    if response.content_length().is_some_and(|length| length > limit as u64) {
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if body.len() + chunk.len() > limit {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    Some(body)
}

/// The sign-in metadata of the UwUMail server behind a JMAP session address, when it hands out app
/// passwords. `None` for any other server, an older UwUMail server, or no answer.
pub async fn metadata(http: &reqwest::Client, session_url: &str) -> Option<ServerMetadata> {
    let origin = https_origin(&Url::parse(session_url.trim()).ok()?)?;
    let asked = format!("{origin}/.well-known/oauth-authorization-server");
    let response = http.get(&asked).timeout(METADATA_TIMEOUT).send().await.ok()?;
    // Not somewhere a redirect led to: the answer decides where the sign-in goes.
    if !response.status().is_success() || response.url().as_str() != asked {
        return None;
    }
    let body = tokio::time::timeout(METADATA_TIMEOUT, read_limited(response, MAX_ANSWER)).await.ok()??;
    check_metadata(&origin, &body)
}

/// The name of an app password: trimmed, 1 to 80 characters, no control characters.
pub fn app_password_name(name: &str) -> Result<String> {
    let name: String = name.trim().chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let count = name.chars().count();
    if count == 0 || count > MAX_NAME {
        return Err(Error::invalid(format!("The app password needs a name of 1 to {MAX_NAME} characters.")));
    }
    Ok(name)
}

/// Registrations of this app at servers, by issuer and redirect address, reused for an hour.
#[derive(Default)]
pub struct Clients {
    known: Mutex<HashMap<(String, String), (String, Instant)>>,
}

impl Clients {
    fn get(&self, issuer: &str, redirect: &str) -> Option<String> {
        let known = self.known.lock().unwrap();
        known
            .get(&(issuer.to_string(), redirect.to_string()))
            .filter(|(_, at)| at.elapsed() < CLIENT_REUSE)
            .map(|(id, _)| id.clone())
    }

    fn put(&self, issuer: &str, redirect: &str, client_id: &str) {
        let mut known = self.known.lock().unwrap();
        known.retain(|_, (_, at)| at.elapsed() < CLIENT_REUSE);
        known.insert((issuer.to_string(), redirect.to_string()), (client_id.to_string(), Instant::now()));
    }

    fn forget(&self, issuer: &str, redirect: &str) {
        self.known.lock().unwrap().remove(&(issuer.to_string(), redirect.to_string()));
    }
}

/// The server's error as a sentence: `error_description`, a problem's `detail` or `title`, or `error`.
fn server_message(status: reqwest::StatusCode, body: &[u8]) -> String {
    let parsed: Option<serde_json::Value> = serde_json::from_slice(body).ok();
    let field = |key: &str| {
        parsed.as_ref().and_then(|v| v.get(key)).and_then(serde_json::Value::as_str).map(str::trim).map(String::from)
    };
    let text = field("error_description")
        .or_else(|| field("detail"))
        .or_else(|| field("title"))
        .or_else(|| field("error"))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| format!("HTTP {status}"));
    // Never more than a line of somebody else's text on screen.
    text.chars().filter(|c| !c.is_control()).take(300).collect()
}

/// Sends one request and reads the answer, never following a redirect: the code, the verifier and
/// the token stay with the server.
async fn send(request: reqwest::RequestBuilder) -> Result<(reqwest::StatusCode, Vec<u8>)> {
    let response = request.timeout(REQUEST_TIMEOUT).send().await?;
    let status = response.status();
    if status.is_redirection() {
        return Err(Error::auth("The UwUMail server sent the sign-in somewhere else."));
    }
    let body = read_limited(response, MAX_ANSWER)
        .await
        .ok_or_else(|| Error::auth("The UwUMail server's answer to the sign-in is too big."))?;
    Ok((status, body))
}

/// Registers this app (RFC 7591) and returns its `client_id`.
pub async fn register(http: &reqwest::Client, meta: &ServerMetadata, name: &str, redirect_uri: &str) -> Result<String> {
    let body = json!({
        "client_name": format!("UwUMail – {name}"),
        "redirect_uris": [redirect_uri],
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code"],
        "response_types": ["code"],
    });
    let (status, answer) = send(http.post(meta.registration_endpoint.clone()).json(&body)).await?;
    if !status.is_success() {
        return Err(Error::auth(format!(
            "The UwUMail server didn't register UwUMail: {}",
            server_message(status, &answer)
        )));
    }
    let registered: serde_json::Value = serde_json::from_slice(&answer)
        .map_err(|_| Error::auth("The UwUMail server's registration isn't readable."))?;
    registered
        .get("client_id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 200)
        .map(String::from)
        .ok_or_else(|| Error::auth("The UwUMail server's registration has no client id."))
}

/// The page that asks the person, with PKCE (S256) and the `app-password` scope.
pub fn authorize_url(
    meta: &ServerMetadata,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    verifier: &str,
    login_hint: &str,
) -> Url {
    let mut url = meta.authorization_endpoint.clone();
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", SCOPE)
        .append_pair("state", state)
        .append_pair("code_challenge", &oauth::pkce_challenge(verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("login_hint", login_hint);
    url
}

/// The code of the redirect, after checking it came from this server (RFC 9207 `iss`, which
/// UwUMail always sends): another server's answer doesn't get this server's code verifier.
fn code_of(redirect: &Url, meta: &ServerMetadata) -> Result<String, Refused> {
    let iss = redirect.query_pairs().find(|(key, _)| key == "iss").map(|(_, value)| value.into_owned());
    if iss.as_deref().is_some_and(|iss| iss.trim_end_matches('/') != meta.issuer) {
        return Err(Error::auth("The sign-in answer came from another server.").into());
    }
    let (code, _) = oauth::redirect_parameters(redirect)?;
    Ok(code)
}

/// Trades the code for an access token that carries `app-password`.
pub async fn exchange_code(
    http: &reqwest::Client,
    meta: &ServerMetadata,
    client_id: &str,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<String> {
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id),
        ("code_verifier", verifier),
    ];
    let (status, answer) = send(http.post(meta.token_endpoint.clone()).form(&form)).await?;
    if !status.is_success() {
        return Err(Error::auth(format!(
            "The UwUMail server refused the sign-in: {}",
            server_message(status, &answer)
        )));
    }
    let tokens: serde_json::Value =
        serde_json::from_slice(&answer).map_err(|_| Error::auth("The UwUMail server's answer isn't readable."))?;
    let scope = tokens.get("scope").and_then(serde_json::Value::as_str);
    if scope.is_some_and(|scope| !scope.split_whitespace().any(|s| s == SCOPE)) {
        return Err(Error::auth("The sign-in wasn't allowed to make an app password."));
    }
    tokens
        .get("access_token")
        .and_then(serde_json::Value::as_str)
        .filter(|token| !token.is_empty())
        .map(String::from)
        .ok_or_else(|| Error::auth("The UwUMail server's answer has no access token."))
}

/// Makes the app password, which ends the sign-in on the server.
pub async fn create_app_password(
    http: &reqwest::Client,
    meta: &ServerMetadata,
    access_token: &str,
    name: &str,
) -> Result<AppPassword> {
    let request = http.post(meta.app_password_endpoint()).bearer_auth(access_token).json(&json!({ "name": name }));
    let (status, answer) = send(request).await?;
    if !status.is_success() {
        let message = server_message(status, &answer);
        return Err(match status.as_u16() {
            400 | 422 => Error::invalid(message),
            _ => Error::auth(format!("The UwUMail server made no app password: {message}")),
        });
    }
    let made: AppPassword = serde_json::from_slice(&answer)
        .map_err(|_| Error::auth("The UwUMail server's app password isn't readable."))?;
    if made.username.trim().is_empty() || made.password.is_empty() {
        return Err(Error::auth("The UwUMail server's app password is incomplete."));
    }
    Ok(made)
}

/// The whole sign-in: register (or reuse the registration), open the server's page in the browser,
/// wait for the answer, and trade it for an app password named `name`. `open_url` opens the system
/// browser. On a computer the answer comes to a loopback listener, on a phone through the app link.
pub async fn sign_in(
    http: &reqwest::Client,
    meta: &ServerMetadata,
    clients: &Clients,
    name: &str,
    login_hint: &str,
    open_url: &(dyn Fn(&str) + Send + Sync),
    redirect: Redirect,
) -> Result<AppPassword> {
    let name = app_password_name(name)?;
    let mut receiver = Receiver::from(redirect);
    let redirect_uri = receiver.prepare(LOOPBACK, LOOPBACK_PATH).await?;
    // Registered once for every port: the server matches loopback addresses without it.
    let registered_uri =
        if receiver.is_app_link() { redirect_uri.clone() } else { format!("{LOOPBACK}{LOOPBACK_PATH}") };
    let client_id = match clients.get(&meta.issuer, &registered_uri) {
        Some(id) => id,
        None => {
            let id = register(http, meta, &name, &registered_uri).await?;
            clients.put(&meta.issuer, &registered_uri, &id);
            id
        }
    };
    let verifier = oauth::random_token(48)?;
    let state = oauth::random_token(24)?;
    open_url(authorize_url(meta, &client_id, &redirect_uri, &state, &verifier, login_hint).as_str());
    let answered = receiver.wait(&state, LOOPBACK_PATH).await.and_then(|url| code_of(&url, meta));
    let code = match answered {
        Ok(code) => code,
        Err(refused) => {
            // Whatever went wrong, the next sign-in registers afresh.
            clients.forget(&meta.issuer, &registered_uri);
            return Err(refused.error);
        }
    };
    let token = exchange_code(http, meta, &client_id, &code, &redirect_uri, &verifier).await?;
    create_app_password(http, meta, &token, &name).await
}

/// The client for these requests: no redirects, the system's certificate check.
pub(crate) fn http_client() -> Result<reqwest::Client> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = crate::tls::http_client()?
        .user_agent(concat!("UwUMail/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| Error::internal(format!("HTTP client setup failed: {e}")))?;
    Ok(CLIENT.get_or_init(|| client).clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata_json(issuer: &str) -> serde_json::Value {
        json!({
            "issuer": issuer,
            "authorization_endpoint": format!("{issuer}/oauth/authorize"),
            "token_endpoint": format!("{issuer}/oauth/token"),
            "registration_endpoint": format!("{issuer}/oauth/register"),
            "scopes_supported": ["openid", "mail", "smtp", "dav", "app-password"],
        })
    }

    #[test]
    fn metadata_counts_only_with_the_scope_and_on_the_servers_own_origin() {
        let origin = "https://mail.example.com";
        let good = metadata_json(origin);
        let meta = check_metadata(origin, good.to_string().as_bytes()).expect("a UwUMail server");
        assert_eq!(meta.app_password_endpoint(), "https://mail.example.com/oauth/app-password");

        let mut older = good.clone();
        older["scopes_supported"] = json!(["openid", "mail"]);
        assert_eq!(check_metadata(origin, older.to_string().as_bytes()), None, "an older server");

        let mut elsewhere = good.clone();
        elsewhere["token_endpoint"] = json!("https://collector.example.net/oauth/token");
        assert_eq!(check_metadata(origin, elsewhere.to_string().as_bytes()), None, "the code stays home");

        let mut plain = good.clone();
        plain["authorization_endpoint"] = json!("http://mail.example.com/oauth/authorize");
        assert_eq!(check_metadata(origin, plain.to_string().as_bytes()), None);

        let other = metadata_json("https://other.example.com");
        assert_eq!(check_metadata(origin, other.to_string().as_bytes()), None, "another issuer");

        let mut trailing = good;
        trailing["issuer"] = json!("https://mail.example.com/");
        assert!(check_metadata(origin, trailing.to_string().as_bytes()).is_some());
        assert_eq!(check_metadata(origin, b"<html>"), None);
    }

    #[test]
    fn app_password_names_are_trimmed_and_short() {
        assert_eq!(app_password_name("  Lorins MacBook ").unwrap(), "Lorins MacBook");
        assert_eq!(app_password_name("a\tb").unwrap(), "a b");
        assert!(app_password_name("   ").is_err());
        assert!(app_password_name(&"x".repeat(81)).is_err());
        assert_eq!(app_password_name(&"ä".repeat(80)).unwrap().chars().count(), 80);
    }

    #[test]
    fn the_authorize_page_asks_for_an_app_password_with_pkce() {
        let meta = check_metadata(
            "https://mail.example.com",
            metadata_json("https://mail.example.com").to_string().as_bytes(),
        )
        .unwrap();
        let url = authorize_url(&meta, "uwu-1", "app.uwumail://oauth", "st", "verifier", "mini@example.com");
        let pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(url.path(), "/oauth/authorize");
        assert_eq!(pairs["scope"], "app-password");
        assert_eq!(pairs["code_challenge_method"], "S256");
        assert_eq!(pairs["code_challenge"], oauth::pkce_challenge("verifier"));
        assert_eq!(pairs["redirect_uri"], "app.uwumail://oauth");
        assert_eq!(pairs["state"], "st");
    }

    #[test]
    fn an_answer_from_another_issuer_is_refused() {
        let meta = check_metadata(
            "https://mail.example.com",
            metadata_json("https://mail.example.com").to_string().as_bytes(),
        )
        .unwrap();
        let ours = Url::parse("app.uwumail://oauth?code=c1&state=s&iss=https%3A%2F%2Fmail.example.com").unwrap();
        assert_eq!(code_of(&ours, &meta).unwrap(), "c1");
        let theirs = Url::parse("app.uwumail://oauth?code=c1&state=s&iss=https%3A%2F%2Fevil.example.net").unwrap();
        assert!(code_of(&theirs, &meta).is_err());
        let denied = Url::parse("app.uwumail://oauth?error=access_denied&state=s").unwrap();
        assert!(code_of(&denied, &meta).is_err());
    }

    #[test]
    fn registrations_are_reused_until_forgotten() {
        let clients = Clients::default();
        assert_eq!(clients.get("https://a.example", "r"), None);
        clients.put("https://a.example", "r", "id1");
        assert_eq!(clients.get("https://a.example", "r").as_deref(), Some("id1"));
        assert_eq!(clients.get("https://a.example", "other"), None, "per redirect address");
        clients.forget("https://a.example", "r");
        assert_eq!(clients.get("https://a.example", "r"), None);
    }

    #[test]
    fn server_errors_become_one_short_line() {
        let status = reqwest::StatusCode::BAD_REQUEST;
        assert_eq!(server_message(status, br#"{"title":"Bad","detail":"Name too long"}"#), "Name too long");
        assert_eq!(server_message(status, br#"{"error":"insufficient_scope"}"#), "insufficient_scope");
        assert_eq!(server_message(status, b"<html>"), "HTTP 400 Bad Request");
        assert_eq!(server_message(status, format!(r#"{{"detail":"{}"}}"#, "x".repeat(500)).as_bytes()).len(), 300);
    }
}
