//! The Android side of UwUMail.
//!
//! The mail engine runs for as long as the app process lives, so a foreground
//! service can keep it connected after the window is gone. Passwords go to the
//! Android Keystore, new mail becomes notifications, and everything that needs
//! Android APIs is a JSON call into Kotlin (`UwuBridge`).
//!
//! Nothing here depends on Tauri, and apart from the certificate setup it
//! builds on any platform, so `cargo check` and the tests run on a PC too.

mod bridge;
mod host;
pub mod launch;
pub mod native;
mod secrets;
pub mod updates;

pub use bridge::{call, call_json};
pub use host::{cache_dir, engine, runtime};
pub use jni;
