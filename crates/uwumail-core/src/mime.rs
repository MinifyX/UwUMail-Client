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
    /// For images the HTML shows through `cid:`, without angle brackets.
    pub content_id: Option<String>,
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
    /// Only present in mail this account sent itself (the copy in Sent keeps it).
    pub bcc: Vec<Address>,
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
    pub unsubscribe: Option<crate::model::Unsubscribe>,
    /// The headers labels without a model read (`uwumail_labels::HEADERS`: List-Id, Precedence, …),
    /// lower-case name and unfolded value.
    pub label_headers: Vec<(String, String)>,
    /// A `text/calendar` or `application/ics` part: an invitation.
    pub calendar: bool,
    /// The receiving server's `Authentication-Results` vouch for the From address's domain
    /// ([`crate::assist::signals::from_vouched`]); learned senders only label such mail.
    pub from_trusted: bool,
}

/// Characters of a header value kept in [`ParsedMessage::label_headers`].
const MAX_LABEL_HEADER_CHARS: usize = 2_000;

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
/// Whether the receiving server vouches for the From address (see [`ParsedMessage::from_trusted`]).
fn from_trusted(message: &mail_parser::Message<'_>) -> bool {
    let Some(from) = message.from().and_then(|from| from.first()).and_then(|addr| addr.address.as_deref()) else {
        return false;
    };
    let headers: Vec<(String, String)> = message
        .headers_raw()
        .filter(|(name, _)| {
            name.eq_ignore_ascii_case("Received") || name.eq_ignore_ascii_case("Authentication-Results")
        })
        .take(10)
        // Never cut: a cut value could read as another domain's pass (C4-1).
        .map(|(name, value)| {
            // Unfolded first, as MailText measures it, so both see the same values (C5-6).
            let value = value.split(['\r', '\n']).map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>();
            (name.to_owned(), crate::assist::signals::whole_or_empty(&value.join(" ")))
        })
        .collect();
    crate::assist::signals::from_vouched(&headers, from)
}

pub fn parse(raw: &[u8]) -> ParsedMessage {
    let Some(message) = MessageParser::default().parse(raw) else {
        return ParsedMessage::default();
    };

    // A bare header block still parses with an empty text part; that isn't a body.
    let header_end = find(raw, b"\r\n\r\n").map(|i| i + 4).or_else(|| find(raw, b"\n\n").map(|i| i + 2));
    let body_present = header_end.is_some_and(|end| raw[end..].iter().any(|b| !b.is_ascii_whitespace()));
    // winmail.dat: its body where the MIME has none, its attachments instead of itself.
    let decoded = crate::tnef::decode(&message);
    let tnef_body = decoded.iter().map(|d| &d.message.body).find(|b| b.text.is_some() || b.html.is_some());
    let tnef_text = tnef_body.filter(|_| !crate::tnef::mime_has_text(&message));

    let text = match tnef_text {
        Some(body) => body.text.clone().or_else(|| body.html.as_deref().map(html_to_text)),
        None => message.body_text(0).map(|t| t.into_owned()).filter(|_| body_present),
    };
    let raw_html = message.body_html(0).map(|h| h.into_owned()).filter(|_| body_present);
    // mail-parser synthesizes HTML from text parts; only keep real HTML.
    let has_html_part = message.html_body_count() > 0
        && message
            .html_part(0)
            .and_then(|part| part.content_type())
            .is_some_and(|ct| ct.subtype().is_some_and(|s| s.eq_ignore_ascii_case("html")));
    let raw_html = match raw_html.filter(|_| has_html_part) {
        Some(html) => Some(html),
        None => tnef_body.and_then(|body| body.html.clone()),
    };
    let (html, has_remote_content) = match raw_html {
        Some(html) => {
            let remote = has_remote_references(&html);
            (Some(sanitize_html(&html)), remote)
        }
        None => (None, false),
    };

    let snippet_source = text.clone().or_else(|| html.as_deref().map(html_to_text)).unwrap_or_default();
    // The preview reads Microsoft Safe Links as the links they wrap.
    let snippet_source = uwumail_tnef::safelinks::unwrap_in_text(&snippet_source).into_owned();

    let attachments = crate::tnef::attachment_parts(&message, &decoded)
        .into_iter()
        .map(|part| ParsedAttachment {
            size: part.data.len() as u64,
            filename: part.filename,
            mime_type: part.mime_type,
            inline: part.inline,
            content_id: part.content_id,
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
        bcc: addresses(message.bcc()),
        reply_to: addresses(message.reply_to()),
        date: message.date().map(|d| d.to_timestamp()),
        has_body: text.is_some() || html.is_some(),
        snippet: snippet(&snippet_source),
        text,
        html,
        has_remote_content,
        attachments,
        unsubscribe: message
            .header_raw("List-Unsubscribe")
            .and_then(|value| unsubscribe_options(value, message.header_raw("List-Unsubscribe-Post"))),
        label_headers: message
            .headers_raw()
            .filter(|(name, _)| uwumail_labels::HEADERS.iter().any(|known| known.eq_ignore_ascii_case(name)))
            .take(20)
            .map(|(name, value)| {
                // Kept with the mail and read by every label check: a few lines' worth is enough.
                let value: String = value.split_whitespace().collect::<Vec<_>>().join(" ");
                (name.to_ascii_lowercase(), value.chars().take(MAX_LABEL_HEADER_CHARS).collect())
            })
            .collect(),
        from_trusted: from_trusted(&message),
        calendar: message.parts.iter().any(|part| {
            part.content_type().is_some_and(|ct| {
                let subtype = ct.subtype().unwrap_or_default();
                (ct.ctype().eq_ignore_ascii_case("text") && subtype.eq_ignore_ascii_case("calendar"))
                    || (ct.ctype().eq_ignore_ascii_case("application") && subtype.eq_ignore_ascii_case("ics"))
            })
        }),
    }
}

/// The ways a List-Unsubscribe header offers: `<https://…>, <mailto:…>`.
pub fn unsubscribe_options(value: &str, post: Option<&str>) -> Option<crate::model::Unsubscribe> {
    let mut url = None;
    let mut mailto = None;
    for part in value.split(',') {
        // Folded headers carry line breaks and spaces inside the brackets.
        let uri: String =
            part.trim().trim_start_matches('<').trim_end_matches('>').chars().filter(|c| !c.is_whitespace()).collect();
        let lower = uri.to_ascii_lowercase();
        if (lower.starts_with("https://") || lower.starts_with("http://")) && url.is_none() {
            url = url::Url::parse(&uri).ok().map(|parsed| parsed.to_string());
        } else if lower.starts_with("mailto:") && mailto.is_none() {
            mailto = Some(uri);
        }
    }
    let one_click = post.is_some_and(|post| post.to_ascii_lowercase().contains("list-unsubscribe=one-click"))
        && url.as_deref().is_some_and(|url| url.starts_with("https://"));
    (url.is_some() || mailto.is_some()).then_some(crate::model::Unsubscribe { one_click, url, mailto })
}

/// Plain text as simple HTML paragraphs, for editing a text-only draft.
pub fn text_to_html(text: &str) -> String {
    let escaped = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    escaped
        .lines()
        .map(|line| if line.is_empty() { "<p><br></p>".to_string() } else { format!("<p>{line}</p>") })
        .collect()
}

/// What a saved draft needs beyond the stored message: Bcc (only drafts keep it in the
/// headers) and the attachment files themselves, to put back into the composer.
pub struct DraftParts {
    pub bcc: Vec<Address>,
    pub attachments: Vec<crate::model::OutgoingAttachment>,
}

pub fn draft_parts(raw: &[u8]) -> DraftParts {
    use base64::Engine as _;
    let Some(message) = MessageParser::default().parse(raw) else {
        return DraftParts { bcc: Vec::new(), attachments: Vec::new() };
    };
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
            crate::model::OutgoingAttachment {
                filename: crate::attachments::clean_display_name(part.attachment_name().unwrap_or("attachment")),
                mime_type,
                size: part.contents().len() as u64,
                source: crate::model::AttachmentSource::Base64 {
                    data: base64::engine::general_purpose::STANDARD.encode(part.contents()),
                },
            }
        })
        .collect();
    DraftParts { bcc: addresses(message.bcc()), attachments }
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
        .attribute_filter(|element, attribute, value| {
            // `data:` is for pictures inside the mail; as a link it would open a page the mail
            // itself wrote (a fake login, say) under an address that names no site.
            let data = value.trim_start().get(..5).is_some_and(|scheme| scheme.eq_ignore_ascii_case("data:"));
            let picture = matches!((element, attribute), ("img", "src") | ("td" | "th" | "table", "background"));
            (!data || picture).then_some(value.into())
        })
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

    #[test]
    fn reads_the_ways_to_unsubscribe() {
        let one_click = unsubscribe_options(
            "<mailto:bye@news.example?subject=unsub>,\r\n <https://news.example/u?id=1>",
            Some("List-Unsubscribe=One-Click"),
        )
        .unwrap();
        assert!(one_click.one_click);
        assert_eq!(one_click.url.as_deref(), Some("https://news.example/u?id=1"));
        assert_eq!(one_click.mailto.as_deref(), Some("mailto:bye@news.example?subject=unsub"));

        let page = unsubscribe_options("<http://news.example/u>", Some("List-Unsubscribe=One-Click")).unwrap();
        assert!(!page.one_click, "one click only over https");
        assert!(unsubscribe_options("<javascript:alert(1)>", None).is_none());
    }

    const SAMPLE: &str = "From: Leni Wanders <leni@wanders.example>\r\n\
To: Mini <mini@uwumail.example>, noah@zockt.example\r\n\
Subject: =?UTF-8?Q?Sonnenuntergang_=F0=9F=8C=85?=\r\n\
Date: Mon, 14 Sep 2026 09:41:00 +0200\r\n\
Message-ID: <abc@wanders.example>\r\n\
In-Reply-To: <parent@uwumail.example>\r\n\
References: <root@uwumail.example> <parent@uwumail.example>\r\n\
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
        assert_eq!(parsed.in_reply_to.as_deref(), Some("parent@uwumail.example"));
        assert_eq!(parsed.references, vec!["root@uwumail.example", "parent@uwumail.example"]);
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
    fn data_addresses_are_only_kept_for_pictures() {
        let clean = sanitize_html(
            "<a href=\" DATA:text/html,<h1>Login</h1>\">x</a><img src=\"data:image/png;base64,AAAA\">\
             <table background=\"data:image/png;base64,AAAA\"><tr><td>y</td></tr></table><a href=\"https://example.com/\">z</a>",
        );
        assert!(!clean.to_ascii_lowercase().contains("data:text"), "{clean}");
        assert!(clean.contains("<img src=\"data:image/png;base64,AAAA\">"), "{clean}");
        assert!(clean.contains("background=\"data:image/png;base64,AAAA\""), "{clean}");
        assert!(clean.contains("href=\"https://example.com/\""), "{clean}");
    }

    #[test]
    fn winmail_dat_gives_its_body_and_attachments() {
        use crate::tnef::tests::{HEADERS, note, request};
        use uwumail_tnef::builder::mime_with_winmail;
        let parsed = parse(&mime_with_winmail(HEADERS, Some(""), &note()));
        let html = parsed.html.as_deref().unwrap();
        assert!(html.contains("Hallo Mia, anbei der Bericht über den Umzug."), "{html}");
        assert!(html.contains("cid:logo@example.com"), "the picture shows from inside: {html}");
        assert!(parsed.text.as_deref().unwrap().contains("Bericht über den Umzug"));
        assert!(parsed.snippet.starts_with("Hallo Mia"));
        let names: Vec<&str> = parsed.attachments.iter().map(|a| a.filename.as_str()).collect();
        assert_eq!(names, ["Quartalsbericht 2026.pdf", "image001.png", "Weitergeleitet.eml"]);
        assert_eq!(parsed.attachments[0].size, 13);
        assert!(parsed.attachments[1].inline);

        // The mail's own text wins; the meeting is an invitation.
        let parsed =
            parse(&mime_with_winmail(HEADERS, Some("Siehe Einladung"), &request("IPM.Schedule.Meeting.Request")));
        assert_eq!(parsed.text.as_deref().map(str::trim), Some("Siehe Einladung"));
        assert_eq!(parsed.attachments[0].filename, "invite.ics");
        assert_eq!(parsed.attachments[0].mime_type, "text/calendar");
    }

    #[test]
    fn previews_read_safe_links_as_the_links_they_wrap() {
        let raw = "From: a@example.com\r\nSubject: x\r\n\r\nSiehe https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwanders.example%2Fclip&data=05%7C02&reserved=0 bis bald";
        let parsed = parse(raw.as_bytes());
        assert_eq!(parsed.snippet, "Siehe https://wanders.example/clip bis bald");
        assert!(parsed.text.unwrap().contains("safelinks"), "the mail itself stays as it came");
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
    fn damaged_messages_never_panic() {
        use crate::tnef::tests::{HEADERS, note};
        let winmail = uwumail_tnef::builder::mime_with_winmail(HEADERS, None, &note());
        let bases: [&[u8]; 2] = [SAMPLE.as_bytes(), &winmail];
        // xorshift: the same cuts and flips every run.
        let mut state: u64 = 0x5eed_0000_0000_0021;
        let mut next = move |n: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % n.max(1) as u64) as usize
        };
        for round in 0..300 {
            let mut data = bases[round % 2].to_vec();
            for _ in 0..=next(6) {
                match next(3) {
                    0 => data.truncate(next(data.len() + 1)),
                    1 if !data.is_empty() => {
                        let at = next(data.len());
                        data[at] = next(256) as u8;
                    }
                    _ => {
                        let at = next(data.len() + 1);
                        let piece: &[u8] =
                            [&b"<"[..], b"&", b"\r\n\r\n", b"--b\r\n", b"=?UTF-8?B?", b"\xff\xfe"][next(6)];
                        data.splice(at..at, piece.iter().copied());
                    }
                }
            }
            let parsed = parse(&data);
            let _ = html_to_text(parsed.html.as_deref().unwrap_or_default());
            let _ = draft_parts(&data);
        }
    }

    #[test]
    fn iso8601_formats_unix_time() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(1_789_371_660), "2026-09-14T07:41:00Z");
        assert_eq!(iso8601(951_782_400), "2000-02-29T00:00:00Z");
    }
}
