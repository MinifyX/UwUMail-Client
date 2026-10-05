//! Sender pictures, looked up per address. With a UwUMail server among the
//! accounts, the server answers for each address: a contact's photo or a
//! person's own picture first, then a company's logo (see the server's
//! `pictureUrl`). Its answers are kept in memory, per address and bounded.
//!
//! Without one, company mail gets the brand logo published via BIMI, or
//! otherwise the icon of the sender's website, looked up from here. Only the
//! registrable domain is ever contacted (`news.mail.shop.example` becomes
//! `shop.example`), once per domain, and the result is cached for 30 days, so
//! a picture can't tell a sender which mail was read. Personal addresses at
//! mail providers never get a picture this way.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use base64::Engine as _;
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
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
/// The largest picture taken from a UwUMail server for one address.
const MAX_SERVER_PICTURE: usize = 2 * 1024 * 1024;
/// Pictures whose header claims more pixels are refused before anything decodes them: a few
/// hundred kilobytes of PNG can claim gigabytes once decoded.
const MAX_PIXELS: u64 = 4096 * 4096;
/// How long a server's answer for an address is kept, found or not.
const ADDRESS_FRESH_FOR: Duration = Duration::from_secs(6 * 60 * 60);
/// After the server didn't answer for an address, wait this long before asking again.
const ADDRESS_RETRY_AFTER: Duration = Duration::from_secs(5 * 60);
/// Bounds of the per-address memory: entries and bytes.
const MAX_ADDRESSES: usize = 2_000;
const MAX_ADDRESS_BYTES: usize = 32 * 1024 * 1024;
/// The longest address looked up (RFC 5321 paths are far shorter).
const MAX_ADDRESS_LEN: usize = 320;

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
    /// A person's picture: a contact's photo or their own profile picture. Fills the circle.
    Photo,
    /// Made to fill a circle or square: BIMI logos and app icons.
    Logo,
    /// A small symbol that needs a plain background around it: favicons.
    Icon,
}

impl PictureKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Photo => "photo",
            Self::Logo => "logo",
            Self::Icon => "icon",
        }
    }

    /// What a server's `X-Picture-Kind` says: a person's photo, a logo, or else a website icon.
    pub fn from_header(header: Option<&str>) -> Self {
        match header.map(|kind| kind.trim().to_ascii_lowercase()).as_deref() {
            Some("photo") => Self::Photo,
            Some("logo") => Self::Logo,
            _ => Self::Icon,
        }
    }
}

/// A picture for the page. Raster pictures cached on disk come as a file for the asset protocol;
/// SVGs and pictures kept only in memory as a `data:` URL, so an SVG is never a document of the
/// app's own origin (security audit W-35) and only ever shows as a picture.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderPicture {
    /// The company domain the picture stands for; `None` for a person's picture.
    pub domain: Option<String>,
    pub kind: PictureKind,
    pub path: Option<PathBuf>,
    pub data_url: Option<String>,
}

/// How a sender picture is looked up.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PictureLookup {
    /// Only what is known without asking another server: the UwUMail server's own pictures
    /// (contacts' photos, people of that server), or what is cached here.
    pub local: bool,
    /// Only a company's logo, never a person's picture.
    pub logo: bool,
    /// Ask again instead of taking the remembered answer, after pictures changed.
    pub fresh: bool,
}

/// A server's answer: the picture's kind and its bytes.
pub type ServerPicture = (PictureKind, Vec<u8>);

/// A UwUMail server that answers picture lookups per address. Its own trait so tests can stand
/// in for the server.
pub trait PictureServer: Send + Sync {
    /// The picture kind and bytes for an address; `Ok(None)` for none, an error when the server
    /// could not be asked.
    fn picture<'a>(&'a self, email: &'a str, lookup: PictureLookup) -> BoxFuture<'a, Result<Option<ServerPicture>>>;
}

impl PictureServer for crate::jmap::Client {
    fn picture<'a>(&'a self, email: &'a str, lookup: PictureLookup) -> BoxFuture<'a, Result<Option<ServerPicture>>> {
        Box::pin(self.sender_picture(email, lookup.local, lookup.logo))
    }
}

/// The address as pictures are looked up and kept: trimmed, lowercase, a local part and a
/// domain name. `None` for anything else, so hostile input never reaches a server.
pub fn picture_address(email: &str) -> Option<String> {
    let address = email.trim().trim_start_matches('<').trim_end_matches('>').trim().to_lowercase();
    if address.len() > MAX_ADDRESS_LEN || address.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let (local, domain) = address.rsplit_once('@')?;
    let domain_ok = !domain.is_empty()
        && !domain.starts_with('.')
        && domain.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '.');
    (!local.is_empty() && domain_ok).then_some(address)
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
pub(crate) fn attributes(tag: &str) -> Vec<(String, String)> {
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

/// Width and height a picture's header claims, read without decoding it: PNG, GIF, JPEG, WebP and
/// icon files (the largest image of an icon, also an embedded PNG). `None` for other formats or
/// when the header can't be read.
fn pixel_size(bytes: &[u8], format: &str) -> Option<(u32, u32)> {
    let be16 = |at: usize| bytes.get(at..at + 2).map(|b| u32::from(u16::from_be_bytes([b[0], b[1]])));
    let le16 = |at: usize| bytes.get(at..at + 2).map(|b| u32::from(u16::from_le_bytes([b[0], b[1]])));
    let le24 = |at: usize| bytes.get(at..at + 3).map(|b| u32::from_le_bytes([b[0], b[1], b[2], 0]));
    let be32 = |at: usize| bytes.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    match format {
        "png" => Some((be32(16)?, be32(20)?)),
        "gif" => Some((le16(6)?, le16(8)?)),
        "webp" => match bytes.get(12..16)? {
            b"VP8X" => Some((le24(24)? + 1, le24(27)? + 1)),
            b"VP8 " => Some((le16(26)? & 0x3fff, le16(28)? & 0x3fff)),
            b"VP8L" => {
                let bits = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
                Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
            }
            _ => None,
        },
        "jpg" => {
            let mut at = 2;
            while at + 4 <= bytes.len() {
                if bytes[at] != 0xFF {
                    return None;
                }
                let marker = bytes[at + 1];
                match marker {
                    0xFF => at += 1,
                    0x01 | 0xD0..=0xD9 => at += 2,
                    0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                        return Some((be16(at + 7)?, be16(at + 5)?));
                    }
                    _ => at += 2 + usize::try_from(be16(at + 2)?).ok()?,
                }
            }
            None
        }
        "ico" => {
            let count = usize::try_from(le16(4)?).ok()?.min(256);
            let mut largest: Option<(u32, u32)> = None;
            for index in 0..count {
                let entry = 6 + index * 16;
                let (Some(&w), Some(&h)) = (bytes.get(entry), bytes.get(entry + 1)) else { break };
                let mut size = (if w == 0 { 256 } else { u32::from(w) }, if h == 0 { 256 } else { u32::from(h) });
                // An entry may hold a whole PNG, whose own header says how big it really is.
                if let Some(offset) =
                    bytes.get(entry + 12..entry + 16).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    && let Some(inner) = usize::try_from(offset).ok().and_then(|offset| bytes.get(offset..))
                    && inner.starts_with(b"\x89PNG\r\n\x1a\n")
                    && let Some(png) = pixel_size(inner, "png")
                {
                    size = png;
                }
                if largest.is_none_or(|(lw, lh)| u64::from(size.0) * u64::from(size.1) > u64::from(lw) * u64::from(lh))
                {
                    largest = Some(size);
                }
            }
            largest
        }
        _ => None,
    }
}

/// Whether a picture's header claims more pixels than a sender picture may have.
fn too_many_pixels(bytes: &[u8], format: &str) -> bool {
    pixel_size(bytes, format).is_some_and(|(width, height)| u64::from(width) * u64::from(height) > MAX_PIXELS)
}

fn media_type(format: &str) -> &'static str {
    match format {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// A picture as a `data:` URL, which a webview only ever shows as a picture.
fn data_url(format: &str, bytes: &[u8]) -> String {
    format!("data:{};base64,{}", media_type(format), base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[derive(Debug)]
struct Found {
    kind: PictureKind,
    format: &'static str,
    bytes: Vec<u8>,
}

/// A server's answer for an address, kept in memory.
struct Remembered {
    found: Option<Arc<Found>>,
    at: Instant,
    /// False when the server couldn't be asked: then it is asked again sooner.
    answered: bool,
}

enum Lookup {
    Found(Found),
    Nothing,
    /// Nothing answered at all; probably offline. Don't remember this.
    Unreachable,
}

/// What a UwUMail server has for an address, checked like any picture from elsewhere.
async fn from_server(server: &dyn PictureServer, email: &str, lookup: PictureLookup) -> Lookup {
    match server.picture(email, lookup).await {
        Ok(Some((kind, bytes))) if bytes.len() <= MAX_SERVER_PICTURE => match sniff_image(&bytes) {
            Some(format) if !too_many_pixels(&bytes, format) => Lookup::Found(Found { kind, format, bytes }),
            _ => Lookup::Nothing,
        },
        Ok(_) => Lookup::Nothing,
        Err(_) => Lookup::Unreachable,
    }
}

/// A server's picture as the page gets it: always as data, it is only kept in memory.
fn shown(address: &str, found: &Found) -> SenderPicture {
    let domain = if found.kind == PictureKind::Photo { None } else { picture_domain(address) };
    SenderPicture { domain, kind: found.kind, path: None, data_url: Some(data_url(found.format, &found.bytes)) }
}

/// A cached picture as the page gets it: raster files through the asset protocol, an SVG as data
/// (W-35). `None` when the file can't be read any more.
fn for_page(picture: SenderPicture) -> Option<SenderPicture> {
    let Some(path) = &picture.path else { return Some(picture) };
    if path.extension().is_some_and(|extension| extension == "svg") {
        let bytes = std::fs::read(path).ok().filter(|bytes| bytes.len() <= MAX_IMAGE)?;
        return Some(SenderPicture { path: None, data_url: Some(data_url("svg", &bytes)), ..picture });
    }
    Some(picture)
}

pub struct SenderPictures {
    dir: PathBuf,
    /// Through the privacy proxy when one is set, for addresses no UwUMail server looks up for us.
    http: crate::tls::PrivacyClient,
    resolver: OnceCell<Option<hickory_resolver::TokioResolver>>,
    locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    unreachable: Mutex<HashMap<String, Instant>>,
    /// A server's answers per (address, local, logo only).
    addresses: Mutex<HashMap<(String, bool, bool), Remembered>>,
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
            addresses: Mutex::new(HashMap::new()),
            permits: Semaphore::new(PARALLEL_FETCHES),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The picture for an address. With `server`, that UwUMail server looks it up per address (a
    /// person's photo first, then a company's logo), so a sender's website or mail server never
    /// sees this device. Otherwise a company's logo is looked up from here, per domain; with
    /// `lookup.local` only what is cached already.
    pub async fn get(
        &self,
        email: &str,
        server: Option<Arc<dyn PictureServer>>,
        lookup: PictureLookup,
    ) -> Result<Option<SenderPicture>> {
        let Some(address) = picture_address(email) else { return Ok(None) };
        match server {
            Some(server) => self.of_address(&address, server.as_ref(), lookup).await,
            None => self.of_domain(&address, lookup.local).await,
        }
    }

    /// A server's picture for an address, remembered for a while.
    async fn of_address(
        &self,
        address: &str,
        server: &dyn PictureServer,
        lookup: PictureLookup,
    ) -> Result<Option<SenderPicture>> {
        let key = (address.to_string(), lookup.local, lookup.logo);
        let known =
            self.addresses.lock().unwrap().get(&key).map(|known| (known.found.clone(), known.at, known.answered));
        if let Some((found, at, answered)) = &known
            && !lookup.fresh
            && at.elapsed() < if *answered { ADDRESS_FRESH_FOR } else { ADDRESS_RETRY_AFTER }
        {
            return Ok(found.as_deref().map(|found| shown(address, found)));
        }
        let answer = {
            let _permit = self.permits.acquire().await.map_err(|_| Error::internal("Picture fetching stopped."))?;
            from_server(server, address, lookup).await
        };
        let (found, answered) = match answer {
            Lookup::Found(found) => (Some(Arc::new(found)), true),
            Lookup::Nothing => (None, true),
            // Offline: what was known stays until the server answers again.
            Lookup::Unreachable => (known.and_then(|(found, _, _)| found), false),
        };
        let picture = found.as_deref().map(|found| shown(address, found));
        self.remember(key, Remembered { found, at: Instant::now(), answered });
        if picture.is_none() && !answered && !lookup.logo {
            // Nothing known for the address yet: a company's logo kept here from before will do.
            return self.of_domain(address, true).await;
        }
        Ok(picture)
    }

    /// Keeps a server's answer, forgetting the oldest ones past the bounds.
    fn remember(&self, key: (String, bool, bool), remembered: Remembered) {
        let mut addresses = self.addresses.lock().unwrap();
        addresses.insert(key, remembered);
        let bytes = |addresses: &HashMap<_, Remembered>| {
            addresses.values().filter_map(|known| known.found.as_ref()).map(|found| found.bytes.len()).sum::<usize>()
        };
        while addresses.len() > MAX_ADDRESSES || (addresses.len() > 1 && bytes(&addresses) > MAX_ADDRESS_BYTES) {
            let Some(oldest) = addresses.iter().min_by_key(|(_, known)| known.at).map(|(key, _)| key.clone()) else {
                break;
            };
            addresses.remove(&oldest);
        }
    }

    /// A company's logo for the address's domain, looked up from here (`offline`: only the cache).
    async fn of_domain(&self, address: &str, offline: bool) -> Result<Option<SenderPicture>> {
        let Some(domain) = picture_domain(address) else { return Ok(None) };
        let lock = self.locks.lock().unwrap().entry(domain.clone()).or_default().clone();
        let _guard = lock.lock().await;

        let cached = self.cached(&domain);
        if let Some((picture, modified)) = &cached
            && (offline || modified.elapsed().unwrap_or_default() < FRESH_FOR)
        {
            return Ok(picture.clone().and_then(for_page));
        }
        if offline {
            return Ok(None);
        }
        let stale = cached.and_then(|(picture, _)| picture);
        if self.unreachable.lock().unwrap().get(&domain).is_some_and(|at| at.elapsed() < RETRY_OFFLINE_AFTER) {
            return Ok(stale.and_then(for_page));
        }

        let lookup = {
            let _permit = self.permits.acquire().await.map_err(|_| Error::internal("Picture fetching stopped."))?;
            self.lookup(&domain).await
        };
        match lookup {
            Lookup::Unreachable => {
                self.unreachable.lock().unwrap().insert(domain, Instant::now());
                Ok(stale.and_then(for_page))
            }
            Lookup::Nothing => {
                self.store(&domain, None)?;
                Ok(None)
            }
            Lookup::Found(found) => Ok(self.store(&domain, Some(found))?.and_then(for_page)),
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
                self.addresses.lock().unwrap().clear();
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
                    let picture =
                        SenderPicture { domain: Some(domain.to_string()), kind, path: Some(path), data_url: None };
                    return Some((Some(picture), time));
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
        Ok(Some(SenderPicture { domain: Some(domain.to_string()), kind: found.kind, path: Some(path), data_url: None }))
    }

    async fn lookup(&self, domain: &str) -> Lookup {
        let mut answered = false;
        // BIMI asks the device's resolver, past the privacy proxy: only without one (audit EG-4).
        if crate::tls::direct_lookups_allowed().await
            && let Some((logo, dns_answered)) = self.bimi(domain).await
        {
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
            let Some(format) = sniff_image(&bytes).filter(|format| !too_many_pixels(&bytes, format)) else { continue };
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
        assert!(stored.path.as_ref().unwrap().ends_with("shop.example.logo.svg"));
        assert_eq!(pictures.cached("shop.example").unwrap().0.unwrap().kind, PictureKind::Logo);
        // A later "nothing found" replaces the picture, and other domains stay apart.
        assert!(pictures.cached("example").is_none());
        pictures.store("shop.example", None).unwrap();
        assert!(pictures.cached("shop.example").unwrap().0.is_none());
        assert!(!stored.path.unwrap().exists());
        pictures.clear().unwrap();
        assert!(pictures.cached("shop.example").is_none());
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&width.to_be_bytes());
        png.extend_from_slice(&height.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        png
    }

    /// A UwUMail server that answers from a list, counts what it was asked and can go away.
    #[derive(Default)]
    struct FakeServer {
        answers: HashMap<String, (PictureKind, Vec<u8>)>,
        asked: Mutex<Vec<(String, PictureLookup)>>,
        down: std::sync::atomic::AtomicBool,
    }

    impl FakeServer {
        fn with(answers: &[(&str, PictureKind, Vec<u8>)]) -> Arc<Self> {
            let answers =
                answers.iter().map(|(email, kind, bytes)| (email.to_string(), (*kind, bytes.clone()))).collect();
            Arc::new(Self { answers, ..Self::default() })
        }

        fn asked(&self) -> usize {
            self.asked.lock().unwrap().len()
        }
    }

    impl PictureServer for FakeServer {
        fn picture<'a>(
            &'a self,
            email: &'a str,
            lookup: PictureLookup,
        ) -> BoxFuture<'a, Result<Option<ServerPicture>>> {
            Box::pin(async move {
                self.asked.lock().unwrap().push((email.to_string(), lookup));
                if self.down.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err(Error::connection("The fake server is away."));
                }
                // Like the real one: a person's picture unless only logos are asked for.
                Ok(self.answers.get(email).filter(|(kind, _)| !(lookup.logo && *kind == PictureKind::Photo)).cloned())
            })
        }
    }

    fn server(fake: &Arc<FakeServer>) -> Option<Arc<dyn PictureServer>> {
        Some(fake.clone() as Arc<dyn PictureServer>)
    }

    #[test]
    fn accepts_only_plain_addresses() {
        assert_eq!(picture_address("  <Kai.Example@Example.COM> ").as_deref(), Some("kai.example@example.com"));
        assert_eq!(picture_address("mia@müller.example").as_deref(), Some("mia@müller.example"));
        for hostile in [
            "",
            "kai",
            "@example.com",
            "kai@",
            "kai @example.com",
            "kai@exa mple.com",
            "kai@example.com/../x",
            "a@[::1]",
        ] {
            assert_eq!(picture_address(hostile), None, "{hostile}");
        }
        assert_eq!(picture_address(&format!("{}@example.com", "a".repeat(400))), None);
        assert_eq!(picture_address("kai\u{0}@example.com"), None);
    }

    #[test]
    fn reads_picture_sizes_from_headers() {
        assert_eq!(pixel_size(&png(640, 480), "png"), Some((640, 480)));
        assert_eq!(pixel_size(b"GIF89a\x20\x03\x58\x02", "gif"), Some((800, 600)));
        // JPEG: an APP0 segment, then the frame header.
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 11, 8, 0x01, 0x2C, 0x01, 0x90, 3, 0, 0, 0];
        assert_eq!(pixel_size(&jpeg, "jpg"), Some((400, 300)));
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
        webp.extend_from_slice(&[0; 8]);
        webp.extend_from_slice(&[0xFF, 0x0F, 0, 0x7F, 0x07, 0]);
        assert_eq!(pixel_size(&webp, "webp"), Some((4096, 1920)));
        // An icon whose entry claims 16 × 16 but holds a huge PNG.
        let mut ico = vec![0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0];
        ico.extend(png(100_000, 100_000));
        assert_eq!(pixel_size(&ico, "ico"), Some((100_000, 100_000)));
        assert!(too_many_pixels(&ico, "ico"));
        assert!(too_many_pixels(&png(50_000, 50_000), "png"));
        assert!(!too_many_pixels(&png(512, 512), "png"));
        // Cut-off and hostile headers never panic.
        for format in ["png", "gif", "jpg", "webp", "ico"] {
            for bytes in [&b""[..], b"\xFF\xD8\xFF", b"RIFF\0\0\0\0WEBPVP8L\0", &[0, 0, 1, 0, 0xFF, 0xFF]] {
                let _ = pixel_size(bytes, format);
            }
        }
    }

    #[tokio::test]
    async fn asks_the_server_per_address_and_keeps_its_answers() {
        let dir = tempfile::tempdir().unwrap();
        let pictures = SenderPictures::new(dir.path()).unwrap();
        let fake = FakeServer::with(&[
            ("kai@example.com", PictureKind::Photo, png(256, 256)),
            ("news@example.com", PictureKind::Logo, b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec()),
        ]);
        let all = PictureLookup::default();

        // The same domain, two addresses: a person's photo and the company's logo.
        let kai = pictures.get("Kai@Example.com", server(&fake), all).await.unwrap().unwrap();
        assert_eq!(kai.kind, PictureKind::Photo);
        assert_eq!(kai.domain, None);
        assert!(kai.path.is_none());
        assert!(kai.data_url.unwrap().starts_with("data:image/png;base64,"));
        let news = pictures.get("news@example.com", server(&fake), all).await.unwrap().unwrap();
        assert_eq!(news.kind, PictureKind::Logo);
        assert_eq!(news.domain.as_deref(), Some("example.com"));
        // An SVG is only ever data, never a file of the app's origin.
        assert!(news.data_url.unwrap().starts_with("data:image/svg+xml;base64,"));
        assert!(pictures.get("nobody@example.com", server(&fake), all).await.unwrap().is_none());
        assert_eq!(fake.asked(), 3);

        // Asked again, whatever the case: from memory, also when nothing was found.
        pictures.get("kai@example.com", server(&fake), all).await.unwrap().unwrap();
        assert!(pictures.get("NOBODY@example.com", server(&fake), all).await.unwrap().is_none());
        assert_eq!(fake.asked(), 3);
        // Another kind of lookup is its own question, and `fresh` asks again.
        let logo_only = PictureLookup { logo: true, ..all };
        assert!(pictures.get("kai@example.com", server(&fake), logo_only).await.unwrap().is_none());
        let local = PictureLookup { local: true, ..all };
        pictures.get("kai@example.com", server(&fake), local).await.unwrap().unwrap();
        pictures.get("kai@example.com", server(&fake), PictureLookup { fresh: true, ..all }).await.unwrap().unwrap();
        assert_eq!(fake.asked(), 6);
        let asked = fake.asked.lock().unwrap().clone();
        assert_eq!(asked[0].0, "kai@example.com");
        assert_eq!(asked[3].1, logo_only);
        assert_eq!(asked[4].1, local);

        // Hostile input never reaches the server.
        assert!(pictures.get("kai@example.com/../x", server(&fake), all).await.unwrap().is_none());
        assert_eq!(fake.asked(), 6);

        // Deleting the saved pictures forgets the answers too.
        pictures.clear().unwrap();
        pictures.get("kai@example.com", server(&fake), all).await.unwrap().unwrap();
        assert_eq!(fake.asked(), 7);
    }

    #[tokio::test]
    async fn refuses_huge_and_unknown_pictures_from_the_server() {
        let dir = tempfile::tempdir().unwrap();
        let pictures = SenderPictures::new(dir.path()).unwrap();
        let mut too_big = png(64, 64);
        too_big.resize(MAX_SERVER_PICTURE + 1, 0);
        let fake = FakeServer::with(&[
            ("bomb@example.com", PictureKind::Photo, png(60_000, 60_000)),
            ("big@example.com", PictureKind::Photo, too_big),
            ("page@example.com", PictureKind::Logo, b"<html><body>Not found</body></html>".to_vec()),
        ]);
        for email in ["bomb@example.com", "big@example.com", "page@example.com"] {
            assert!(pictures.get(email, server(&fake), PictureLookup::default()).await.unwrap().is_none(), "{email}");
        }
    }

    #[tokio::test]
    async fn keeps_what_it_knew_while_the_server_is_away() {
        let dir = tempfile::tempdir().unwrap();
        let pictures = SenderPictures::new(dir.path()).unwrap();
        let fake = FakeServer::with(&[("kai@example.com", PictureKind::Photo, png(64, 64))]);
        let all = PictureLookup::default();
        pictures.get("kai@example.com", server(&fake), all).await.unwrap().unwrap();
        fake.down.store(true, std::sync::atomic::Ordering::SeqCst);
        let fresh = PictureLookup { fresh: true, ..all };
        assert_eq!(
            pictures.get("kai@example.com", server(&fake), fresh).await.unwrap().unwrap().kind,
            PictureKind::Photo
        );
        // An address not known yet gets a company logo cached here from before, if there is one.
        let logo = Found { kind: PictureKind::Logo, format: "png", bytes: png(128, 128) };
        pictures.store("example.com", Some(logo)).unwrap();
        let news = pictures.get("news@example.com", server(&fake), all).await.unwrap().unwrap();
        assert_eq!(news.kind, PictureKind::Logo);
        assert!(news.path.is_some());
        // The server isn't asked again right away for an address it didn't answer for.
        let asked = fake.asked();
        pictures.get("news@example.com", server(&fake), all).await.unwrap();
        assert_eq!(fake.asked(), asked);
    }

    #[tokio::test]
    async fn without_a_server_local_lookups_only_take_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let pictures = SenderPictures::new(dir.path()).unwrap();
        let local = PictureLookup { local: true, ..PictureLookup::default() };
        // Nothing cached: nothing, and no request (example.com doesn't exist, a lookup would fail).
        assert!(pictures.get("news@example.com", None, local).await.unwrap().is_none());
        assert!(pictures.unreachable.lock().unwrap().is_empty());
        let svg = Found { kind: PictureKind::Logo, format: "svg", bytes: b"<svg/>".to_vec() };
        pictures.store("example.com", Some(svg)).unwrap();
        let cached = pictures.get("news@example.com", None, local).await.unwrap().unwrap();
        assert!(cached.path.is_none(), "an SVG is handed out as data");
        assert!(cached.data_url.unwrap().starts_with("data:image/svg+xml;base64,"));
        // People at mail providers never get a company picture.
        assert!(pictures.get("someone@gmail.com", None, local).await.unwrap().is_none());
    }

    #[test]
    fn keeps_a_bounded_number_of_answers() {
        let dir = tempfile::tempdir().unwrap();
        let pictures = SenderPictures::new(dir.path()).unwrap();
        let start = Instant::now();
        for index in 0..MAX_ADDRESSES + 10 {
            let at = start + Duration::from_millis(index as u64);
            pictures.remember(
                (format!("p{index}@example.com"), false, false),
                Remembered { found: None, at, answered: true },
            );
        }
        let addresses = pictures.addresses.lock().unwrap();
        assert_eq!(addresses.len(), MAX_ADDRESSES);
        assert!(!addresses.contains_key(&("p0@example.com".to_string(), false, false)), "the oldest go first");
        drop(addresses);
        // And a bounded number of bytes.
        let big = Arc::new(Found { kind: PictureKind::Photo, format: "png", bytes: vec![0; MAX_SERVER_PICTURE] });
        for index in 0..(MAX_ADDRESS_BYTES / MAX_SERVER_PICTURE + 5) {
            let at = start + Duration::from_secs(10 + index as u64);
            let found = Some(big.clone());
            pictures
                .remember((format!("big{index}@example.com"), false, false), Remembered { found, at, answered: true });
        }
        let addresses = pictures.addresses.lock().unwrap();
        let bytes: usize =
            addresses.values().filter_map(|known| known.found.as_ref()).map(|found| found.bytes.len()).sum();
        assert!(bytes <= MAX_ADDRESS_BYTES);
    }

    #[test]
    fn reads_the_picture_kind_header() {
        assert_eq!(PictureKind::from_header(Some(" Photo ")), PictureKind::Photo);
        assert_eq!(PictureKind::from_header(Some("logo")), PictureKind::Logo);
        assert_eq!(PictureKind::from_header(Some("favicon")), PictureKind::Icon);
        assert_eq!(PictureKind::from_header(None), PictureKind::Icon);
    }
}
