//! Test-only helpers: TLS that trusts one certificate, and small HTTPS or HTTP stub servers.
//!
//! Only the integration tests use this. The app always checks certificates with the system
//! (`uwumail_core::tls`); nothing here is reachable from its commands or settings.

#![allow(dead_code)]

use std::sync::{Arc, Mutex, OnceLock};

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;

/// A client config that trusts exactly these certificates.
pub fn client_config(roots: &[CertificateDer<'static>]) -> rustls::ClientConfig {
    uwumail_core::tls::install_crypto_provider();
    let mut store = rustls::RootCertStore::empty();
    for cert in roots {
        store.add(cert.clone()).expect("a usable test certificate");
    }
    let mut config = rustls::ClientConfig::builder().with_root_certificates(store).with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    config
}

/// An HTTP client builder that trusts exactly these certificates.
pub fn http_builder(roots: &[CertificateDer<'static>]) -> reqwest::ClientBuilder {
    reqwest::Client::builder().tls_backend_preconfigured(client_config(roots))
}

/// The certificate of the stubs: self-signed for `localhost` and `127.0.0.1`, made per test run.
pub fn stub_certificate() -> &'static (CertificateDer<'static>, PrivatePkcs8KeyDer<'static>) {
    static CERT: OnceLock<(CertificateDer<'static>, PrivatePkcs8KeyDer<'static>)> = OnceLock::new();
    CERT.get_or_init(|| {
        let made = rcgen::generate_simple_self_signed(vec!["localhost".to_string(), "127.0.0.1".to_string()])
            .expect("a test certificate");
        (made.cert.der().clone(), PrivatePkcs8KeyDer::from(made.signing_key.serialize_der()))
    })
}

#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    pub fn has_password(&self) -> bool {
        self.header("authorization").is_some()
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn new(status: u16, body: impl Into<Vec<u8>>) -> Self {
        Self { status, headers: Vec::new(), body: body.into() }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    pub fn redirect(location: &str) -> Self {
        Self::new(301, "").header("Location", location)
    }

    pub fn multistatus(xml: impl Into<Vec<u8>>) -> Self {
        Self::new(207, xml).header("Content-Type", "application/xml; charset=utf-8")
    }

    pub fn json(value: &serde_json::Value) -> Self {
        Self::new(200, value.to_string()).header("Content-Type", "application/json")
    }
}

type Handler = dyn Fn(&Request) -> Response + Send + Sync;

/// A running stub: its port and every request it got.
pub struct Stub {
    pub port: u16,
    pub requests: Arc<Mutex<Vec<Request>>>,
    tls: bool,
}

impl Stub {
    pub fn url(&self, host: &str, path: &str) -> url::Url {
        let scheme = if self.tls { "https" } else { "http" };
        url::Url::parse(&format!("{scheme}://{host}:{}{path}", self.port)).unwrap()
    }

    pub fn seen(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}

/// An HTTPS stub on 127.0.0.1 (reachable as `localhost` and `127.0.0.1`).
pub async fn https_stub(handler: impl Fn(&Request) -> Response + Send + Sync + 'static) -> Stub {
    start(Arc::new(handler), true).await
}

/// A plain HTTP stub on 127.0.0.1, for JMAP (which the engine allows over HTTP on loopback).
pub async fn http_stub(handler: impl Fn(&Request) -> Response + Send + Sync + 'static) -> Stub {
    start(Arc::new(handler), false).await
}

async fn start(handler: Arc<Handler>, tls: bool) -> Stub {
    uwumail_core::tls::install_crypto_provider();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let acceptor = tls.then(|| {
        let (cert, key) = stub_certificate();
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert.clone()], PrivateKeyDer::Pkcs8(key.clone_key()))
            .unwrap();
        tokio_rustls::TlsAcceptor::from(Arc::new(config))
    });
    let seen = Arc::clone(&requests);
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else { return };
            let handler = Arc::clone(&handler);
            let seen = Arc::clone(&seen);
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                match acceptor {
                    Some(acceptor) => {
                        if let Ok(stream) = acceptor.accept(tcp).await {
                            serve(stream, &*handler, &seen).await;
                        }
                    }
                    None => serve(tcp, &*handler, &seen).await,
                }
            });
        }
    });
    Stub { port, requests, tls }
}

/// One request per connection: read it, answer, close.
async fn serve<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, handler: &Handler, seen: &Mutex<Vec<Request>>) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break end;
        }
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let method = first.next().unwrap_or_default().to_string();
    let path = first.next().unwrap_or_default().to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }
    let request = Request { method, path, headers, body };
    let response = handler(&request);
    seen.lock().unwrap().push(request);
    let mut out = format!(
        "HTTP/1.1 {} Stub\r\nContent-Length: {}\r\nConnection: close\r\n",
        response.status,
        response.body.len()
    );
    for (name, value) in &response.headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str("\r\n");
    let _ = stream.write_all(out.as_bytes()).await;
    let _ = stream.write_all(&response.body).await;
    let _ = stream.shutdown().await;
}
