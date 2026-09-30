//! winmail.dat (`application/ms-tnef`): Outlook and Exchange sometimes pack a mail's body,
//! attachments and meeting invitation into one TNEF part instead of MIME. The mail stays as it
//! came; whenever it is read ([`crate::mime::parse`], an attachment opened, pictures read) the
//! TNEF part is decoded with `uwumail-tnef` (copied from UwUMail Server) and stands for what it
//! holds, the same way the server shows it over JMAP (docs/winmail-dat.md of UwUMail Server):
//!
//! - the attachments inside, in their order, with the meeting first as `invite.ics`
//!   (`text/calendar` with a METHOD, which the app shows like any invitation); pictures the HTML
//!   shows by `cid:` are inline, attached messages become `.eml` files;
//! - the body, where the MIME has none.
//!
//! Decoding is bounded (`uwumail_tnef::Limits`) and gives the same parts every time, so an
//! attachment's index stays the same between the list and opening it.

use std::borrow::Cow;

use mail_builder::MessageBuilder;
use mail_builder::headers::address::Address as BuilderAddress;
use mail_builder::headers::date::Date;
use mail_parser::{Message, MessagePart, MimeHeaders, PartType};
use uwumail_tnef::{IcsOptions, Person};

/// TNEF parts of one message that are decoded, at most.
pub const MAX_TNEF_PARTS: usize = 4;
/// How deep messages attached to attached messages are written out.
const MAX_ATTACHED_DEPTH: usize = 3;

/// The TNEF stream of a part: one of type `application/ms-tnef` (or `vnd.ms-tnef`), or named
/// `winmail.dat`, whose content really is TNEF.
pub fn stream<'a>(part: &'a MessagePart<'_>) -> Option<&'a [u8]> {
    let bytes: &[u8] = match &part.body {
        PartType::Binary(bytes) | PartType::InlineBinary(bytes) => bytes,
        _ => return None,
    };
    let typed = part.content_type().is_some_and(|ct| {
        ct.ctype().eq_ignore_ascii_case("application")
            && ct.subtype().is_some_and(|s| s.eq_ignore_ascii_case("ms-tnef") || s.eq_ignore_ascii_case("vnd.ms-tnef"))
    });
    let named = part.attachment_name().is_some_and(|n| n.trim().eq_ignore_ascii_case("winmail.dat"));
    ((typed || named) && uwumail_tnef::is_tnef(bytes)).then_some(bytes)
}

/// One decoded TNEF part.
#[derive(Debug, Clone)]
pub struct Decoded {
    /// The TNEF part's index among the message's parts.
    pub index: usize,
    pub message: uwumail_tnef::Message,
    /// The meeting as iCalendar with a METHOD, when it is one.
    pub calendar: Option<String>,
}

fn people(address: Option<&mail_parser::Address<'_>>) -> Vec<Person> {
    address
        .map(|a| {
            a.iter()
                .filter_map(|addr| {
                    Some(Person {
                        name: addr.name.as_deref().map(str::to_owned),
                        email: Some(addr.address.as_deref()?.to_owned()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// What the mail's headers say, for the meeting's iCalendar.
fn ics_options(message: &Message<'_>) -> IcsOptions {
    IcsOptions {
        // The message's own date, so the same mail always gives the same calendar part.
        now: message.date().map_or(0, |d| d.to_timestamp()),
        from: people(message.from()).into_iter().next(),
        to: people(message.to()),
        cc: people(message.cc()),
    }
}

/// Whether the message has a real `text/calendar` part, which wins over a meeting in TNEF.
fn has_calendar_part(message: &Message<'_>) -> bool {
    message.parts.iter().any(|part| {
        part.content_type().is_some_and(|ct| {
            ct.ctype().eq_ignore_ascii_case("text") && ct.subtype().is_some_and(|s| s.eq_ignore_ascii_case("calendar"))
        })
    })
}

/// Decodes the TNEF parts of a message (the first [`MAX_TNEF_PARTS`]).
pub fn decode(message: &Message<'_>) -> Vec<Decoded> {
    let calendar_wins = has_calendar_part(message);
    message
        .parts
        .iter()
        .enumerate()
        .filter_map(|(index, part)| Some((index, stream(part)?)))
        .take(MAX_TNEF_PARTS)
        .filter_map(|(index, bytes)| {
            let decoded = uwumail_tnef::decode(bytes).ok()?;
            let calendar = if calendar_wins {
                None
            } else {
                decoded.meeting().and_then(|meeting| meeting.to_ical(&ics_options(message)))
            };
            Some(Decoded { index, message: decoded, calendar })
        })
        .collect()
}

/// Whether the message's own MIME body has some text worth showing.
pub fn mime_has_text(message: &Message<'_>) -> bool {
    message.text_body.iter().chain(&message.html_body).any(|index| {
        matches!(message.parts.get(*index as usize).map(|p| &p.body),
            Some(PartType::Text(text) | PartType::Html(text)) if !text.trim().is_empty())
    })
}

/// An attachment as the app lists and opens it: a MIME part, or one made of a TNEF part.
#[derive(Debug, Clone)]
pub struct Part<'a> {
    pub filename: String,
    pub mime_type: String,
    /// Without angle brackets.
    pub content_id: Option<String>,
    /// Shown inside the HTML (by `cid:`) rather than as a file.
    pub inline: bool,
    pub data: Cow<'a, [u8]>,
}

fn mime_type(part: &MessagePart<'_>) -> String {
    part.content_type()
        .map(|ct| match ct.subtype() {
            Some(sub) => format!("{}/{}", ct.ctype(), sub),
            None => ct.ctype().to_string(),
        })
        .unwrap_or_else(|| "application/octet-stream".into())
}

/// A file name for an attached message.
fn eml_name(name: &str) -> String {
    if name.to_ascii_lowercase().ends_with(".eml") { name.to_owned() } else { format!("{name}.eml") }
}

/// A message attached inside winmail.dat, written as a MIME message.
fn attached_message(message: &uwumail_tnef::Message, depth: usize) -> Vec<u8> {
    let mut builder = MessageBuilder::new()
        .date(Date::new(message.sent_at.unwrap_or(0)))
        .subject(message.subject.clone().unwrap_or_default());
    if let Some(sender) = &message.sender
        && let Some(email) = &sender.email
    {
        builder =
            builder.from(BuilderAddress::new_address(sender.name.clone().map(Cow::Owned), Cow::Owned(email.clone())));
    }
    if let Some(text) = &message.body.text {
        builder = builder.text_body(text.clone());
    }
    if let Some(html) = &message.body.html {
        builder = builder.html_body(html.clone());
    }
    for attachment in &message.attachments {
        let name = attachment.name.clone().unwrap_or_else(|| "attachment".into());
        builder = match (&attachment.embedded, &attachment.content_id) {
            (Some(inner), _) if depth < MAX_ATTACHED_DEPTH => {
                builder.attachment("message/rfc822", eml_name(&name), attached_message(inner, depth + 1))
            }
            (Some(_), _) => continue,
            (None, Some(cid)) if attachment.inline => {
                builder.inline(attachment.mime_type.clone(), cid.clone(), attachment.data.clone())
            }
            (None, _) => builder.attachment(attachment.mime_type.clone(), name, attachment.data.clone()),
        };
    }
    builder.write_to_vec().unwrap_or_default()
}

/// The parts a TNEF part stands for: the meeting, then each attachment.
fn decoded_parts(decoded: &Decoded) -> Vec<Part<'static>> {
    let mut parts = Vec::new();
    if let Some(calendar) = &decoded.calendar {
        parts.push(Part {
            filename: "invite.ics".into(),
            mime_type: "text/calendar".into(),
            content_id: None,
            inline: false,
            data: Cow::Owned(calendar.clone().into_bytes()),
        });
    }
    for attachment in &decoded.message.attachments {
        let part = match &attachment.embedded {
            Some(inner) => Part {
                filename: eml_name(attachment.name.as_deref().or(inner.subject.as_deref()).unwrap_or("message")),
                mime_type: "message/rfc822".into(),
                content_id: None,
                inline: false,
                data: Cow::Owned(attached_message(inner, 0)),
            },
            None => Part {
                filename: attachment.name.clone().unwrap_or_else(|| "attachment".into()),
                mime_type: attachment.mime_type.clone(),
                content_id: attachment.content_id.clone(),
                inline: attachment.inline && attachment.content_id.is_some(),
                data: Cow::Owned(attachment.data.clone()),
            },
        };
        parts.push(Part { filename: crate::attachments::clean_display_name(&part.filename), ..part });
    }
    parts
}

/// The message's attachments in the order the app numbers them: each MIME attachment, a TNEF
/// part replaced by what it holds. `decoded` is [`decode`] of the same message.
pub fn attachment_parts<'a>(message: &'a Message<'a>, decoded: &[Decoded]) -> Vec<Part<'a>> {
    let mut parts = Vec::new();
    for &index in &message.attachments {
        let index = index as usize;
        let Some(part) = message.parts.get(index) else { continue };
        if let Some(found) = decoded.iter().find(|d| d.index == index) {
            parts.extend(decoded_parts(found));
            continue;
        }
        let content_id = part.content_id().map(|id| id.trim().trim_matches(['<', '>']).to_string());
        // Parts with a Content-ID belong into the HTML unless they say they're attachments.
        let inline = content_id.is_some() && !part.content_disposition().is_some_and(|d| d.is_attachment());
        parts.push(Part {
            filename: crate::attachments::clean_display_name(part.attachment_name().unwrap_or("attachment")),
            mime_type: mime_type(part),
            content_id,
            inline,
            data: Cow::Borrowed(part.contents()),
        });
    }
    parts
}

#[cfg(test)]
pub(crate) mod tests {
    use mail_parser::MessageParser;
    use uwumail_tnef::builder::{Props, Tnef, compressed_rtf, global_object_id, mime_with_winmail};
    use uwumail_tnef::mapi::{self, IID_IMESSAGE, PSETID_APPOINTMENT, PSETID_MEETING};

    use super::*;

    pub(crate) const HEADERS: &str = "From: Leni <leni@example.com>\r\nTo: mia@example.org\r\nSubject: Umzug\r\nDate: Mon, 26 Oct 2026 10:00:00 +0100\r\nMessage-ID: <tnef@example.com>\r\n";

    const RTF: &[u8] = br#"{\rtf1\ansi\ansicpg1252\fromhtml1 {\*\htmltag19 <html>}{\*\htmltag50 <body>}
{\*\htmltag64 <p>}\htmlrtf {\htmlrtf0 Hallo Mia, anbei der Bericht \'fcber den Umzug.\htmlrtf\par}\htmlrtf0
{\*\htmltag84 <img src="cid:logo@example.com">}{\*\htmltag72 </p>}{\*\htmltag58 </body>}{\*\htmltag27 </html>}}"#;

    /// A note with an HTML body in RTF, a PDF, a picture the HTML shows and an attached message.
    pub(crate) fn note() -> Vec<u8> {
        let inner = {
            let mut t = Tnef::new();
            t.message_props(&Props::new().unicode(mapi::PR_SUBJECT, "Weitergeleitet").unicode(mapi::PR_BODY, "Innen"));
            t.build()
        };
        let mut t = Tnef::new();
        t.message_class("IPM.Note");
        t.message_props(&Props::new().binary(mapi::PR_RTF_COMPRESSED, &compressed_rtf(RTF)));
        t.attachment(
            "QUARTA~1.PDF",
            b"%PDF-1.7 fake",
            &Props::new().unicode(mapi::PR_ATTACH_LONG_FILENAME, "Quartalsbericht 2026.pdf"),
        );
        t.attachment(
            "image001.png",
            b"\x89PNG\r\n\x1a\nfake",
            &Props::new()
                .unicode(mapi::PR_ATTACH_CONTENT_ID, "logo@example.com")
                .bool(mapi::PR_ATTACHMENT_HIDDEN, true),
        );
        t.attachment(
            "Weitergeleitet",
            &[],
            &Props::new().long(mapi::PR_ATTACH_METHOD, 5).object(mapi::PR_ATTACH_DATA, &IID_IMESSAGE, &inner),
        );
        t.build()
    }

    /// A meeting request of Outlook's, in TNEF.
    pub(crate) fn request(class: &str) -> Vec<u8> {
        const START: i64 = 1_793_091_600;
        let recipient = Props::new()
            .unicode(mapi::PR_DISPLAY_NAME, "Mia")
            .unicode(mapi::PR_ADDRTYPE, "SMTP")
            .unicode(mapi::PR_EMAIL_ADDRESS, "mia@example.org")
            .long(mapi::PR_RECIPIENT_TYPE, 1);
        let mut t = Tnef::new();
        t.message_class(class);
        t.message_props(
            &Props::new()
                .unicode(mapi::PR_SUBJECT, "Umzugsplanung")
                .unicode(mapi::PR_SENT_REPRESENTING_NAME, "Leni")
                .unicode(mapi::PR_SENT_REPRESENTING_SMTP_ADDRESS, "leni@example.com")
                .unicode(mapi::PR_BODY, "Wir planen den Umzug.")
                .named_time(&PSETID_APPOINTMENT, 0x820D, START)
                .named_time(&PSETID_APPOINTMENT, 0x820E, START + 3600)
                .named_binary(&PSETID_MEETING, 0x0003, &global_object_id("umzug@example.com", None)),
        );
        t.recipients(&[recipient]);
        t.build()
    }

    #[test]
    fn a_winmail_dat_stands_for_what_it_holds() {
        let raw = mime_with_winmail(HEADERS, Some(""), &note());
        let message = MessageParser::default().parse(&raw).unwrap();
        let decoded = decode(&message);
        assert_eq!(decoded.len(), 1);
        let parts = attachment_parts(&message, &decoded);
        let names: Vec<&str> = parts.iter().map(|p| p.filename.as_str()).collect();
        assert_eq!(names, ["Quartalsbericht 2026.pdf", "image001.png", "Weitergeleitet.eml"]);
        assert_eq!(parts[0].data.as_ref(), b"%PDF-1.7 fake");
        assert_eq!((parts[1].inline, parts[1].content_id.as_deref()), (true, Some("logo@example.com")));
        assert_eq!(parts[2].mime_type, "message/rfc822");
        let inner = MessageParser::default().parse(parts[2].data.as_ref()).unwrap();
        assert_eq!(inner.subject(), Some("Weitergeleitet"));
        assert_eq!(inner.body_text(0).as_deref().map(str::trim), Some("Innen"));
    }

    #[test]
    fn a_meeting_comes_first_as_an_invitation_unless_the_mail_has_its_own() {
        let raw = mime_with_winmail(HEADERS, None, &request("IPM.Schedule.Meeting.Request"));
        let message = MessageParser::default().parse(&raw).unwrap();
        let parts = attachment_parts(&message, &decode(&message));
        assert_eq!((parts[0].filename.as_str(), parts[0].mime_type.as_str()), ("invite.ics", "text/calendar"));
        let ics = String::from_utf8(parts[0].data.to_vec()).unwrap();
        assert!(ics.contains("METHOD:REQUEST") && ics.contains("SUMMARY:Umzugsplanung"), "{ics}");
        assert!(ics.to_lowercase().contains("mailto:leni@example.com"));

        let cancel = mime_with_winmail(HEADERS, None, &request("IPM.Schedule.Meeting.Canceled"));
        let message = MessageParser::default().parse(&cancel).unwrap();
        let ics = String::from_utf8(attachment_parts(&message, &decode(&message))[0].data.to_vec()).unwrap();
        assert!(ics.contains("METHOD:CANCEL"), "{ics}");

        let reply = mime_with_winmail(HEADERS, None, &request("IPM.Schedule.Meeting.Resp.Pos"));
        let message = MessageParser::default().parse(&reply).unwrap();
        let ics = String::from_utf8(attachment_parts(&message, &decode(&message))[0].data.to_vec()).unwrap();
        assert!(ics.contains("METHOD:REPLY"), "{ics}");

        // A real text/calendar part wins.
        let own = String::from_utf8(mime_with_winmail(HEADERS, None, &request("IPM.Schedule.Meeting.Request")))
            .unwrap()
            .replace(
                "--tnef-boundary\r\nContent-Type: application/ms-tnef",
                "--tnef-boundary\r\nContent-Type: text/calendar; method=REQUEST\r\n\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n--tnef-boundary\r\nContent-Type: application/ms-tnef",
            );
        let message = MessageParser::default().parse(own.as_bytes()).unwrap();
        let decoded = decode(&message);
        assert!(decoded[0].calendar.is_none());
    }

    #[test]
    fn damaged_or_fake_tnef_stays_a_file() {
        let fake = mime_with_winmail(HEADERS, Some("Hallo"), b"not tnef at all");
        let message = MessageParser::default().parse(&fake).unwrap();
        let parts = attachment_parts(&message, &decode(&message));
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].filename, "winmail.dat");
    }
}
