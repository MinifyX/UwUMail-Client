//! Remote images of a mail, fetched so the reader can look at their pixels.
//!
//! The reader recolors light images for its dark mode. The web view may show a
//! remote image but never lets the page read it, so the engine fetches a copy.
//! This only runs for images the web view is already loading (the reader asks
//! only when remote content is allowed for the mail), and only from public
//! websites: a mail must not make UwUMail read anything from the local network.

use std::time::Duration;

use tokio::sync::Semaphore;
use url::Url;

use crate::error::{Error, Result};
use crate::pictures::sniff_image;

const TIMEOUT: Duration = Duration::from_secs(10);
/// Larger images are photos; there's nothing to recolor in them anyway.
const MAX_BYTES: usize = 4 * 1024 * 1024;
const PARALLEL_FETCHES: usize = 4;

/// `http` or `https` on a name under a known public suffix: no IP address, no
/// `localhost`, no name that only exists in the local network, no login in the URL.
pub fn is_public_image_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.host(), Some(url::Host::Domain(host))
            if psl::suffix(host.trim_end_matches('.').as_bytes()).is_some_and(|suffix| suffix.is_known()))
}

pub struct MailImages {
    http: reqwest::Client,
    permits: Semaphore,
}

impl MailImages {
    pub fn new() -> Result<Self> {
        let http = crate::tls::http_client()?
            .user_agent(concat!("UwUMail/", env!("CARGO_PKG_VERSION")))
            .timeout(TIMEOUT)
            .referer(false)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 {
                    attempt.error("too many redirects")
                } else if is_public_image_url(attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(|e| Error::internal(format!("HTTP client setup failed: {e}")))?;
        Ok(Self { http, permits: Semaphore::new(PARALLEL_FETCHES) })
    }

    /// The image's bytes, or `None` when the address isn't public, nothing answered,
    /// or the answer isn't an image of a sensible size.
    pub async fn get(&self, url: &str) -> Option<Vec<u8>> {
        let url = Url::parse(url).ok().filter(is_public_image_url)?;
        let _permit = self.permits.acquire().await.ok()?;
        let mut response = self.http.get(url).send().await.ok()?;
        if !response.status().is_success() || response.content_length().is_some_and(|n| n > MAX_BYTES as u64) {
            return None;
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            body.extend_from_slice(&chunk);
            if body.len() > MAX_BYTES {
                return None;
            }
        }
        matches!(sniff_image(&body), Some("png" | "jpg" | "gif" | "webp" | "svg")).then_some(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn public(url: &str) -> bool {
        is_public_image_url(&Url::parse(url).unwrap())
    }

    #[test]
    fn only_fetches_from_public_websites() {
        assert!(public("https://img.shop.example.com/banner.png"));
        assert!(public("http://news.example.de/logo.gif?x=1"));
        assert!(!public("https://localhost/a.png"));
        assert!(!public("http://192.168.1.1/a.png"));
        assert!(!public("http://[::1]/a.png"));
        assert!(!public("https://printer.local/a.png"));
        assert!(!public("https://intranet/a.png"));
        assert!(!public("https://user:secret@shop.example.com/a.png"));
        assert!(!public("ftp://shop.example.com/a.png"));
        assert!(!public("file:///C:/a.png"));
    }
}
