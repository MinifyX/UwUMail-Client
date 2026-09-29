//! The AI assistant: writing and rewriting drafts, summaries, a second opinion on spam, dates for
//! the calendar and the person's own labels on new mail.
//!
//! A mailbox on a UwUMail server with `urn:uwumail:jmap:assist` asks its server ([`server`]), which
//! makes every call to a model. Every other mailbox ("foreign") uses the providers the person set
//! up on this device ([`provider`]); those calls go out from here, with the same rules as the
//! server's (docs/architecture.md "AI assistant"): mail is quoted data, answers that are used have a
//! fixed, checked shape, and nothing reaches a draft or a mail without a click, except the person's
//! own labels when they switched auto-labels on.

pub mod local;
pub mod mail;
pub mod prompts;
pub mod provider;
pub mod server;
pub mod signals;
pub mod sse;
pub mod validate;

use serde::{Deserialize, Serialize};

/// What the assistant does, as the server names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Feature {
    Compose,
    Summarize,
    SpamCheck,
    ExtractEvents,
    AutoLabels,
}

impl Feature {
    pub const ALL: [Feature; 5] =
        [Self::Compose, Self::Summarize, Self::SpamCheck, Self::ExtractEvents, Self::AutoLabels];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Compose => "compose",
            Self::Summarize => "summarize",
            Self::SpamCheck => "spamCheck",
            Self::ExtractEvents => "extractEvents",
            Self::AutoLabels => "autoLabels",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|f| f.as_str() == name)
    }
}

/// A piece of a streamed answer, for the page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StreamEvent {
    /// `write` with a subject wanted: the proposal, before the text.
    Subject { subject: String },
    /// The next piece of the text.
    Delta { text: String },
}

/// Where streamed pieces go while the model writes.
pub type StreamSink = std::sync::Arc<dyn Fn(StreamEvent) + Send + Sync>;

/// The person's own word for a kind of mail, set on mail as the keyword `keyword`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub id: String,
    pub name: String,
    /// What belongs there: what the model reads.
    pub description: String,
    pub keyword: String,
    /// `#rrggbb`, or `None` for the default.
    pub color: Option<String>,
}
