//! The providers people set up on this device, for mailboxes whose server has no assistant: every
//! request to a model goes out from here (the Rust side), never from the page.
//!
//! Two API shapes are spoken, like UwUMail Server does: OpenAI's Chat Completions (OpenAI, Gemini's
//! OpenAI-compatible endpoint, Mistral, OpenRouter, Ollama's `/v1` and every compatible server) and
//! Anthropic's Messages. Keys only ever travel over HTTPS; plain `http://` is allowed for Ollama and
//! OpenAI-compatible servers on a loopback or private address the person typed.
//!
//! Limits are the server's (docs/llm.md "Limits"): 60 s without a byte, 3 min in total, 1 MB for a
//! whole answer, 4 MB for a streamed one, and at most [`MAX_TEXT_CHARS`] characters of text kept.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderName, HeaderValue, RETRY_AFTER};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::sse::{self, Flow, SseEvent, StreamLimits};
use crate::error::{Error, Result};

/// Without a byte from the provider for this long, the answer is given up.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// A whole answer, retries included.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(180);
/// A model list, the key test included.
const MODELS_TIMEOUT: Duration = Duration::from_secs(20);
/// A whole (not streamed) answer or model list.
const MAX_BODY_BYTES: usize = 1024 * 1024;
/// The bytes of a streamed answer.
const MAX_STREAM_BYTES: usize = 4 * 1024 * 1024;
/// What is read of an error answer.
const MAX_ERROR_BYTES: usize = 64 * 1024;
/// The text kept of an answer; reading stops there and keeps what came.
pub const MAX_TEXT_CHARS: usize = 200_000;
/// Models listed at most.
const MAX_MODELS: usize = 500;
/// The longest model id taken from a list.
const MAX_MODEL_ID_CHARS: usize = 200;
/// The longest address taken.
const MAX_URL_CHARS: usize = 2048;
/// How much of a provider's own error text is shown.
const MAX_DETAIL_CHARS: usize = 200;
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// The two API shapes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// OpenAI's Chat Completions.
    Chat,
    /// Anthropic's Messages.
    Messages,
}

/// The kinds a person can set up on this device. ChatGPT's sign-in is not offered here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ProviderKind {
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "gemini")]
    Gemini,
    #[serde(rename = "mistral")]
    Mistral,
    #[serde(rename = "openrouter")]
    OpenRouter,
    #[serde(rename = "ollama")]
    Ollama,
    #[serde(rename = "openaiCompatible")]
    OpenAiCompatible,
}

impl ProviderKind {
    pub const ALL: [ProviderKind; 7] = [
        Self::OpenAi,
        Self::Anthropic,
        Self::Gemini,
        Self::Mistral,
        Self::OpenRouter,
        Self::Ollama,
        Self::OpenAiCompatible,
    ];

    /// The name the server and the page use (`openai`, …, `openaiCompatible`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::Mistral => "mistral",
            Self::OpenRouter => "openrouter",
            Self::Ollama => "ollama",
            Self::OpenAiCompatible => "openaiCompatible",
        }
    }

    pub fn parse(kind: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == kind)
    }

    /// The address used when the person gives none; `None` where one is required.
    pub fn default_base_url(self) -> Option<&'static str> {
        match self {
            Self::OpenAi => Some("https://api.openai.com/v1"),
            Self::Anthropic => Some("https://api.anthropic.com/v1"),
            Self::Gemini => Some("https://generativelanguage.googleapis.com/v1beta/openai"),
            Self::Mistral => Some("https://api.mistral.ai/v1"),
            Self::OpenRouter => Some("https://openrouter.ai/api/v1"),
            Self::Ollama | Self::OpenAiCompatible => None,
        }
    }

    /// Whether the person gives (Ollama, OpenAI-compatible) or may change (OpenAI, Anthropic: a
    /// gateway) the address. Gemini, Mistral and OpenRouter have a fixed one.
    pub fn base_url_editable(self) -> bool {
        matches!(self, Self::OpenAi | Self::Anthropic | Self::Ollama | Self::OpenAiCompatible)
    }

    /// Whether an address is needed.
    pub fn base_url_required(self) -> bool {
        matches!(self, Self::Ollama | Self::OpenAiCompatible)
    }

    /// Whether a key is needed (Ollama none, OpenAI-compatible optional).
    pub fn key_required(self) -> bool {
        !matches!(self, Self::Ollama | Self::OpenAiCompatible)
    }

    /// The suggested model for writing and the cheaper one for everything else (docs/llm.md).
    pub fn default_models(self) -> (Option<&'static str>, Option<&'static str>) {
        match self {
            Self::OpenAi => (Some("gpt-5-mini"), Some("gpt-5-nano")),
            Self::Anthropic => (Some("claude-sonnet-5"), Some("claude-haiku-4-5")),
            Self::Gemini => (Some("gemini-2.5-flash"), Some("gemini-2.5-flash-lite")),
            Self::Mistral => (Some("mistral-medium-latest"), Some("mistral-small-latest")),
            Self::OpenRouter => (Some("openai/gpt-5-mini"), Some("google/gemini-2.5-flash-lite")),
            Self::Ollama | Self::OpenAiCompatible => (None, None),
        }
    }

    /// The API shape this kind speaks.
    fn shape(self) -> Shape {
        if self == Self::Anthropic { Shape::Messages } else { Shape::Chat }
    }

    /// Servers of every kind of build, which may not know newer request fields.
    fn compatible(self) -> bool {
        matches!(self, Self::Ollama | Self::OpenAiCompatible)
    }
}

/// Where and how to reach one provider. The key never shows in `Debug`.
#[derive(Clone)]
pub struct Endpoint {
    pub kind: ProviderKind,
    /// The checked address (see [`check_base_url`]), `None` for the kind's default.
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

impl std::fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Endpoint")
            .field("kind", &self.kind)
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "***"))
            .finish()
    }
}

/// Checks an address the person typed for a provider of `kind` and returns it normalized (no
/// trailing `/`). Refused, with a reason to show: not `http(s)://`, a login, a query or a fragment
/// in it, `http://` anywhere but on a loopback or private address (and only for Ollama and
/// OpenAI-compatible servers). Ollama gets `/v1` added when it's missing.
pub fn check_base_url(kind: ProviderKind, url: &str) -> std::result::Result<String, String> {
    if !kind.base_url_editable() {
        return Err("This provider's address can't be changed.".into());
    }
    let url = url.trim();
    if url.is_empty() {
        return Err("Enter the provider's address.".into());
    }
    if url.chars().count() > MAX_URL_CHARS {
        return Err("The address is too long.".into());
    }
    let parsed = url::Url::parse(url).map_err(|_| "This isn't a web address.".to_string())?;
    let https = match parsed.scheme() {
        "https" => true,
        "http" => false,
        _ => return Err("The address must start with https://.".into()),
    };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("The address may not contain a login.".into());
    }
    if parsed.query().is_some() {
        return Err("The address may not contain a query (the part after ?).".into());
    }
    if parsed.fragment().is_some() {
        return Err("The address may not contain a fragment (the part after #).".into());
    }
    let local = match parsed.host() {
        None => return Err("The address has no host.".into()),
        Some(url::Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            if name.is_empty() {
                return Err("The address has no host.".into());
            }
            name == "localhost" || name.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(ip)) => ip_is_local(IpAddr::V4(ip))?,
        Some(url::Host::Ipv6(ip)) => ip_is_local(IpAddr::V6(ip))?,
    };
    if !https {
        if !kind.compatible() {
            return Err("This provider needs an https:// address.".into());
        }
        if !local {
            return Err("Plain http:// is only allowed on this device or in the local network; use https://.".into());
        }
    }
    let mut normalized = parsed.to_string();
    while normalized.ends_with('/') {
        normalized.pop();
    }
    if kind == ProviderKind::Ollama && !normalized.ends_with("/v1") {
        normalized.push_str("/v1");
    }
    Ok(normalized)
}

/// Whether an address typed as an IP is on this device or in a private network; refused for the
/// ranges no provider is on (link-local with the cloud metadata, unspecified, broadcast, multicast).
fn ip_is_local(ip: IpAddr) -> std::result::Result<bool, String> {
    let refused = || "This address can't be used for a provider.".to_string();
    match ip {
        IpAddr::V4(ip) => ipv4_is_local(ip).ok_or_else(refused),
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return ipv4_is_local(v4).ok_or_else(refused);
            }
            let first = ip.segments()[0];
            if ip.is_unspecified() || ip.is_multicast() || (first & 0xffc0) == 0xfe80 {
                return Err(refused());
            }
            Ok(ip == Ipv6Addr::LOCALHOST || (first & 0xfe00) == 0xfc00)
        }
    }
}

/// `Some(local)`, or `None` for a refused IPv4 address.
fn ipv4_is_local(ip: Ipv4Addr) -> Option<bool> {
    let [a, b, ..] = ip.octets();
    if a == 0 || ip.is_link_local() || ip.is_broadcast() || ip.is_multicast() {
        return None;
    }
    Some(ip.is_loopback() || ip.is_private() || (a == 100 && (b & 0xc0) == 64))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

/// An answer that must have a shape: asked for as JSON with this schema where the provider takes
/// schemas, and checked by the caller either way.
#[derive(Debug, Clone)]
pub struct JsonSchema {
    /// `[a-zA-Z0-9_-]`, like `spam_check`.
    pub name: &'static str,
    pub schema: Value,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    /// The instructions; mail content is never in here, only in `messages`.
    pub system: String,
    pub messages: Vec<ChatMessage>,
    pub max_output_tokens: u32,
    pub json_schema: Option<JsonSchema>,
    pub temperature: Option<f32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone)]
pub struct ChatAnswer {
    pub text: String,
    /// What the provider reported; `None` when it reported nothing.
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Model {
    pub id: String,
    pub name: String,
}

/// Asks the model. With `on_delta`, the answer is streamed and every new piece of text is handed
/// to it as it comes; the returned answer holds the whole text either way. Errors are
/// `Error::assist("providerFailed", …)` in plain words (wrong key, not reachable, too slow, busy with
/// `retry_after`, an answer that isn't usable, a refusal). Dropping the future stops the request.
///
/// With a `json_schema`, Chat Completions servers get it as `response_format`; one that refuses it
/// is asked once more without (the prompt asks for JSON anyway). Anthropic gets the schema in the
/// instructions. The text comes back as the model wrote it, at most [`MAX_TEXT_CHARS`] characters:
/// the caller finds and checks the JSON.
pub async fn chat(
    http: &reqwest::Client,
    endpoint: &Endpoint,
    request: &ChatRequest,
    on_delta: Option<&mut (dyn FnMut(&str) + Send)>,
) -> Result<ChatAnswer> {
    let base = base_url(endpoint)?;
    if request.model.trim().is_empty() {
        return Err(Error::assist("invalidArguments", "No model is chosen for this provider."));
    }
    let headers = auth_headers(endpoint)?;
    let work = async {
        match endpoint.kind.shape() {
            Shape::Chat => chat_completions(http, endpoint, &base, &headers, request, on_delta).await,
            Shape::Messages => messages(http, endpoint, &base, &headers, request, on_delta).await,
        }
    };
    tokio::time::timeout(TOTAL_TIMEOUT, work).await.map_err(|_| too_slow())?
}

/// The models the provider offers (at most 500, sorted by id); doubles as a test of the key.
pub async fn models(http: &reqwest::Client, endpoint: &Endpoint) -> Result<Vec<Model>> {
    let base = base_url(endpoint)?;
    let headers = auth_headers(endpoint)?;
    let key = api_key(endpoint);
    let work = async {
        // OpenRouter lists its models to anyone: the key is tested on its own.
        if endpoint.kind == ProviderKind::OpenRouter {
            get_json(http, &format!("{base}/key"), &headers, key).await?;
        }
        // Anthropic hands out 20 at a time unless asked for more.
        let query = if endpoint.kind.shape() == Shape::Messages { "?limit=1000" } else { "" };
        let value = get_json(http, &format!("{base}/models{query}"), &headers, key).await?;
        Ok(model_list(&value))
    };
    tokio::time::timeout(MODELS_TIMEOUT, work).await.map_err(|_| too_slow())?
}

/// The client for requests to providers: no redirects, no cookies, bounded connect time.
pub fn http_client() -> Result<reqwest::Client> {
    crate::tls::http_client()?
        .user_agent(concat!("UwUMail/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| Error::internal(format!("HTTP client setup failed: {e}")))
}

// ---------------------------------------------------------------------------------------------
// Requests

fn base_url(endpoint: &Endpoint) -> Result<String> {
    let base = endpoint
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|base| !base.is_empty())
        .or(endpoint.kind.default_base_url())
        .ok_or_else(|| Error::assist("invalidArguments", "This provider needs an address."))?;
    Ok(base.trim_end_matches('/').to_string())
}

fn api_key(endpoint: &Endpoint) -> Option<&str> {
    endpoint.api_key.as_deref().map(str::trim).filter(|key| !key.is_empty())
}

/// The key (marked sensitive, so it never shows in reqwest's own output) and the fixed headers.
fn auth_headers(endpoint: &Endpoint) -> Result<HeaderMap> {
    let key = api_key(endpoint);
    if key.is_none() && endpoint.kind.key_required() {
        return Err(Error::assist("invalidArguments", "This provider needs a key."));
    }
    let secret = |value: &str| -> Result<HeaderValue> {
        let mut value = HeaderValue::from_str(value)
            .map_err(|_| Error::assist("invalidArguments", "The key contains characters that can't be sent."))?;
        value.set_sensitive(true);
        Ok(value)
    };
    let mut headers = HeaderMap::new();
    match endpoint.kind.shape() {
        Shape::Chat => {
            if let Some(key) = key {
                headers.insert(AUTHORIZATION, secret(&format!("Bearer {key}"))?);
            }
            if endpoint.kind == ProviderKind::OpenRouter {
                headers.insert(HeaderName::from_static("x-title"), HeaderValue::from_static("UwUMail"));
            }
        }
        Shape::Messages => {
            if let Some(key) = key {
                headers.insert(HeaderName::from_static("x-api-key"), secret(key)?);
            }
            headers.insert(HeaderName::from_static("anthropic-version"), HeaderValue::from_static(ANTHROPIC_VERSION));
        }
    }
    Ok(headers)
}

fn accept(stream: bool) -> &'static str {
    if stream { "text/event-stream" } else { "application/json" }
}

/// A temperature as the person would write it (`0.2`, not `0.20000000298023224`).
fn temperature(value: f32) -> Value {
    json!((f64::from(value) * 100.0).round() / 100.0)
}

fn message_list(request: &ChatRequest) -> Vec<Value> {
    request.messages.iter().map(|message| json!({ "role": message.role, "content": message.content })).collect()
}

fn chat_body(kind: ProviderKind, request: &ChatRequest, stream: bool, schema: bool, stream_options: bool) -> Value {
    let mut messages = Vec::with_capacity(request.messages.len() + 1);
    if !request.system.is_empty() {
        messages.push(json!({ "role": "system", "content": request.system }));
    }
    messages.extend(message_list(request));
    let mut body = json!({ "model": request.model, "messages": messages, "stream": stream });
    let tokens = request.max_output_tokens.max(1);
    if kind == ProviderKind::OpenAi {
        // The gpt-5 models take neither `max_tokens` nor a temperature.
        body["max_completion_tokens"] = json!(tokens);
    } else {
        body["max_tokens"] = json!(tokens);
        if let Some(value) = request.temperature {
            body["temperature"] = temperature(value);
        }
    }
    if stream && stream_options {
        body["stream_options"] = json!({ "include_usage": true });
    }
    if schema && let Some(schema) = &request.json_schema {
        body["response_format"] = json!({
            "type": "json_schema",
            "json_schema": { "name": schema.name, "schema": schema.schema, "strict": true },
        });
    }
    body
}

fn messages_body(request: &ChatRequest, stream: bool) -> Value {
    let mut system = request.system.clone();
    if let Some(schema) = &request.json_schema {
        if !system.is_empty() {
            system.push_str("\n\n");
        }
        system.push_str(
            "Answer only with one JSON value that matches this JSON schema, with no other text before or after it:\n",
        );
        system.push_str(&schema.schema.to_string());
    }
    let mut body = json!({
        "model": request.model,
        "max_tokens": request.max_output_tokens.max(1),
        "messages": message_list(request),
        "stream": stream,
    });
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    if let Some(value) = request.temperature {
        body["temperature"] = temperature(value);
    }
    body
}

/// An answer other than 2xx, read (a little of it) for the error and the fallbacks.
struct Refusal {
    status: u16,
    retry_after: Option<u64>,
    body: String,
}

impl Refusal {
    /// What to leave out when asking once more: (the schema, `stream_options`). Nothing when the
    /// refusal isn't about either.
    fn fallbacks(&self, kind: ProviderKind, schema: bool, stream_options: bool) -> (bool, bool) {
        if !matches!(self.status, 400 | 422) {
            return (false, false);
        }
        let text = self.body.to_lowercase();
        let about_schema = ["response_format", "json_schema", "schema"].iter().any(|word| text.contains(word));
        let about_stream = text.contains("stream_options");
        // Compatible servers often say nothing useful: leave out both.
        let unclear = kind.compatible() && self.status == 400 && !about_schema && !about_stream;
        let drop_schema = schema && (about_schema || unclear);
        let drop_stream_options = stream_options && self.status == 400 && (about_stream || unclear);
        (drop_schema, drop_stream_options)
    }

    fn into_error(self, key: Option<&str>) -> Error {
        let status = self.status;
        let detail = serde_json::from_slice::<Value>(self.body.as_bytes()).ok().and_then(|value| detail(&value, key));
        let with_detail = |text: &str| match &detail {
            Some(detail) => format!("{text} (HTTP {status}): {detail}"),
            None => format!("{text} (HTTP {status})."),
        };
        let message = match status {
            401 | 403 => "The provider didn't accept the key.".to_string(),
            404 => with_detail("The provider doesn't know this model or address"),
            429 => "The provider is busy right now. Try again in a moment.".to_string(),
            300..=399 => "The provider's address sends elsewhere, which isn't followed. Check the address.".to_string(),
            500..=599 => format!("The provider isn't available right now (HTTP {status})."),
            _ => with_detail("The provider refused the request"),
        };
        let error = Error::assist("providerFailed", message);
        if status == 429 { error.with_retry_after(self.retry_after) } else { error }
    }
}

/// Sends a request; `Ok(Err(…))` is an answer other than 2xx (a redirect too: none is followed).
async fn send(request: reqwest::RequestBuilder) -> Result<std::result::Result<reqwest::Response, Refusal>> {
    let response = match tokio::time::timeout(IDLE_TIMEOUT, request.send()).await {
        Err(_) => return Err(too_slow()),
        Ok(Err(error)) => return Err(transport_error(&error)),
        Ok(Ok(response)) => response,
    };
    let status = response.status();
    if status.is_success() {
        return Ok(Ok(response));
    }
    let retry_after = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| seconds.min(86_400));
    let limits =
        StreamLimits { idle: Duration::from_secs(10), total: Duration::from_secs(10), max_bytes: MAX_ERROR_BYTES };
    let body = sse::read_body(response, limits).await.unwrap_or_default();
    Ok(Err(Refusal { status: status.as_u16(), retry_after, body: String::from_utf8_lossy(&body).into_owned() }))
}

fn limits(max_bytes: usize) -> StreamLimits {
    StreamLimits { idle: IDLE_TIMEOUT, total: TOTAL_TIMEOUT, max_bytes }
}

async fn read_json(response: reqwest::Response) -> Result<Value> {
    let body = sse::read_body(response, limits(MAX_BODY_BYTES)).await.map_err(read_error)?;
    serde_json::from_slice(&body).map_err(|_| unusable())
}

async fn get_json(http: &reqwest::Client, url: &str, headers: &HeaderMap, key: Option<&str>) -> Result<Value> {
    let request = http.get(url).headers(headers.clone()).header(ACCEPT, "application/json");
    match send(request).await? {
        Ok(response) => read_json(response).await,
        Err(refusal) => Err(refusal.into_error(key)),
    }
}

// ---------------------------------------------------------------------------------------------
// Chat Completions

async fn chat_completions(
    http: &reqwest::Client,
    endpoint: &Endpoint,
    base: &str,
    headers: &HeaderMap,
    request: &ChatRequest,
    mut on_delta: Option<&mut (dyn FnMut(&str) + Send)>,
) -> Result<ChatAnswer> {
    let url = format!("{base}/chat/completions");
    let key = api_key(endpoint);
    let stream = on_delta.is_some();
    let mut schema = request.json_schema.is_some();
    let mut stream_options = stream;
    // Every retry leaves out one more of the two, so there are three tries at most.
    loop {
        let body = chat_body(endpoint.kind, request, stream, schema, stream_options);
        let post = http.post(&url).headers(headers.clone()).header(ACCEPT, accept(stream)).json(&body);
        let response = match send(post).await? {
            Ok(response) => response,
            Err(refusal) => {
                let (drop_schema, drop_stream_options) = refusal.fallbacks(endpoint.kind, schema, stream_options);
                if !drop_schema && !drop_stream_options {
                    return Err(refusal.into_error(key));
                }
                schema &= !drop_schema;
                stream_options &= !drop_stream_options;
                continue;
            }
        };
        return if stream {
            stream_chat(response, on_delta.take(), key).await
        } else {
            parse_chat(&read_json(response).await?, key)
        };
    }
}

fn parse_chat(value: &Value, key: Option<&str>) -> Result<ChatAnswer> {
    if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
        return Err(provider_said(error, key));
    }
    let choice = value.pointer("/choices/0").ok_or_else(unusable)?;
    let message = choice.get("message");
    let finish = choice.get("finish_reason").and_then(Value::as_str);
    let refusal = message.and_then(|message| message.get("refusal")).and_then(Value::as_str);
    if refusal.is_some_and(|refusal| !refusal.trim().is_empty()) || finish == Some("content_filter") {
        return Err(refused());
    }
    let text = message.and_then(|message| message.get("content")).map(content_text).unwrap_or_default();
    let usage = value.get("usage").and_then(|usage| usage_of(usage, "prompt_tokens", "completion_tokens"));
    answer(cap(&text), usage, finish == Some("length"))
}

/// `content` as a string, or as parts with text.
fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts.iter().filter_map(|part| part.get("text").and_then(Value::as_str)).collect(),
        _ => String::new(),
    }
}

async fn stream_chat(
    response: reqwest::Response,
    on_delta: Option<&mut (dyn FnMut(&str) + Send)>,
    key: Option<&str>,
) -> Result<ChatAnswer> {
    let mut text = Collector::new(on_delta);
    let mut usage = None;
    let mut finish: Option<String> = None;
    let mut refusal = false;
    sse::read_events(response, limits(MAX_STREAM_BYTES), |event: SseEvent| {
        let data = event.data.trim();
        if data == "[DONE]" {
            return Ok(Flow::Stop);
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else { return Ok(Flow::Continue) };
        if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
            return Err(provider_said(error, key));
        }
        if let Some(reported) = value.get("usage").and_then(|u| usage_of(u, "prompt_tokens", "completion_tokens")) {
            usage = Some(reported);
        }
        // Ollama's own NDJSON (`/api/chat`), for a server that answers that way.
        if let Some(reported) = usage_of(&value, "prompt_eval_count", "eval_count") {
            usage = Some(reported);
        }
        let choice = value.pointer("/choices/0");
        if let Some(reason) = choice.and_then(|choice| choice.get("finish_reason")).and_then(Value::as_str) {
            finish = Some(reason.to_string());
        }
        if choice
            .and_then(|choice| choice.pointer("/delta/refusal"))
            .and_then(Value::as_str)
            .is_some_and(|r| !r.is_empty())
        {
            refusal = true;
        }
        let piece = match choice {
            Some(choice) => choice.pointer("/delta/content"),
            None => value.pointer("/message/content"),
        };
        if let Some(piece) = piece.and_then(Value::as_str)
            && text.push(piece) == Flow::Stop
        {
            return Ok(Flow::Stop);
        }
        if value.get("done").and_then(Value::as_bool) == Some(true) {
            return Ok(Flow::Stop);
        }
        Ok(Flow::Continue)
    })
    .await
    .map_err(read_error)?;
    if refusal || finish.as_deref() == Some("content_filter") {
        return Err(refused());
    }
    answer(text.text, usage, finish.as_deref() == Some("length"))
}

// ---------------------------------------------------------------------------------------------
// Anthropic Messages

async fn messages(
    http: &reqwest::Client,
    endpoint: &Endpoint,
    base: &str,
    headers: &HeaderMap,
    request: &ChatRequest,
    on_delta: Option<&mut (dyn FnMut(&str) + Send)>,
) -> Result<ChatAnswer> {
    let key = api_key(endpoint);
    let stream = on_delta.is_some();
    let post = http
        .post(format!("{base}/messages"))
        .headers(headers.clone())
        .header(ACCEPT, accept(stream))
        .json(&messages_body(request, stream));
    let response = match send(post).await? {
        Ok(response) => response,
        Err(refusal) => return Err(refusal.into_error(key)),
    };
    if stream {
        stream_messages(response, on_delta, key).await
    } else {
        parse_messages(&read_json(response).await?, key)
    }
}

fn anthropic_usage(usage: &Value) -> Option<TokenUsage> {
    let number = |name: &str| usage.get(name).and_then(Value::as_u64).unwrap_or(0);
    usage.is_object().then(|| TokenUsage {
        input_tokens: number("input_tokens")
            + number("cache_read_input_tokens")
            + number("cache_creation_input_tokens"),
        output_tokens: number("output_tokens"),
    })
}

fn parse_messages(value: &Value, key: Option<&str>) -> Result<ChatAnswer> {
    if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
        return Err(provider_said(error, key));
    }
    let stop = value.get("stop_reason").and_then(Value::as_str);
    if stop == Some("refusal") {
        return Err(refused());
    }
    let text: String = value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect();
    let usage = value.get("usage").and_then(anthropic_usage);
    answer(cap(&text), usage, stop == Some("max_tokens"))
}

async fn stream_messages(
    response: reqwest::Response,
    on_delta: Option<&mut (dyn FnMut(&str) + Send)>,
    key: Option<&str>,
) -> Result<ChatAnswer> {
    let mut text = Collector::new(on_delta);
    let mut usage: Option<TokenUsage> = None;
    let mut stop: Option<String> = None;
    sse::read_events(response, limits(MAX_STREAM_BYTES), |event: SseEvent| {
        let Ok(value) = serde_json::from_str::<Value>(event.data.trim()) else { return Ok(Flow::Continue) };
        match value.get("type").and_then(Value::as_str).unwrap_or(event.event.as_str()) {
            "message_start" => {
                if let Some(reported) = value.pointer("/message/usage").and_then(anthropic_usage) {
                    usage = Some(reported);
                }
            }
            "content_block_delta" => {
                if value.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta")
                    && let Some(piece) = value.pointer("/delta/text").and_then(Value::as_str)
                    && text.push(piece) == Flow::Stop
                {
                    return Ok(Flow::Stop);
                }
            }
            "message_delta" => {
                if let Some(reason) = value.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    stop = Some(reason.to_string());
                }
                if let Some(tokens) = value.pointer("/usage/output_tokens").and_then(Value::as_u64) {
                    usage.get_or_insert_default().output_tokens = tokens;
                }
            }
            "error" => {
                let kind = value.pointer("/error/type").and_then(Value::as_str).unwrap_or_default();
                if kind == "overloaded_error" || kind == "rate_limit_error" {
                    return Err(busy());
                }
                return Err(provider_said(value.get("error").unwrap_or(&Value::Null), key));
            }
            "message_stop" => return Ok(Flow::Stop),
            _ => {}
        }
        Ok(Flow::Continue)
    })
    .await
    .map_err(read_error)?;
    if stop.as_deref() == Some("refusal") {
        return Err(refused());
    }
    answer(text.text, usage, stop.as_deref() == Some("max_tokens"))
}

// ---------------------------------------------------------------------------------------------
// Answers

/// Streamed text, kept up to [`MAX_TEXT_CHARS`] and handed on piece by piece.
struct Collector<'a> {
    text: String,
    chars: usize,
    on_delta: Option<&'a mut (dyn FnMut(&str) + Send)>,
}

impl<'a> Collector<'a> {
    fn new(on_delta: Option<&'a mut (dyn FnMut(&str) + Send)>) -> Self {
        Self { text: String::new(), chars: 0, on_delta }
    }

    /// Takes a piece; `Stop` once the text is full (the rest is dropped).
    fn push(&mut self, piece: &str) -> Flow {
        let room = MAX_TEXT_CHARS.saturating_sub(self.chars);
        let (piece, full) = match piece.char_indices().nth(room) {
            Some((cut, _)) => (&piece[..cut], true),
            None => (piece, false),
        };
        if !piece.is_empty() {
            self.chars += piece.chars().count();
            self.text.push_str(piece);
            if let Some(on_delta) = self.on_delta.as_mut() {
                on_delta(piece);
            }
        }
        if full || self.chars >= MAX_TEXT_CHARS { Flow::Stop } else { Flow::Continue }
    }
}

fn cap(text: &str) -> String {
    match text.char_indices().nth(MAX_TEXT_CHARS) {
        Some((cut, _)) => text[..cut].to_string(),
        None => text.to_string(),
    }
}

fn answer(text: String, usage: Option<TokenUsage>, cut_off: bool) -> Result<ChatAnswer> {
    if text.trim().is_empty() {
        let message = if cut_off {
            "The model used up its tokens before it wrote an answer."
        } else {
            "The model gave an empty answer."
        };
        return Err(Error::assist("providerFailed", message));
    }
    Ok(ChatAnswer { text, usage })
}

fn usage_of(usage: &Value, input: &str, output: &str) -> Option<TokenUsage> {
    let input = usage.get(input).and_then(Value::as_u64);
    let output = usage.get(output).and_then(Value::as_u64);
    (input.is_some() || output.is_some())
        .then(|| TokenUsage { input_tokens: input.unwrap_or(0), output_tokens: output.unwrap_or(0) })
}

// ---------------------------------------------------------------------------------------------
// Models

fn model_list(value: &Value) -> Vec<Model> {
    let list = value.get("data").or_else(|| value.get("models")).and_then(Value::as_array);
    let mut models: Vec<Model> = list
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let raw = entry.get("id").or_else(|| entry.get("name")).and_then(Value::as_str)?.trim();
            // Gemini names its models `models/…`.
            let id = raw.strip_prefix("models/").unwrap_or(raw);
            if id.is_empty() || id.chars().count() > MAX_MODEL_ID_CHARS || id.chars().any(char::is_control) {
                return None;
            }
            let name = entry
                .get("display_name")
                .or_else(|| entry.get("name"))
                .and_then(Value::as_str)
                .map(|name| shorten(name.strip_prefix("models/").unwrap_or(name), 100))
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| id.to_string());
            Some(Model { id: id.to_string(), name })
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    models.truncate(MAX_MODELS);
    models
}

// ---------------------------------------------------------------------------------------------
// Errors (plain words; never the key)

/// At most `max` characters of `text`, on one line.
fn shorten(text: &str, max: usize) -> String {
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let flat = flat.trim();
    match flat.char_indices().nth(max) {
        Some((cut, _)) => format!("{}…", &flat[..cut]),
        None => flat.to_string(),
    }
}

/// The provider's own words about an error (`{"error": {"message": …}}` in its variants), without
/// the key and shortened.
fn detail(value: &Value, key: Option<&str>) -> Option<String> {
    let value = match value {
        Value::Array(items) => items.first()?,
        _ => value,
    };
    let text = match value {
        Value::String(text) => text.as_str(),
        _ => value
            .pointer("/error/message")
            .or_else(|| value.get("message"))
            .or_else(|| value.get("error").filter(|error| error.is_string()))
            .or_else(|| value.get("detail"))?
            .as_str()?,
    };
    let text = match key {
        Some(key) => text.replace(key, "***"),
        None => text.to_string(),
    };
    Some(shorten(&text, MAX_DETAIL_CHARS)).filter(|text| !text.is_empty())
}

fn provider_said(error: &Value, key: Option<&str>) -> Error {
    let message = match detail(error, key) {
        Some(detail) => format!("The provider reported an error: {detail}"),
        None => "The provider reported an error.".to_string(),
    };
    Error::assist("providerFailed", message)
}

fn transport_error(error: &reqwest::Error) -> Error {
    if error.is_builder() {
        Error::assist("invalidArguments", "The provider's address can't be used.")
    } else if error.is_timeout() {
        too_slow()
    } else {
        Error::assist("providerFailed", "The provider can't be reached. Check the address and the connection.")
    }
}

/// Errors while reading an answer: the reader's own stay, a broken connection gets plain words.
fn read_error(error: Error) -> Error {
    if error.assist.is_some() {
        error
    } else {
        Error::assist("providerFailed", "The connection to the provider broke off.")
    }
}

fn too_slow() -> Error {
    Error::assist("providerFailed", "The model took too long to answer.")
}

fn busy() -> Error {
    Error::assist("providerFailed", "The provider is busy right now. Try again in a moment.")
}

fn refused() -> Error {
    Error::assist("providerFailed", "The model refused to answer.")
}

fn unusable() -> Error {
    Error::assist("providerFailed", "The provider's answer couldn't be read.")
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    use super::*;

    const KEY: &str = "sk-test-SECRET-4242";

    #[derive(Debug, Clone)]
    struct Recorded {
        method: String,
        path: String,
        headers: Vec<(String, String)>,
        body: String,
    }

    impl Recorded {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
        }

        fn json(&self) -> Value {
            serde_json::from_str(&self.body).expect("a JSON body")
        }
    }

    struct Reply {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Reply {
        fn new(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Self {
            Self { status, headers: vec![("content-type".into(), content_type.into())], body: body.into() }
        }

        fn json(status: u16, value: Value) -> Self {
            Self::new(status, "application/json", value.to_string())
        }

        fn sse(body: &str) -> Self {
            Self::new(200, "text/event-stream", body)
        }

        fn header(mut self, name: &str, value: &str) -> Self {
            self.headers.push((name.into(), value.into()));
            self
        }
    }

    /// A server on 127.0.0.1 that answers one request per canned reply, in order, and records them.
    struct Stub {
        base: String,
        requests: Arc<Mutex<Vec<Recorded>>>,
    }

    impl Stub {
        fn requests(&self) -> Vec<Recorded> {
            self.requests.lock().unwrap().clone()
        }
    }

    async fn stub(replies: Vec<Reply>) -> Stub {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        tokio::spawn(async move {
            for reply in replies {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let Some(request) = read_request(&mut socket).await else { return };
                log.lock().unwrap().push(request);
                let mut head = format!(
                    "HTTP/1.1 {} Stub\r\ncontent-length: {}\r\nconnection: close\r\n",
                    reply.status,
                    reply.body.len()
                );
                for (name, value) in &reply.headers {
                    head.push_str(&format!("{name}: {value}\r\n"));
                }
                head.push_str("\r\n");
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(&reply.body).await;
                let _ = socket.shutdown().await;
            }
        });
        Stub { base, requests }
    }

    async fn read_request(socket: &mut TcpStream) -> Option<Recorded> {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 8192];
        let head_end = loop {
            if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                break end;
            }
            let read = socket.read(&mut chunk).await.ok()?;
            if read == 0 || buffer.len() > 1 << 20 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..read]);
        };
        let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
        let mut lines = head.split("\r\n");
        let mut first = lines.next()?.split(' ');
        let (method, path) = (first.next()?.to_string(), first.next()?.to_string());
        let headers: Vec<(String, String)> = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
            .collect();
        let length: usize =
            headers.iter().find(|(n, _)| n == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
        let mut body = buffer[head_end + 4..].to_vec();
        while body.len() < length {
            let read = socket.read(&mut chunk).await.ok()?;
            if read == 0 {
                return None;
            }
            body.extend_from_slice(&chunk[..read]);
        }
        Some(Recorded { method, path, headers, body: String::from_utf8_lossy(&body).into_owned() })
    }

    fn endpoint(kind: ProviderKind, base: &str) -> Endpoint {
        Endpoint { kind, base_url: Some(base.to_string()), api_key: Some(KEY.to_string()) }
    }

    fn request(schema: bool) -> ChatRequest {
        ChatRequest {
            model: "m-1".into(),
            system: "Be brief.".into(),
            messages: vec![ChatMessage { role: Role::User, content: "Hallo".into() }],
            max_output_tokens: 300,
            json_schema: schema.then(|| JsonSchema {
                name: "spam_check",
                schema: json!({ "type": "object", "properties": { "spam": { "type": "boolean" } }, "required": ["spam"] }),
            }),
            temperature: Some(0.2),
        }
    }

    /// Asks, collecting the streamed pieces when `stream`.
    async fn ask(endpoint: &Endpoint, request: &ChatRequest, stream: bool) -> (Result<ChatAnswer>, Vec<String>) {
        let http = http_client().unwrap();
        let mut pieces = Vec::new();
        let mut sink = |piece: &str| pieces.push(piece.to_string());
        let result = if stream {
            chat(&http, endpoint, request, Some(&mut sink)).await
        } else {
            chat(&http, endpoint, request, None).await
        };
        (result, pieces)
    }

    /// A `providerFailed` error that does not show the key.
    fn failed(result: Result<ChatAnswer>) -> Error {
        let error = result.expect_err("an error");
        assert_eq!(error.assist_kind(), Some("providerFailed"), "{error:?}");
        assert_no_key(&error);
        error
    }

    fn assert_no_key(error: &Error) {
        let all = format!("{error:?} {error} {}", serde_json::to_string(error).unwrap());
        assert!(!all.contains(KEY), "the key leaked: {all}");
    }

    #[tokio::test]
    async fn openai_non_streamed() {
        let server = stub(vec![Reply::json(
            200,
            json!({
                "choices": [{ "message": { "role": "assistant", "content": "Hi there" }, "finish_reason": "stop" }],
                "usage": { "prompt_tokens": 12, "completion_tokens": 3 }
            }),
        )])
        .await;
        let (answer, _) = ask(&endpoint(ProviderKind::OpenAi, &server.base), &request(true), false).await;
        let answer = answer.unwrap();
        assert_eq!(answer.text, "Hi there");
        assert_eq!(answer.usage, Some(TokenUsage { input_tokens: 12, output_tokens: 3 }));
        let sent = &server.requests()[0];
        assert_eq!((sent.method.as_str(), sent.path.as_str()), ("POST", "/v1/chat/completions"));
        assert_eq!(sent.header("authorization"), Some(format!("Bearer {KEY}").as_str()));
        assert_eq!(sent.header("accept"), Some("application/json"));
        let body = sent.json();
        assert_eq!(body["model"], "m-1");
        assert_eq!(body["max_completion_tokens"], 300);
        assert!(body.get("max_tokens").is_none() && body.get("temperature").is_none());
        assert_eq!(body["stream"], false);
        assert_eq!(
            body["messages"],
            json!([{ "role": "system", "content": "Be brief." }, { "role": "user", "content": "Hallo" }])
        );
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(body["response_format"]["json_schema"]["name"], "spam_check");
        assert_eq!(body["response_format"]["json_schema"]["strict"], true);
        assert_eq!(body["response_format"]["json_schema"]["schema"]["required"], json!(["spam"]));
    }

    #[tokio::test]
    async fn openai_streamed_with_usage() {
        let server = stub(vec![Reply::sse(concat!(
            ": keep-alive\n\n",
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hal\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo ✓\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n",
            "data: [DONE]\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"after the end\"}}]}\n\n",
        ))])
        .await;
        let (answer, pieces) = ask(&endpoint(ProviderKind::OpenAi, &server.base), &request(false), true).await;
        let answer = answer.unwrap();
        assert_eq!(answer.text, "Hallo ✓");
        assert_eq!(pieces, ["Hal", "lo ✓"]);
        assert_eq!(answer.usage, Some(TokenUsage { input_tokens: 5, output_tokens: 2 }));
        let sent = &server.requests()[0];
        assert_eq!(sent.header("accept"), Some("text/event-stream"));
        let body = sent.json();
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"], json!({ "include_usage": true }));
        assert!(body.get("response_format").is_none());
    }

    #[tokio::test]
    async fn a_refused_schema_is_left_out_on_a_second_try() {
        let server = stub(vec![
            Reply::json(
                400,
                json!({ "error": { "message": "Invalid response_format: json_schema is not supported" } }),
            ),
            Reply::json(200, json!({ "choices": [{ "message": { "content": "{\"spam\":true}" } }] })),
        ])
        .await;
        let (answer, _) = ask(&endpoint(ProviderKind::Mistral, &server.base), &request(true), false).await;
        assert_eq!(answer.unwrap().text, "{\"spam\":true}");
        let sent = server.requests();
        assert_eq!(sent.len(), 2);
        let (first, second) = (sent[0].json(), sent[1].json());
        assert!(first.get("response_format").is_some());
        assert_eq!(first["max_tokens"], 300);
        assert_eq!(first["temperature"], 0.2);
        assert!(second.get("response_format").is_none());
        assert_eq!(second["messages"], first["messages"]);
    }

    #[tokio::test]
    async fn a_compatible_server_saying_nothing_useful_is_asked_plainly() {
        let server = stub(vec![
            Reply::new(400, "text/plain", "bad request"),
            Reply::sse("data: {\"choices\":[{\"delta\":{\"content\":\"{}\"}}]}\n\ndata: [DONE]\n\n"),
        ])
        .await;
        let local =
            Endpoint { kind: ProviderKind::OpenAiCompatible, base_url: Some(server.base.clone()), api_key: None };
        let (answer, pieces) = ask(&local, &request(true), true).await;
        let answer = answer.unwrap();
        assert_eq!((answer.text.as_str(), answer.usage), ("{}", None));
        assert_eq!(pieces, ["{}"]);
        let sent = server.requests();
        assert_eq!(sent.len(), 2);
        assert!(sent[0].header("authorization").is_none());
        assert!(sent[0].json().get("stream_options").is_some() && sent[0].json().get("response_format").is_some());
        assert!(sent[1].json().get("stream_options").is_none() && sent[1].json().get("response_format").is_none());
    }

    #[tokio::test]
    async fn refused_stream_options_are_left_out_alone() {
        let server = stub(vec![
            Reply::json(400, json!({ "error": "unknown field: stream_options" })),
            Reply::sse("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n"),
        ])
        .await;
        let (answer, _) = ask(&endpoint(ProviderKind::OpenAiCompatible, &server.base), &request(true), true).await;
        assert_eq!(answer.unwrap().text, "ok");
        let sent = server.requests();
        assert_eq!(sent.len(), 2);
        assert!(sent[1].json().get("stream_options").is_none());
        assert!(sent[1].json().get("response_format").is_some(), "the schema stays");
    }

    #[tokio::test]
    async fn other_bad_requests_are_not_retried_and_hide_the_key() {
        let server = stub(vec![Reply::json(
            400,
            json!({ "error": { "message": format!("Something is off with {KEY} and the\nmessages") } }),
        )])
        .await;
        let (answer, _) = ask(&endpoint(ProviderKind::OpenAi, &server.base), &request(true), false).await;
        let error = failed(answer);
        assert_eq!(
            error.message,
            "The provider refused the request (HTTP 400): Something is off with *** and the messages"
        );
        assert_eq!(server.requests().len(), 1);
    }

    #[tokio::test]
    async fn anthropic_non_streamed() {
        let server = stub(vec![Reply::json(
            200,
            json!({
                "type": "message",
                "content": [{ "type": "text", "text": "{\"spam\":" }, { "type": "text", "text": "false}" }],
                "stop_reason": "end_turn",
                "usage": { "input_tokens": 10, "cache_read_input_tokens": 2, "output_tokens": 4 }
            }),
        )])
        .await;
        let (answer, _) = ask(&endpoint(ProviderKind::Anthropic, &server.base), &request(true), false).await;
        let answer = answer.unwrap();
        assert_eq!(answer.text, "{\"spam\":false}");
        assert_eq!(answer.usage, Some(TokenUsage { input_tokens: 12, output_tokens: 4 }));
        let sent = &server.requests()[0];
        assert_eq!((sent.method.as_str(), sent.path.as_str()), ("POST", "/v1/messages"));
        assert_eq!(sent.header("x-api-key"), Some(KEY));
        assert_eq!(sent.header("anthropic-version"), Some("2023-06-01"));
        assert!(sent.header("authorization").is_none());
        let body = sent.json();
        let system = body["system"].as_str().unwrap();
        assert!(system.starts_with("Be brief.\n\n") && system.contains("JSON schema") && system.contains("\"spam\""));
        assert_eq!(body["max_tokens"], 300);
        assert_eq!(body["temperature"], 0.2);
        assert_eq!(body["messages"], json!([{ "role": "user", "content": "Hallo" }]));
        assert!(body.get("response_format").is_none());
    }

    #[tokio::test]
    async fn anthropic_streamed() {
        let server = stub(vec![Reply::sse(concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":9,\"output_tokens\":1}}}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0}\n\n",
            "event: ping\ndata: {\"type\":\"ping\"}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Guten\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\" Tag\"}}\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":7}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        ))])
        .await;
        let (answer, pieces) = ask(&endpoint(ProviderKind::Anthropic, &server.base), &request(false), true).await;
        let answer = answer.unwrap();
        assert_eq!(answer.text, "Guten Tag");
        assert_eq!(pieces, ["Guten", " Tag"]);
        assert_eq!(answer.usage, Some(TokenUsage { input_tokens: 9, output_tokens: 7 }));
        let body = server.requests()[0].json();
        assert_eq!(body["stream"], true);
        assert_eq!(body["system"], "Be brief.");
    }

    #[tokio::test]
    async fn anthropic_stream_errors_fail() {
        let server = stub(vec![Reply::sse(concat!(
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n",
            "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal trouble\"}}\n\n",
        ))])
        .await;
        let (answer, _) = ask(&endpoint(ProviderKind::Anthropic, &server.base), &request(false), true).await;
        assert_eq!(failed(answer).message, "The provider reported an error: Internal trouble");
    }

    #[tokio::test]
    async fn statuses_in_plain_words() {
        let cases = [
            (
                Reply::json(401, json!({ "error": { "message": format!("Incorrect API key provided: {KEY}") } })),
                "didn't accept the key",
            ),
            (Reply::json(403, json!({})), "didn't accept the key"),
            (
                Reply::json(404, json!({ "error": { "message": "model m-1 not found" } })),
                "doesn't know this model or address (HTTP 404): model m-1 not found",
            ),
            (Reply::json(500, json!({})), "isn't available right now (HTTP 500)"),
            (Reply::json(529, json!({})), "isn't available right now (HTTP 529)"),
            (
                Reply::new(302, "text/plain", "").header("location", "https://elsewhere.example.com/v1"),
                "isn't followed",
            ),
        ];
        for (reply, words) in cases {
            let server = stub(vec![reply]).await;
            let (answer, _) = ask(&endpoint(ProviderKind::OpenAi, &server.base), &request(false), false).await;
            let error = failed(answer);
            assert!(error.message.contains(words), "{} lacks {words}", error.message);
            assert_eq!(error.assist.as_ref().unwrap().retry_after, None);
            assert_eq!(server.requests().len(), 1);
        }
    }

    #[tokio::test]
    async fn busy_names_the_wait() {
        let server = stub(vec![Reply::json(429, json!({})).header("retry-after", "7")]).await;
        let (answer, _) = ask(&endpoint(ProviderKind::Anthropic, &server.base), &request(false), true).await;
        let error = failed(answer);
        assert!(error.message.contains("busy"));
        assert_eq!(error.assist.as_ref().unwrap().retry_after, Some(7));
    }

    #[tokio::test]
    async fn refusals_and_empty_answers_fail() {
        let cases = [
            (
                ProviderKind::OpenAi,
                false,
                Reply::json(
                    200,
                    json!({ "choices": [{ "message": { "content": null, "refusal": "I can't help with that." } }] }),
                ),
                "The model refused to answer.",
            ),
            (
                ProviderKind::Gemini,
                false,
                Reply::json(
                    200,
                    json!({ "choices": [{ "message": { "content": "" }, "finish_reason": "content_filter" }] }),
                ),
                "The model refused to answer.",
            ),
            (
                ProviderKind::OpenAi,
                true,
                Reply::sse("data: {\"choices\":[{\"delta\":{\"refusal\":\"No.\"}}]}\n\ndata: [DONE]\n\n"),
                "The model refused to answer.",
            ),
            (
                ProviderKind::Anthropic,
                false,
                Reply::json(200, json!({ "content": [], "stop_reason": "refusal" })),
                "The model refused to answer.",
            ),
            (
                ProviderKind::Anthropic,
                true,
                Reply::sse("data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\"}}\n\n"),
                "The model refused to answer.",
            ),
            (
                ProviderKind::OpenAi,
                false,
                Reply::json(200, json!({ "choices": [{ "message": { "content": "  " }, "finish_reason": "stop" }] })),
                "The model gave an empty answer.",
            ),
            (
                ProviderKind::OpenAi,
                false,
                Reply::json(200, json!({ "choices": [{ "message": { "content": "" }, "finish_reason": "length" }] })),
                "The model used up its tokens before it wrote an answer.",
            ),
            (ProviderKind::OpenAi, true, Reply::sse("data: [DONE]\n\n"), "The model gave an empty answer."),
            (
                ProviderKind::OpenAi,
                false,
                Reply::json(200, json!({ "nothing": true })),
                "The provider's answer couldn't be read.",
            ),
            (
                ProviderKind::OpenRouter,
                false,
                Reply::json(200, json!({ "error": { "message": "No endpoints found", "code": 404 } })),
                "The provider reported an error: No endpoints found",
            ),
        ];
        for (kind, stream, reply, words) in cases {
            let server = stub(vec![reply]).await;
            let (answer, _) = ask(&endpoint(kind, &server.base), &request(false), stream).await;
            assert_eq!(failed(answer).message, words, "{kind:?}, stream {stream}");
        }
    }

    #[tokio::test]
    async fn an_oversized_answer_is_refused() {
        let body = format!("{{\"choices\":[{{\"message\":{{\"content\":\"{}\"}}}}]}}", "x".repeat(MAX_BODY_BYTES));
        let server = stub(vec![Reply::new(200, "application/json", body)]).await;
        let (answer, _) = ask(&endpoint(ProviderKind::OpenAi, &server.base), &request(false), false).await;
        assert_eq!(failed(answer).message, "The answer was too long.");
    }

    #[tokio::test]
    async fn streamed_text_stops_at_the_cap() {
        // Pieces below the stream parser's line limit, together longer than the cap.
        let piece = "ä".repeat(MAX_TEXT_CHARS / 4 + 10);
        let mut stream = String::new();
        for _ in 0..5 {
            stream.push_str(&format!("data: {}\n\n", json!({ "choices": [{ "delta": { "content": piece } }] })));
        }
        let server = stub(vec![Reply::sse(&stream)]).await;
        let (answer, pieces) = ask(&endpoint(ProviderKind::OpenAi, &server.base), &request(false), true).await;
        let answer = answer.unwrap();
        assert_eq!(answer.text.chars().count(), MAX_TEXT_CHARS);
        assert_eq!(pieces.len(), 4);
        assert_eq!(pieces.concat(), answer.text);
    }

    #[tokio::test]
    async fn ndjson_streams_are_read_too() {
        let server = stub(vec![Reply::new(
            200,
            "application/x-ndjson",
            concat!(
                "{\"message\":{\"role\":\"assistant\",\"content\":\"Moin\"},\"done\":false}\n",
                "{\"message\":{\"role\":\"assistant\",\"content\":\"!\"},\"done\":true,\"prompt_eval_count\":6,\"eval_count\":2}\n",
            ),
        )])
        .await;
        let local = Endpoint { kind: ProviderKind::Ollama, base_url: Some(server.base.clone()), api_key: None };
        let (answer, pieces) = ask(&local, &request(false), true).await;
        let answer = answer.unwrap();
        assert_eq!((answer.text.as_str(), pieces.len()), ("Moin!", 2));
        assert_eq!(answer.usage, Some(TokenUsage { input_tokens: 6, output_tokens: 2 }));
        assert!(server.requests()[0].header("authorization").is_none());
    }

    #[tokio::test]
    async fn an_address_nobody_listens_on_cannot_be_reached() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        drop(listener);
        let (answer, _) = ask(&endpoint(ProviderKind::OpenAi, &base), &request(false), false).await;
        assert!(failed(answer).message.contains("can't be reached"));
    }

    #[tokio::test]
    async fn requests_that_cannot_be_built() {
        let http = http_client().unwrap();
        let cases = [
            (Endpoint { kind: ProviderKind::Ollama, base_url: None, api_key: None }, "m-1", "needs an address"),
            (Endpoint { kind: ProviderKind::OpenAi, base_url: None, api_key: Some("  ".into()) }, "m-1", "needs a key"),
            (
                Endpoint { kind: ProviderKind::OpenAi, base_url: None, api_key: Some("sk-a\nb".into()) },
                "m-1",
                "can't be sent",
            ),
            (endpoint(ProviderKind::OpenAi, "http://127.0.0.1:9/v1"), " ", "No model"),
        ];
        for (endpoint, model, words) in cases {
            let request = ChatRequest { model: model.into(), ..request(false) };
            let error = chat(&http, &endpoint, &request, None).await.unwrap_err();
            assert_eq!(error.assist_kind(), Some("invalidArguments"));
            assert!(error.message.contains(words), "{}", error.message);
        }
    }

    async fn list(endpoint: &Endpoint) -> Result<Vec<Model>> {
        models(&http_client().unwrap(), endpoint).await
    }

    #[tokio::test]
    async fn models_are_sorted_and_deduplicated() {
        let server = stub(vec![Reply::json(
            200,
            json!({ "object": "list", "data": [{ "id": "b" }, { "id": "a" }, { "id": "b" }, { "id": "" }, {}] }),
        )])
        .await;
        let found = list(&endpoint(ProviderKind::OpenAi, &server.base)).await.unwrap();
        let ids: Vec<_> = found.iter().map(|m| (m.id.as_str(), m.name.as_str())).collect();
        assert_eq!(ids, [("a", "a"), ("b", "b")]);
        let sent = &server.requests()[0];
        assert_eq!((sent.method.as_str(), sent.path.as_str()), ("GET", "/v1/models"));
        assert_eq!(sent.header("authorization"), Some(format!("Bearer {KEY}").as_str()));
    }

    #[tokio::test]
    async fn gemini_models_lose_their_prefix() {
        let server = stub(vec![Reply::json(
            200,
            json!({ "data": [
                { "id": "models/gemini-2.5-flash", "object": "model" },
                { "id": "models/gemini-2.5-pro", "display_name": "Gemini 2.5 Pro" }
            ] }),
        )])
        .await;
        let found = list(&endpoint(ProviderKind::Gemini, &server.base)).await.unwrap();
        assert_eq!(
            found,
            [
                Model { id: "gemini-2.5-flash".into(), name: "gemini-2.5-flash".into() },
                Model { id: "gemini-2.5-pro".into(), name: "Gemini 2.5 Pro".into() },
            ]
        );
    }

    #[tokio::test]
    async fn at_most_500_models() {
        let data: Vec<Value> = (0..600).rev().map(|n| json!({ "id": format!("m-{n:03}") })).collect();
        let server = stub(vec![Reply::json(200, json!({ "data": data }))]).await;
        let found = list(&endpoint(ProviderKind::Mistral, &server.base)).await.unwrap();
        assert_eq!(found.len(), MAX_MODELS);
        assert_eq!((found[0].id.as_str(), found[499].id.as_str()), ("m-000", "m-499"));
    }

    #[tokio::test]
    async fn anthropic_models() {
        let server = stub(vec![Reply::json(
            200,
            json!({ "data": [{ "type": "model", "id": "claude-haiku-4-5", "display_name": "Claude Haiku 4.5" }], "has_more": false }),
        )])
        .await;
        let found = list(&endpoint(ProviderKind::Anthropic, &server.base)).await.unwrap();
        assert_eq!(found, [Model { id: "claude-haiku-4-5".into(), name: "Claude Haiku 4.5".into() }]);
        let sent = &server.requests()[0];
        assert_eq!(sent.path, "/v1/models?limit=1000");
        assert_eq!(sent.header("x-api-key"), Some(KEY));
        assert_eq!(sent.header("anthropic-version"), Some("2023-06-01"));
    }

    #[tokio::test]
    async fn openrouter_tests_the_key_first() {
        let server = stub(vec![Reply::json(401, json!({ "error": { "message": "No auth credentials found" } }))]).await;
        let error = list(&endpoint(ProviderKind::OpenRouter, &server.base)).await.unwrap_err();
        assert_eq!(error.message, "The provider didn't accept the key.");
        assert_no_key(&error);
        let sent = server.requests();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].path, "/v1/key");

        let server = stub(vec![
            Reply::json(200, json!({ "data": { "label": "sk-or-v1-…", "usage": 0 } })),
            Reply::json(200, json!({ "data": [{ "id": "openai/gpt-5-mini", "name": "OpenAI: GPT-5 Mini" }] })),
        ])
        .await;
        let found = list(&endpoint(ProviderKind::OpenRouter, &server.base)).await.unwrap();
        assert_eq!(found, [Model { id: "openai/gpt-5-mini".into(), name: "OpenAI: GPT-5 Mini".into() }]);
        let sent = server.requests();
        assert_eq!(sent.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(), ["/v1/key", "/v1/models"]);
        assert_eq!(sent[1].header("x-title"), Some("UwUMail"));
    }

    #[test]
    fn addresses_accepted() {
        use ProviderKind::*;
        let cases = [
            (OpenAi, "https://gateway.example.com/v1/", "https://gateway.example.com/v1"),
            (Anthropic, " https://api.anthropic.com/v1 ", "https://api.anthropic.com/v1"),
            (Ollama, "http://127.0.0.1:11434", "http://127.0.0.1:11434/v1"),
            (Ollama, "http://localhost:11434/v1/", "http://localhost:11434/v1"),
            (Ollama, "http://gpu.localhost:11434", "http://gpu.localhost:11434/v1"),
            (OpenAiCompatible, "http://10.1.2.3:8000/v1", "http://10.1.2.3:8000/v1"),
            (OpenAiCompatible, "http://192.168.1.20:1234/v1", "http://192.168.1.20:1234/v1"),
            (OpenAiCompatible, "http://172.16.5.4/v1", "http://172.16.5.4/v1"),
            (OpenAiCompatible, "http://100.64.0.9/v1", "http://100.64.0.9/v1"),
            (OpenAiCompatible, "http://[fd00::5]:8080/v1", "http://[fd00::5]:8080/v1"),
            (OpenAiCompatible, "http://[::1]:8080/v1", "http://[::1]:8080/v1"),
            (OpenAiCompatible, "HTTPS://LLM.Example.COM:443/v1", "https://llm.example.com/v1"),
            (OpenAiCompatible, "https://192.0.2.10/v1", "https://192.0.2.10/v1"),
            (OpenAiCompatible, "https://[2001:db8::1]/v1", "https://[2001:db8::1]/v1"),
        ];
        for (kind, url, normalized) in cases {
            assert_eq!(check_base_url(kind, url).as_deref(), Ok(normalized), "{kind:?} {url}");
        }
    }

    #[test]
    fn addresses_refused() {
        use ProviderKind::*;
        let cases = [
            (Gemini, "https://generativelanguage.googleapis.com/v1beta/openai"),
            (Mistral, "https://api.mistral.ai/v1"),
            (OpenRouter, "https://openrouter.ai/api/v1"),
            (OpenAi, "http://127.0.0.1/v1"),
            (Anthropic, "http://localhost/v1"),
            (OpenAiCompatible, "http://llm.example.com/v1"),
            (OpenAiCompatible, "http://localhost.example.com/v1"),
            (Ollama, "http://192.0.2.10:11434"),
            (OpenAiCompatible, "http://198.51.100.7/v1"),
            (OpenAiCompatible, "http://100.128.0.1/v1"),
            (OpenAiCompatible, "https://169.254.169.254/latest"),
            (Ollama, "http://169.254.1.1:11434"),
            (OpenAiCompatible, "http://[fe80::1]/v1"),
            (OpenAiCompatible, "https://[::ffff:169.254.169.254]/v1"),
            (OpenAiCompatible, "https://0.0.0.0/v1"),
            (OpenAiCompatible, "https://[::]/v1"),
            (OpenAiCompatible, "https://255.255.255.255/v1"),
            (OpenAiCompatible, "https://224.0.0.1/v1"),
            (OpenAiCompatible, "https://[ff02::1]/v1"),
            (OpenAiCompatible, "https://user:pw@llm.example.com/v1"),
            (OpenAiCompatible, "https://token@llm.example.com/v1"),
            (OpenAiCompatible, "https://llm.example.com/v1?key=1"),
            (OpenAiCompatible, "https://llm.example.com/v1#top"),
            (OpenAiCompatible, "ftp://llm.example.com/v1"),
            (OpenAiCompatible, "file:///etc/passwd"),
            (OpenAiCompatible, "llm.example.com/v1"),
            (OpenAiCompatible, ""),
        ];
        for (kind, url) in cases {
            let reason = check_base_url(kind, url).expect_err(url);
            assert!(reason.ends_with('.') && reason.len() > 10, "{url}: {reason}");
        }
        let long = format!("https://llm.example.com/{}", "a".repeat(MAX_URL_CHARS));
        assert!(check_base_url(OpenAi, &long).is_err());
    }

    #[test]
    fn kinds() {
        for kind in ProviderKind::ALL {
            assert_eq!(ProviderKind::parse(kind.as_str()), Some(kind));
            assert_eq!(kind.default_base_url().is_none(), kind.base_url_required());
            assert_eq!(kind.default_models().0.is_none(), kind.base_url_required());
            if let Some(url) = kind.default_base_url() {
                assert!(url.starts_with("https://") && !url.ends_with('/'));
            }
            if kind.base_url_required() {
                assert!(kind.base_url_editable());
            }
        }
        assert_eq!(ProviderKind::OpenAi.default_models(), (Some("gpt-5-mini"), Some("gpt-5-nano")));
        assert!(!ProviderKind::Gemini.base_url_editable());
        assert!(ProviderKind::Anthropic.base_url_editable());
    }

    #[test]
    fn the_key_never_shows_in_debug() {
        let shown = format!("{:?}", endpoint(ProviderKind::OpenAi, "https://api.openai.com/v1"));
        assert!(!shown.contains(KEY) && shown.contains("***"), "{shown}");
    }

    #[test]
    fn shortening_is_char_aware() {
        assert_eq!(shorten(&"ü".repeat(300), 200), format!("{}…", "ü".repeat(200)));
        assert_eq!(shorten(" a\nb ", 200), "a b");
    }
}
