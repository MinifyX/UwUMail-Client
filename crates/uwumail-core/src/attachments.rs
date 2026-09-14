//! Attachment files: extracted on first use and cached on disk.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use mail_parser::{MessageParser, MimeHeaders};
use serde::Serialize;

use crate::error::{Error, Result};

/// The cache is trimmed back to this size once it grows past `CACHE_LIMIT`.
const CACHE_LIMIT: u64 = 1024 * 1024 * 1024;
const CACHE_TARGET: u64 = 800 * 1024 * 1024;

/// Extensions that run code when opened. Opening them needs an explicit confirmation.
/// Also web pages: attached login pages are a common way to steal passwords.
const DANGEROUS: &[&str] = &[
    "exe",
    "com",
    "bat",
    "cmd",
    "msi",
    "msix",
    "msixbundle",
    "appx",
    "appxbundle",
    "appref-ms",
    "application",
    "msp",
    "mst",
    "scr",
    "pif",
    "cpl",
    "lnk",
    "url",
    "reg",
    "inf",
    "ins",
    "isp",
    "hta",
    "chm",
    "hlp",
    "msc",
    "scf",
    "settingcontent-ms",
    "library-ms",
    "diagcab",
    "gadget",
    "js",
    "jse",
    "vbs",
    "vbe",
    "wsf",
    "wsh",
    "wsc",
    "sct",
    "ps1",
    "ps1xml",
    "ps2",
    "psc1",
    "psd1",
    "psm1",
    "jar",
    "jnlp",
    "app",
    "dmg",
    "pkg",
    "command",
    "sh",
    "run",
    "appimage",
    "deb",
    "rpm",
    "docm",
    "dotm",
    "xlsm",
    "xltm",
    "xlam",
    "xll",
    "pptm",
    "potm",
    "ppam",
    "sldm",
    "one",
    "iqy",
    "slk",
    "iso",
    "img",
    "vhd",
    "vhdx",
    "html",
    "htm",
    "xhtml",
    "shtml",
    "mht",
    "mhtml",
];

/// Characters that reverse how text is displayed, e.g. to show `rechnung\u{202E}fdp.exe` as "rechnungexe.pdf".
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// An attachment name as it should be shown and stored: no invisible direction tricks.
pub fn clean_display_name(name: &str) -> String {
    name.chars().filter(|c| !is_bidi_control(*c)).collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentFile {
    pub path: PathBuf,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    pub dangerous: bool,
}

pub fn is_dangerous(filename: &str) -> bool {
    // Windows ignores trailing dots and spaces, so "tool.exe. " still runs as tool.exe.
    let name = clean_display_name(filename);
    let name = name.trim_end_matches(['.', ' ']);
    name.rsplit_once('.').is_some_and(|(_, ext)| DANGEROUS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// A file name that is safe on every OS: no paths, no reserved names, not too long.
pub fn safe_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    let cleaned = if cleaned.is_empty() { "attachment".to_string() } else { cleaned };
    let stem = cleaned.split('.').next().unwrap_or_default().to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4);
    let cleaned = if reserved { format!("_{cleaned}") } else { cleaned };
    if cleaned.chars().count() <= 150 {
        return cleaned;
    }
    let (stem, ext) = match cleaned.rsplit_once('.') {
        Some((stem, ext)) if ext.len() <= 10 => (stem.to_string(), format!(".{ext}")),
        _ => (cleaned.clone(), String::new()),
    };
    format!("{}{ext}", stem.chars().take(150 - ext.chars().count()).collect::<String>())
}

/// Splits `"<message id>:<index>"`.
pub fn parse_id(id: &str) -> Result<(String, usize)> {
    let (message, index) = id.rsplit_once(':').ok_or_else(|| Error::invalid("Invalid attachment id."))?;
    let index = index.parse().map_err(|_| Error::invalid("Invalid attachment id."))?;
    Ok((message.to_string(), index))
}

pub struct AttachmentCache {
    dir: PathBuf,
}

impl AttachmentCache {
    pub fn new(data_dir: &Path) -> Self {
        Self { dir: data_dir.join("attachments") }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn folder(&self, message_id: &str) -> PathBuf {
        self.dir.join(safe_filename(message_id))
    }

    /// The cached file, if it was extracted before.
    pub fn cached(&self, message_id: &str, index: usize) -> Option<PathBuf> {
        let prefix = format!("{index}-");
        std::fs::read_dir(self.folder(message_id))
            .ok()?
            .filter_map(|entry| entry.ok())
            .find(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
            .map(|entry| entry.path())
    }

    /// Extracts attachment `index` from a raw message into the cache.
    pub fn store_from_raw(&self, message_id: &str, index: usize, raw: &[u8]) -> Result<AttachmentFile> {
        let message =
            MessageParser::default().parse(raw).ok_or_else(|| Error::internal("The message couldn't be read."))?;
        let part =
            message.attachments().nth(index).ok_or_else(|| Error::not_found("This attachment no longer exists."))?;
        let filename = clean_display_name(part.attachment_name().unwrap_or("attachment"));
        let mime_type = part
            .content_type()
            .map(|ct| match ct.subtype() {
                Some(sub) => format!("{}/{}", ct.ctype(), sub),
                None => ct.ctype().to_string(),
            })
            .unwrap_or_else(|| "application/octet-stream".into());
        let folder = self.folder(message_id);
        std::fs::create_dir_all(&folder).map_err(|e| Error::internal(format!("Couldn't create the cache: {e}")))?;
        let path = folder.join(format!("{index}-{}", safe_filename(&filename)));
        let contents = part.contents();
        std::fs::write(&path, contents).map_err(|e| Error::internal(format!("Couldn't save the attachment: {e}")))?;
        self.trim();
        Ok(AttachmentFile {
            dangerous: is_dangerous(&filename),
            size: contents.len() as u64,
            path,
            filename,
            mime_type,
        })
    }

    pub fn remove_message(&self, message_id: &str) {
        let _ = std::fs::remove_dir_all(self.folder(message_id));
    }

    /// Deletes the least recently written files once the cache is over its limit.
    fn trim(&self) {
        let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
        let Ok(folders) = std::fs::read_dir(&self.dir) else { return };
        for folder in folders.filter_map(|entry| entry.ok()) {
            let Ok(entries) = std::fs::read_dir(folder.path()) else { continue };
            for entry in entries.filter_map(|entry| entry.ok()) {
                if let Ok(meta) = entry.metadata() {
                    files.push((entry.path(), meta.len(), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
                }
            }
        }
        for path in files_to_evict(&mut files, CACHE_LIMIT, CACHE_TARGET) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Oldest files first until the total drops to `target`, but only once it exceeds `limit`.
fn files_to_evict(files: &mut [(PathBuf, u64, SystemTime)], limit: u64, target: u64) -> Vec<PathBuf> {
    let mut total: u64 = files.iter().map(|(_, size, _)| size).sum();
    if total <= limit {
        return Vec::new();
    }
    files.sort_by_key(|(_, _, modified)| *modified);
    let mut evict = Vec::new();
    for (path, size, _) in files.iter() {
        if total <= target {
            break;
        }
        total -= size;
        evict.push(path.clone());
    }
    evict
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn recognizes_dangerous_files() {
        assert!(is_dangerous("rechnung.pdf.exe"));
        assert!(is_dangerous("Update.PS1"));
        assert!(is_dangerous("angebot.docm"));
        assert!(!is_dangerous("angebot.pdf"));
        assert!(!is_dangerous("README"));
        assert!(is_dangerous("tool.exe. "), "Windows drops trailing dots and spaces");
        assert!(is_dangerous("login.html"));
        assert!(is_dangerous("rechnung\u{202E}fdp.exe"));
        assert_eq!(clean_display_name("rechnung\u{202E}fdp.exe"), "rechnungfdp.exe");
    }

    #[test]
    fn makes_file_names_safe() {
        assert_eq!(safe_filename("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_filename("a:b*c?.txt"), "a_b_c_.txt");
        assert_eq!(safe_filename("CON.txt"), "_CON.txt");
        assert_eq!(safe_filename("  "), "attachment");
        let long = format!("{}.pdf", "x".repeat(300));
        let safe = safe_filename(&long);
        assert!(safe.ends_with(".pdf") && safe.chars().count() == 150);
    }

    #[test]
    fn parses_attachment_ids() {
        assert_eq!(parse_id("3f2a-uuid:2").unwrap(), ("3f2a-uuid".to_string(), 2));
        assert!(parse_id("nope").is_err());
    }

    #[test]
    fn extracts_and_caches_attachments() {
        let raw = "From: a@b.example\r\nSubject: Hi\r\nMIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"x\"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nHallo\r\n\
--x\r\nContent-Type: text/plain; name=\"notiz.txt\"\r\nContent-Disposition: attachment; filename=\"notiz.txt\"\r\n\
Content-Transfer-Encoding: base64\r\n\r\nSGFsbG8gZGEh\r\n--x--\r\n";
        let dir = tempfile::tempdir().unwrap();
        let cache = AttachmentCache::new(dir.path());
        assert!(cache.cached("m1", 0).is_none());
        let file = cache.store_from_raw("m1", 0, raw.as_bytes()).unwrap();
        assert_eq!(file.filename, "notiz.txt");
        assert_eq!(std::fs::read_to_string(&file.path).unwrap(), "Hallo da!");
        assert_eq!(cache.cached("m1", 0), Some(file.path.clone()));
        assert!(cache.store_from_raw("m1", 5, raw.as_bytes()).is_err());
    }

    #[test]
    fn evicts_oldest_files_only_over_the_limit() {
        let t = |secs| SystemTime::UNIX_EPOCH + Duration::from_secs(secs);
        let mut files = vec![("new".into(), 40, t(3)), ("old".into(), 40, t(1)), ("mid".into(), 40, t(2))];
        assert!(files_to_evict(&mut files, 200, 100).is_empty());
        assert_eq!(files_to_evict(&mut files, 100, 50), vec![PathBuf::from("old"), PathBuf::from("mid")]);
    }
}
