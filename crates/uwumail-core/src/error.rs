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
}

/// Error type crossing the boundary to the UI. The message is shown to users,
/// so it must never contain secrets.
#[derive(Debug, Clone, thiserror::Error, Serialize)]
#[error("{message}")]
pub struct Error {
    pub code: ErrorCode,
    pub message: String,
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
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
