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

#[allow(clippy::too_many_arguments)]
pub fn build(
    from: &Address,
    to: &[Address],
    cc: &[Address],
    bcc: &[Address],
    subject: &str,
    text: &str,
    html: &str,
    threading: Option<&Threading>,
    attachments: &[OutgoingAttachment],
) -> Result<Message> {
    if to.len() + cc.len() + bcc.len() == 0 {
        return Err(Error::invalid("Add at least one recipient."));
    }
    // Our own Message-ID: lettre would otherwise leave it out or put the computer name in it.
    let domain = from.email.rsplit_once('@').map(|(_, d)| d).unwrap_or("uwumail.invalid");
    let message_id = format!("<{}@{domain}>", uuid::Uuid::new_v4().simple());
    let mut builder = Message::builder()
        .from(mailbox(from)?)
        .subject(single_line(subject))
        .message_id(Some(message_id))
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

    #[test]
    fn builds_a_threaded_reply_with_attachment() {
        let from = Address { name: Some("Mini".into()), email: "mini@uwumail.dev".into() };
        let to = [Address { name: Some("Leni Wanders".into()), email: "leni@wanders.example".into() }];
        let bcc = [Address { name: None, email: "secret@uwumail.dev".into() }];
        let threading = Threading { parent_message_id: "b@x".into(), references: "a@x".into() };
        let attachment = OutgoingAttachment {
            filename: "notiz.txt".into(),
            mime_type: "text/plain".into(),
            size: 5,
            source: AttachmentSource::Base64 { data: "SGFsbG8=".into() },
        };
        let message = build(
            &from,
            &to,
            &[],
            &bcc,
            "Re: Clip",
            "Sieht gut aus",
            "<p>Sieht gut aus</p>",
            Some(&threading),
            &[attachment],
        )
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
        let message =
            build(&from, &to, &[], &[], "Hallo\r\nBcc: sneaky@evil.example", "Hi", "<p>Hi</p>", None, &[]).unwrap();
        let raw = String::from_utf8(message.formatted()).unwrap();
        assert!(!raw.contains("\r\nBcc:"), "a subject or name must not start a new header line");
        assert_eq!(message.envelope().to().len(), 1);
        let threading = Threading {
            parent_message_id: "a@b\r\nBcc: sneaky@evil.example".into(),
            references: "x@y\r\nBcc:z".into(),
        };
        let reply = build(&from, &to, &[], &[], "Re: Hi", "", "", Some(&threading), &[]).unwrap();
        assert!(!String::from_utf8(reply.formatted()).unwrap().contains("\r\nBcc:"));
        let injected = Address { name: None, email: "leni@wanders.example>\r\nBcc: sneaky@evil.example".into() };
        assert!(build(&from, &[injected], &[], &[], "Hi", "", "", None, &[]).is_err());
    }

    #[test]
    fn refuses_messages_without_recipients() {
        let from = Address { name: None, email: "mini@uwumail.dev".into() };
        assert!(build(&from, &[], &[], &[], "Hi", "", "", None, &[]).is_err());
    }
}
