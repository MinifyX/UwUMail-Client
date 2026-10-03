//! Mail of this device's mailboxes for a UwUMail server's assistant, when the person lets that
//! server do the AI of their other mailboxes (`serverAssist`, docs/jmap-assist.md "Foreign mail" of
//! UwUMail Server). The server has no copy of such mail, so its content goes along with the call,
//! held to the sizes the server takes: it refuses anything larger rather than cutting it.

use serde_json::{Value, json};

use super::mail::MailText;
use crate::model::Address;

/// Mails of a conversation sent for a summary, at most.
pub const MAX_MAILS: usize = 20;
/// Labels sent along, at most.
pub const MAX_LABELS: usize = 50;
const MAX_ADDRESSES: usize = 50;
const MAX_NAME_CHARS: usize = 200;
const MAX_EMAIL_CHARS: usize = 320;
const MAX_SUBJECT_CHARS: usize = 998;
const MAX_TEXT_CHARS: usize = 200_000;
const MAX_HEADERS: usize = 100;
const MAX_HEADER_NAME_CHARS: usize = 100;
const MAX_HEADER_VALUE_CHARS: usize = 2_000;
const MAX_LABEL_NAME_CHARS: usize = 40;
const MAX_LABEL_DESCRIPTION_CHARS: usize = 300;
/// The headers the server's spam check reads (its `signals`); no other header leaves the device,
/// so `Received` lines, addresses and ids of the other provider stay here.
const SPAM_HEADERS: [&str; 2] = ["Authentication-Results", "X-Spam-Status"];

fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn addresses(list: &[Address]) -> Value {
    Value::Array(
        list.iter()
            .filter(|address| {
                let chars = address.email.trim().chars().count();
                chars > 0 && chars <= MAX_EMAIL_CHARS
            })
            .take(MAX_ADDRESSES)
            .map(|address| {
                json!({
                    "name": address.name.as_deref().map(|name| cut(name.trim(), MAX_NAME_CHARS)),
                    "email": address.email.trim(),
                })
            })
            .collect(),
    )
}

/// One foreign mail. `spam` is `Some(in_junk)` for the spam check, which also gets the headers it
/// reads ([`SPAM_HEADERS`], at most 100, values cut to 2,000 characters); every other call gets
/// neither.
pub fn mail(mail: &MailText, spam: Option<bool>) -> Value {
    let mut out = json!({
        "from": addresses(&mail.from),
        "to": addresses(&mail.to),
        "cc": addresses(&mail.cc),
        "date": (mail.date > 0).then(|| crate::mime::iso8601(mail.date)),
        "subject": cut(&mail.subject, MAX_SUBJECT_CHARS),
        "text": cut(&mail.text, MAX_TEXT_CHARS),
    });
    if let Some(in_junk) = spam {
        // Only the ones the receiving server wrote: the server takes the topmost it gets, and one a
        // sender wrote lower down would vouch for its own mail (C-1).
        let headers: Vec<Value> = super::signals::receiving_headers(&mail.headers)
            .iter()
            .filter(|(name, _)| {
                name.chars().count() <= MAX_HEADER_NAME_CHARS
                    && SPAM_HEADERS.iter().any(|wanted| wanted.eq_ignore_ascii_case(name.trim()))
            })
            .take(MAX_HEADERS)
            .map(|(name, value)| json!({ "name": name, "value": cut(value, MAX_HEADER_VALUE_CHARS) }))
            .collect();
        out["headers"] = Value::Array(headers);
        out["inJunk"] = Value::Bool(in_junk);
    }
    out
}

/// A conversation, oldest first: its latest [`MAX_MAILS`] mails.
pub fn mails(mails: &[MailText]) -> Value {
    let start = mails.len().saturating_sub(MAX_MAILS);
    Value::Array(mails[start..].iter().map(|m| mail(m, None)).collect())
}

/// The device's labels as `foreignLabels`: (name, description, whether the mail has it).
pub fn labels(labels: &[(String, String, bool)]) -> Value {
    Value::Array(
        labels
            .iter()
            .take(MAX_LABELS)
            .map(|(name, description, is_set)| {
                json!({
                    "name": cut(name, MAX_LABEL_NAME_CHARS),
                    "description": cut(description, MAX_LABEL_DESCRIPTION_CHARS),
                    "isSet": is_set,
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreign_mail_keeps_to_the_servers_sizes() {
        let many: Vec<Address> = (0..60)
            .map(|n| Address { name: Some("N".repeat(300)), email: format!("p{n}@example.org") })
            .chain(std::iter::once(Address { name: None, email: format!("{}@example.org", "x".repeat(320)) }))
            .collect();
        let text = MailText {
            subject: "S".repeat(1200),
            from: vec![Address { name: Some("Stadtwerke".into()), email: "rechnung@stadtwerke.example".into() }],
            to: many.clone(),
            cc: Vec::new(),
            date: 0,
            text: "t".repeat(250_000),
            links: Vec::new(),
            headers: (0..150)
                .flat_map(|n| {
                    [
                        (format!("X-H{n}"), "v".repeat(3000)),
                        ("Received".to_string(), format!("from mx{n}.example.net (192.0.2.{n})")),
                        ("Authentication-Results".to_string(), "v".repeat(3000)),
                    ]
                })
                .chain(std::iter::once(("x-spam-status".to_string(), "No, score=1.2".to_string())))
                .collect(),
        };
        let plain = mail(&text, None);
        assert_eq!(plain["to"].as_array().unwrap().len(), 50);
        assert_eq!(plain["to"][0]["name"].as_str().unwrap().chars().count(), 200);
        assert!(plain["to"].as_array().unwrap().iter().all(|a| a["email"].as_str().unwrap().len() <= 320));
        assert_eq!(plain["subject"].as_str().unwrap().chars().count(), 998);
        assert_eq!(plain["text"].as_str().unwrap().chars().count(), 200_000);
        assert!(plain["date"].is_null(), "unknown date");
        assert!(plain.get("headers").is_none() && plain.get("inJunk").is_none(), "only for the spam check");
        assert_eq!(plain["from"][0]["email"], "rechnung@stadtwerke.example");

        let spam = mail(&MailText { date: 1_790_000_000, ..text.clone() }, Some(true));
        // Below the first intake line every header may be the sender's: none of them goes.
        assert_eq!(spam["headers"], json!([]));
        let few = MailText {
            headers: vec![
                ("X-Spam-Status".into(), "No".into()),
                ("Authentication-Results".into(), format!("mx.example.net; {}", "v".repeat(3000))),
                ("Received".into(), "from relay.example.com by mx.example.net".into()),
                ("X-Spam-Status".into(), "No, score=-50".into()),
                ("Authentication-Results".into(), "mx.example.net; dmarc=pass".into()),
            ],
            ..text.clone()
        };
        let sent = mail(&few, Some(false));
        let sent = sent["headers"].as_array().unwrap();
        assert_eq!(sent.len(), 2, "only what the spam check reads, only the receiving server's: {sent:?}");
        assert_eq!(sent[0], json!({ "name": "X-Spam-Status", "value": "No" }));
        assert_eq!(sent[1]["name"], "Authentication-Results");
        assert_eq!(sent[1]["value"].as_str().unwrap().chars().count(), 2000);
        assert_eq!(spam["inJunk"], true);
        assert!(spam["date"].as_str().unwrap().ends_with('Z'));

        let thread: Vec<MailText> =
            (0..25).map(|n| MailText { subject: format!("{n}"), ..MailText::default() }).collect();
        let sent = mails(&thread);
        assert_eq!(sent.as_array().unwrap().len(), 20);
        assert_eq!(sent[0]["subject"], "5", "the latest, oldest first");

        let list: Vec<(String, String, bool)> = (0..60).map(|n| (format!("L{n}"), "d".repeat(400), n == 0)).collect();
        let sent = labels(&list);
        assert_eq!(sent.as_array().unwrap().len(), 50);
        assert_eq!(sent[0]["isSet"], true);
        assert_eq!(sent[0]["description"].as_str().unwrap().len(), 300);
    }
}
