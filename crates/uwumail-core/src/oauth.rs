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
    scopes: &'static str,
    redirect_host: &'static str,
    extra: &'static [(&'static str, &'static str)],
}

fn config(provider: OAuthProvider) -> Result<ProviderConfig> {
    let missing = || {
        Error::not_supported(
            "This build of UwUMail has no OAuth client id for this provider. See docs/oauth.md to set one up.",
        )
    };
    Ok(match provider {
        OAuthProvider::Microsoft => ProviderConfig {
            client_id: option_env!("UWUMAIL_MICROSOFT_CLIENT_ID").filter(|id| !id.is_empty()).ok_or_else(missing)?,
            client_secret: None,
            authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            scopes: "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
            redirect_host: "localhost",
            extra: &[("prompt", "select_account")],
        },
        OAuthProvider::Google => ProviderConfig {
            client_id: option_env!("UWUMAIL_GOOGLE_CLIENT_ID").filter(|id| !id.is_empty()).ok_or_else(missing)?,
            client_secret: option_env!("UWUMAIL_GOOGLE_CLIENT_SECRET"),
            authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
            token_url: "https://oauth2.googleapis.com/token",
            scopes: "https://mail.google.com/",
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
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
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
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            _ => {}
        }
    }
    if let Some(error) = error {
        return Err(Error::auth(format!("Sign-in was cancelled ({error}).")));
    }
    Ok((code.ok_or_else(|| Error::auth("No authorization code received."))?, state.unwrap_or_default()))
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>UwUMail</title>\
<body style=\"font-family:system-ui;background:#f8f4f6;color:#1c1420;display:grid;place-items:center;height:100vh;margin:0\">\
<div style=\"text-align:center\"><h1 style=\"color:#e11d74\">(◕‿◕✿)</h1><p>All done! You can close this tab and go back to UwUMail.</p>\
<p>Fertig! Du kannst diesen Tab schließen und zu UwUMail zurückkehren.</p></div>";

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
            let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
            let port = listener.local_addr()?.port();
            (format!("http://{}:{port}", config.redirect_host), Receiver::Loopback(listener))
        }
        Redirect::App { uri, incoming } => (uri, Receiver::App(incoming)),
    };
    let verifier = random_token(48)?;
    let state = random_token(24)?;

    let mut authorize = url::Url::parse(config.authorize_url).map_err(|e| Error::internal(e.to_string()))?;
    authorize
        .query_pairs_mut()
        .append_pair("client_id", config.client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", config.scopes)
        .append_pair("code_challenge", &pkce_challenge(&verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("login_hint", login_hint)
        .extend_pairs(config.extra.iter().copied());
    open_url(authorize.as_str());

    let listener = match receiver {
        Receiver::Loopback(listener) => listener,
        Receiver::App(mut incoming) => {
            let (code, _state) = tokio::time::timeout(SIGN_IN_TIMEOUT, wait_for_app_link(&mut incoming, &state))
                .await
                .map_err(|_| Error::auth("Sign-in took too long. Please try again."))??;
            return exchange_code(http, &config, code, redirect_uri, verifier).await;
        }
    };
    let (code, _state) = tokio::time::timeout(SIGN_IN_TIMEOUT, async {
        loop {
            let (mut socket, _) = listener.accept().await?;
            let mut buffer = vec![0u8; 8192];
            let read = socket.read(&mut buffer).await?;
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            // Browsers also ask for /favicon.ico; only the redirect carries a query.
            if !request.starts_with("GET /?") {
                let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
                continue;
            }
            let url = match request_url(&request) {
                Ok(url) if belongs_to(&url, &state) => url,
                _ => {
                    let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n").await;
                    continue;
                }
            };
            let result = redirect_parameters(&url);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{DONE_PAGE}",
                DONE_PAGE.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
            return result;
        }
    })
    .await
    .map_err(|_| Error::auth("Sign-in took too long. Please try again."))??;
    exchange_code(http, &config, code, redirect_uri, verifier).await
}

enum Receiver {
    Loopback(TcpListener),
    App(tokio::sync::mpsc::Receiver<String>),
}

async fn exchange_code(
    http: &reqwest::Client,
    config: &ProviderConfig,
    code: String,
    redirect_uri: String,
    verifier: String,
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
    request_tokens(http, config.token_url, &form).await
}

pub async fn refresh(http: &reqwest::Client, provider: OAuthProvider, refresh_token: &str) -> Result<Tokens> {
    let config = config(provider)?;
    let mut form = vec![
        ("client_id", config.client_id.to_string()),
        ("grant_type", "refresh_token".into()),
        ("refresh_token", refresh_token.to_string()),
    ];
    if let Some(secret) = config.client_secret {
        form.push(("client_secret", secret.to_string()));
    }
    request_tokens(http, config.token_url, &form).await
}

async fn request_tokens(http: &reqwest::Client, url: &str, form: &[(&str, String)]) -> Result<Tokens> {
    let response = http.post(url).form(form).send().await?;
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        let message = serde_json::from_str::<TokenError>(&body)
            .map(|e| e.error_description.unwrap_or(e.error))
            .unwrap_or_else(|_| format!("HTTP {status}"));
        return Err(Error::auth(format!("The provider refused the sign-in: {message}")));
    }
    let tokens: TokenResponse = serde_json::from_str(&body)?;
    Ok(Tokens {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: Duration::from_secs(tokens.expires_in.unwrap_or(3600)),
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

    #[test]
    fn builds_the_xoauth2_string() {
        assert_eq!(xoauth2("a@b.c", "tok").as_bytes(), b"user=a@b.c\x01auth=Bearer tok\x01\x01");
    }
}
