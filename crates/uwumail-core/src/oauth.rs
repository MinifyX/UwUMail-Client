//! OAuth 2.0 sign-in for providers that no longer accept passwords over IMAP.
//!
//! Authorization code flow with PKCE and a loopback redirect: the system
//! browser shows the provider's page, and a one-shot HTTP listener on
//! 127.0.0.1 receives the code. Client ids are compiled in from
//! `UWUMAIL_MICROSOFT_CLIENT_ID`, `UWUMAIL_GOOGLE_CLIENT_ID` and
//! `UWUMAIL_GOOGLE_CLIENT_SECRET` (Google's "secret" for desktop apps is not
//! confidential). See docs/oauth.md.

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::error::{Error, Result};
use crate::model::OAuthProvider;

const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

struct ProviderConfig {
    client_id: &'static str,
    client_secret: Option<&'static str>,
    authorize_url: &'static str,
    token_url: &'static str,
    /// What the token for mail is asked with, when that isn't everything: Microsoft gives one
    /// token per resource (Outlook for IMAP/SMTP, Graph for calendars and contacts).
    mail_scopes: Option<&'static str>,
    redirect_host: &'static str,
    extra: &'static [(&'static str, &'static str)],
}

/// Microsoft's mail token: IMAP and SMTP on outlook.office.com. Mailboxes signed in before
/// calendars came along consented to exactly these, so refreshing with them always works.
pub const MICROSOFT_MAIL_SCOPES: &str =
    "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send";
/// Exchange Web Services (Autodiscover of shared mailboxes). Same resource as IMAP, so it lands in
/// the mail token once consented.
pub const MICROSOFT_EWS_SCOPE: &str = "https://outlook.office.com/EWS.AccessAsUser.All";
/// Microsoft Graph for calendars and contacts, own and shared ones. A token of its own.
pub const MICROSOFT_GRAPH_SCOPES: &str = "https://graph.microsoft.com/Calendars.ReadWrite \
https://graph.microsoft.com/Calendars.ReadWrite.Shared https://graph.microsoft.com/Contacts.ReadWrite \
https://graph.microsoft.com/Contacts.ReadWrite.Shared https://graph.microsoft.com/User.Read offline_access";
/// Graph without the shared permissions, for a sign-in that wasn't given those (e.g. a personal
/// account that doesn't offer them).
pub const MICROSOFT_GRAPH_OWN_SCOPES: &str = "https://graph.microsoft.com/Calendars.ReadWrite \
https://graph.microsoft.com/Contacts.ReadWrite https://graph.microsoft.com/User.Read offline_access";
/// Google gives one token for everything the sign-in was allowed.
pub const GOOGLE_CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar";
pub const GOOGLE_CONTACTS_SCOPE: &str = "https://www.googleapis.com/auth/contacts";

/// What the sign-in page asks consent for: mail first (its token is the one the code is exchanged
/// for), then Exchange Web Services and Graph.
const MICROSOFT_SIGN_IN_SCOPES: &str = "offline_access https://outlook.office.com/IMAP.AccessAsUser.All \
https://outlook.office.com/SMTP.Send https://outlook.office.com/EWS.AccessAsUser.All \
https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Calendars.ReadWrite.Shared \
https://graph.microsoft.com/Contacts.ReadWrite https://graph.microsoft.com/Contacts.ReadWrite.Shared \
https://graph.microsoft.com/User.Read";
/// The code is exchanged for the Outlook token, with Exchange Web Services in it.
const MICROSOFT_EXCHANGE_SCOPES: &str = "offline_access https://outlook.office.com/IMAP.AccessAsUser.All \
https://outlook.office.com/SMTP.Send https://outlook.office.com/EWS.AccessAsUser.All";
/// Personal Microsoft accounts (outlook.com, hotmail.*, live.*, ...) have neither shared mailboxes
/// nor Exchange Web Services for UwUMail: asking for those could fail the whole sign-in.
const MICROSOFT_PERSONAL_SIGN_IN_SCOPES: &str = "offline_access https://outlook.office.com/IMAP.AccessAsUser.All \
https://outlook.office.com/SMTP.Send https://graph.microsoft.com/Calendars.ReadWrite \
https://graph.microsoft.com/Contacts.ReadWrite https://graph.microsoft.com/User.Read";

/// What a sign-in as `login_hint` asks consent for, and what the code is then exchanged for (None:
/// whatever the consent covered). Personal Microsoft accounts get the set without shared calendars,
/// shared contacts and Exchange Web Services; company accounts everything.
pub fn sign_in_scopes(provider: OAuthProvider, login_hint: &str) -> (&'static str, Option<&'static str>) {
    match provider {
        OAuthProvider::Microsoft if crate::shared::is_personal_address(login_hint) => {
            (MICROSOFT_PERSONAL_SIGN_IN_SCOPES, Some(MICROSOFT_MAIL_SCOPES))
        }
        OAuthProvider::Microsoft => (MICROSOFT_SIGN_IN_SCOPES, Some(MICROSOFT_EXCHANGE_SCOPES)),
        OAuthProvider::Google => (GOOGLE_SIGN_IN_SCOPES, None),
    }
}

/// The Graph scopes a refresh asks for: personal accounts only their own calendars and contacts.
pub fn graph_scopes(personal: bool) -> &'static str {
    if personal { MICROSOFT_GRAPH_OWN_SCOPES } else { MICROSOFT_GRAPH_SCOPES }
}

const GOOGLE_SIGN_IN_SCOPES: &str =
    "https://mail.google.com/ https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/contacts";

/// The app's own link that phones come back to after signing in. Registered with Microsoft next to
/// `http://localhost` (docs/oauth.md), and with the system: Android's manifest, iOS' Info.plist.
pub const APP_LINK: &str = "app.uwumail://oauth";

fn config(provider: OAuthProvider) -> Result<ProviderConfig> {
    let missing = || {
        Error::oauth_not_configured(
            "This build of UwUMail has no OAuth client id for this provider. See docs/oauth.md to set one up.",
        )
    };
    Ok(match provider {
        OAuthProvider::Microsoft => ProviderConfig {
            client_id: option_env!("UWUMAIL_MICROSOFT_CLIENT_ID").filter(|id| !id.is_empty()).ok_or_else(missing)?,
            client_secret: None,
            authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            mail_scopes: Some(MICROSOFT_MAIL_SCOPES),
            redirect_host: "localhost",
            extra: &[("prompt", "select_account")],
        },
        OAuthProvider::Google => ProviderConfig {
            client_id: option_env!("UWUMAIL_GOOGLE_CLIENT_ID").filter(|id| !id.is_empty()).ok_or_else(missing)?,
            client_secret: option_env!("UWUMAIL_GOOGLE_CLIENT_SECRET"),
            authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
            token_url: "https://oauth2.googleapis.com/token",
            mail_scopes: None,
            redirect_host: "127.0.0.1",
            extra: &[("access_type", "offline"), ("prompt", "consent")],
        },
    })
}

#[derive(Debug, Clone)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Duration,
    /// The scopes the access token carries, when the provider says (both do).
    pub scope: Option<String>,
}

impl Tokens {
    /// Whether the token was given `scope`. A provider that didn't say counts as yes; the API
    /// answers for itself then.
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scope.as_deref().is_none_or(|granted| granted.split_whitespace().any(|s| s.eq_ignore_ascii_case(scope)))
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

fn random_token(bytes: usize) -> Result<String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).map_err(|e| Error::internal(format!("No randomness available: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(buffer))
}

pub(crate) fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// The URL of `GET /?code=…&state=… HTTP/1.1`.
fn request_url(request: &str) -> Result<url::Url> {
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| Error::auth("The sign-in page sent an invalid response."))?;
    url::Url::parse(&format!("http://localhost{target}")).map_err(|_| Error::auth("Invalid redirect."))
}

/// Pulls `code` and `state` out of `GET /?code=…&state=… HTTP/1.1`.
#[cfg(test)]
fn parse_redirect(request: &str) -> Result<(String, String)> {
    redirect_parameters(&request_url(request)?)
}

/// Whether a redirect answers this sign-in. Anything on the device can send one (a local program
/// to the loopback port, any app or web page to the app link), so only the matching `state`
/// counts, for a code as well as for an error. Everything else is ignored instead of ending the sign-in.
fn belongs_to(url: &url::Url, state: &str) -> bool {
    url.query_pairs().any(|(key, value)| key == "state" && value == state)
}

/// Waits for the app link that answers this sign-in, skipping any other.
async fn wait_for_app_link(
    incoming: &mut tokio::sync::mpsc::Receiver<String>,
    state: &str,
) -> Result<(String, String)> {
    loop {
        let url = incoming.recv().await.ok_or_else(|| Error::auth("The sign-in was cancelled."))?;
        if let Ok(url) = url::Url::parse(&url)
            && belongs_to(&url, state)
        {
            return redirect_parameters(&url);
        }
    }
}

/// `code` and `state` of a redirect URL, or the error the provider reported.
pub(crate) fn redirect_parameters(url: &url::Url) -> Result<(String, String)> {
    let mut code = None;
    let mut state = None;
    let mut error = None;
    let mut description = String::new();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            "error_description" => description = value.into_owned(),
            _ => {}
        }
    }
    if let Some(error) = error {
        return Err(explain_sign_in_error(&error, &description));
    }
    Ok((code.ok_or_else(|| Error::auth("No authorization code received."))?, state.unwrap_or_default()))
}

/// Turns a refused sign-in into something the person can act on.
///
/// Microsoft states the real reason as an AADSTS code inside
/// `error_description`. The one that matters here is a company tenant that
/// only lets an administrator allow an app: UwUMail asks for mailbox access,
/// which counts as more than signing in, so tenants hand that decision to an
/// admin by default. Nobody signing in can do anything about it themselves,
/// and saying "cancelled" would send them looking in the wrong place.
pub(crate) fn explain_sign_in_error(error: &str, description: &str) -> Error {
    // AADSTS65001: nobody has consented yet. AADSTS90094: the grant needs an admin.
    if description.contains("AADSTS65001") || description.contains("AADSTS90094") {
        return Error::admin_consent_required("This company allows apps only after an administrator agrees.");
    }
    Error::auth(format!("Sign-in was cancelled ({error})."))
}

/// The page where an administrator allows UwUMail for their whole company.
///
/// Naming the domain instead of `common` lands the admin in their own tenant.
/// The page lists exactly the permissions the app registration asks for.
pub fn admin_consent_url(domain: &str) -> Result<String> {
    let config = config(OAuthProvider::Microsoft)?;
    let tenant: String = url::form_urlencoded::byte_serialize(domain.as_bytes()).collect();
    let client_id: String = url::form_urlencoded::byte_serialize(config.client_id.as_bytes()).collect();
    Ok(format!("https://login.microsoftonline.com/{tenant}/adminconsent?client_id={client_id}"))
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>UwUMail</title>\
<body style=\"font-family:system-ui;background:#f8f4f6;color:#1c1420;display:grid;place-items:center;height:100vh;margin:0\">\
<div style=\"text-align:center\"><h1 style=\"color:#e11d74\">(◕‿◕✿)</h1><p>All done! You can close this tab and go back to UwUMail.</p>\
<p>Fertig! Du kannst diesen Tab schließen und zu UwUMail zurückkehren.</p></div>";

/// Whether signing in with `provider` can come back through the app's own link. Microsoft takes it
/// for "Mobile and desktop applications"; Google can't: its desktop clients only allow the loopback, so a phone signs in to Google through the loopback as
/// well, which works while the app keeps running behind the browser.
pub fn takes_app_link(provider: OAuthProvider) -> bool {
    match provider {
        OAuthProvider::Microsoft => true,
        OAuthProvider::Google => false,
    }
}

/// Where the provider sends the browser back to.
pub enum Redirect {
    /// A one-shot HTTP listener on 127.0.0.1 (desktop).
    Loopback,
    /// The app's own link, e.g. `app.uwumail://oauth` on Android: the platform hands
    /// every URL it was opened with to the waiting sign-in, which picks its own.
    App { uri: String, incoming: tokio::sync::mpsc::Receiver<String> },
}

/// Runs the whole browser sign-in. `open_url` must open the system browser.
pub async fn sign_in(
    http: &reqwest::Client,
    provider: OAuthProvider,
    login_hint: &str,
    open_url: &(dyn Fn(&str) + Send + Sync),
    redirect: Redirect,
) -> Result<Tokens> {
    let config = config(provider)?;
    let (redirect_uri, receiver) = match redirect {
        Redirect::Loopback => {
            let listeners = loopback_listeners().await?;
            let port = listeners[0].local_addr()?.port();
            (format!("http://{}:{port}", config.redirect_host), Receiver::Loopback(listeners))
        }
        Redirect::App { uri, incoming } => (uri, Receiver::App(incoming)),
    };
    let verifier = random_token(48)?;
    let state = random_token(24)?;
    let (scopes, exchange) = sign_in_scopes(provider, login_hint);

    let mut authorize = url::Url::parse(config.authorize_url).map_err(|e| Error::internal(e.to_string()))?;
    authorize
        .query_pairs_mut()
        .append_pair("client_id", config.client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", scopes)
        .append_pair("code_challenge", &pkce_challenge(&verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("login_hint", login_hint)
        .extend_pairs(config.extra.iter().copied());
    open_url(authorize.as_str());

    let listeners = match receiver {
        Receiver::Loopback(listeners) => listeners,
        Receiver::App(mut incoming) => {
            let (code, _state) = tokio::time::timeout(SIGN_IN_TIMEOUT, wait_for_app_link(&mut incoming, &state))
                .await
                .map_err(|_| Error::auth("Sign-in took too long. Please try again."))??;
            return exchange_code(http, &config, code, redirect_uri, verifier, exchange).await;
        }
    };
    let (code, _state) = tokio::time::timeout(SIGN_IN_TIMEOUT, wait_for_loopback(listeners, state))
        .await
        .map_err(|_| Error::auth("Sign-in took too long. Please try again."))??;
    exchange_code(http, &config, code, redirect_uri, verifier, exchange).await
}

/// Listeners on one port of both loopback addresses. Microsoft's redirect names `localhost`, which a
/// browser may try as `[::1]` first: with that port taken by UwUMail too, no other program on this
/// computer can wait there for the code (audit CC-4). Without IPv6 the IPv4 one does alone.
async fn loopback_listeners() -> Result<Vec<TcpListener>> {
    for _ in 0..8 {
        let v4 = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = v4.local_addr()?.port();
        match TcpListener::bind(("::1", port)).await {
            Ok(v6) => return Ok(vec![v4, v6]),
            // Somebody else has that port on [::1]: another one.
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(_) => return Ok(vec![v4]),
        }
    }
    Err(Error::internal("No free port for the sign-in on this computer."))
}

/// How long one connection to the loopback listener may take to send its request.
const REQUEST_WAIT: Duration = Duration::from_secs(10);

/// Waits for the browser's redirect with this sign-in's `state`. Every connection is answered on
/// its own, so one that says nothing, breaks off or sends something else neither holds up nor ends
/// the sign-in: any program on the device can connect to the port.
async fn wait_for_loopback(listeners: Vec<TcpListener>, state: String) -> Result<(String, String)> {
    let (found, mut answers) = tokio::sync::mpsc::channel(1);
    let (accepted_tx, mut accepted) = tokio::sync::mpsc::channel(16);
    // Dropped on return, which stops them.
    let mut acceptors = tokio::task::JoinSet::new();
    for listener in listeners {
        let accepted_tx = accepted_tx.clone();
        acceptors.spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((socket, _)) => {
                        if accepted_tx.send(socket).await.is_err() {
                            return;
                        }
                    }
                    // Out of file handles, say: give the ones in use a moment to close.
                    Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
                }
            }
        });
    }
    drop(accepted_tx);
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            Some(result) = answers.recv() => return result,
            socket = accepted.recv() => {
                let Some(socket) = socket else {
                    return Err(Error::internal("The sign-in stopped listening."));
                };
                // Finished ones are let go of, so a flood of connections holds nothing.
                while connections.try_join_next().is_some() {}
                let (found, state) = (found.clone(), state.clone());
                connections.spawn(async move {
                    if let Ok(Some(result)) = tokio::time::timeout(REQUEST_WAIT, answer(socket, &state)).await {
                        let _ = found.send(result).await;
                    }
                });
            }
        }
    }
}

/// Answers one connection to the loopback listener: the redirect of this sign-in, or `None`.
async fn answer(mut socket: tokio::net::TcpStream, state: &str) -> Option<Result<(String, String)>> {
    let mut buffer = vec![0u8; 8192];
    let read = socket.read(&mut buffer).await.ok()?;
    let request = String::from_utf8_lossy(&buffer[..read]).to_string();
    // Browsers also ask for /favicon.ico; only the redirect carries a query.
    if !request.starts_with("GET /?") {
        let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
        return None;
    }
    let url = match request_url(&request) {
        Ok(url) if belongs_to(&url, state) => url,
        _ => {
            let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n").await;
            return None;
        }
    };
    let result = redirect_parameters(&url);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{DONE_PAGE}",
        DONE_PAGE.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    Some(result)
}

enum Receiver {
    Loopback(Vec<TcpListener>),
    App(tokio::sync::mpsc::Receiver<String>),
}

async fn exchange_code(
    _http: &reqwest::Client,
    config: &ProviderConfig,
    code: String,
    redirect_uri: String,
    verifier: String,
    exchange: Option<&str>,
) -> Result<Tokens> {
    let mut form = vec![
        ("client_id", config.client_id.to_string()),
        ("grant_type", "authorization_code".into()),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
    ];
    if let Some(secret) = config.client_secret {
        form.push(("client_secret", secret.to_string()));
    }
    if let Some(scope) = exchange {
        // Consent covered several resources; the code becomes the Outlook token.
        form.push(("scope", scope.to_string()));
    }
    request_tokens(config.token_url, &form, false).await
}

/// Where refresh tokens are redeemed, and as which app.
#[derive(Debug, Clone)]
pub struct TokenEndpoint {
    pub url: String,
    pub client_id: String,
    pub client_secret: Option<String>,
}

pub fn token_endpoint(provider: OAuthProvider) -> Result<TokenEndpoint> {
    let config = config(provider)?;
    Ok(TokenEndpoint {
        url: config.token_url.to_string(),
        client_id: config.client_id.to_string(),
        client_secret: config.client_secret.map(String::from),
    })
}

/// A fresh access token for mail (IMAP and SMTP).
pub async fn refresh(_http: &reqwest::Client, provider: OAuthProvider, refresh_token: &str) -> Result<Tokens> {
    let config = config(provider)?;
    let endpoint = token_endpoint(provider)?;
    refresh_at(&endpoint, refresh_token, config.mail_scopes, false).await
}

/// A fresh access token for `scope` (all the sign-in allowed when `None`). With `api`, a refresh
/// token that doesn't cover the scope, or no longer works, comes back as "sign in again" instead
/// of a refused sign-in: it's about calendars and contacts then, and mail goes on.
pub async fn refresh_at(
    endpoint: &TokenEndpoint,
    refresh_token: &str,
    scope: Option<&str>,
    api: bool,
) -> Result<Tokens> {
    let mut form = vec![
        ("client_id", endpoint.client_id.clone()),
        ("grant_type", "refresh_token".into()),
        ("refresh_token", refresh_token.to_string()),
    ];
    if let Some(secret) = &endpoint.client_secret {
        form.push(("client_secret", secret.clone()));
    }
    if let Some(scope) = scope {
        form.push(("scope", scope.to_string()));
    }
    request_tokens(&endpoint.url, &form, api).await
}

/// Whether a refused refresh means the person has to sign in again: no consent for what was asked
/// (Microsoft: AADSTS65001, `consent_required`, `interaction_required`, `invalid_scope`), or a
/// refresh token that ran out or was revoked (`invalid_grant`).
pub(crate) fn needs_new_sign_in(error: &str, description: &str) -> bool {
    matches!(error, "invalid_grant" | "interaction_required" | "consent_required" | "invalid_scope")
        || ["AADSTS65001", "AADSTS65004", "AADSTS70000", "AADSTS70011", "AADSTS50076", "AADSTS50079"]
            .iter()
            .any(|code| description.contains(code))
}

/// Whether only an administrator can allow what was asked for (AADSTS90094, or 65001 with an admin).
pub(crate) fn needs_admin(description: &str) -> bool {
    description.contains("AADSTS90094") || description.contains("AADSTS90008")
}

/// The client for the token endpoint: no redirects, so the code, its verifier and refresh tokens
/// only ever go to the provider's own address.
fn token_client() -> Result<reqwest::Client> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = crate::tls::http_client()?
        .user_agent(concat!("UwUMail/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| Error::internal(format!("HTTP client setup failed: {e}")))?;
    Ok(CLIENT.get_or_init(|| client).clone())
}

/// Token answers are small; a bigger one isn't one.
const MAX_TOKEN_ANSWER: usize = 256 * 1024;

async fn request_tokens(url: &str, form: &[(&str, String)], api: bool) -> Result<Tokens> {
    let mut response = token_client()?.post(url).form(form).send().await?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > MAX_TOKEN_ANSWER {
            return Err(Error::auth("The provider's answer to the sign-in is too big."));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8_lossy(&bytes);
    if !status.is_success() {
        let parsed = serde_json::from_str::<TokenError>(&body).ok();
        if api && let Some(parsed) = &parsed {
            let description = parsed.error_description.as_deref().unwrap_or_default();
            if needs_admin(description) {
                return Err(Error::admin_consent_required(
                    "This company allows calendars and contacts in apps only after an administrator agrees.",
                ));
            }
            if needs_new_sign_in(&parsed.error, description) {
                return Err(Error::sign_in_again("Sign in again to see calendar and contacts."));
            }
        }
        let message =
            parsed.map(|e| e.error_description.unwrap_or(e.error)).unwrap_or_else(|| format!("HTTP {status}"));
        return Err(Error::auth(format!("The provider refused the sign-in: {message}")));
    }
    let tokens: TokenResponse =
        serde_json::from_str(&body).map_err(|_| Error::auth("The provider's answer to the sign-in isn't readable."))?;
    Ok(Tokens {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: Duration::from_secs(tokens.expires_in.unwrap_or(3600)),
        scope: tokens.scope,
    })
}

/// SASL XOAUTH2 initial response for IMAP and SMTP.
pub fn xoauth2(user: &str, access_token: &str) -> String {
    const SOH: char = 1 as char;
    format!("user={user}{SOH}auth=Bearer {access_token}{SOH}{SOH}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_example() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn reads_code_and_state_from_the_redirect() {
        let (code, state) =
            parse_redirect("GET /?code=abc%2F123&state=xyz HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
        assert_eq!(code, "abc/123");
        assert_eq!(state, "xyz");
        assert!(parse_redirect("GET /?error=access_denied HTTP/1.1\r\n").is_err());
    }

    #[test]
    fn personal_microsoft_accounts_ask_for_no_shared_or_ews_scopes() {
        // Microsoft's own consumer domains (nothing is sent there).
        for personal in ["mini@outlook.com", "mini@hotmail.de", "mini@live.com"] {
            let (authorize, exchange) = sign_in_scopes(OAuthProvider::Microsoft, personal);
            assert!(!authorize.contains(".Shared"), "{personal}");
            assert!(!authorize.contains("EWS"), "{personal}");
            for wanted in [
                "IMAP.AccessAsUser.All",
                "SMTP.Send",
                "offline_access",
                "Calendars.ReadWrite",
                "Contacts.ReadWrite",
                "User.Read",
            ] {
                assert!(authorize.contains(wanted), "{personal}: {wanted}");
            }
            assert_eq!(exchange, Some(MICROSOFT_MAIL_SCOPES));
        }
        let (authorize, exchange) = sign_in_scopes(OAuthProvider::Microsoft, "alex@contoso.example");
        for wanted in
            ["Calendars.ReadWrite.Shared", "Contacts.ReadWrite.Shared", "EWS.AccessAsUser.All", "IMAP.AccessAsUser.All"]
        {
            assert!(authorize.contains(wanted), "{wanted}");
        }
        assert!(exchange.unwrap().contains("EWS.AccessAsUser.All"));
        assert_eq!(sign_in_scopes(OAuthProvider::Google, "mini@example.com").1, None);
        assert!(!graph_scopes(true).contains(".Shared"));
        assert!(graph_scopes(false).contains("Calendars.ReadWrite.Shared"));
    }

    #[test]
    fn only_microsoft_comes_back_through_the_app_link() {
        assert!(takes_app_link(OAuthProvider::Microsoft));
        assert!(!takes_app_link(OAuthProvider::Google), "Google's desktop clients only take the loopback");
        assert_eq!(url::Url::parse(APP_LINK).unwrap().scheme(), "app.uwumail");
    }

    #[test]
    fn reads_the_app_link_redirect() {
        let url = url::Url::parse("app.uwumail://oauth?code=abc&state=xyz").unwrap();
        assert_eq!(redirect_parameters(&url).unwrap(), ("abc".to_string(), "xyz".to_string()));
        let cancelled = url::Url::parse("app.uwumail://oauth?error=access_denied&state=xyz").unwrap();
        assert!(redirect_parameters(&cancelled).is_err());
    }

    #[tokio::test]
    async fn foreign_links_dont_end_the_sign_in() {
        let (sender, mut incoming) = tokio::sync::mpsc::channel(8);
        for forged in [
            "app.uwumail://oauth?code=evil&state=guess",
            "app.uwumail://oauth?error=access_denied",
            "app.uwumail://oauth?error=access_denied&state=guess",
            "not a url",
        ] {
            sender.send(forged.to_string()).await.unwrap();
        }
        sender.send("app.uwumail://oauth?code=real&state=ours".to_string()).await.unwrap();
        assert_eq!(wait_for_app_link(&mut incoming, "ours").await.unwrap(), ("real".into(), "ours".into()));

        sender.send("app.uwumail://oauth?error=access_denied&state=ours".to_string()).await.unwrap();
        assert!(wait_for_app_link(&mut incoming, "ours").await.is_err(), "a cancel with our state counts");
        drop(sender);
        assert!(wait_for_app_link(&mut incoming, "ours").await.is_err(), "a replaced sign-in ends");
    }

    #[tokio::test]
    async fn other_connections_neither_hold_up_nor_end_a_loopback_sign_in() {
        use tokio::net::TcpStream;

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let waiting = tokio::spawn(wait_for_loopback(vec![listener], "ours".into()));

        // One that connects and says nothing, one that hangs up, and one with a wrong state.
        let _silent = TcpStream::connect(address).await.unwrap();
        drop(TcpStream::connect(address).await.unwrap());
        let mut forged = TcpStream::connect(address).await.unwrap();
        forged.write_all(b"GET /?code=evil&state=guess HTTP/1.1\r\n\r\n").await.unwrap();
        let mut refused = String::new();
        forged.read_to_string(&mut refused).await.unwrap();
        assert!(refused.starts_with("HTTP/1.1 400"), "{refused}");

        let mut browser = TcpStream::connect(address).await.unwrap();
        browser.write_all(b"GET /?code=real&state=ours HTTP/1.1\r\nHost: localhost\r\n\r\n").await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), waiting).await.expect("not held up").unwrap();
        assert_eq!(result.unwrap(), ("real".to_string(), "ours".to_string()));
    }

    #[tokio::test]
    async fn the_sign_in_port_is_taken_on_both_loopback_addresses() {
        use tokio::net::TcpStream;

        let listeners = loopback_listeners().await.unwrap();
        let port = listeners[0].local_addr().unwrap().port();
        let has_v6 = listeners.len() == 2;
        if has_v6 {
            assert_eq!(
                listeners[1].local_addr().unwrap(),
                std::net::SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port))
            );
            assert!(TcpListener::bind(("::1", port)).await.is_err(), "nobody else can wait on [::1]");
        }
        let waiting = tokio::spawn(wait_for_loopback(listeners, "ours".into()));
        // The browser may come on either address; the redirect counts on both.
        let address = if has_v6 { "[::1]" } else { "127.0.0.1" };
        let mut browser = TcpStream::connect(format!("{address}:{port}")).await.unwrap();
        browser.write_all(b"GET /?code=real&state=ours HTTP/1.1\r\nHost: localhost\r\n\r\n").await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), waiting).await.expect("answered").unwrap();
        assert_eq!(result.unwrap(), ("real".to_string(), "ours".to_string()));
    }

    #[test]
    fn tells_an_admin_approval_from_a_cancelled_sign_in() {
        // What a company tenant answers when only admins may allow apps.
        let needs_admin = url::Url::parse(
            "http://localhost/?error=access_denied&error_description=AADSTS65001%3A+The+user+or+administrator+has+not+consented&state=s",
        )
        .unwrap();
        assert_eq!(redirect_parameters(&needs_admin).unwrap_err().code, crate::error::ErrorCode::AdminConsentRequired);
        let grant_needs_admin = url::Url::parse(
            "http://localhost/?error=access_denied&error_description=AADSTS90094%3A+needs+permission+to+access+resources&state=s",
        )
        .unwrap();
        assert_eq!(
            redirect_parameters(&grant_needs_admin).unwrap_err().code,
            crate::error::ErrorCode::AdminConsentRequired
        );
        // Someone who simply closed the page is not an admin problem.
        let cancelled = url::Url::parse("http://localhost/?error=access_denied&state=s").unwrap();
        assert_eq!(redirect_parameters(&cancelled).unwrap_err().code, crate::error::ErrorCode::AuthFailed);
    }

    #[test]
    fn builds_the_xoauth2_string() {
        assert_eq!(xoauth2("a@b.c", "tok").as_bytes(), b"user=a@b.c\x01auth=Bearer tok\x01\x01");
    }
}
