//! Certificate checks for IMAP and HTTPS (SMTP gets the same through lettre's features).
//!
//! Desktop systems check certificates themselves, including ones a company
//! installed. On Android that check would need Java classes loaded before the
//! first connection, so UwUMail uses Mozilla's root list there instead.

use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;

use rustls::ClientConfig;
use tokio::sync::Notify;

use crate::error::{Error, Result};

pub fn install_crypto_provider() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

/// The TLS settings shared by every IMAP connection.
pub fn client_config() -> Result<Arc<ClientConfig>> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    if let Some(config) = CONFIG.get() {
        return Ok(config.clone());
    }
    install_crypto_provider();
    let config = build()?;
    Ok(CONFIG.get_or_init(|| Arc::new(config)).clone())
}

#[cfg(not(target_os = "android"))]
fn build() -> Result<ClientConfig> {
    use rustls_platform_verifier::BuilderVerifierExt;

    Ok(ClientConfig::builder()
        .with_platform_verifier()
        .map_err(|e| Error::internal(format!("TLS setup failed: {e}")))?
        .with_no_client_auth())
}

#[cfg(target_os = "android")]
fn build() -> Result<ClientConfig> {
    let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    Ok(ClientConfig::builder().with_root_certificates(roots).with_no_client_auth())
}

/// The proxy for requests that tell a sender something about the reader: a mail's remote pictures,
/// sender logos and one-click unsubscribes. `None` until the app said what it is; `Some(None)` for
/// "straight from this device". Mail itself, calendars and updates never take it.
static PRIVACY_PROXY: RwLock<Option<Option<String>>> = RwLock::new(None);
static PRIVACY_PROXY_TOLD: Notify = Notify::const_new();
/// How long such a request waits for the app to say which proxy it wants, before it gives up.
const PRIVACY_PROXY_WAIT: Duration = Duration::from_secs(15);

/// Sets the proxy for those requests: `http://host:port` or `socks5://host:port`, optionally with a
/// login; empty for none. Clients built earlier pick it up on their next request.
pub fn set_privacy_proxy(proxy: &str) -> Result<()> {
    let proxy = proxy.trim();
    let proxy = if proxy.is_empty() {
        None
    } else {
        let scheme = proxy.split_once("://").map(|(scheme, _)| scheme.to_ascii_lowercase());
        if !matches!(scheme.as_deref(), Some("http" | "socks5" | "socks5h")) {
            return Err(Error::invalid("The proxy has to start with http://, socks5:// or socks5h://."));
        }
        reqwest::Proxy::all(proxy).map_err(|_| Error::invalid("That is not a proxy address."))?;
        Some(proxy.to_owned())
    };
    *PRIVACY_PROXY.write().unwrap_or_else(|e| e.into_inner()) = Some(proxy);
    PRIVACY_PROXY_TOLD.notify_waiters();
    Ok(())
}

async fn privacy_proxy() -> Result<Option<String>> {
    let deadline = tokio::time::Instant::now() + PRIVACY_PROXY_WAIT;
    loop {
        let told = PRIVACY_PROXY_TOLD.notified();
        if let Some(proxy) = PRIVACY_PROXY.read().unwrap_or_else(|e| e.into_inner()).clone() {
            return Ok(proxy);
        }
        if tokio::time::timeout_at(deadline, told).await.is_err() {
            return Err(Error::internal("The app has not said yet which proxy to use."));
        }
    }
}

/// A client for requests that tell a sender something about the reader. Built with `configure`, through
/// the privacy proxy when one is set, and built anew when it changes.
pub struct PrivacyClient {
    configure: fn(reqwest::ClientBuilder) -> reqwest::ClientBuilder,
    current: Mutex<Option<(Option<String>, reqwest::Client)>>,
}

impl PrivacyClient {
    pub const fn new(configure: fn(reqwest::ClientBuilder) -> reqwest::ClientBuilder) -> PrivacyClient {
        PrivacyClient { configure, current: Mutex::new(None) }
    }

    pub async fn get(&self) -> Result<reqwest::Client> {
        let proxy = privacy_proxy().await?;
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((built_for, client)) = current.as_ref()
            && *built_for == proxy
        {
            return Ok(client.clone());
        }
        let mut builder = (self.configure)(http_client()?);
        if let Some(proxy) = &proxy {
            let proxy =
                reqwest::Proxy::all(proxy.as_str()).map_err(|_| Error::invalid("That is not a proxy address."))?;
            builder = builder.proxy(proxy);
        }
        let client = builder.build().map_err(|e| Error::internal(format!("HTTP client setup failed: {e}")))?;
        *current = Some((proxy, client.clone()));
        Ok(client)
    }
}

/// An HTTP client builder that checks certificates like [`client_config`].
pub fn http_client() -> Result<reqwest::ClientBuilder> {
    install_crypto_provider();
    let builder = reqwest::Client::builder();
    #[cfg(target_os = "android")]
    let builder = {
        let mut config = (*client_config()?).clone();
        config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        builder.tls_backend_preconfigured(config)
    };
    Ok(builder)
}
