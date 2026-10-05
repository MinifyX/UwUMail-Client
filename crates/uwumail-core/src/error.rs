use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    AuthFailed,
    ConnectionFailed,
    NotFound,
    InvalidInput,
    NotSupported,
    Internal,
    /// The server is fine and the sign-in worked, but an administrator has
    /// switched IMAP off for this mailbox. Common in Microsoft 365.
    ImapDisabled,
    /// Same for sending: the tenant or the mailbox may not submit over SMTP.
    SmtpDisabled,
    /// The sign-in needs an administrator of the company to allow UwUMail in
    /// their tenant first. Nothing the person signing in can do themselves.
    AdminConsentRequired,
    /// This build carries no client id for the provider, so signing in with it
    /// cannot start. A packaging matter, not something a user can fix.
    OauthNotConfigured,
    /// The mailbox's sign-in doesn't cover this (e.g. calendars and contacts of a Microsoft or
    /// Google mailbox signed in before UwUMail asked for them), or it ran out. Signing in again
    /// fixes it; mail keeps working meanwhile.
    SignInAgain,
    /// The server doesn't allow this for the person: a domain or a limit an administrator set
    /// (masked addresses), or a public picture where public ones are switched off.
    Forbidden,
}

/// Error type crossing the boundary to the UI. The message is shown to users,
/// so it must never contain secrets.
#[derive(Debug, Clone, thiserror::Error, Serialize)]
#[error("{message}")]
pub struct Error {
    pub code: ErrorCode,
    pub message: String,
    /// A refusal of the AI assistant, with the type its UwUMail server (or this device) gave it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assist: Option<Box<AssistFailure>>,
}

/// Why the assistant refused, as UwUMail Server names it (docs/jmap-assist.md "Common errors"):
/// `assistUnavailable`, `overQuota`, `providerFailed`, `notFound`, `forbidden`,
/// `invalidArguments` or `invalidProperties`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistFailure {
    #[serde(rename = "type")]
    pub kind: String,
    /// Seconds to wait, when a busy provider named them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
    /// For `invalidProperties`: the fields it names.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub properties: Vec<String>,
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), assist: None }
    }

    /// A refusal of the assistant. `kind` is the server's error type; the code follows from it.
    pub fn assist(kind: &str, message: impl Into<String>) -> Self {
        let code = match kind {
            "assistUnavailable" | "unknownMethod" | "unknownCapability" | "accountNotSupportedByMethod" => {
                ErrorCode::NotSupported
            }
            "notFound" => ErrorCode::NotFound,
            "providerFailed" => ErrorCode::ConnectionFailed,
            "forbidden" | "overQuota" | "invalidArguments" | "invalidProperties" => ErrorCode::InvalidInput,
            _ => ErrorCode::Internal,
        };
        Self {
            code,
            message: message.into(),
            assist: Some(Box::new(AssistFailure { kind: kind.to_string(), retry_after: None, properties: Vec::new() })),
        }
    }

    /// The same refusal, with the seconds a busy provider asked to wait.
    pub fn with_retry_after(mut self, seconds: Option<u64>) -> Self {
        if let Some(failure) = self.assist.as_mut() {
            failure.retry_after = seconds;
        }
        self
    }

    /// The same refusal, naming the fields that were refused.
    pub fn with_properties(mut self, properties: Vec<String>) -> Self {
        if let Some(failure) = self.assist.as_mut() {
            failure.properties = properties;
        }
        self
    }

    /// The assistant's error type, when this is one of its refusals.
    pub fn assist_kind(&self) -> Option<&str> {
        self.assist.as_deref().map(|failure| failure.kind.as_str())
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::AuthFailed, message)
    }

    pub fn connection(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ConnectionFailed, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }

    pub fn not_supported(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotSupported, message)
    }

    pub fn imap_disabled(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ImapDisabled, message)
    }

    pub fn smtp_disabled(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::SmtpDisabled, message)
    }

    pub fn admin_consent_required(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::AdminConsentRequired, message)
    }

    pub fn oauth_not_configured(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::OauthNotConfigured, message)
    }

    pub fn sign_in_again(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::SignInAgain, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::QueryReturnedNoRows => Self::not_found("Not found"),
            other => Self::internal(format!("Database error: {other}")),
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::internal(format!("Serialization error: {error}"))
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::connection(error.to_string())
    }
}

impl From<async_imap::error::Error> for Error {
    fn from(error: async_imap::error::Error) -> Self {
        use async_imap::error::Error as Imap;
        match error {
            Imap::No(message) | Imap::Bad(message) => Self::new(ErrorCode::Internal, format!("Server said: {message}")),
            Imap::Io(io) => Self::connection(io.to_string()),
            Imap::ConnectionLost => Self::connection("The connection to the mail server was lost."),
            other => Self::internal(format!("IMAP error: {other}")),
        }
    }
}

impl From<reqwest::Error> for Error {
    fn from(error: reqwest::Error) -> Self {
        Self::connection(format!("HTTP error: {}", error.without_url()))
    }
}

impl From<keyring::Error> for Error {
    fn from(error: keyring::Error) -> Self {
        match error {
            keyring::Error::NoEntry => Self::auth("No saved password for this mailbox."),
            other => Self::internal(format!("Keychain error: {other}")),
        }
    }
}
