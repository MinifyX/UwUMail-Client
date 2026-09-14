//! Turning raw RFC 5322 messages into what the store and UI need.

use std::collections::HashSet;

use mail_parser::{Address as ParsedAddress, HeaderValue, MessageParser, MimeHeaders};

use crate::model::Address;

#[derive(Debug, Clone, Default)]
pub struct ParsedAttachment {
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    pub inline: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedMessage {
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub subject: String,
    pub from: Option<Address>,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub reply_to: Vec<Address>,
    /// Unix seconds.
    pub date: Option<i64>,
    pub text: Option<String>,
    /// Sanitized HTML.
    pub html: Option<String>,
    pub has_remote_content: bool,
    pub snippet: String,
    pub attachments: Vec<ParsedAttachment>,
    pub has_body: bool,
}

fn addresses(value: Option<&ParsedAddress>) -> Vec<Address> {
    let Some(value) = value else { return Vec::new() };
    value
        .iter()
        .filter_map(|addr| {
            let email = addr.address.as_deref()?.trim().to_string();
            if email.is_empty() {
                return None;
            }
            let name = addr.name.as_deref().map(str::trim).filter(|n| !n.is_empty() && *n != email).map(String::from);
            Some(Address { name, email })
        })
        .collect()
}

fn ids(value: &HeaderValue) -> Vec<String> {
    match value {
        HeaderValue::Text(text) => vec![clean_id(text)],
        HeaderValue::TextList(list) => list.iter().map(|id| clean_id(id)).collect(),
        _ => Vec::new(),
    }
    .into_iter()
    .filter(|id| !id.is_empty())
    .collect()
}

fn clean_id(id: &str) -> String {
    id.trim().trim_start_matches('<').trim_end_matches('>').to_string()
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

/// Parses a full message or just its header block.
pub fn parse(raw: &[u8]) -> ParsedMessage {
    let Some(message) = MessageParser::default().parse(raw) else {
        return ParsedMessage::default();
    };

    // A bare header block still parses with an empty text part; that isn't a body.
    let header_end = find(raw, b"\r\n\r\n").map(|i| i + 4).or_else(|| find(raw, b"\n\n").map(|i| i + 2));
    let body_present = header_end.is_some_and(|end| raw[end..].iter().any(|b| !b.is_ascii_whitespace()));
    let text = message.body_text(0).map(|t| t.into_owned()).filter(|_| body_present);
    let raw_html = message.body_html(0).map(|h| h.into_owned()).filter(|_| body_present);
    // mail-parser synthesizes HTML from text parts; only keep real HTML.
    let has_html_part = message.html_body_count() > 0
        && message
            .html_part(0)
            .and_then(|part| part.content_type())
            .is_some_and(|ct| ct.subtype().is_some_and(|s| s.eq_ignore_ascii_case("html")));
    let (html, has_remote_content) = match raw_html.filter(|_| has_html_part) {
        Some(html) => {
            let remote = has_remote_references(&html);
            (Some(sanitize_html(&html)), remote)
        }
        None => (None, false),
    };

    let snippet_source = text.clone().or_else(|| html.as_deref().map(html_to_text)).unwrap_or_default();

    let attachments = message
        .attachments()
        .map(|part| {
            let mime_type = part
                .content_type()
                .map(|ct| match ct.subtype() {
                    Some(sub) => format!("{}/{}", ct.ctype(), sub),
                    None => ct.ctype().to_string(),
                })
                .unwrap_or_else(|| "application/octet-stream".into());
            let inline = part.content_disposition().is_some_and(|d| d.is_inline()) && part.content_id().is_some();
            ParsedAttachment {
                filename: crate::attachments::clean_display_name(part.attachment_name().unwrap_or("attachment")),
                mime_type,
                size: part.contents().len() as u64,
                inline,
            }
        })
        .collect();

    ParsedMessage {
        message_id: message.message_id().map(clean_id),
        in_reply_to: ids(message.in_reply_to()).into_iter().next(),
        references: ids(message.references()),
        subject: message.subject().unwrap_or_default().trim().to_string(),
        from: addresses(message.from()).into_iter().next(),
        to: addresses(message.to()),
        cc: addresses(message.cc()),
        reply_to: addresses(message.reply_to()),
        date: message.date().map(|d| d.to_timestamp()),
        has_body: text.is_some() || html.is_some(),
        snippet: snippet(&snippet_source),
        text,
        html,
        has_remote_content,
        attachments,
    }
}

const REMOTE_MARKERS: [&str; 6] =
    ["src=\"http", "src='http", "url(http", "url(\"http", "url('http", "background=\"http"];

pub fn has_remote_references(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    REMOTE_MARKERS.iter().any(|marker| lower.contains(marker)) || lower.contains("srcset=")
}

/// Removes everything that could run code or submit data. Styles stay, because
/// mail layouts depend on them; the UI renders the result in a script-less
/// sandbox with a CSP that blocks remote loads.
pub fn sanitize_html(html: &str) -> String {
    let mut builder = ammonia::Builder::default();
    builder
        .rm_clean_content_tags(&["style"])
        .add_tags(&["style", "center", "font", "u", "s", "strike"])
        .add_generic_attributes(&[
            "style",
            "align",
            "valign",
            "bgcolor",
            "width",
            "height",
            "border",
            "cellpadding",
            "cellspacing",
            "dir",
            "class",
            "id",
            "role",
        ])
        .add_tag_attributes("font", &["color", "face", "size"])
        .add_tag_attributes("img", &["src", "alt", "width", "height"])
        .add_tag_attributes("td", &["colspan", "rowspan", "background"])
        .add_tag_attributes("th", &["colspan", "rowspan", "background"])
        .add_tag_attributes("table", &["background"])
        .url_schemes(HashSet::from(["http", "https", "mailto", "cid", "data"]))
        .link_rel(Some("noopener noreferrer"))
        .strip_comments(true);
    // The sanitizer drops <body>, and with it the background many newsletters set
    // there. It moves to a wrapper that goes through the sanitizer like the rest.
    let input = match body_background(html) {
        Some(style) => format!("<div style=\"{style}\">{html}</div>"),
        None => html.to_string(),
    };
    builder.clean(&input).to_string()
}

/// Reads `bgcolor` and `style` from the `<body>` tag as one inline style.
fn body_background(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<body")?;
    let end = start + lower[start..].find('>')?;
    let tag = &html[start..end];
    let attribute = |name: &str| {
        let tag_lower = tag.to_ascii_lowercase();
        let at = tag_lower.find(&format!("{name}="))? + name.len() + 1;
        let rest = &tag[at..];
        let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
        let value = &rest[1..];
        Some(value[..value.find(quote)?].to_string())
    };
    let mut style = String::new();
    if let Some(color) = attribute("bgcolor").filter(|c| c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '#')) {
        style.push_str(&format!("background-color:{color};"));
    }
    if let Some(inline) = attribute("style") {
        style.push_str(&inline.replace('"', "'"));
    }
    (!style.is_empty()).then_some(style)
}

/// Rough HTML to text conversion for snippets and search.
pub fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    let mut skip_until: Option<&str> = None;
    let lower = html.to_ascii_lowercase();
    let mut index = 0;
    let bytes = html.as_bytes();
    while index < bytes.len() {
        if let Some(end) = skip_until {
            match lower[index..].find(end) {
                Some(offset) => {
                    index += offset + end.len();
                    skip_until = None;
                    continue;
                }
                None => break,
            }
        }
        let rest = &lower[index..];
        if !in_tag && rest.starts_with("<style") {
            skip_until = Some("</style>");
            continue;
        }
        if !in_tag && rest.starts_with("<script") {
            skip_until = Some("</script>");
            continue;
        }
        let ch = html[index..].chars().next().unwrap_or(' ');
        match ch {
            '<' => {
                in_tag = true;
                if rest.starts_with("<br")
                    || rest.starts_with("<p")
                    || rest.starts_with("<div")
                    || rest.starts_with("<tr")
                {
                    out.push('\n');
                }
            }
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
        index += ch.len_utf8();
    }
    decode_entities(&out)
}

fn decode_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// First meaningful words of a message: no quoted replies, collapsed whitespace.
pub fn snippet(text: &str) -> String {
    let mut words = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('>') {
            continue;
        }
        if (line.starts_with("On ") && line.ends_with("wrote:"))
            || (line.starts_with("Am ") && line.ends_with("schrieb:"))
        {
            break;
        }
        for word in line.split_whitespace() {
            if !words.is_empty() {
                words.push(' ');
            }
            words.push_str(word);
        }
        if words.chars().count() > 220 {
            break;
        }
    }
    words.chars().take(200).collect()
}

/// Unix seconds to an RFC 3339 UTC timestamp, without pulling in a date crate.
pub fn iso8601(timestamp: i64) -> String {
    let days = timestamp.div_euclid(86_400);
    let seconds = timestamp.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", seconds / 3600, (seconds % 3600) / 60, seconds % 60)
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "From: Leni Wanders <leni@wanders.example>\r\n\
To: Mini <mini@uwumail.dev>, noah@zockt.example\r\n\
Subject: =?UTF-8?Q?Sonnenuntergang_=F0=9F=8C=85?=\r\n\
Date: Mon, 14 Sep 2026 09:41:00 +0200\r\n\
Message-ID: <abc@wanders.example>\r\n\
In-Reply-To: <parent@uwumail.dev>\r\n\
References: <root@uwumail.dev> <parent@uwumail.dev>\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/alternative; boundary=\"b\"\r\n\
\r\n\
--b\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Hey!\r\nSchau mal rein.\r\n\r\n> alte Nachricht\r\n\
--b\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<p onclick=\"alert(1)\">Hey!</p><script>alert(2)</script><img src=\"https://t.example/p.gif\"><style>p{color:red}</style>\r\n\
--b--\r\n";

    #[test]
    fn parses_headers_bodies_and_threading_ids() {
        let parsed = parse(SAMPLE.as_bytes());
        assert_eq!(parsed.subject, "Sonnenuntergang 🌅");
        assert_eq!(parsed.from.unwrap().name.as_deref(), Some("Leni Wanders"));
        assert_eq!(parsed.to.len(), 2);
        assert_eq!(parsed.message_id.as_deref(), Some("abc@wanders.example"));
        assert_eq!(parsed.in_reply_to.as_deref(), Some("parent@uwumail.dev"));
        assert_eq!(parsed.references, vec!["root@uwumail.dev", "parent@uwumail.dev"]);
        assert_eq!(parsed.snippet, "Hey! Schau mal rein.");
        assert!(parsed.has_remote_content);
        assert_eq!(parsed.date, Some(1_789_371_660));
    }

    #[test]
    fn sanitizer_removes_scripts_and_handlers_but_keeps_styles() {
        let html = parse(SAMPLE.as_bytes()).html.unwrap();
        assert!(!html.contains("script"));
        assert!(!html.contains("onclick"));
        assert!(html.contains("<style>p{color:red}</style>"));
    }

    #[test]
    fn newsletter_layouts_survive_sanitizing() {
        let html = "<html><head><style>#main > td { padding: 8px }</style></head>\
            <body bgcolor=\"#f4f4f4\" style=\"margin:0\" onload=\"x()\">\
            <table id=\"main\" width=\"600\" cellpadding=\"0\" align=\"center\"><tr><th colspan=\"2\">Hi</th></tr></table></body></html>";
        let clean = sanitize_html(html);
        assert!(clean.contains("#main > td { padding: 8px }"), "CSS must not be escaped: {clean}");
        assert!(clean.contains("id=\"main\""));
        assert!(clean.contains("width=\"600\""));
        assert!(clean.contains("colspan=\"2\""));
        assert!(clean.starts_with("<div style=\"background-color:#f4f4f4;margin:0\">"), "{clean}");
        assert!(!clean.contains("onload"));
    }

    #[test]
    fn plain_text_messages_have_no_html() {
        let raw = "From: a@b.example\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\nJust text\r\n";
        let parsed = parse(raw.as_bytes());
        assert!(parsed.html.is_none());
        assert_eq!(parsed.text.as_deref().map(str::trim), Some("Just text"));
    }

    #[test]
    fn html_to_text_skips_styles_and_decodes_entities() {
        assert_eq!(html_to_text("<style>x{}</style><p>Tom &amp; Jerry</p>").trim(), "Tom & Jerry");
    }

    #[test]
    fn iso8601_formats_unix_time() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(1_789_371_660), "2026-09-14T07:41:00Z");
        assert_eq!(iso8601(951_782_400), "2000-02-29T00:00:00Z");
    }
}
