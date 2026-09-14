//! The UwUMail mail engine.
//!
//! Plain library without any UI or Tauri dependency: accounts and secrets,
//! server discovery, IMAP sync into a local SQLite store, SMTP sending and
//! full-text search.

pub mod attachments;
pub mod autoconfig;
pub mod engine;
pub mod error;
pub mod imap;
pub mod jmap;
pub mod jmap_sync;
pub mod mailto;
pub mod mime;
pub mod model;
pub mod oauth;
pub mod pictures;
pub mod secrets;
pub mod smtp;
pub mod store;

pub use engine::{Engine, EngineOptions};
pub use error::{Error, ErrorCode, Result};
