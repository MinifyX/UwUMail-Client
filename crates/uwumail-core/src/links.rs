//! Web links the app hands to the system browser.
//!
//! The page decides whether to ask first (apps/desktop/src/lib/links.ts), but what reaches the
//! operating system is checked here: only `https` and `http`, and always in the parsed, normalized
//! form. That way the browser gets exactly the address the dialog showed, and nothing in a link
//! written into a mail (quotes, spaces, line breaks) reaches the command line that starts it.

use url::Url;

use crate::error::{Error, Result};

/// The normalized form of a web link that may open in the browser.
pub fn external_url(link: &str) -> Result<String> {
    let url = Url::parse(link.trim()).map_err(|_| Error::invalid("This isn't a web address."))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err(Error::invalid("Only web addresses open in the browser."));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(Error::invalid("This web address has no site."));
    }
    let normalized = url.as_str();
    // The URL parser percent-encodes these for web addresses; this only guards that promise.
    if normalized.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"') {
        return Err(Error::invalid("This web address can't be opened."));
    }
    Ok(normalized.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_web_addresses() {
        assert_eq!(external_url(" https://shop.example/a?b=c#d ").unwrap(), "https://shop.example/a?b=c#d");
        assert_eq!(external_url("HTTP://Shop.Example").unwrap(), "http://shop.example/");
        for link in [
            "mailto:someone@example.org",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "data:text/html,hi",
            "ms-settings:privacy",
            "tauri://localhost/",
            "ipc://localhost/cmd",
            "intent://example.org#Intent;scheme=https;end",
            "\\\\server\\share\\file.exe",
            "https:",
            "",
        ] {
            assert!(external_url(link).is_err(), "{link} must not open");
        }
    }

    #[test]
    fn hands_over_the_normalized_address() {
        // What the browser gets is what the page parsed and showed: quotes, spaces and line breaks
        // never reach the command line that starts it.
        let opened = external_url("https://shop.example/a\"b c?q=\"x y\"#\"f g").unwrap();
        assert!(!opened.contains('"') && !opened.contains(' '), "{opened}");
        assert_eq!(external_url("https://shop.\nexample/\tpath").unwrap(), "https://shop.example/path");
        // Backslashes count as slashes in web addresses, like in every browser.
        assert_eq!(
            external_url("https://evil.example\\@shop.example/").unwrap(),
            "https://evil.example/@shop.example/"
        );
    }
}
