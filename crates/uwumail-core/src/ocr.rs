//! Text in a mail's pictures, so dates on a poster or an invitation that only exists as a picture
//! can be found like those in the text. A UwUMail server reads the pictures of its own accounts
//! (`Email/imageText`, UwUMail-Server docs/jmap-image-text.md). For every other mailbox this
//! device's own OCR reads them, handed to the engine as a [`TextRecognizer`] (Vision on macOS and
//! iOS, Windows.Media.Ocr on Windows, ML Kit on Android): those pictures never leave the device for
//! this. Linux has no recognizer, and the feature stays off there.
//!
//! The limits are the server's: at most 20 pictures a mail, none under 64 pixels on a side (icons,
//! spacers, tracking pixels), none over 10 MB or 40 megapixels, and remote pictures only when the
//! reader let the mail load them.

use std::collections::VecDeque;
use std::time::Duration;

use serde_json::Value;

use crate::model::{Attachment, ImageText, ImageTextResult};

/// Pictures read per mail; the rest count as skipped.
pub const MAX_IMAGES: usize = 20;
/// Bigger pictures are skipped.
pub const MAX_BYTES: u64 = 10 * 1024 * 1024;
/// Pictures smaller than this on a side are icons, spacers or tracking pixels.
pub const MIN_SIDE: u32 = 64;
pub const MAX_PIXELS: u64 = 40_000_000;
/// Text kept per picture.
pub const MAX_TEXT_CHARS: usize = 20_000;
/// One picture may take this long; the recognizer is then no longer waited for.
pub const RECOGNIZE_TIMEOUT: Duration = Duration::from_secs(20);
/// A whole mail may take this long; pictures not read by then are skipped.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(90);
/// Pictures read at the same time on this device, across all mails.
pub const PARALLEL: usize = 2;
/// Mails whose results are kept in memory.
const CACHED_MAILS: usize = 64;
/// A mail with more `<img>` than this is not looked at any further.
const MAX_REMOTE_SCAN: usize = 500;
/// Longer picture addresses are not read.
const MAX_URL_CHARS: usize = 4096;
/// A server answer with more pictures than this is cut off.
const MAX_SERVER_IMAGES: usize = 100;

/// Reads the text in a picture with the system's OCR.
pub trait TextRecognizer: Send + Sync {
    /// Whether pictures can be read right now (e.g. Google Play services on Android). Blocking
    /// like [`recognize`](Self::recognize); asked before a mail's pictures are read.
    fn available(&self) -> bool {
        true
    }

    /// The text in an encoded picture (PNG, JPEG, GIF or WebP), lines separated by `\n`, empty when
    /// there is none. Blocking: the engine calls it on a blocking thread, at most [`PARALLEL`] at a
    /// time, and stops waiting after [`RECOGNIZE_TIMEOUT`].
    fn recognize(&self, image: &[u8]) -> std::result::Result<String, String>;
}

/// Whether an attachment's type is a picture that can be read.
pub fn readable_type(mime_type: &str) -> bool {
    matches!(
        mime_type.trim().to_ascii_lowercase().as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/pjpeg" | "image/gif" | "image/webp"
    )
}

/// Width and height of a PNG, JPEG, GIF or WebP picture from its header; `None` for anything else.
pub fn picture_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let be16 = |at: usize| bytes.get(at..at + 2).map(|b| u32::from(u16::from_be_bytes([b[0], b[1]])));
    let le16 = |at: usize| bytes.get(at..at + 2).map(|b| u32::from(u16::from_le_bytes([b[0], b[1]])));
    let le24 = |at: usize| bytes.get(at..at + 3).map(|b| u32::from_le_bytes([b[0], b[1], b[2], 0]));
    let size = match crate::pictures::sniff_image(bytes)? {
        "png" if bytes.get(12..16) == Some(b"IHDR") => {
            let be32 = |at: usize| bytes.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
            (be32(16)?, be32(20)?)
        }
        "gif" => (le16(6)?, le16(8)?),
        "webp" => match bytes.get(12..16)? {
            b"VP8 " if bytes.get(23..26) == Some(&[0x9d, 0x01, 0x2a]) => (le16(26)? & 0x3fff, le16(28)? & 0x3fff),
            b"VP8L" if bytes.get(20) == Some(&0x2f) => {
                let bits = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
                ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
            }
            b"VP8X" => (le24(24)? + 1, le24(27)? + 1),
            _ => return None,
        },
        "jpg" => {
            let mut at = 2;
            loop {
                // Markers may be padded with any number of 0xFF.
                while bytes.get(at) == Some(&0xFF) && bytes.get(at + 1) == Some(&0xFF) {
                    at += 1;
                }
                if bytes.get(at) != Some(&0xFF) {
                    return None;
                }
                let marker = *bytes.get(at + 1)?;
                match marker {
                    // Start of frame (not DHT, JPG or DAC, which share the range).
                    0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => break (be16(at + 7)?, be16(at + 5)?),
                    // Markers without a length.
                    0x01 | 0xD0..=0xD8 => at += 2,
                    // The image data starts without a frame header: broken.
                    0xD9 | 0xDA => return None,
                    _ => at += 2 + usize::try_from(be16(at + 2)?).ok()?,
                }
            }
        }
        _ => return None,
    };
    Some(size).filter(|(width, height)| *width > 0 && *height > 0)
}

/// Why a picture is left out before it is read, if it is.
pub fn too_small_or_big(width: u32, height: u32) -> bool {
    width < MIN_SIDE || height < MIN_SIDE || u64::from(width) * u64::from(height) > MAX_PIXELS
}

/// The `http(s)` addresses of a mail's `<img>` pictures, each once, in the order they come. Only
/// `src` is read, like on the server: no backgrounds, no `srcset`.
pub fn remote_sources(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut found: Vec<String> = Vec::new();
    let mut offset = 0;
    let mut seen = 0;
    while let Some(start) = lower[offset..].find("<img") {
        let tag_start = offset + start + "<img".len();
        offset = tag_start;
        seen += 1;
        if seen > MAX_REMOTE_SCAN {
            break;
        }
        // `<imgfoo>` is some other tag.
        if !lower[tag_start..].starts_with(|c: char| c.is_ascii_whitespace() || c == '/') {
            continue;
        }
        let tag_end = lower[tag_start..].find('>').map_or(html.len(), |end| tag_start + end);
        let attributes = crate::pictures::attributes(&html[tag_start..tag_end]);
        let Some((_, src)) = attributes.iter().find(|(name, _)| name == "src") else { continue };
        let src = src.replace("&amp;", "&");
        let web = src.get(..8).is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"))
            || src.get(..7).is_some_and(|scheme| scheme.eq_ignore_ascii_case("http://"));
        if web && src.chars().count() <= MAX_URL_CHARS && !found.contains(&src) {
            found.push(src);
        }
    }
    found
}

/// Recognized text as it is handed on: lines trimmed, empty ones and control characters dropped,
/// at most [`MAX_TEXT_CHARS`].
pub fn clean_text(raw: &str) -> String {
    let mut text = String::new();
    let mut chars = 0;
    for line in raw.lines() {
        let line: String = line.chars().map(|c| if c == '\t' { ' ' } else { c }).filter(|c| !c.is_control()).collect();
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push('\n');
            chars += 1;
        }
        for c in line.chars() {
            if chars >= MAX_TEXT_CHARS {
                return text;
            }
            text.push(c);
            chars += 1;
        }
    }
    text
}

/// Where a picture of the mail is: which attachment or which address.
pub fn part_source(attachment: &Attachment) -> String {
    match &attachment.content_id {
        Some(cid) if attachment.inline && !cid.is_empty() => format!("cid:{cid}"),
        _ => format!("blob:{}", attachment.id),
    }
}

/// A part of a mail as its JMAP server describes it (`Email/get`, `attachments`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServerPart {
    pub blob_id: String,
    pub cid: Option<String>,
    pub name: Option<String>,
    pub size: u64,
}

/// The attachments of the email in an `Email/get` answer.
pub fn server_parts(answer: &Value) -> Vec<ServerPart> {
    let email = answer.get("list").and_then(Value::as_array).and_then(|list| list.first());
    email
        .and_then(|email| email.get("attachments"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(1000)
        .filter_map(|part| {
            Some(ServerPart {
                blob_id: part.get("blobId")?.as_str()?.to_string(),
                cid: part.get("cid").and_then(Value::as_str).map(|cid| cid.trim().trim_matches(['<', '>']).to_string()),
                name: part.get("name").and_then(Value::as_str).map(String::from),
                size: part.get("size").and_then(Value::as_u64).unwrap_or(0),
            })
        })
        .collect()
}

/// The app's id of the attachment the server knows by `blob_id`: the one with the same Content-ID,
/// else the same name and size, else the one at the same place when both list as many.
pub fn attachment_for_blob(blob_id: &str, parts: &[ServerPart], attachments: &[Attachment]) -> Option<String> {
    let (index, part) = parts.iter().enumerate().find(|(_, part)| part.blob_id == blob_id)?;
    let by_cid = part
        .cid
        .as_deref()
        .filter(|cid| !cid.is_empty())
        .and_then(|cid| attachments.iter().find(|a| a.content_id.as_deref() == Some(cid)));
    let by_name = || {
        let name = crate::attachments::clean_display_name(part.name.as_deref()?);
        attachments.iter().find(|a| a.filename == name && a.size == part.size)
    };
    let by_place = || (parts.len() == attachments.len()).then(|| attachments.get(index)).flatten();
    by_cid.or_else(by_name).or_else(by_place).map(|a| a.id.clone())
}

/// An `Email/imageText` answer with the server's ids replaced by the app's.
pub fn from_server(
    email_id: &str,
    answer: &Value,
    parts: &[ServerPart],
    attachments: &[Attachment],
) -> ImageTextResult {
    let unavailable = answer.get("unavailable").and_then(Value::as_bool).unwrap_or(false);
    let size = |image: &Value, key: &str| {
        image.get(key).and_then(Value::as_u64).map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX))
    };
    let images = answer
        .get("images")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|_| !unavailable)
        .take(MAX_SERVER_IMAGES)
        .filter_map(|image| {
            let source = image.get("source")?.as_str()?;
            let source = if let Some(blob) = source.strip_prefix("blob:") {
                // A picture the app can't match up keeps its text; only where it is stays unknown.
                format!("blob:{}", attachment_for_blob(blob, parts, attachments).unwrap_or_default())
            } else if source.starts_with("cid:") || source.starts_with("https://") || source.starts_with("http://") {
                source.chars().take(MAX_URL_CHARS).collect()
            } else {
                return None;
            };
            let text = clean_text(image.get("text")?.as_str()?);
            (!text.is_empty()).then(|| ImageText {
                source,
                text,
                width: size(image, "width"),
                height: size(image, "height"),
            })
        })
        .collect();
    let skipped = answer.get("skipped").and_then(Value::as_u64).map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX));
    ImageTextResult {
        email_id: email_id.to_string(),
        unavailable,
        images,
        skipped: if unavailable { 0 } else { skipped },
    }
}

/// Results by mail and whether remote pictures were read, the oldest going first.
#[derive(Default)]
pub struct ResultCache {
    entries: VecDeque<((String, bool), ImageTextResult)>,
}

impl ResultCache {
    pub fn get(&self, message_id: &str, remote: bool) -> Option<ImageTextResult> {
        self.entries.iter().find(|((id, r), _)| id == message_id && *r == remote).map(|(_, result)| result.clone())
    }

    pub fn put(&mut self, message_id: &str, remote: bool, result: ImageTextResult) {
        self.entries.retain(|((id, r), _)| !(id == message_id && *r == remote));
        if self.entries.len() >= CACHED_MAILS {
            self.entries.pop_front();
        }
        self.entries.push_back(((message_id.to_string(), remote), result));
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use serde_json::json;

    use super::*;

    /// A PNG header of the given size; enough for [`picture_size`].
    pub fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        bytes
    }

    #[test]
    fn reads_the_size_of_common_pictures() {
        assert_eq!(picture_size(&png(1200, 1600)), Some((1200, 1600)));
        let gif = [b"GIF89a".as_slice(), &[0x40, 0x01, 0xF0, 0x00], &[0; 8]].concat();
        assert_eq!(picture_size(&gif), Some((320, 240)));
        // A JPEG with an APP0 segment before its frame header.
        let jpeg = [
            &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x4A, 0x46][..],
            &[0xFF, 0xC0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03][..],
            &[0; 12],
        ]
        .concat();
        assert_eq!(picture_size(&jpeg), Some((800, 600)));
        let riff = |kind: &[u8], body: &[u8]| [b"RIFF\0\0\0\0WEBP".as_slice(), kind, &[0; 4], body].concat();
        let lossy = riff(b"VP8 ", &[0, 0, 0, 0x9d, 0x01, 0x2a, 0x90, 0x01, 0x2c, 0x01]);
        assert_eq!(picture_size(&lossy), Some((400, 300)));
        // 640 x 480: (640 - 1) | (480 - 1) << 14 after the 0x2f signature.
        let bits: u32 = 639 | (479 << 14);
        let lossless = riff(b"VP8L", &[[0x2f].as_slice(), &bits.to_le_bytes()].concat());
        assert_eq!(picture_size(&lossless), Some((640, 480)));
        let extended = riff(b"VP8X", &[0, 0, 0, 0, 0x1F, 0x03, 0x00, 0x57, 0x02, 0x00]);
        assert_eq!(picture_size(&extended), Some((800, 600)));
    }

    #[test]
    fn rejects_broken_and_foreign_headers() {
        assert_eq!(picture_size(b""), None);
        assert_eq!(picture_size(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>"), None);
        assert_eq!(picture_size(&png(1200, 1600)[..20]), None);
        assert_eq!(picture_size(&png(0, 10)), None);
        // A JPEG segment claiming to run past the end, and one with image data before a frame.
        assert_eq!(picture_size(&[0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF, 0x00]), None);
        assert_eq!(picture_size(&[0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02]), None);
    }

    #[test]
    fn leaves_out_icons_trackers_and_huge_pictures() {
        assert!(too_small_or_big(1, 1));
        assert!(too_small_or_big(600, 20));
        assert!(!too_small_or_big(64, 64));
        assert!(!too_small_or_big(1200, 1600));
        assert!(too_small_or_big(10_000, 5_000));
    }

    #[test]
    fn finds_remote_pictures_once_in_order() {
        let html = r#"<p>Hi</p><img src="https://cdn.example.com/poster.jpg?a=1&amp;b=2" alt="Poster">
            <IMG SRC='http://cdn.example.com/b.png'><img src="cid:logo@example.com">
            <img src="https://cdn.example.com/poster.jpg?a=1&b=2"><imgx src="https://example.com/no.png">
            <img srcset="https://example.com/set.png 2x"><img src=data:image/png;base64,AAAA>
            <div style="background:url(https://example.com/bg.png)"></div>"#;
        assert_eq!(
            remote_sources(html),
            ["https://cdn.example.com/poster.jpg?a=1&b=2", "http://cdn.example.com/b.png"]
        );
        assert!(remote_sources("<img").is_empty());
        assert!(remote_sources("ä<img src=\"https://ö.example/ü.png\"").len() == 1);
    }

    #[test]
    fn cleans_recognized_text() {
        assert_eq!(clean_text("  Premiere:\tFreitag \n\n\u{7}Kino am Hafen\r\n "), "Premiere: Freitag\nKino am Hafen");
        let long = "ä".repeat(MAX_TEXT_CHARS + 10);
        assert_eq!(clean_text(&long).chars().count(), MAX_TEXT_CHARS);
    }

    fn attachment(id: &str, name: &str, size: u64, cid: Option<&str>, inline: bool) -> Attachment {
        Attachment {
            id: id.into(),
            filename: name.into(),
            mime_type: "image/png".into(),
            size,
            inline,
            content_id: cid.map(String::from),
        }
    }

    #[test]
    fn maps_the_servers_pictures_to_the_apps_ids() {
        let attachments = [
            attachment("m1:0", "poster.png", 5000, Some("poster@example.com"), true),
            attachment("m1:1", "flyer.png", 7000, None, false),
            attachment("m1:2", "image.png", 9000, None, false),
        ];
        let get = json!({ "list": [{ "id": "e42", "attachments": [
            { "blobId": "Bposter", "cid": "<poster@example.com>", "name": "poster.png", "size": 5000 },
            { "blobId": "Bflyer", "name": "flyer.png", "size": 7000 },
            { "blobId": "Bnameless", "size": 9000 },
        ] }] });
        let parts = server_parts(&get);
        assert_eq!(parts.len(), 3);
        assert_eq!(attachment_for_blob("Bposter", &parts, &attachments).as_deref(), Some("m1:0"));
        assert_eq!(attachment_for_blob("Bflyer", &parts, &attachments).as_deref(), Some("m1:1"));
        assert_eq!(attachment_for_blob("Bnameless", &parts, &attachments).as_deref(), Some("m1:2"));
        assert_eq!(attachment_for_blob("Bother", &parts, &attachments), None);

        let answer = json!({ "accountId": "a7", "emailId": "e42", "unavailable": false, "skipped": 2, "images": [
            { "source": "cid:poster@example.com", "text": "Premiere: Freitag, 9. Oktober", "width": 1200, "height": 1600 },
            { "source": "blob:Bflyer", "text": " Sale ends Sunday ", "width": 600, "height": 200 },
            { "source": "blob:Bunknown", "text": "Somewhere", "width": 100, "height": 100 },
            { "source": "https://cdn.example.com/banner.jpg", "text": "   ", "width": 600, "height": 200 },
            { "source": "javascript:alert(1)", "text": "no", "width": 1, "height": 1 },
            { "source": "cid:x", "text": 7 },
        ] });
        let result = from_server("m1", &answer, &parts, &attachments);
        assert_eq!(result.email_id, "m1");
        assert_eq!(result.skipped, 2);
        let sources: Vec<&str> = result.images.iter().map(|i| i.source.as_str()).collect();
        assert_eq!(sources, ["cid:poster@example.com", "blob:m1:1", "blob:"]);
        assert_eq!(result.images[1].text, "Sale ends Sunday");
        assert_eq!((result.images[0].width, result.images[0].height), (1200, 1600));

        let off = from_server("m1", &json!({ "unavailable": true, "images": [], "skipped": 3 }), &[], &[]);
        assert!(off.unavailable && off.images.is_empty() && off.skipped == 0);
    }

    #[test]
    fn keeps_a_bounded_number_of_results() {
        let mut cache = ResultCache::default();
        let result = |id: &str| ImageTextResult { email_id: id.into(), unavailable: false, images: vec![], skipped: 0 };
        for n in 0..CACHED_MAILS + 5 {
            cache.put(&format!("m{n}"), false, result(&format!("m{n}")));
        }
        assert!(cache.get("m0", false).is_none());
        assert!(cache.get(&format!("m{}", CACHED_MAILS + 4), false).is_some());
        assert!(
            cache.get(&format!("m{}", CACHED_MAILS + 4), true).is_none(),
            "remote pictures are a result of their own"
        );
        cache.put("m5", false, result("again"));
        assert_eq!(cache.get("m5", false).unwrap().email_id, "again");
        assert_eq!(cache.entries.len(), CACHED_MAILS);
    }
}
