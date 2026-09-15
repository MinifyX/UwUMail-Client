//! Building and sending outgoing mail.

use std::time::Duration;

use base64::Engine as _;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::extension::ClientId;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::error::{Error, Result};
use crate::model::{Address, AttachmentSource, OutgoingAttachment, Security, ServerSettings};

pub enum SmtpAuth {
    Password(String),
    OAuth(String),
}

pub struct Threading {
    pub parent_message_id: String,
    pub references: String,
}

/// Header text on one line. Names and subjects often come from received mail, and a line
/// break in them would either start a new header or make lettre panic.
fn single_line(text: &str) -> String {
    text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().to_string()
}

/// Message ids never contain spaces or control characters; anything else is dropped.
fn message_id_part(id: &str) -> String {
    id.chars().filter(|c| !c.is_control() && !c.is_whitespace() && !matches!(c, '<' | '>')).collect()
}

fn mailbox(address: &Address) -> Result<Mailbox> {
    let email = address
        .email
        .trim()
        .parse()
        .map_err(|_| Error::invalid(format!("\"{}\" isn't a valid email address.", address.email)))?;
    Ok(Mailbox::new(address.name.as_deref().map(single_line).filter(|n| !n.is_empty()), email))
}

fn attachment_body(attachment: &OutgoingAttachment) -> Result<Vec<u8>> {
    match &attachment.source {
        AttachmentSource::Base64 { data } => base64::engine::general_purpose::STANDARD
            .decode(data.as_bytes())
            .map_err(|_| Error::invalid(format!("Attachment {} is damaged.", attachment.filename))),
    }
}

/// A fresh Message-ID (without angle brackets) in the sender's domain. Our own, because lettre
/// would otherwise leave it out or put the computer name in it.
pub fn new_message_id(from_email: &str) -> String {
    let domain = from_email.rsplit_once('@').map(|(_, d)| d).filter(|d| !d.is_empty()).unwrap_or("uwumail.invalid");
    format!("{}@{}", uuid::Uuid::new_v4().simple(), message_id_part(domain))
}

/// Draft keys come back from the page and go into IMAP searches and headers: only what a
/// Message-ID may contain (also ids other mail programs gave their drafts), no quotes or spaces.
pub fn is_draft_key(key: &str) -> bool {
    key.len() <= 250
        && key.split_once('@').is_some_and(|(local, domain)| !local.is_empty() && !domain.is_empty())
        && key.chars().all(|c| c.is_ascii_alphanumeric() || "@.!#$%&'*+-/=?^_`{|}~[]".contains(c))
}

/// Everything that goes into one outgoing message or draft.
pub struct Mail<'a> {
    pub from: &'a Address,
    pub to: &'a [Address],
    pub cc: &'a [Address],
    pub bcc: &'a [Address],
    pub subject: &'a str,
    pub text: &'a str,
    pub html: &'a str,
    pub threading: Option<&'a Threading>,
    pub attachments: &'a [OutgoingAttachment],
    /// Without angle brackets; a new one when `None`.
    pub message_id: Option<&'a str>,
    /// Drafts keep Bcc in the headers (so it's there when writing continues) and may have no recipients.
    pub draft: bool,
}

pub fn build(mail: &Mail<'_>) -> Result<Message> {
    let Mail { from, to, cc, bcc, subject, text, html, threading, attachments, message_id, draft } = *mail;
    if to.len() + cc.len() + bcc.len() == 0 && !draft {
        return Err(Error::invalid("Add at least one recipient."));
    }
    let message_id = message_id.map(message_id_part).unwrap_or_else(|| new_message_id(&from.email));
    let sender = mailbox(from)?;
    let mut builder = Message::builder()
        .from(sender.clone())
        .subject(single_line(subject))
        .message_id(Some(format!("<{message_id}>")))
        .user_agent("UwUMail".into());
    for address in to {
        builder = builder.to(mailbox(address)?);
    }
    for address in cc {
        builder = builder.cc(mailbox(address)?);
    }
    for address in bcc {
        builder = builder.bcc(mailbox(address)?);
    }
    if draft {
        builder = builder.keep_bcc();
        if to.len() + cc.len() + bcc.len() == 0 {
            // Never sent, but lettre wants an envelope to build a message at all.
            let envelope = lettre::address::Envelope::new(Some(sender.email.clone()), vec![sender.email.clone()])
                .map_err(|e| Error::invalid(format!("Couldn't build the draft: {e}")))?;
            builder = builder.envelope(envelope);
        }
    }
    if let Some(threading) = threading {
        let parent = format!("<{}>", message_id_part(&threading.parent_message_id));
        let references = threading
            .references
            .split_whitespace()
            .map(message_id_part)
            .filter(|id| !id.is_empty())
            .map(|id| format!("<{id}>"))
            .chain(std::iter::once(parent.clone()))
            .collect::<Vec<_>>()
            .join(" ");
        builder = builder.in_reply_to(parent).references(references);
    }

    let body = MultiPart::alternative_plain_html(text.to_string(), html.to_string());
    let message = if attachments.is_empty() {
        builder.multipart(body)
    } else {
        let mut mixed = MultiPart::mixed().multipart(body);
        for attachment in attachments {
            let content_type = ContentType::parse(&attachment.mime_type)
                .unwrap_or_else(|_| ContentType::parse("application/octet-stream").expect("valid content type"));
            let part: SinglePart =
                Attachment::new(single_line(&attachment.filename)).body(attachment_body(attachment)?, content_type);
            mixed = mixed.singlepart(part);
        }
        builder.multipart(mixed)
    };
    message.map_err(|e| Error::invalid(format!("Couldn't build the message: {e}")))
}

pub async fn send(settings: &ServerSettings, username: &str, auth: SmtpAuth, message: &Message) -> Result<()> {
    let host = settings.host.as_str();
    let builder = match settings.security {
        Security::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(host),
        Security::Starttls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host),
        Security::None => Ok(AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)),
    }
    .map_err(|e| Error::connection(format!("Couldn't prepare a connection to {host}: {e}")))?;

    let (secret, mechanisms) = match auth {
        SmtpAuth::Password(password) => (password, vec![Mechanism::Plain, Mechanism::Login]),
        SmtpAuth::OAuth(token) => (token, vec![Mechanism::Xoauth2]),
    };
    let transport = builder
        .port(settings.port)
        .credentials(Credentials::new(username.to_string(), secret))
        .authentication(mechanisms)
        // Like Thunderbird: greet with an address literal instead of revealing the computer name.
        .hello_name(ClientId::Ipv4(std::net::Ipv4Addr::LOCALHOST))
        .timeout(Some(Duration::from_secs(60)))
        .build();

    transport.send(message.clone()).await.map(|_| ()).map_err(|error| {
        let text = error.to_string();
        if text.contains("535") || text.to_lowercase().contains("authentication") {
            Error::auth("The mail server rejected the login for sending.")
        } else if error.is_permanent() {
            Error::invalid(format!("The server refused the message: {text}"))
        } else {
            Error::connection(format!("Sending failed: {text}"))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mail<'a>(from: &'a Address, to: &'a [Address], subject: &'a str) -> Mail<'a> {
        Mail {
            from,
            to,
            cc: &[],
            bcc: &[],
            subject,
            text: "Hi",
            html: "<p>Hi</p>",
            threading: None,
            attachments: &[],
            message_id: None,
            draft: false,
        }
    }

    #[test]
    fn builds_a_threaded_reply_with_attachment() {
        let from = Address { name: Some("Mini".into()), email: "mini@uwumail.dev".into() };
        let to = [Address { name: Some("Leni Wanders".into()), email: "leni@wanders.example".into() }];
        let bcc = [Address { name: None, email: "secret@uwumail.dev".into() }];
        let threading = Threading { parent_message_id: "b@x".into(), references: "a@x".into() };
        let attachment = [OutgoingAttachment {
            filename: "notiz.txt".into(),
            mime_type: "text/plain".into(),
            size: 5,
            source: AttachmentSource::Base64 { data: "SGFsbG8=".into() },
        }];
        let message = build(&Mail {
            bcc: &bcc,
            threading: Some(&threading),
            attachments: &attachment,
            ..mail(&from, &to, "Re: Clip")
        })
        .unwrap();
        let raw = String::from_utf8(message.formatted()).unwrap();
        assert!(raw.contains("In-Reply-To: <b@x>"));
        assert!(raw.contains("References: <a@x> <b@x>"));
        assert!(raw.contains("notiz.txt"));
        assert!(raw.contains("@uwumail.dev>"), "Message-ID uses the sender domain");
        assert!(!raw.contains("secret@uwumail.dev"), "Bcc must not appear in the headers");
        assert_eq!(message.envelope().to().len(), 2);
    }

    #[test]
    fn line_breaks_cannot_add_headers() {
        let from = Address { name: Some("Mini\r\nBcc: sneaky@evil.example".into()), email: "mini@uwumail.dev".into() };
        let to = [Address { name: None, email: "leni@wanders.example".into() }];
        let message = build(&mail(&from, &to, "Hallo\r\nBcc: sneaky@evil.example")).unwrap();
        let raw = String::from_utf8(message.formatted()).unwrap();
        assert!(!raw.contains("\r\nBcc:"), "a subject or name must not start a new header line");
        assert_eq!(message.envelope().to().len(), 1);
        let threading = Threading {
            parent_message_id: "a@b\r\nBcc: sneaky@evil.example".into(),
            references: "x@y\r\nBcc:z".into(),
        };
        let reply = build(&Mail { threading: Some(&threading), ..mail(&from, &to, "Re: Hi") }).unwrap();
        assert!(!String::from_utf8(reply.formatted()).unwrap().contains("\r\nBcc:"));
        let injected = [Address { name: None, email: "leni@wanders.example>\r\nBcc: sneaky@evil.example".into() }];
        assert!(build(&mail(&from, &injected, "Hi")).is_err());
        let sneaky_id = build(&Mail { message_id: Some("a@b>\r\nBcc: x@y"), ..mail(&from, &to, "Hi") }).unwrap();
        assert!(!String::from_utf8(sneaky_id.formatted()).unwrap().contains("\r\nBcc:"));
    }

    #[test]
    fn refuses_messages_without_recipients() {
        let from = Address { name: None, email: "mini@uwumail.dev".into() };
        assert!(build(&mail(&from, &[], "Hi")).is_err());
    }

    #[test]
    fn drafts_keep_their_id_and_bcc_and_may_be_empty() {
        let from = Address { name: None, email: "mini@uwumail.dev".into() };
        let bcc = [Address { name: None, email: "secret@uwumail.dev".into() }];
        let draft =
            build(&Mail { bcc: &bcc, message_id: Some("abc@uwumail.dev"), draft: true, ..mail(&from, &[], "") })
                .unwrap();
        let raw = String::from_utf8(draft.formatted()).unwrap();
        assert!(raw.contains("Message-ID: <abc@uwumail.dev>"));
        assert!(raw.contains("secret@uwumail.dev"), "a draft remembers Bcc");
        assert!(build(&Mail { draft: true, ..mail(&from, &[], "") }).is_ok(), "an empty draft can be saved");
    }

    #[test]
    fn recognizes_draft_keys() {
        assert!(is_draft_key(&new_message_id("mini@uwumail.dev")));
        assert!(!is_draft_key("abc"));
        assert!(!is_draft_key("a@b\" OR ALL"));
        assert!(!is_draft_key("<a@b>"));
    }
}
