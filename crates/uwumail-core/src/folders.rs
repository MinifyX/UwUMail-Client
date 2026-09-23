//! Folder names people type: what may be one, and how it becomes an IMAP path.
//!
//! IMAP paths carry non-ASCII names in modified UTF-7 (RFC 3501 5.1.3) and nest
//! with the server's hierarchy delimiter; some servers keep every folder below
//! `INBOX.` (a namespace prefix). JMAP mailboxes only need a clean name.

use crate::error::{Error, Result};

/// Longest folder name, in characters. Servers differ; this fits every one we know.
pub const MAX_NAME: usize = 200;

/// Checks and trims a folder name. `delimiter` is the server's hierarchy
/// delimiter; `imap` also refuses the LIST wildcards `*` and `%`.
pub fn clean_name(name: &str, delimiter: Option<&str>, imap: bool) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::invalid("Enter a name for the folder."));
    }
    if name.chars().count() > MAX_NAME {
        return Err(Error::invalid(format!("Folder names can have at most {MAX_NAME} characters.")));
    }
    if name.chars().any(char::is_control) {
        return Err(Error::invalid("Folder names can't contain line breaks or control characters."));
    }
    if let Some(delimiter) = delimiter.filter(|d| !d.is_empty())
        && name.contains(delimiter)
    {
        return Err(Error::invalid(format!("Folder names can't contain \"{delimiter}\".")));
    }
    if imap && name.contains(['*', '%']) {
        return Err(Error::invalid("Folder names can't contain \"*\" or \"%\"."));
    }
    if name == "." || name == ".." {
        return Err(Error::invalid("That name isn't possible for a folder."));
    }
    Ok(name.to_string())
}

/// Encodes a folder name in IMAP's modified UTF-7, e.g. `Entwürfe` → `Entw&APw-rfe`.
pub fn encode_modified_utf7(text: &str) -> String {
    use base64::Engine as _;
    let mut out = String::with_capacity(text.len());
    let mut pending: Vec<u16> = Vec::new();
    let flush = |pending: &mut Vec<u16>, out: &mut String| {
        if pending.is_empty() {
            return;
        }
        let bytes: Vec<u8> = pending.iter().flat_map(|unit| unit.to_be_bytes()).collect();
        let encoded = base64::engine::general_purpose::STANDARD_NO_PAD.encode(bytes).replace('/', ",");
        out.push('&');
        out.push_str(&encoded);
        out.push('-');
        pending.clear();
    };
    for c in text.chars() {
        if (' '..='~').contains(&c) {
            flush(&mut pending, &mut out);
            if c == '&' {
                out.push_str("&-");
            } else {
                out.push(c);
            }
        } else {
            let mut units = [0u16; 2];
            pending.extend_from_slice(c.encode_utf16(&mut units));
        }
    }
    flush(&mut pending, &mut out);
    out
}

/// The delimiter when every folder but INBOX lives below `INBOX<delimiter>` (Courier-style
/// namespaces): new top-level folders then belong there too.
pub fn inbox_namespace<'a>(folders: impl IntoIterator<Item = (&'a str, Option<&'a str>)>) -> Option<String> {
    let folders: Vec<(&str, Option<&str>)> = folders.into_iter().collect();
    let delimiter = folders.iter().find_map(|(_, d)| d.filter(|d| !d.is_empty()))?;
    let others: Vec<&str> =
        folders.iter().map(|(path, _)| *path).filter(|path| !path.eq_ignore_ascii_case("INBOX")).collect();
    let prefix = format!("INBOX{delimiter}");
    (!others.is_empty() && others.iter().all(|path| path.starts_with(&prefix))).then(|| delimiter.to_string())
}

/// The IMAP path of a new folder: below `parent`, or at the top (inside the INBOX namespace
/// when the server has one). `name` is the clean, not yet encoded name.
pub fn child_path(
    parent: Option<&str>,
    name: &str,
    delimiter: Option<&str>,
    namespace: Option<&str>,
) -> Result<String> {
    let encoded = encode_modified_utf7(name);
    let delimiter = delimiter.filter(|d| !d.is_empty());
    match (parent, delimiter) {
        (Some(parent), Some(delimiter)) => Ok(format!("{parent}{delimiter}{encoded}")),
        (Some(_), None) => Err(Error::not_supported("This mail server doesn't keep folders inside folders.")),
        (None, _) => match namespace.filter(|d| !d.is_empty()) {
            Some(namespace) => Ok(format!("INBOX{namespace}{encoded}")),
            None => Ok(encoded),
        },
    }
}

/// The path of a folder after renaming it: same parent, new last part.
pub fn renamed_path(path: &str, name: &str, delimiter: Option<&str>) -> String {
    let encoded = encode_modified_utf7(name);
    match delimiter.filter(|d| !d.is_empty()).and_then(|d| path.rsplit_once(d).map(|(parent, _)| (parent, d))) {
        Some((parent, delimiter)) => format!("{parent}{delimiter}{encoded}"),
        None => encoded,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::decode_modified_utf7;

    #[test]
    fn names_must_be_usable() {
        assert_eq!(clean_name("  Rechnungen ", Some("/"), true).unwrap(), "Rechnungen");
        assert!(clean_name("   ", None, false).is_err());
        assert!(clean_name("a/b", Some("/"), true).is_err());
        assert!(clean_name("a.b", Some("."), true).is_err());
        assert!(clean_name("a.b", Some("/"), true).is_ok());
        assert!(clean_name("line\nbreak", None, false).is_err());
        assert!(clean_name("tab\there", None, false).is_err());
        assert!(clean_name("100%", Some("/"), true).is_err());
        assert!(clean_name("100%", Some("/"), false).is_ok());
        assert!(clean_name("..", None, false).is_err());
        assert!(clean_name(&"x".repeat(MAX_NAME), None, false).is_ok());
        assert!(clean_name(&"ü".repeat(MAX_NAME + 1), None, false).is_err());
    }

    #[test]
    fn encodes_modified_utf7_like_imap_expects() {
        assert_eq!(encode_modified_utf7("Entwürfe"), "Entw&APw-rfe");
        assert_eq!(encode_modified_utf7("Gelöschte Elemente"), "Gel&APY-schte Elemente");
        assert_eq!(encode_modified_utf7("Tom & Jerry"), "Tom &- Jerry");
        assert_eq!(encode_modified_utf7("INBOX"), "INBOX");
        // RFC 3501's own example, and characters outside the BMP.
        assert_eq!(encode_modified_utf7("~peter/mail/台北/日本語"), "~peter/mail/&U,BTFw-/&ZeVnLIqe-");
        for name in ["Entwürfe", "日本語 & 台北", "📬 Post", "a&b&&c", "ÄÖÜ äöü ß"] {
            assert_eq!(decode_modified_utf7(&encode_modified_utf7(name)), name, "{name}");
        }
    }

    #[test]
    fn builds_paths_with_delimiter_and_namespace() {
        assert_eq!(child_path(None, "Kunden", Some("/"), None).unwrap(), "Kunden");
        assert_eq!(child_path(Some("Kunden"), "Bäckerei", Some("/"), None).unwrap(), "Kunden/B&AOQ-ckerei");
        assert_eq!(child_path(None, "Kunden", Some("."), Some(".")).unwrap(), "INBOX.Kunden");
        assert_eq!(child_path(Some("INBOX.Kunden"), "A", Some("."), Some(".")).unwrap(), "INBOX.Kunden.A");
        assert!(child_path(Some("Kunden"), "A", None, None).is_err());

        assert_eq!(renamed_path("Kunden/Alt", "Neu", Some("/")), "Kunden/Neu");
        assert_eq!(renamed_path("INBOX.Alt", "Größer", Some(".")), "INBOX.Gr&APYA3w-er");
        assert_eq!(renamed_path("Alt", "Neu", None), "Neu");
    }

    #[test]
    fn detects_an_inbox_namespace() {
        let dovecot = [("INBOX", Some(".")), ("INBOX.Sent", Some(".")), ("INBOX.Trash", Some("."))];
        assert_eq!(inbox_namespace(dovecot.iter().map(|(p, d)| (*p, *d))), Some(".".to_string()));
        let flat = [("INBOX", Some("/")), ("Sent", Some("/")), ("INBOX/Sub", Some("/"))];
        assert_eq!(inbox_namespace(flat.iter().map(|(p, d)| (*p, *d))), None);
        let only_inbox = [("INBOX", Some("/"))];
        assert_eq!(inbox_namespace(only_inbox.iter().map(|(p, d)| (*p, *d))), None);
    }
}
