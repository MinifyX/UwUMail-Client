//! Certificate checks for IMAP and HTTPS (SMTP gets the same through lettre's features).
//!
//! Desktop systems check certificates themselves, including ones a company
//! installed. On Android that check would need Java classes loaded before the
//! first connection, so UwUMail uses Mozilla's root list there instead.

use std::sync::{Arc, OnceLock};

use rustls::ClientConfig;

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
