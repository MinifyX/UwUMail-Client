//! `mailto:` links (RFC 6068), for when UwUMail is the default mail app.

use serde::Serialize;

use crate::model::Address;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailtoDraft {
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub subject: String,
    pub body: String,
}

fn decode(value: &str) -> String {
    percent_encoding::percent_decode_str(value).decode_utf8_lossy().into_owned()
}

fn addresses(list: &str) -> Vec<Address> {
    decode(list)
        .split([',', ';'])
        .map(str::trim)
        .filter(|email| email.contains('@') && !email.contains(char::is_whitespace))
        .map(|email| Address { name: None, email: email.to_string() })
        .collect()
}

/// Parses a `mailto:` link, or returns `None` for anything else.
pub fn parse(link: &str) -> Option<MailtoDraft> {
    let link = link.trim().trim_matches('"');
    let rest = link.get(..7).filter(|scheme| scheme.eq_ignore_ascii_case("mailto:")).map(|_| &link[7..])?;
    let (recipients, query) = rest.split_once('?').unwrap_or((rest, ""));
    let mut draft = MailtoDraft { to: addresses(recipients), ..MailtoDraft::default() };
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match key.to_ascii_lowercase().as_str() {
            "to" => draft.to.extend(addresses(value)),
            "cc" => draft.cc.extend(addresses(value)),
            "bcc" => draft.bcc.extend(addresses(value)),
            "subject" => draft.subject = decode(&value.replace('+', "%20")),
            "body" => draft.body = decode(&value.replace('+', "%20")).replace("\r\n", "\n"),
            _ => {}
        }
    }
    Some(draft)
}

/// The first `mailto:` link among command line arguments.
pub fn from_args<I: IntoIterator<Item = S>, S: AsRef<str>>(args: I) -> Option<MailtoDraft> {
    args.into_iter().find_map(|arg| parse(arg.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_recipients_subject_and_body() {
        let draft =
            parse("mailto:leni@example.com,noah@example.com?cc=mia@example.com&subject=Hallo%20Leni&body=Zeile%201%0D%0AZeile%202")
                .unwrap();
        let emails = |list: &[Address]| list.iter().map(|a| a.email.clone()).collect::<Vec<_>>();
        assert_eq!(emails(&draft.to), ["leni@example.com", "noah@example.com"]);
        assert_eq!(emails(&draft.cc), ["mia@example.com"]);
        assert_eq!(draft.subject, "Hallo Leni");
        assert_eq!(draft.body, "Zeile 1\nZeile 2");
    }

    #[test]
    fn handles_odd_links() {
        assert_eq!(parse("MAILTO:?to=a%40b.example&subject=Hi+there").unwrap().to[0].email, "a@b.example");
        assert_eq!(parse("mailto:?subject=Hi+there").unwrap().subject, "Hi there");
        assert!(parse("mailto:not an address").unwrap().to.is_empty());
        assert!(parse("https://example.com").is_none());
        let from_cli = from_args(["uwumail.exe", "--autostart", "\"mailto:x@y.example\""]).unwrap();
        assert_eq!(from_cli.to[0].email, "x@y.example");
    }
}
