//! The system's own text recognition, for the text in a mail's pictures (e.g. the date on a
//! poster): Vision on macOS and iOS, Windows.Media.Ocr on Windows. Both come with the system, so
//! nothing is shipped or installed for them, and the pictures never leave the device. Android reads
//! pictures with ML Kit through its Kotlin side (crates/uwumail-android); Linux has nothing here.
//!
//! Kept apart from the mail engine, so `cargo check --target …` can look at the platform code
//! without building everything else for that target.

#[cfg(any(target_os = "macos", target_os = "ios"))]
#[path = "vision.rs"]
mod system;

#[cfg(windows)]
#[path = "windows.rs"]
mod system;

#[cfg(not(any(target_os = "macos", target_os = "ios", windows)))]
mod system {
    pub fn available() -> bool {
        false
    }

    pub fn recognize(_image: &[u8]) -> Result<String, String> {
        Err("This system has no text recognition.".into())
    }
}

/// Whether this platform has a recognizer here at all.
pub const SUPPORTED: bool = cfg!(any(target_os = "macos", target_os = "ios", windows));

/// Whether pictures can be read right now: a new enough system, and on Windows a recognition
/// language among the user's languages.
pub fn available() -> bool {
    system::available()
}

/// The text in an encoded picture (PNG, JPEG, GIF or WebP), one recognized line per line, empty
/// when there is none. Blocking; takes up to a few seconds for a big picture.
pub fn recognize(image: &[u8]) -> Result<String, String> {
    system::recognize(image)
}
