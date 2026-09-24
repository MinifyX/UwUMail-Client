//! Remote pictures of a mail. The web view never loads one from its sender itself: it asks the app
//! (`uwuimg:`), and only once the reader let the mail's pictures show. A UwUMail server fetches them for
//! its own accounts; for every other account they come from here, through the privacy proxy when one is
//! set, so the sender at most sees the proxy. Only from addresses with a public host name: no IP
//! address, no `localhost`, no name that only exists in the local network. A public name that the
//! sender points at a local address still gets through (accepted risk I6, as for sender pictures).
//! The reader's dark mode reads the same copies to recolor them.

use std::time::Duration;

use tokio::sync::Semaphore;
use url::Url;

use crate::error::Result;
use crate::pictures::sniff_image;

const TIMEOUT: Duration = Duration::from_secs(10);
/// Newsletters stay far below this; a UwUMail server draws the same line.
const MAX_BYTES: usize = 10 * 1024 * 1024;
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

/// The account and the picture's address from a reader request (`?account=…&url=…`): the web view
/// never loads a remote picture itself, it asks the app for it this way.
pub fn picture_request(query: &str) -> Option<(Option<String>, String)> {
    let mut account = None;
    let mut url = None;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "account" if !value.is_empty() => account = Some(value.into_owned()),
            "url" => url = Some(value.into_owned()),
            _ => {}
        }
    }
    Some((account, url.filter(|url| url.starts_with("https://") || url.starts_with("http://"))?))
}

/// Nothing that tells the sender which program, or which version of it, is looking.
pub(crate) const AGENT: &str = "Mozilla/5.0";

fn configure(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder.user_agent(AGENT).timeout(TIMEOUT).referer(false).redirect(reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            attempt.error("too many redirects")
        } else if is_public_image_url(attempt.url()) {
            attempt.follow()
        } else {
            attempt.stop()
        }
    }))
}

pub struct MailImages {
    /// Through the privacy proxy when one is set: a picture tells its sender who looked, and when.
    http: crate::tls::PrivacyClient,
    permits: Semaphore,
}

impl MailImages {
    pub fn new() -> Result<Self> {
        Ok(Self { http: crate::tls::PrivacyClient::new(configure), permits: Semaphore::new(PARALLEL_FETCHES) })
    }

    /// The image's bytes, or `None` when the address isn't public, nothing answered,
    /// or the answer isn't an image of a sensible size.
    pub async fn get(&self, url: &str) -> Option<Vec<u8>> {
        let url = Url::parse(url).ok().filter(is_public_image_url)?;
        let _permit = self.permits.acquire().await.ok()?;
        let http = self.http.get().await.ok()?;
        let mut response = http.get(url).send().await.ok()?;
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

    #[test]
    fn reader_requests_name_the_account_and_a_web_address() {
        assert_eq!(
            picture_request("account=a1&url=https%3A%2F%2Fcdn.example%2Fa.png%3Fw%3D1%26h%3D2"),
            Some((Some("a1".into()), "https://cdn.example/a.png?w=1&h=2".into()))
        );
        assert_eq!(
            picture_request("url=http%3A%2F%2Fx.example%2Fb.gif"),
            Some((None, "http://x.example/b.gif".into()))
        );
        assert_eq!(picture_request("account=a1&url=file%3A%2F%2F%2Fetc%2Fpasswd"), None);
        assert_eq!(picture_request("account=a1"), None);
    }
}
