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

/// One foreign mail. `spam` is `Some(in_junk)` for the spam check, which also gets the headers
/// (the first 100 whose name fits, values cut to 2,000 characters); every other call gets neither.
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
        let headers: Vec<Value> = mail
            .headers
            .iter()
            .filter(|(name, _)| {
                let chars = name.chars().count();
                chars > 0 && chars <= MAX_HEADER_NAME_CHARS
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
            headers: (0..150).map(|n| (format!("X-H{n}"), "v".repeat(3000))).collect(),
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
        assert_eq!(spam["headers"].as_array().unwrap().len(), 100);
        assert_eq!(spam["headers"][0]["value"].as_str().unwrap().len(), 2000);
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
