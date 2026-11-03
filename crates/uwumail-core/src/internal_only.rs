//! Mailboxes that may only send to addresses on their own server.
//!
//! A UwUMail server (0.27 and later) can restrict a mailbox to the domains it hosts itself. Its
//! session then says so in the submission capability of the account: `uwuInternalOnly: true` and
//! `uwuInternalDomains`, the hosted domains in lower case. Older servers leave both out, which
//! means no restriction. The server refuses other recipients itself (SMTP 550 5.7.1; over JMAP
//! they come back as a bounce while the others still get the mail); the app shows it beforehand
//! and doesn't hand such a mail over at all, so a refused one is never tried again on its own.

use serde_json::Value;

use crate::error::{Error, ErrorCode, Result};

/// A session naming more domains than this is cut short.
const MAX_DOMAINS: usize = 10_000;

/// The domains a mailbox may send to, from its submission capability; `None` when it may send
/// anywhere. An internal-only mailbox whose server names no (usable) domains is treated as
/// unrestricted too: an empty list means "unknown", not "nowhere", so nothing is blocked wrongly.
pub fn from_capability(capability: Option<&Value>) -> Option<Vec<String>> {
    let capability = capability?;
    if capability.get("uwuInternalOnly").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let mut domains: Vec<String> = capability
        .get("uwuInternalDomains")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).filter_map(normal_domain).take(MAX_DOMAINS).collect())
        .unwrap_or_default();
    domains.sort();
    domains.dedup();
    (!domains.is_empty()).then_some(domains)
}

/// A domain as it is compared: trimmed, without a final dot, in lower case, IDNA-encoded to ASCII
/// (the server lists punycode). If that fails the lower-cased input is kept.
fn normal_domain(domain: &str) -> Option<String> {
    let domain = domain.trim().trim_end_matches('.').to_lowercase();
    let domain = idna::domain_to_ascii(&domain).ok().filter(|ascii| !ascii.is_empty()).unwrap_or(domain);
    let fine = !domain.is_empty()
        && domain.len() <= 253
        && !domain.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '@' | '<' | '>'));
    fine.then_some(domain)
}

/// The domain of an address (`mini+news@Example.COM` → `example.com`); also of one written with
/// its name (`Mini <mini@example.com>`). `None` when it has none.
pub fn domain_of(address: &str) -> Option<String> {
    let address = match (address.rfind('<'), address.rfind('>')) {
        (Some(start), Some(end)) if start < end => &address[start + 1..end],
        _ => address,
    };
    let (local, domain) = address.trim().rsplit_once('@')?;
    if local.is_empty() {
        return None;
    }
    normal_domain(domain)
}

/// The recipients that aren't on one of `domains`, each once, in their order.
pub fn external<'a>(recipients: impl IntoIterator<Item = &'a str>, domains: &[String]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for recipient in recipients {
        let inside = domain_of(recipient).is_some_and(|domain| domains.contains(&domain));
        if !inside && !found.iter().any(|known| known.eq_ignore_ascii_case(recipient.trim())) {
            found.push(recipient.trim().to_string());
        }
    }
    found
}

/// Refuses a mail to recipients the mailbox may not send to (`domains` from [`from_capability`]).
pub fn check<'a>(domains: Option<&[String]>, recipients: impl IntoIterator<Item = &'a str>) -> Result<()> {
    // `None` and an empty list both mean "no (known) restriction".
    let Some(domains) = domains.filter(|domains| !domains.is_empty()) else { return Ok(()) };
    let outside = external(recipients, domains);
    if outside.is_empty() {
        return Ok(());
    }
    Err(Error::new(
        ErrorCode::Forbidden,
        format!("This mailbox may only send to addresses on its own server. Not deliverable: {}", outside.join(", ")),
    ))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_the_capability() {
        assert_eq!(from_capability(None), None);
        assert_eq!(from_capability(Some(&json!({}))), None, "older servers say nothing");
        assert_eq!(from_capability(Some(&json!({ "uwuInternalOnly": false, "uwuInternalDomains": ["a.test"] }))), None);
        assert_eq!(from_capability(Some(&json!({ "uwuInternalOnly": "true" }))), None, "only a boolean counts");
        assert_eq!(
            from_capability(Some(&json!({
                "uwuInternalOnly": true,
                "uwuInternalDomains": ["B.example.", " a.test ", "a.test", "", "bad@x.test", 7]
            }))),
            Some(vec!["a.test".to_string(), "b.example".to_string()])
        );
        assert_eq!(
            from_capability(Some(&json!({ "uwuInternalOnly": true }))),
            None,
            "no domains: unknown, not blocked"
        );
        assert_eq!(from_capability(Some(&json!({ "uwuInternalOnly": true, "uwuInternalDomains": [] }))), None);
        assert_eq!(from_capability(Some(&json!({ "uwuInternalOnly": true, "uwuInternalDomains": ["", "x@y"] }))), None);
    }

    #[test]
    fn finds_the_domain_of_an_address() {
        assert_eq!(domain_of("mini@Example.COM").as_deref(), Some("example.com"));
        assert_eq!(domain_of("mini+news@a.test").as_deref(), Some("a.test"));
        assert_eq!(domain_of("Mini <mini@a.test.>").as_deref(), Some("a.test"));
        assert_eq!(domain_of("\"at@home\"@b.example").as_deref(), Some("b.example"));
        assert_eq!(domain_of("nobody"), None);
        assert_eq!(domain_of("@a.test"), None);
        assert_eq!(domain_of("mini@"), None);
    }

    #[test]
    fn refuses_only_outside_recipients() {
        let domains = vec!["a.test".to_string(), "example.org".to_string()];
        let outside =
            external(["mini@A.test", "x@example.com", "y@sub.a.test", "X@example.com", "z+tag@example.org"], &domains);
        assert_eq!(outside, ["x@example.com", "y@sub.a.test"], "subdomains aren't hosted; each address once");
        assert!(check(None, ["x@example.com"]).is_ok(), "no restriction");
        assert!(check(Some(&domains), ["mini@a.test"]).is_ok());
        let error = check(Some(&domains), ["mini@a.test", "x@example.com"]).unwrap_err();
        assert_eq!(error.code, ErrorCode::Forbidden);
        assert!(error.message.contains("x@example.com"));
        assert!(check(Some(&[]), ["mini@a.test"]).is_ok(), "empty list: unknown, nothing blocked");
    }

    #[test]
    fn compares_idn_domains_in_ascii() {
        let hosted = from_capability(Some(&json!({
            "uwuInternalOnly": true, "uwuInternalDomains": ["xn--bcher-kva.example"]
        })))
        .unwrap();
        assert!(check(Some(&hosted), ["kim@bücher.example"]).is_ok(), "Unicode form of a hosted domain");
        assert!(check(Some(&hosted), ["kim@BÜCHER.example"]).is_ok());
        assert!(check(Some(&hosted), ["kim@xn--bcher-kva.example"]).is_ok());
        let unicode = from_capability(Some(&json!({
            "uwuInternalOnly": true, "uwuInternalDomains": ["bücher.example"]
        })))
        .unwrap();
        assert!(check(Some(&unicode), ["kim@xn--bcher-kva.example"]).is_ok());
        assert!(check(Some(&hosted), ["kim@bucher.example"]).is_err());
        assert!(check(Some(&hosted), ["kim@xn--bcher-kva.example/x"]).is_err(), "no stripping of a path");
        assert!(check(Some(&hosted), ["kim@xn--bcher-kva.example:25"]).is_err(), "no stripping of a port");
    }
}
