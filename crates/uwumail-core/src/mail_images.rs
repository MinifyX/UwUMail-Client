//! Remote pictures of a mail. The web view never loads one from its sender itself: it asks the app
//! (`uwuimg:`), and only once the reader let the mail's pictures show. A UwUMail server fetches them for
//! its own accounts; for every other account they come from here, through the privacy proxy when one is
//! set, so the sender at most sees the proxy. Only from addresses with a public host name: no IP
//! address, no `localhost`, no name that only exists in the local network. A public name that the
//! sender points at a local address still gets through (accepted risk I6, as for sender pictures).
//! The reader's dark mode reads the same copies to recolor them.
//!
//! Before the pictures, the reader wants their sizes, so each one waits in its final place
//! ([`MailImages::probe`]). That fetches them whole and keeps them a few minutes in a small memory
//! cache, which the following `uwuimg:` requests take them from. Fetching is kept fair and quick:
//! short timeouts, a cap on requests at once and a smaller one per host, so one slow host never
//! holds up the rest, and a host that didn't answer is left alone for a minute.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::StreamExt;
use futures::stream::FuturesUnordered;
use serde::Serialize;
use tokio::sync::Semaphore;
use url::Url;

use crate::error::Result;
use crate::image_size::image_size;
use crate::pictures::sniff_image;

/// What the reader learns about one remote picture before it loads (`Backend.imageSizes`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteImageSize {
    /// The address as the mail has it.
    pub url: String,
    /// Pixels; `None` when the picture is there but its size can't be read from it.
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// The picture can't be had: a dead host, an error, too big, or not a picture.
    pub failed: bool,
}

impl RemoteImageSize {
    pub fn failed(url: &str) -> Self {
        Self { url: url.to_string(), width: None, height: None, failed: true }
    }

    pub fn unknown(url: &str) -> Self {
        Self { url: url.to_string(), width: None, height: None, failed: false }
    }
}

/// How fetching is bounded; see [`Limits::default`].
#[derive(Debug, Clone)]
pub(crate) struct Limits {
    /// Requests at once, over all hosts.
    pub parallel: usize,
    /// Requests at once to one host.
    pub per_host: usize,
    /// Addresses one probe fetches; the rest are answered as failed.
    pub per_mail: usize,
    pub connect_timeout: Duration,
    /// For the whole request, body included.
    pub timeout: Duration,
    /// How long a host that didn't answer is left alone.
    pub dead_for: Duration,
    pub max_bytes: usize,
    pub cache_bytes: usize,
    pub cache_entries: usize,
    pub cache_for: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            parallel: 8,
            per_host: 3,
            per_mail: 100,
            connect_timeout: Duration::from_millis(3500),
            timeout: Duration::from_secs(9),
            dead_for: Duration::from_secs(60),
            // Newsletters stay far below this; a UwUMail server draws the same line.
            max_bytes: 10 * 1024 * 1024,
            cache_bytes: 32 * 1024 * 1024,
            cache_entries: 2000,
            cache_for: Duration::from_secs(5 * 60),
        }
    }
}

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
    let limits = Limits::default();
    redirects(builder.connect_timeout(limits.connect_timeout).timeout(limits.timeout))
}

/// No telling who looks, and redirects only to other public addresses.
fn redirects(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder.user_agent(AGENT).referer(false).redirect(reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            attempt.error("too many redirects")
        } else if is_public_image_url(attempt.url()) {
            attempt.follow()
        } else {
            attempt.stop()
        }
    }))
}

enum Http {
    /// Through the privacy proxy when one is set: a picture tells its sender who looked, and when.
    Privacy(crate::tls::PrivacyClient),
    #[cfg(test)]
    Fixed(reqwest::Client),
}

impl Http {
    async fn get(&self) -> Result<reqwest::Client> {
        match self {
            Http::Privacy(client) => client.get().await,
            #[cfg(test)]
            Http::Fixed(client) => Ok(client.clone()),
        }
    }
}

/// Why a picture couldn't be had.
#[derive(Debug, PartialEq, Eq)]
enum Miss {
    /// The host didn't answer in time or refused the connection; it's left alone for a while.
    Unreachable,
    /// It answered, but with no picture of a sensible size.
    Unusable,
}

pub struct MailImages {
    http: Http,
    limits: Limits,
    permits: Semaphore,
    /// Each host's own share of `permits`, while anything waits for or talks to it.
    hosts: Mutex<HashMap<String, Arc<Semaphore>>>,
    /// Hosts that didn't answer, with when.
    dead: Mutex<HashMap<String, Instant>>,
    cache: Mutex<ByteCache>,
}

impl MailImages {
    pub fn new() -> Result<Self> {
        Ok(Self::with(Http::Privacy(crate::tls::PrivacyClient::new(configure)), Limits::default()))
    }

    fn with(http: Http, limits: Limits) -> Self {
        Self {
            http,
            permits: Semaphore::new(limits.parallel),
            hosts: Mutex::new(HashMap::new()),
            dead: Mutex::new(HashMap::new()),
            cache: Mutex::new(ByteCache::new(limits.cache_bytes, limits.cache_entries, limits.cache_for)),
            limits,
        }
    }

    /// The image's bytes, or `None` when the address isn't public, nothing answered,
    /// or the answer isn't an image of a sensible size.
    pub async fn get(&self, url: &str) -> Option<Arc<Vec<u8>>> {
        let url = Url::parse(url.trim()).ok().filter(is_public_image_url)?;
        self.fetch(&url).await.ok()
    }

    /// Fetches each picture of a mail and tells its size as soon as it is known, in any order;
    /// every address once. The pictures stay in the cache for the reader to load right after.
    pub async fn probe(&self, urls: &[String], mut on_size: impl FnMut(RemoteImageSize)) {
        let mut asked = HashSet::new();
        let mut fetches = FuturesUnordered::new();
        for address in urls {
            if !asked.insert(address.as_str()) {
                continue;
            }
            let Some(url) = Url::parse(address.trim()).ok().filter(is_public_image_url) else {
                on_size(RemoteImageSize::failed(address));
                continue;
            };
            // A mail with this many pictures gets no more fetched from here.
            if fetches.len() >= self.limits.per_mail {
                on_size(RemoteImageSize::failed(address));
                continue;
            }
            fetches.push(async move {
                match self.fetch(&url).await {
                    Ok(bytes) => match image_size(&bytes) {
                        Some(size) => RemoteImageSize {
                            url: address.clone(),
                            width: Some(size.width),
                            height: Some(size.height),
                            failed: false,
                        },
                        None => RemoteImageSize::unknown(address),
                    },
                    Err(_) => RemoteImageSize::failed(address),
                }
            });
        }
        while let Some(size) = fetches.next().await {
            on_size(size);
        }
    }

    async fn fetch(&self, url: &Url) -> std::result::Result<Arc<Vec<u8>>, Miss> {
        if let Some(bytes) = self.cache.lock().unwrap_or_else(|e| e.into_inner()).get(url.as_str()) {
            return Ok(bytes);
        }
        let host = host_key(url);
        if self.is_dead(&host) {
            return Err(Miss::Unreachable);
        }
        // The host's share first: waiting for a slow host takes nothing from the others.
        let share = self.host_share(&host);
        let _host = share.acquire().await.map_err(|_| Miss::Unusable)?;
        let _permit = self.permits.acquire().await.map_err(|_| Miss::Unusable)?;
        // Another picture of the same page may have brought this one, or found the host dead.
        if let Some(bytes) = self.cache.lock().unwrap_or_else(|e| e.into_inner()).get(url.as_str()) {
            return Ok(bytes);
        }
        if self.is_dead(&host) {
            return Err(Miss::Unreachable);
        }
        let result = self.download(url).await;
        match &result {
            Ok(bytes) => self.cache.lock().unwrap_or_else(|e| e.into_inner()).put(url.as_str(), Arc::clone(bytes)),
            Err(Miss::Unreachable) => {
                let mut dead = self.dead.lock().unwrap_or_else(|e| e.into_inner());
                // Bounded: forget the ones whose time is up before adding another.
                dead.retain(|_, since| since.elapsed() < self.limits.dead_for);
                dead.insert(host, Instant::now());
            }
            Err(Miss::Unusable) => {}
        }
        result
    }

    async fn download(&self, url: &Url) -> std::result::Result<Arc<Vec<u8>>, Miss> {
        let unreachable = |error: reqwest::Error| {
            if error.is_connect() || error.is_timeout() { Miss::Unreachable } else { Miss::Unusable }
        };
        let http = self.http.get().await.map_err(|_| Miss::Unusable)?;
        let mut response = http.get(url.clone()).send().await.map_err(unreachable)?;
        let max = self.limits.max_bytes;
        if !response.status().is_success() || response.content_length().is_some_and(|n| n > max as u64) {
            return Err(Miss::Unusable);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(unreachable)? {
            if body.len() + chunk.len() > max {
                return Err(Miss::Unusable);
            }
            body.extend_from_slice(&chunk);
        }
        if matches!(sniff_image(&body), Some("png" | "jpg" | "gif" | "webp" | "svg")) {
            Ok(Arc::new(body))
        } else {
            Err(Miss::Unusable)
        }
    }

    fn is_dead(&self, host: &str) -> bool {
        let dead = self.dead.lock().unwrap_or_else(|e| e.into_inner());
        dead.get(host).is_some_and(|since| since.elapsed() < self.limits.dead_for)
    }

    fn host_share(&self, host: &str) -> Arc<Semaphore> {
        let mut hosts = self.hosts.lock().unwrap_or_else(|e| e.into_inner());
        // Hosts nobody waits for or talks to any more are forgotten.
        if hosts.len() >= 64 {
            hosts.retain(|_, share| Arc::strong_count(share) > 1);
        }
        Arc::clone(hosts.entry(host.to_string()).or_insert_with(|| Arc::new(Semaphore::new(self.limits.per_host))))
    }
}

fn host_key(url: &Url) -> String {
    format!("{}:{}", url.host_str().unwrap_or_default(), url.port_or_known_default().unwrap_or_default())
}

/// Pictures fetched lately, bounded in total bytes, count and age. When full, the oldest go first.
struct ByteCache {
    entries: HashMap<String, (Arc<Vec<u8>>, Instant)>,
    total: usize,
    max_bytes: usize,
    max_entries: usize,
    keep_for: Duration,
}

impl ByteCache {
    fn new(max_bytes: usize, max_entries: usize, keep_for: Duration) -> Self {
        Self { entries: HashMap::new(), total: 0, max_bytes, max_entries, keep_for }
    }

    fn get(&mut self, key: &str) -> Option<Arc<Vec<u8>>> {
        let (bytes, at) = self.entries.get(key)?;
        if at.elapsed() < self.keep_for {
            return Some(Arc::clone(bytes));
        }
        self.remove(key);
        None
    }

    fn put(&mut self, key: &str, bytes: Arc<Vec<u8>>) {
        self.remove(key);
        if bytes.len() > self.max_bytes || self.max_entries == 0 {
            return;
        }
        let keep_for = self.keep_for;
        let expired: Vec<String> =
            self.entries.iter().filter(|(_, (_, at))| at.elapsed() >= keep_for).map(|(key, _)| key.clone()).collect();
        for key in expired {
            self.remove(&key);
        }
        while self.total + bytes.len() > self.max_bytes || self.entries.len() >= self.max_entries {
            let Some(oldest) = self.entries.iter().min_by_key(|(_, (_, at))| *at).map(|(key, _)| key.clone()) else {
                break;
            };
            self.remove(&oldest);
        }
        self.total += bytes.len();
        self.entries.insert(key.to_string(), (bytes, Instant::now()));
    }

    fn remove(&mut self, key: &str) {
        if let Some((bytes, _)) = self.entries.remove(key) {
            self.total -= bytes.len();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    fn public(url: &str) -> bool {
        is_public_image_url(&Url::parse(url).unwrap())
    }

    #[test]
    fn only_fetches_from_public_websites() {
        assert!(public("https://img.shop.example.com/banner.png"));
        assert!(public("http://news.example.org/logo.gif?x=1"));
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

    #[test]
    fn the_cache_stays_within_its_bytes_count_and_age() {
        let bytes = |n: usize| Arc::new(vec![0u8; n]);
        let mut cache = ByteCache::new(100, 3, Duration::from_secs(60));
        cache.put("a", bytes(60));
        cache.put("b", bytes(30));
        assert!(cache.get("a").is_some() && cache.get("b").is_some());
        // Too big for what's left: the oldest makes room.
        cache.put("c", bytes(50));
        assert!(cache.get("a").is_none());
        assert_eq!(cache.total, 80);
        // Bigger than the whole cache: not kept, nothing else lost.
        cache.put("huge", bytes(101));
        assert!(cache.get("huge").is_none());
        assert_eq!(cache.total, 80);
        // At most three entries.
        cache.put("d", bytes(1));
        cache.put("e", bytes(1));
        assert_eq!(cache.entries.len(), 3);
        assert!(cache.get("b").is_none(), "the oldest went");
        // Putting the same address again replaces it.
        cache.put("e", bytes(10));
        assert_eq!(cache.total, 50 + 1 + 10);

        let mut stale = ByteCache::new(100, 10, Duration::ZERO);
        stale.put("a", bytes(10));
        assert!(stale.get("a").is_none());
        assert_eq!(stale.total, 0);
    }

    const PNG_2X1: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR\0\0\0\x02\0\0\0\x01\x08\x06\0\0\0";

    /// A plain HTTP stub for every `*.example.com` name. `/hold/…` answers only once `open` is
    /// called; `/big` is larger than the tests' limit, `/text` no picture, anything else a PNG.
    struct Stub {
        port: u16,
        gate: Arc<tokio::sync::Semaphore>,
        requests: Arc<Mutex<Vec<String>>>,
        active: Arc<Mutex<HashMap<String, usize>>>,
        most: Arc<Mutex<HashMap<String, usize>>>,
        most_total: Arc<AtomicUsize>,
    }

    impl Stub {
        async fn start() -> Stub {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let stub = Stub {
                port,
                gate: Arc::new(tokio::sync::Semaphore::new(0)),
                requests: Arc::default(),
                active: Arc::default(),
                most: Arc::default(),
                most_total: Arc::default(),
            };
            let (gate, requests, active, most, most_total) = (
                Arc::clone(&stub.gate),
                Arc::clone(&stub.requests),
                Arc::clone(&stub.active),
                Arc::clone(&stub.most),
                Arc::clone(&stub.most_total),
            );
            tokio::spawn(async move {
                while let Ok((mut socket, _)) = listener.accept().await {
                    let (gate, requests, active, most, most_total) = (
                        Arc::clone(&gate),
                        Arc::clone(&requests),
                        Arc::clone(&active),
                        Arc::clone(&most),
                        Arc::clone(&most_total),
                    );
                    tokio::spawn(async move {
                        let mut head = Vec::new();
                        let mut buffer = [0u8; 1024];
                        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                            let Ok(n) = socket.read(&mut buffer).await else { return };
                            if n == 0 {
                                return;
                            }
                            head.extend_from_slice(&buffer[..n]);
                        }
                        let head = String::from_utf8_lossy(&head).into_owned();
                        let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                        let host = head
                            .lines()
                            .find_map(|line| line.strip_prefix("host: ").or_else(|| line.strip_prefix("Host: ")))
                            .unwrap_or_default()
                            .split(['.', ':'])
                            .next()
                            .unwrap_or_default()
                            .to_string();
                        requests.lock().unwrap().push(format!("{host}{path}"));
                        {
                            let mut active = active.lock().unwrap();
                            let now = active.entry(host.clone()).or_default();
                            *now += 1;
                            let now = *now;
                            let mut most = most.lock().unwrap();
                            let top = most.entry(host.clone()).or_default();
                            *top = (*top).max(now);
                            most_total.fetch_max(active.values().sum(), Ordering::SeqCst);
                        }
                        if path.starts_with("/hold/") {
                            gate.acquire().await.unwrap().forget();
                        }
                        let body: Vec<u8> = match path.as_str() {
                            "/big" => [PNG_2X1, &[0u8; 2048]].concat(),
                            "/text" => b"<html>not a picture</html>".to_vec(),
                            _ => PNG_2X1.to_vec(),
                        };
                        let status = if path == "/missing" { "404 Not Found" } else { "200 OK" };
                        let answer =
                            format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                        *active.lock().unwrap().get_mut(&host).unwrap() -= 1;
                        let _ = socket.write_all(answer.as_bytes()).await;
                        let _ = socket.write_all(&body).await;
                    });
                }
            });
            stub
        }

        fn url(&self, host: &str, path: &str) -> String {
            format!("http://{host}.example.com:{}{path}", self.port)
        }

        fn images(&self, limits: Limits) -> MailImages {
            let address = std::net::SocketAddr::from(([127, 0, 0, 1], self.port));
            let mut builder = redirects(
                reqwest::Client::builder().connect_timeout(limits.connect_timeout).timeout(limits.timeout).no_proxy(),
            );
            for host in ["a", "b", "c", "dead"] {
                builder = builder.resolve(&format!("{host}.example.com"), address);
            }
            MailImages::with(Http::Fixed(builder.build().unwrap()), limits)
        }

        async fn until_active(&self, host: &str, count: usize) {
            // Waits for the event itself, bounded so a broken test fails instead of hanging.
            tokio::time::timeout(Duration::from_secs(10), async {
                while self.active.lock().unwrap().get(host).copied().unwrap_or(0) < count {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("the requests arrive");
        }

        fn most(&self, host: &str) -> usize {
            self.most.lock().unwrap().get(host).copied().unwrap_or(0)
        }
    }

    fn limits() -> Limits {
        Limits {
            parallel: 3,
            per_host: 2,
            per_mail: 4,
            connect_timeout: Duration::from_secs(5),
            timeout: Duration::from_secs(10),
            max_bytes: 1024,
            ..Limits::default()
        }
    }

    #[tokio::test]
    async fn a_slow_host_never_holds_up_the_others() {
        let stub = Stub::start().await;
        let images = Arc::new(stub.images(limits()));
        let slow: Vec<_> = (0..4)
            .map(|i| {
                let (images, url) = (Arc::clone(&images), stub.url("a", &format!("/hold/{i}.png")));
                tokio::spawn(async move { images.get(&url).await })
            })
            .collect();
        stub.until_active("a", 2).await;
        // The slow host has its two, one is left over for everyone else.
        let quick = tokio::time::timeout(Duration::from_secs(10), images.get(&stub.url("b", "/quick.png")))
            .await
            .expect("not held up");
        assert_eq!(quick.as_deref().map(Vec::as_slice), Some(PNG_2X1));
        stub.gate.add_permits(4);
        for fetch in slow {
            assert!(fetch.await.unwrap().is_some());
        }
        assert_eq!(stub.most("a"), 2, "at most two at once to one host");
        assert!(stub.most_total.load(Ordering::SeqCst) <= 3, "at most three at once overall");
    }

    #[tokio::test]
    async fn a_dead_host_fails_its_other_pictures_at_once() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let stub = Stub { port, ..Stub::start().await };
        let images = stub.images(limits());
        assert!(images.get(&stub.url("dead", "/a.png")).await.is_none());
        assert!(images.is_dead(&format!("dead.example.com:{port}")));
        assert_eq!(images.fetch(&Url::parse(&stub.url("dead", "/b.png")).unwrap()).await, Err(Miss::Unreachable));
    }

    #[tokio::test]
    async fn a_host_that_takes_too_long_counts_as_dead() {
        let stub = Stub::start().await;
        let images = stub.images(Limits { timeout: Duration::from_millis(150), ..limits() });
        assert!(images.get(&stub.url("c", "/hold/slow.png")).await.is_none());
        assert!(images.is_dead(&format!("c.example.com:{}", stub.port)));
        // Others still load.
        assert!(images.get(&stub.url("a", "/fine.png")).await.is_some());
    }

    #[tokio::test]
    async fn only_pictures_of_a_sensible_size_are_kept() {
        let stub = Stub::start().await;
        let images = stub.images(limits());
        assert!(images.get(&stub.url("a", "/big")).await.is_none());
        assert!(images.get(&stub.url("a", "/text")).await.is_none());
        assert!(images.get(&stub.url("a", "/missing")).await.is_none());
        assert!(!images.is_dead(&format!("a.example.com:{}", stub.port)), "it answered");
        assert!(images.get("http://127.0.0.1/a.png").await.is_none());
    }

    #[tokio::test]
    async fn a_probe_tells_sizes_and_keeps_the_pictures_for_the_reader() {
        let stub = Stub::start().await;
        let images = stub.images(limits());
        let urls: Vec<String> = [
            stub.url("a", "/one.png"),
            stub.url("a", "/one.png"),
            stub.url("b", "/missing"),
            stub.url("b", "/text"),
            "https://localhost/x.png".to_string(),
            stub.url("c", "/two.png"),
            stub.url("c", "/three.png"),
        ]
        .into();
        let mut answers = Vec::new();
        images.probe(&urls, |size| answers.push(size)).await;
        answers.sort_by(|a, b| a.url.cmp(&b.url));
        let sized =
            |url: &str| RemoteImageSize { url: url.to_string(), width: Some(2), height: Some(1), failed: false };
        let mut expected = vec![
            sized(&urls[0]),
            RemoteImageSize::failed(&urls[2]),
            RemoteImageSize::failed(&urls[3]),
            RemoteImageSize::failed(&urls[4]),
            sized(&urls[5]),
            // The fifth picture of a mail allowed four.
            RemoteImageSize::failed(&urls[6]),
        ];
        expected.sort_by(|a, b| a.url.cmp(&b.url));
        assert_eq!(answers, expected);

        let before = stub.requests.lock().unwrap().len();
        assert_eq!(before, 4);
        assert!(images.get(&urls[0]).await.is_some());
        assert!(images.get(&urls[5]).await.is_some());
        assert_eq!(stub.requests.lock().unwrap().len(), before, "the reader's requests came from the cache");
    }
}
