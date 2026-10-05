//! Building and sending outgoing mail.

use std::time::Duration;

use base64::Engine as _;
use lettre::Message;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::client::{AsyncSmtpConnection, TlsParameters};
use lettre::transport::smtp::commands::{self, Data, Rcpt};
use lettre::transport::smtp::extension::{ClientId, Extension, MailBodyParameter, MailParameter};

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

/// Images pasted into a mail or its signature arrive as `data:` URLs, which many mail programs
/// don't show. They travel as inline parts instead, referenced by `cid:`.
fn inline_images(html: &str) -> (String, Vec<(String, ContentType, Vec<u8>)>) {
    const MARKER: &str = "data:image/";
    let mut out = String::with_capacity(html.len());
    let mut images = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find(MARKER) {
        let (before, from) = rest.split_at(start);
        // Only whole attribute values: src="data:…" or src='data:…'.
        let Some(quote) = before.chars().last().filter(|c| matches!(c, '"' | '\'')) else {
            out.push_str(&rest[..start + MARKER.len()]);
            rest = &rest[start + MARKER.len()..];
            continue;
        };
        let Some(end) = from.find(quote) else { break };
        out.push_str(before);
        match data_image(&from[..end]) {
            Some((content_type, bytes)) => {
                let cid = format!("img{}.{}@uwumail", images.len() + 1, uuid::Uuid::new_v4().simple());
                out.push_str("cid:");
                out.push_str(&cid);
                images.push((cid, content_type, bytes));
            }
            None => out.push_str(&from[..end]),
        }
        rest = &from[end..];
    }
    out.push_str(rest);
    (out, images)
}

/// A base64 `data:` URL of a common image type.
fn data_image(url: &str) -> Option<(ContentType, Vec<u8>)> {
    let (meta, data) = url.strip_prefix("data:")?.split_once(',')?;
    let mime = meta.strip_suffix(";base64")?.to_ascii_lowercase();
    if !["image/png", "image/jpeg", "image/gif", "image/webp"].contains(&mime.as_str()) {
        return None;
    }
    let data: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    Some((ContentType::parse(&mime).ok()?, bytes))
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

    // Drafts keep their images as they are, so writing continues with them.
    let (html, images) = if draft { (html.to_string(), Vec::new()) } else { inline_images(html) };
    let body = if images.is_empty() {
        MultiPart::alternative_plain_html(text.to_string(), html)
    } else {
        let mut related = MultiPart::related().singlepart(SinglePart::html(html));
        for (cid, content_type, bytes) in images {
            related = related.singlepart(Attachment::new_inline(cid).body(bytes, content_type));
        }
        MultiPart::alternative().singlepart(SinglePart::plain(text.to_string())).multipart(related)
    };
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

/// Sends one message. Only a failure before the message itself went over the wire, or the
/// server's own refusal of it, can be tried again safely; a connection that breaks off while the
/// message is handed over or before the server answered it is [`Error::maybe_sent`], because the
/// server may have taken it (security review 0.10 SL-2).
pub async fn send(settings: &ServerSettings, username: &str, auth: SmtpAuth, message: &Message) -> Result<()> {
    let host = settings.host.as_str();
    let (secret, mechanisms) = match auth {
        SmtpAuth::Password(password) => (password, vec![Mechanism::Plain, Mechanism::Login]),
        SmtpAuth::OAuth(token) => (token, vec![Mechanism::Xoauth2]),
    };
    let credentials = Credentials::new(username.to_string(), secret);
    // Like Thunderbird: greet with an address literal instead of revealing the computer name.
    let hello = ClientId::Ipv4(std::net::Ipv4Addr::LOCALHOST);
    let tls = || {
        TlsParameters::new(host.to_string())
            .map_err(|e| Error::connection(format!("Couldn't prepare a connection to {host}: {e}")))
    };
    let wrapper = match settings.security {
        Security::Tls => Some(tls()?),
        Security::Starttls | Security::None => None,
    };

    // Everything up to and including DATA: the server hasn't seen the message yet.
    let mut connection =
        AsyncSmtpConnection::connect_tokio1((host, settings.port), Some(SMTP_TIMEOUT), &hello, wrapper, None)
            .await
            .map_err(refused)?;
    let prepared = async {
        if settings.security == Security::Starttls {
            connection.starttls(tls()?, &hello).await.map_err(refused)?;
        }
        connection.auth(&mechanisms, &credentials).await.map_err(refused)?;
        let envelope = message.envelope();
        let raw = message.formatted();
        let mut options = Vec::new();
        let utf8_addresses = envelope
            .from()
            .into_iter()
            .chain(envelope.to())
            .any(|address: &lettre::Address| !AsRef::<str>::as_ref(address).is_ascii());
        if utf8_addresses {
            if !connection.server_info().supports_feature(Extension::SmtpUtfEight) {
                return Err(Error::invalid("The mail server can't send to addresses with international characters."));
            }
            options.push(MailParameter::SmtpUtfEight);
        }
        if !raw.is_ascii() {
            if !connection.server_info().supports_feature(Extension::EightBitMime) {
                return Err(Error::invalid("The mail server can't send this message's characters."));
            }
            options.push(MailParameter::Body(MailBodyParameter::EightBitMime));
        }
        connection.command(commands::Mail::new(envelope.from().cloned(), options)).await.map_err(refused)?;
        for recipient in envelope.to() {
            connection.command(Rcpt::new(recipient.clone(), vec![])).await.map_err(refused)?;
        }
        connection.command(Data).await.map_err(refused)?;
        Ok(raw)
    }
    .await;
    let raw = match prepared {
        Ok(raw) => raw,
        Err(error) => {
            connection.abort().await;
            return Err(error);
        }
    };

    // From here on the server may take the message even if its answer never arrives.
    let result = connection.message(&raw).await.map_err(|error| {
        if error.is_transient() || error.is_permanent() { refused(error) } else { Error::maybe_sent(error) }
    });
    connection.abort().await;
    result.map(|_| ())
}

/// How long one connection may wait on the server, as lettre's transport did.
const SMTP_TIMEOUT: Duration = Duration::from_secs(60);

/// An SMTP failure where the server certainly didn't take the mail (or answered with a refusal).
fn refused(error: lettre::transport::smtp::Error) -> Error {
    let text = error.to_string();
    if let Some(refused) = explain_refusal(&text) {
        refused
    } else if text.contains("535") || text.to_lowercase().contains("authentication") {
        Error::auth("The mail server rejected the login for sending.")
    } else if error.is_permanent() {
        Error::invalid(format!("The server refused the message: {text}"))
    } else {
        Error::connection(format!("Sending failed: {text}"))
    }
}

/// Recognises a server that refuses to let this mailbox submit mail at all.
///
/// Microsoft 365 turns SMTP submission off for new tenants by default, and
/// Basic authentication for it is being retired, so the refusal is a permanent
/// setting an administrator has to change — not something retrying will fix.
pub(crate) fn explain_refusal(text: &str) -> Option<Error> {
    let text = text.to_ascii_lowercase();
    let disabled = text.contains("smtpclientauthentication is disabled")
        || text.contains("smtp_auth_disabled")
        || text.contains("5.7.139")
        // "550 5.7.30 Basic authentication is not supported for Client Submission"
        || text.contains("5.7.30")
        || (text.contains("client submission") && text.contains("not supported"))
        || (text.contains("submission") && text.contains("disabled"));
    disabled.then(|| Error::smtp_disabled("This mailbox may not send over SMTP."))
}

#[cfg(test)]
mod tests {

    #[test]
    fn recognizes_a_tenant_that_forbids_smtp_submission() {
        for refusal in [
            "535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant. Visit https://aka.ms/smtp_auth_disabled for more information.",
            "550 5.7.30 Basic authentication is not supported for Client Submission",
        ] {
            assert_eq!(
                explain_refusal(refusal).map(|e| e.code),
                Some(crate::error::ErrorCode::SmtpDisabled),
                "should recognize: {refusal}"
            );
        }
        // An ordinary bad password is not a policy problem and must stay retryable advice.
        assert!(explain_refusal("535 5.7.3 Authentication unsuccessful").is_none());
        assert!(explain_refusal("451 4.7.0 Temporary server error").is_none());
    }
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
        let from = Address { name: Some("Mini".into()), email: "mini@uwumail.example".into() };
        let to = [Address { name: Some("Leni Wanders".into()), email: "leni@wanders.example".into() }];
        let bcc = [Address { name: None, email: "secret@uwumail.example".into() }];
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
        assert!(raw.contains("@uwumail.example>"), "Message-ID uses the sender domain");
        assert!(!raw.contains("secret@uwumail.example"), "Bcc must not appear in the headers");
        assert_eq!(message.envelope().to().len(), 2);
    }

    #[test]
    fn line_breaks_cannot_add_headers() {
        let from =
            Address { name: Some("Mini\r\nBcc: sneaky@evil.example".into()), email: "mini@uwumail.example".into() };
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
    fn attachment_types_and_names_stay_in_their_header() {
        let from = Address { name: None, email: "mini@uwumail.example".into() };
        let to = [Address { name: None, email: "leni@wanders.example".into() }];
        let attachment = [OutgoingAttachment {
            filename: "a.txt\r\nBcc: sneaky@evil.example".into(),
            mime_type: "text/plain\r\nBcc: sneaky@evil.example".into(),
            size: 5,
            source: AttachmentSource::Base64 { data: "SGFsbG8=".into() },
        }];
        let message = build(&Mail { attachments: &attachment, ..mail(&from, &to, "Hi") }).unwrap();
        let raw = String::from_utf8(message.formatted()).unwrap();
        assert!(!raw.contains("\r\nBcc:"), "{raw}");
        assert!(raw.contains("application/octet-stream"), "a broken type falls back");
        assert_eq!(message.envelope().to().len(), 1);
    }

    #[test]
    fn refuses_messages_without_recipients() {
        let from = Address { name: None, email: "mini@uwumail.example".into() };
        assert!(build(&mail(&from, &[], "Hi")).is_err());
    }

    #[test]
    fn drafts_keep_their_id_and_bcc_and_may_be_empty() {
        let from = Address { name: None, email: "mini@uwumail.example".into() };
        let bcc = [Address { name: None, email: "secret@uwumail.example".into() }];
        let draft =
            build(&Mail { bcc: &bcc, message_id: Some("abc@uwumail.example"), draft: true, ..mail(&from, &[], "") })
                .unwrap();
        let raw = String::from_utf8(draft.formatted()).unwrap();
        assert!(raw.contains("Message-ID: <abc@uwumail.example>"));
        assert!(raw.contains("secret@uwumail.example"), "a draft remembers Bcc");
        assert!(build(&Mail { draft: true, ..mail(&from, &[], "") }).is_ok(), "an empty draft can be saved");
    }

    #[test]
    fn embeds_pasted_images() {
        let from = Address { name: None, email: "mini@uwumail.example".into() };
        let to = [Address { name: None, email: "leni@wanders.example".into() }];
        let html = r#"<p>Liebe Grüße</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="Logo"><img src='https://x.example/a.png'>"#;
        let message = build(&Mail { html, ..mail(&from, &to, "Hi") }).unwrap();
        let raw = String::from_utf8(message.formatted()).unwrap();
        assert!(raw.contains("multipart/related"));
        assert!(raw.contains("Content-ID: <img1."));
        assert!(raw.contains("cid:img1."));
        assert!(!raw.contains("data:image"), "the image travels as a part, not inside the HTML");
        assert!(raw.contains("https://x.example/a.png"), "other images stay untouched");

        let draft = build(&Mail { html, draft: true, ..mail(&from, &to, "Hi") }).unwrap();
        assert!(String::from_utf8(draft.formatted()).unwrap().contains("data:image/png"));
        let broken =
            build(&Mail { html: r#"<img src="data:image/svg+xml;base64,PHN2Zz4=">"#, ..mail(&from, &to, "Hi") })
                .unwrap();
        assert!(
            !String::from_utf8(broken.formatted()).unwrap().contains("multipart/related"),
            "only plain image types"
        );

        // What arrives: the HTML points at an inline part the reader can show.
        let parsed = crate::mime::parse(&message.formatted());
        let image = &parsed.attachments[0];
        assert!(image.inline);
        let cid = image.content_id.as_deref().unwrap();
        assert!(parsed.html.unwrap().contains(&format!("cid:{cid}")));
    }

    #[test]
    fn recognizes_draft_keys() {
        assert!(is_draft_key(&new_message_id("mini@uwumail.example")));
        assert!(!is_draft_key("abc"));
        assert!(!is_draft_key("a@b\" OR ALL"));
        assert!(!is_draft_key("<a@b>"));
    }

    /// Where a fake submission server stops answering.
    #[derive(Clone, Copy)]
    enum BreakOff {
        AfterMail,
        AfterMessage,
        RefuseMessage,
        Accept,
    }

    /// A submission server on 127.0.0.1:0 that behaves as told, once.
    async fn fake_server(at: BreakOff) -> super::ServerSettings {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let (read, mut write) = socket.into_split();
            let mut lines = BufReader::new(read).lines();
            write.write_all(b"220 fake ESMTP\r\n").await.unwrap();
            let mut in_data = false;
            while let Ok(Some(line)) = lines.next_line().await {
                if in_data {
                    if line != "." {
                        continue;
                    }
                    match at {
                        // The connection breaks before the server's answer arrives.
                        BreakOff::AfterMessage => return,
                        BreakOff::RefuseMessage => write.write_all(b"451 4.3.0 try later\r\n").await.unwrap(),
                        _ => write.write_all(b"250 2.0.0 queued\r\n").await.unwrap(),
                    }
                    in_data = false;
                    continue;
                }
                let verb = line.split(' ').next().unwrap_or_default().to_ascii_uppercase();
                let answer: &[u8] = match verb.as_str() {
                    "EHLO" => b"250-fake\r\n250-8BITMIME\r\n250 AUTH PLAIN LOGIN\r\n",
                    "AUTH" => b"235 2.7.0 ok\r\n",
                    "MAIL" if matches!(at, BreakOff::AfterMail) => return,
                    "MAIL" | "RCPT" => b"250 ok\r\n",
                    "DATA" => {
                        in_data = true;
                        b"354 go ahead\r\n"
                    }
                    "QUIT" => b"221 bye\r\n",
                    _ => b"500 what\r\n",
                };
                if write.write_all(answer).await.is_err() {
                    return;
                }
            }
        });
        super::ServerSettings { host: "127.0.0.1".into(), port, security: super::Security::None }
    }

    async fn send_to(at: BreakOff) -> super::Result<()> {
        let from = super::Address { name: None, email: "mini@uwumail.example".into() };
        let to = [super::Address { name: None, email: "kim@uwumail.example".into() }];
        let message = super::build(&super::Mail {
            from: &from,
            to: &to,
            cc: &[],
            bcc: &[],
            subject: "Hallo",
            text: "Hallo",
            html: "<p>Hallo</p>",
            threading: None,
            attachments: &[],
            message_id: None,
            draft: false,
        })
        .unwrap();
        let settings = fake_server(at).await;
        super::send(&settings, "mini", super::SmtpAuth::Password("pw".into()), &message).await
    }

    #[tokio::test]
    async fn only_a_break_after_the_message_went_over_counts_as_maybe_sent() {
        use crate::error::ErrorCode;
        assert!(send_to(BreakOff::Accept).await.is_ok());
        // Before the message: certainly not sent, so it may be tried again.
        assert_eq!(send_to(BreakOff::AfterMail).await.unwrap_err().code, ErrorCode::ConnectionFailed);
        // The server's own "not now" for the message: not taken either.
        assert_eq!(send_to(BreakOff::RefuseMessage).await.unwrap_err().code, ErrorCode::ConnectionFailed);
        // Handed over but no answer: it may have gone out, never retried on its own (SL-2).
        let unsure = send_to(BreakOff::AfterMessage).await.unwrap_err();
        assert_eq!(unsure.code, ErrorCode::MaybeSent);
        assert!(unsure.message.contains("may have been sent"), "{}", unsure.message);
    }
}
