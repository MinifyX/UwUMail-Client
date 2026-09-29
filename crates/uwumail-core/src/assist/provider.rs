//! The providers people set up on this device, for mailboxes whose server has no assistant: every
//! request to a model goes out from here (the Rust side), never from the page.
//!
//! Two API shapes are spoken, like UwUMail Server does: OpenAI's Chat Completions (OpenAI, Gemini's
//! OpenAI-compatible endpoint, Mistral, OpenRouter, Ollama's `/v1` and every compatible server) and
//! Anthropic's Messages. Keys only ever travel over HTTPS; plain `http://` is allowed for Ollama and
//! OpenAI-compatible servers on a loopback or private address the person typed.
//!
//! SKELETON: the interface is fixed (the engine builds on it); the bodies are being filled in.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};

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
        todo_skeleton()
    }

    /// Whether the person gives (Ollama, OpenAI-compatible) or may change (OpenAI, Anthropic: a
    /// gateway) the address. Gemini, Mistral and OpenRouter have a fixed one.
    pub fn base_url_editable(self) -> bool {
        todo_skeleton()
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
        todo_skeleton()
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
    let _ = (kind, url);
    todo_skeleton()
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
pub async fn chat(
    http: &reqwest::Client,
    endpoint: &Endpoint,
    request: &ChatRequest,
    on_delta: Option<&mut (dyn FnMut(&str) + Send)>,
) -> Result<ChatAnswer> {
    let _ = (http, endpoint, request, on_delta);
    Err(Error::assist("providerFailed", "Not built yet."))
}

/// The models the provider offers (at most 500, sorted by id); doubles as a test of the key.
pub async fn models(http: &reqwest::Client, endpoint: &Endpoint) -> Result<Vec<Model>> {
    let _ = (http, endpoint);
    Err(Error::assist("providerFailed", "Not built yet."))
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

fn todo_skeleton<T>() -> T {
    unimplemented!("assist provider skeleton")
}
