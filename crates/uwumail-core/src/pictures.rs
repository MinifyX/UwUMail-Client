//! Sender pictures for company mail: the brand logo published via BIMI, or
//! otherwise the icon of the sender's website.
//!
//! Only the registrable domain is ever contacted (`news.mail.shop.example`
//! becomes `shop.example`), once per domain, and the result is cached for 30
//! days, so a picture can't tell a sender which mail was read. Personal
//! addresses at mail providers never get a picture.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use tokio::sync::{Mutex as AsyncMutex, OnceCell, Semaphore};
use tokio::time::timeout;
use url::Url;

use crate::error::{Error, Result};

const FRESH_FOR: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// After a failure that looked like being offline, wait before trying the domain again.
const RETRY_OFFLINE_AFTER: Duration = Duration::from_secs(30 * 60);
const TIMEOUT: Duration = Duration::from_secs(8);
const MAX_PAGE: usize = 512 * 1024;
const MAX_IMAGE: usize = 512 * 1024;
const PARALLEL_FETCHES: usize = 4;
/// Icons smaller than this look blurry in an avatar; they're only used when nothing better exists.
const SHARP_WIDTH: u32 = 48;
const EXTENSIONS: &[&str] = &["svg", "png", "jpg", "gif", "webp", "ico"];

/// Mail providers where addresses belong to people, not to the company behind the domain.
const FREEMAIL: &[&str] = &[
    "163.com",
    "126.com",
    "1und1.de",
    "aim.com",
    "aol.com",
    "aol.de",
    "arcor.de",
    "bluewin.ch",
    "btinternet.com",
    "comcast.net",
    "disroot.org",
    "duck.com",
    "email.de",
    "fastmail.com",
    "fastmail.fm",
    "free.fr",
    "freenet.de",
    "gmail.com",
    "gmx.at",
    "gmx.ch",
    "gmx.com",
    "gmx.de",
    "gmx.fr",
    "gmx.net",
    "googlemail.com",
    "hey.com",
    "hotmail.co.uk",
    "hotmail.com",
    "hotmail.de",
    "hotmail.fr",
    "icloud.com",
    "kabelmail.de",
    "laposte.net",
    "libero.it",
    "live.com",
    "live.de",
    "live.fr",
    "mac.com",
    "mail.com",
    "mail.de",
    "mail.ru",
    "mailbox.org",
    "me.com",
    "msn.com",
    "naver.com",
    "o2.pl",
    "onet.pl",
    "online.de",
    "orange.fr",
    "outlook.com",
    "outlook.de",
    "outlook.fr",
    "pm.me",
    "posteo.de",
    "posteo.net",
    "proton.me",
    "protonmail.ch",
    "protonmail.com",
    "qq.com",
    "riseup.net",
    "rocketmail.com",
    "seznam.cz",
    "sfr.fr",
    "sky.com",
    "t-online.de",
    "tuta.com",
    "tuta.io",
    "tutanota.com",
    "tutanota.de",
    "vodafone.de",
    "web.de",
    "wp.pl",
    "yahoo.co.uk",
    "yahoo.com",
    "yahoo.de",
    "yahoo.fr",
    "yandex.com",
    "yandex.ru",
    "ymail.com",
    "zoho.com",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PictureKind {
    /// Made to fill a circle or square: BIMI logos and app icons.
    Logo,
    /// A small symbol that needs a plain background around it: favicons.
    Icon,
}

impl PictureKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Logo => "logo",
            Self::Icon => "icon",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderPicture {
    pub domain: String,
    pub kind: PictureKind,
    pub path: PathBuf,
}

/// The domain whose picture stands for this address, or `None` for mail
/// providers and anything that isn't a public domain name.
pub fn picture_domain(email: &str) -> Option<String> {
    let (_, host) = email.trim().trim_end_matches('>').rsplit_once('@')?;
    let host = match url::Host::parse(host.trim().trim_end_matches('.')).ok()? {
        url::Host::Domain(domain) => domain,
        _ => return None,
    };
    if !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.') {
        return None;
    }
    if !psl::suffix(host.as_bytes()).is_some_and(|suffix| suffix.is_known()) {
        return None;
    }
    let domain = psl::domain_str(&host)?.to_string();
    (!FREEMAIL.contains(&domain.as_str())).then_some(domain)
}

/// Pictures only come from public websites: a web page or logo record must not make UwUMail
/// call `localhost`, an IP address or a name that only exists in the local network.
pub fn is_public_web_url(url: &Url) -> bool {
    url.scheme() == "https"
        && matches!(url.host(), Some(url::Host::Domain(host))
            if psl::suffix(host.trim_end_matches('.').as_bytes()).is_some_and(|suffix| suffix.is_known()))
}

/// The logo URL of a `default._bimi` TXT record, if it publishes one.
pub fn bimi_logo(record: &str) -> Option<Url> {
    let mut tags = record.split(';').map(str::trim).filter(|tag| !tag.is_empty());
    let (key, version) = tags.next()?.split_once('=')?;
    if !key.trim().eq_ignore_ascii_case("v") || !version.trim().eq_ignore_ascii_case("BIMI1") {
        return None;
    }
    let location =
        tags.filter_map(|tag| tag.split_once('=')).find(|(key, _)| key.trim().eq_ignore_ascii_case("l"))?.1.trim();
    Url::parse(location).ok().filter(|url| url.scheme() == "https")
}

/// Icon links of a web page, best first, resolved against `base`.
pub fn icon_links(html: &str, base: &Url) -> Vec<(Url, PictureKind)> {
    let lower = html.to_ascii_lowercase();
    let end = lower.find("</head").unwrap_or(lower.len());
    let mut found: Vec<(i32, Url, PictureKind)> = Vec::new();
    let mut offset = 0;
    while let Some(start) = lower[offset..end].find("<link") {
        let tag_start = offset + start + "<link".len();
        let attributes = attributes(&html[tag_start..end]);
        offset = tag_start;
        let get = |name: &str| attributes.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
        let (Some(rel), Some(href)) = (get("rel"), get("href")) else { continue };
        let Some(url) = base.join(&href.replace("&amp;", "&")).ok().filter(|url| url.scheme() == "https") else {
            continue;
        };
        let rel = rel.to_ascii_lowercase();
        let rel: Vec<&str> = rel.split_ascii_whitespace().collect();
        let largest = get("sizes").map(|sizes| {
            sizes
                .split_ascii_whitespace()
                .map(|size| {
                    if size.eq_ignore_ascii_case("any") {
                        512
                    } else {
                        size.split(['x', 'X']).next().and_then(|n| n.parse::<i32>().ok()).unwrap_or(0)
                    }
                })
                .max()
                .unwrap_or(0)
        });
        let svg = get("type").is_some_and(|t| t.contains("svg")) || url.path().ends_with(".svg");
        let (score, kind) = if rel.iter().any(|r| r.starts_with("apple-touch-icon")) {
            (1000 + largest.unwrap_or(180).min(512), PictureKind::Logo)
        } else if rel.contains(&"icon") {
            match (svg, largest) {
                (true, _) => (900, PictureKind::Icon),
                (false, Some(size)) => (300 + size.min(512), PictureKind::Icon),
                (false, None) if url.path().ends_with(".ico") => (100, PictureKind::Icon),
                (false, None) => (200, PictureKind::Icon),
            }
        } else if rel.contains(&"fluid-icon") {
            (500, PictureKind::Logo)
        } else {
            continue;
        };
        if !found.iter().any(|(_, known, _)| *known == url) {
            found.push((score, url, kind));
        }
    }
    found.sort_by_key(|(score, _, _)| std::cmp::Reverse(*score));
    found.into_iter().map(|(_, url, kind)| (url, kind)).collect()
}

/// `name="value"` pairs of a tag, up to its closing `>`. Names are lowercase.
fn attributes(tag: &str) -> Vec<(String, String)> {
    let bytes = tag.as_bytes();
    let mut pairs = Vec::new();
    let mut i = 0;
    loop {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] == b'>' {
            return pairs;
        }
        let name_start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && !matches!(bytes[i], b'=' | b'>' | b'/') {
            i += 1;
        }
        let name = tag[name_start..i].to_ascii_lowercase();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            pairs.push((name, String::new()));
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let value = match bytes.get(i) {
            Some(quote @ (b'"' | b'\'')) => {
                let start = i + 1;
                let end = tag[start..].find(*quote as char).map_or(tag.len(), |n| start + n);
                i = (end + 1).min(tag.len());
                &tag[start..end]
            }
            _ => {
                let start = i;
                while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
                    i += 1;
                }
                &tag[start..i]
            }
        };
        pairs.push((name, value.trim().to_string()));
    }
}

/// The image format by its first bytes. Web servers often send HTML error pages with image URLs.
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("gif");
    }
    if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    if bytes.starts_with(&[0, 0, 1, 0]) && bytes.len() > 6 {
        return Some("ico");
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).to_ascii_lowercase();
    let head = head.trim_start_matches('\u{feff}').trim_start();
    let looks_like_svg = (head.starts_with("<?xml") || head.starts_with("<svg") || head.starts_with("<!--"))
        && head.contains("<svg")
        && !head.contains("<html");
    looks_like_svg.then_some("svg")
}

/// Pixel width of PNG and ICO files (the largest image of an ICO), for picking sharp icons.
fn pixel_width(bytes: &[u8], format: &str) -> Option<u32> {
    match format {
        "png" if bytes.len() >= 24 => Some(u32::from_be_bytes(bytes[16..20].try_into().ok()?)),
        "ico" => {
            let count = u16::from_le_bytes(bytes.get(4..6)?.try_into().ok()?) as usize;
            (0..count)
                .filter_map(|index| bytes.get(6 + index * 16).map(|&w| if w == 0 { 256 } else { u32::from(w) }))
                .max()
        }
        _ => None,
    }
}

struct Found {
    kind: PictureKind,
    format: &'static str,
    bytes: Vec<u8>,
}

enum Lookup {
    Found(Found),
    Nothing,
    /// Nothing answered at all; probably offline. Don't remember this.
    Unreachable,
}

/// What a UwUMail server keeps for an address.
async fn from_server(server: &crate::jmap::Client, email: &str) -> Lookup {
    match server.sender_picture(email).await {
        Ok(Some((logo, bytes))) => match sniff_image(&bytes) {
            Some(format) => {
                let kind = if logo { PictureKind::Logo } else { PictureKind::Icon };
                Lookup::Found(Found { kind, format, bytes })
            }
            None => Lookup::Nothing,
        },
        Ok(None) => Lookup::Nothing,
        Err(_) => Lookup::Unreachable,
    }
}

pub struct SenderPictures {
    dir: PathBuf,
    /// Through the privacy proxy when one is set, for addresses no UwUMail server looks up for us.
    http: crate::tls::PrivacyClient,
    resolver: OnceCell<Option<hickory_resolver::TokioResolver>>,
    locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    unreachable: Mutex<HashMap<String, Instant>>,
    permits: Semaphore,
}

impl SenderPictures {
    pub fn new(data_dir: &Path) -> Result<Self> {
        fn configure(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
            builder.user_agent(crate::mail_images::AGENT).timeout(TIMEOUT).https_only(true).referer(false).redirect(
                reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() >= 5 {
                        attempt.error("too many redirects")
                    } else if is_public_web_url(attempt.url()) {
                        attempt.follow()
                    } else {
                        attempt.stop()
                    }
                }),
            )
        }
        Ok(Self {
            dir: data_dir.join("pictures"),
            http: crate::tls::PrivacyClient::new(configure),
            resolver: OnceCell::new(),
            locks: Mutex::new(HashMap::new()),
            unreachable: Mutex::new(HashMap::new()),
            permits: Semaphore::new(PARALLEL_FETCHES),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The picture for an address. With `server`, a UwUMail server looks it up for us, so the
    /// sender's website never sees this device; otherwise it is looked up from here.
    pub async fn get(&self, email: &str, server: Option<Arc<crate::jmap::Client>>) -> Result<Option<SenderPicture>> {
        let Some(domain) = picture_domain(email) else { return Ok(None) };
        let lock = self.locks.lock().unwrap().entry(domain.clone()).or_default().clone();
        let _guard = lock.lock().await;

        let cached = self.cached(&domain);
        if let Some((picture, modified)) = &cached
            && modified.elapsed().unwrap_or_default() < FRESH_FOR
        {
            return Ok(picture.clone());
        }
        let stale = cached.and_then(|(picture, _)| picture);
        if self.unreachable.lock().unwrap().get(&domain).is_some_and(|at| at.elapsed() < RETRY_OFFLINE_AFTER) {
            return Ok(stale);
        }

        let lookup = {
            let _permit = self.permits.acquire().await.map_err(|_| Error::internal("Picture fetching stopped."))?;
            match server {
                Some(server) => from_server(&server, email).await,
                None => self.lookup(&domain).await,
            }
        };
        match lookup {
            Lookup::Unreachable => {
                self.unreachable.lock().unwrap().insert(domain, Instant::now());
                Ok(stale)
            }
            Lookup::Nothing => {
                self.store(&domain, None)?;
                Ok(None)
            }
            Lookup::Found(found) => self.store(&domain, Some(found)),
        }
    }

    /// Forgets every cached picture.
    pub fn clear(&self) -> Result<()> {
        match std::fs::remove_dir_all(&self.dir) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err(Error::internal(format!("Couldn't delete the saved pictures: {error}")))
            }
            _ => {
                self.unreachable.lock().unwrap().clear();
                Ok(())
            }
        }
    }

    fn marker(&self, domain: &str) -> PathBuf {
        self.dir.join(format!("{domain}.none"))
    }

    fn file(&self, domain: &str, kind: PictureKind, format: &str) -> PathBuf {
        self.dir.join(format!("{domain}.{}.{format}", kind.as_str()))
    }

    fn cached(&self, domain: &str) -> Option<(Option<SenderPicture>, SystemTime)> {
        let modified = |path: &Path| std::fs::metadata(path).and_then(|m| m.modified()).ok();
        if let Some(time) = modified(&self.marker(domain)) {
            return Some((None, time));
        }
        for kind in [PictureKind::Logo, PictureKind::Icon] {
            for format in EXTENSIONS {
                let path = self.file(domain, kind, format);
                if let Some(time) = modified(&path) {
                    return Some((Some(SenderPicture { domain: domain.to_string(), kind, path }), time));
                }
            }
        }
        None
    }

    fn store(&self, domain: &str, found: Option<Found>) -> Result<Option<SenderPicture>> {
        let fail = |e: std::io::Error| Error::internal(format!("Couldn't save the sender picture: {e}"));
        std::fs::create_dir_all(&self.dir).map_err(fail)?;
        let _ = std::fs::remove_file(self.marker(domain));
        for kind in [PictureKind::Logo, PictureKind::Icon] {
            for format in EXTENSIONS {
                let _ = std::fs::remove_file(self.file(domain, kind, format));
            }
        }
        let Some(found) = found else {
            std::fs::write(self.marker(domain), b"").map_err(fail)?;
            return Ok(None);
        };
        let path = self.file(domain, found.kind, found.format);
        std::fs::write(&path, &found.bytes).map_err(fail)?;
        Ok(Some(SenderPicture { domain: domain.to_string(), kind: found.kind, path }))
    }

    async fn lookup(&self, domain: &str) -> Lookup {
        let mut answered = false;
        if let Some((logo, dns_answered)) = self.bimi(domain).await {
            answered |= dns_answered;
            if let Some(url) = logo
                && let Ok(Some((bytes, _))) = self.download(&url, MAX_IMAGE).await
                && sniff_image(&bytes) == Some("svg")
            {
                return Lookup::Found(Found { kind: PictureKind::Logo, format: "svg", bytes });
            }
        }

        let mut candidates = Vec::new();
        let mut page_answered = false;
        for start in [format!("https://{domain}/"), format!("https://www.{domain}/")] {
            let Ok(url) = Url::parse(&start) else { continue };
            match self.download(&url, MAX_PAGE).await {
                Ok(Some((bytes, final_url))) => {
                    page_answered = true;
                    candidates = icon_links(&String::from_utf8_lossy(&bytes), &final_url);
                    if let Ok(favicon) = final_url.join("/favicon.ico") {
                        candidates.push((favicon, PictureKind::Icon));
                    }
                    break;
                }
                Ok(None) => page_answered = true,
                Err(()) => {}
            }
        }
        answered |= page_answered;
        if candidates.is_empty()
            && let Ok(favicon) = Url::parse(&format!("https://{domain}/favicon.ico"))
        {
            candidates.push((favicon, PictureKind::Icon));
        }

        let mut blurry = None;
        let mut seen = Vec::new();
        for (url, kind) in candidates.into_iter().take(6) {
            if seen.contains(&url) {
                continue;
            }
            seen.push(url.clone());
            let Ok(response) = self.download(&url, MAX_IMAGE).await else { continue };
            answered = true;
            let Some((bytes, _)) = response else { continue };
            let Some(format) = sniff_image(&bytes) else { continue };
            let found = Found { kind, format, bytes };
            if pixel_width(&found.bytes, format).is_some_and(|width| width < SHARP_WIDTH) {
                blurry.get_or_insert(found);
                continue;
            }
            return Lookup::Found(found);
        }
        match (blurry, answered) {
            (Some(found), _) => Lookup::Found(Found { kind: PictureKind::Icon, ..found }),
            (None, true) => Lookup::Nothing,
            (None, false) => Lookup::Unreachable,
        }
    }

    /// The BIMI logo URL and whether DNS answered at all.
    async fn bimi(&self, domain: &str) -> Option<(Option<Url>, bool)> {
        let resolver = self
            .resolver
            .get_or_init(|| async { hickory_resolver::Resolver::builder_tokio().ok()?.build().ok() })
            .await
            .as_ref()?;
        match timeout(TIMEOUT, resolver.txt_lookup(format!("default._bimi.{domain}."))).await {
            Ok(Ok(lookup)) => {
                let logo = lookup.answers().iter().find_map(|record| match &record.data {
                    hickory_resolver::proto::rr::RData::TXT(txt) => {
                        let text: String = txt.txt_data.iter().map(|part| String::from_utf8_lossy(part)).collect();
                        bimi_logo(&text)
                    }
                    _ => None,
                });
                Some((logo, true))
            }
            Ok(Err(error)) => Some((None, error.is_no_records_found() || error.is_nx_domain())),
            Err(_) => Some((None, false)),
        }
    }

    /// `Ok(Some)` with the body and final URL on success, `Ok(None)` when the
    /// server answered with an error or too much data, `Err` when nothing answered.
    async fn download(&self, url: &Url, limit: usize) -> std::result::Result<Option<(Vec<u8>, Url)>, ()> {
        if !is_public_web_url(url) {
            return Ok(None);
        }
        let http = self.http.get().await.map_err(|_| ())?;
        let mut response = http.get(url.clone()).send().await.map_err(|_| ())?;
        let final_url = response.url().clone();
        if !response.status().is_success() {
            return Ok(None);
        }
        if response.content_length().is_some_and(|length| length > limit as u64) {
            return Ok(None);
        }
        let mut body = Vec::new();
        while let Ok(Some(chunk)) = response.chunk().await {
            body.extend_from_slice(&chunk);
            if body.len() > limit {
                // A cut-off page still has its <head>; a cut-off image is useless.
                if limit == MAX_PAGE {
                    body.truncate(limit);
                    break;
                }
                return Ok(None);
            }
        }
        Ok(Some((body, final_url)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_the_main_domain_of_company_addresses() {
        assert_eq!(picture_domain("news@example.org").as_deref(), Some("example.org"));
        assert_eq!(picture_domain("noreply@em.mail.shop.example.co.uk").as_deref(), Some("example.co.uk"));
        assert_eq!(picture_domain("Hallo@Bright-Labs.DE").as_deref(), Some("bright-labs.de"));
        assert_eq!(picture_domain("info@müller.de").as_deref(), Some("xn--mller-kva.de"));
    }

    #[test]
    fn skips_mail_providers_and_private_names() {
        assert_eq!(picture_domain("mini@gmail.com"), None);
        assert_eq!(picture_domain("someone@mail.gmx.net"), None);
        assert_eq!(picture_domain("me@yahoo.co.uk"), None);
        assert_eq!(picture_domain("admin@router.local"), None);
        assert_eq!(picture_domain("root@localhost"), None);
        assert_eq!(picture_domain("x@[127.0.0.1]"), None);
        assert_eq!(picture_domain("not an address"), None);
    }

    #[test]
    fn only_fetches_from_public_websites() {
        let public = |url: &str| is_public_web_url(&Url::parse(url).unwrap());
        assert!(public("https://www.bright-labs.de/icon.png"));
        assert!(!public("http://bright-labs.de/icon.png"));
        assert!(!public("https://192.168.178.1/login"));
        assert!(!public("https://[::1]/"));
        assert!(!public("https://localhost:8443/"));
        assert!(!public("https://router.lan/"));
        assert!(!public("https://nas.internal/"));
    }

    #[test]
    fn reads_bimi_records() {
        let logo = bimi_logo("v=BIMI1; l=https://brand.example/logo.svg; a=https://brand.example/vmc.pem;");
        assert_eq!(logo.unwrap().as_str(), "https://brand.example/logo.svg");
        assert!(bimi_logo("v=BIMI1; l=; a=;").is_none());
        assert!(bimi_logo("v=BIMI1; l=http://brand.example/logo.svg").is_none());
        assert!(bimi_logo("v=spf1 include:_spf.example ~all").is_none());
    }

    #[test]
    fn prefers_app_icons_and_sharp_icons() {
        let base = Url::parse("https://www.shop.example/de/").unwrap();
        let html = r##"<!doctype html><html><head>
            <link rel="icon" href="/favicon-16.png" sizes="16x16">
            <LINK REL='shortcut icon' HREF=favicon.ico>
            <link rel="mask-icon" href="/mask.svg" color="#000">
            <link href="https://cdn.shop.example/touch.png?v=1&amp;x=2" rel="apple-touch-icon" sizes="180x180" />
            <link rel="icon" type="image/png" href="http://insecure.example/icon.png" sizes="192x192">
            <link rel="icon" href="/favicon-96.png" sizes="96x96">
            </head><body><link rel="icon" href="/late.png"></body></html>"##;
        let links: Vec<String> = icon_links(html, &base).into_iter().map(|(url, _)| url.to_string()).collect();
        assert_eq!(
            links,
            [
                "https://cdn.shop.example/touch.png?v=1&x=2",
                "https://www.shop.example/favicon-96.png",
                "https://www.shop.example/favicon-16.png",
                "https://www.shop.example/de/favicon.ico",
            ]
        );
        assert_eq!(icon_links(html, &base)[0].1, PictureKind::Logo);
    }

    #[test]
    fn recognizes_images_and_rejects_error_pages() {
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\n...."), Some("png"));
        assert_eq!(sniff_image(b"<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), Some("svg"));
        assert_eq!(sniff_image(b"<!doctype html><html><body><svg></svg>Not found</body></html>"), None);
        assert_eq!(sniff_image(&[0, 0, 1, 0, 1, 0, 32, 32]), Some("ico"));
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&[0, 0, 0, 16, 0, 0, 0, 16]);
        assert_eq!(pixel_width(&png, "png"), Some(16));
        let mut ico = vec![0, 0, 1, 0, 2, 0];
        ico.extend([16, 16].iter().chain([0; 14].iter()));
        ico.extend([0, 0].iter().chain([0; 14].iter()));
        assert_eq!(pixel_width(&ico, "ico"), Some(256), "width 0 means 256 px");
        ico[22] = 32;
        assert_eq!(pixel_width(&ico, "ico"), Some(32));
    }

    #[test]
    fn caches_results_per_domain() {
        let dir = tempfile::tempdir().unwrap();
        let pictures = SenderPictures::new(dir.path()).unwrap();
        assert!(pictures.cached("shop.example").is_none());
        let found = Found { kind: PictureKind::Logo, format: "svg", bytes: b"<svg/>".to_vec() };
        let stored = pictures.store("shop.example", Some(found)).unwrap().unwrap();
        assert!(stored.path.ends_with("shop.example.logo.svg"));
        assert_eq!(pictures.cached("shop.example").unwrap().0.unwrap().kind, PictureKind::Logo);
        // A later "nothing found" replaces the picture, and other domains stay apart.
        assert!(pictures.cached("example").is_none());
        pictures.store("shop.example", None).unwrap();
        assert!(pictures.cached("shop.example").unwrap().0.is_none());
        assert!(!stored.path.exists());
        pictures.clear().unwrap();
        assert!(pictures.cached("shop.example").is_none());
    }
}
