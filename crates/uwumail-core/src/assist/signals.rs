//! What is known about a mail besides its text, for the spam check of a mailbox without a server
//! assistant: SPF, DKIM and DMARC from the receiving server's `Authentication-Results`, its spam
//! filter's `X-Spam-Status`, whether the mail is in Junk, and this device's history with the sender.

use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticationSignals {
    pub spf: Option<String>,
    pub dkim: Option<String>,
    pub dmarc: Option<String>,
    pub from_domain: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderSignals {
    pub address: String,
    pub earlier_messages: u64,
    pub earlier_in_junk: u64,
    pub written_to: u64,
    pub in_contacts: bool,
    /// When the first mail from it came (UTC), `None` when this is the first.
    pub first_seen: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpamSignals {
    pub authentication: AuthenticationSignals,
    pub spam_score: Option<f64>,
    pub spam_threshold: Option<f64>,
    pub tests: Vec<String>,
    pub in_junk: bool,
    pub sender: SenderSignals,
}

/// SPF, DKIM and DMARC from the receiving server's `Authentication-Results`. Header fields are
/// read top first; only one above the second `Received:` counts (the receiving server writes its
/// own there), so a sender can't vouch for itself with one lower down. The headers are only as
/// trustworthy as that server.
pub fn authentication(headers: &[(String, String)], from_email: &str) -> AuthenticationSignals {
    let from_domain = from_email
        .rsplit_once('@')
        .map(|(_, domain)| domain.trim().trim_end_matches('>').to_ascii_lowercase())
        .filter(|domain| !domain.is_empty());
    let mut signals = AuthenticationSignals { from_domain, ..AuthenticationSignals::default() };
    let Some(value) = receiving_results(headers) else { return signals };
    let mut dkim: Vec<String> = Vec::new();
    for part in value.split(';').skip(1) {
        let Some(first) = part.split_whitespace().next() else { continue };
        let Some((method, result)) = first.split_once('=') else { continue };
        let result: String =
            result.chars().filter(|c| c.is_ascii_alphanumeric()).take(20).collect::<String>().to_ascii_lowercase();
        if result.is_empty() {
            continue;
        }
        match method.to_ascii_lowercase().as_str() {
            "spf" if signals.spf.is_none() => signals.spf = Some(result),
            "dmarc" if signals.dmarc.is_none() => signals.dmarc = Some(result),
            "dkim" => dkim.push(result),
            _ => {}
        }
    }
    signals.dkim = if dkim.iter().any(|r| r == "pass") { Some("pass".into()) } else { dkim.into_iter().next() };
    signals
}

/// The receiving server's own `Authentication-Results`: read top first, only one above the second
/// `Received:` counts, so a sender can't vouch for itself with one lower down.
fn receiving_results(headers: &[(String, String)]) -> Option<&str> {
    let mut received = 0;
    for (name, value) in headers {
        if name.eq_ignore_ascii_case("Received") {
            received += 1;
            if received >= 2 {
                return None;
            }
        } else if name.eq_ignore_ascii_case("Authentication-Results") {
            return Some(value);
        }
    }
    None
}

/// Whether the receiving server's `Authentication-Results` vouch for the domain of the From
/// address: DMARC passed for it, or DKIM or SPF passed for a domain aligned with it (the same
/// domain or one within the same registrable domain). Labels without a model only give learned
/// senders' labels to such mail (`from_trusted` in docs/labels.md of UwUMail Server), since anyone
/// can write a known address into `From`. No results, or none that vouch: `false`.
pub fn from_vouched(headers: &[(String, String)], from_email: &str) -> bool {
    let Some(from_domain) = from_email.rsplit_once('@').and_then(|(_, domain)| domain_of(domain)) else {
        return false;
    };
    let Some(value) = receiving_results(headers) else { return false };
    for part in value.split(';').skip(1) {
        let mut tokens = part.split_whitespace().filter(|token| !token.starts_with('('));
        let Some((method, result)) = tokens.next().and_then(|first| first.split_once('=')) else { continue };
        if !result.eq_ignore_ascii_case("pass") {
            continue;
        }
        let property = |names: &[&str]| {
            part.split_whitespace().find_map(|token| {
                let (name, value) = token.split_once('=')?;
                names.iter().any(|n| n.eq_ignore_ascii_case(name)).then(|| value.trim_matches(|c| c == '"' || c == ';'))
            })
        };
        let vouched = match method.to_ascii_lowercase().as_str() {
            // DMARC is about the From domain itself; when the server names it, it must be this one.
            "dmarc" => property(&["header.from"]).is_none_or(|domain| aligned(domain, &from_domain)),
            "dkim" => property(&["header.d", "header.i"]).is_some_and(|domain| aligned(domain, &from_domain)),
            "spf" => property(&["smtp.mailfrom", "smtp.helo"]).is_some_and(|domain| aligned(domain, &from_domain)),
            _ => false,
        };
        if vouched {
            return true;
        }
    }
    false
}

/// The lower-case domain of an address, or the name itself when it has no `@`.
fn domain_of(address: &str) -> Option<String> {
    let domain = address.rsplit_once('@').map_or(address, |(_, domain)| domain);
    let domain = domain.trim().trim_end_matches('>').trim_end_matches('.').to_ascii_lowercase();
    (!domain.is_empty() && domain.len() <= 253).then_some(domain)
}

/// Relaxed alignment (RFC 7489): both have the same registrable domain.
fn aligned(vouched: &str, from_domain: &str) -> bool {
    let Some(vouched) = domain_of(vouched) else { return false };
    if vouched == from_domain {
        return true;
    }
    match (psl::domain_str(&vouched), psl::domain_str(from_domain)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// The receiving server's spam filter: `X-Spam-Status: Yes, score=6.0 required=5.0 tests=A,B`.
pub fn spam_status(headers: &[(String, String)]) -> (Option<f64>, Option<f64>, Vec<String>) {
    let Some((_, value)) = headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("X-Spam-Status")) else {
        return (None, None, Vec::new());
    };
    let (mut score, mut required, mut tests) = (None, None, Vec::new());
    for token in value.split([' ', ',', '\t']).filter(|t| !t.is_empty()) {
        if let Some(value) = token.strip_prefix("score=") {
            score = value.parse::<f64>().ok().filter(|v| v.is_finite());
        } else if let Some(value) = token.strip_prefix("required=") {
            required = value.parse::<f64>().ok().filter(|v| v.is_finite());
        } else if let Some(value) = token.strip_prefix("tests=") {
            if !value.eq_ignore_ascii_case("none") {
                tests.push(value.to_owned());
            }
        } else if !tests.is_empty() && !token.contains('=') {
            tests.push(token.to_owned());
        }
    }
    tests.retain(|test| test.len() <= 60 && test.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    tests.truncate(30);
    (score, required, tests)
}

/// The signals as facts for the prompt.
pub fn findings(signals: &SpamSignals) -> String {
    let auth = &signals.authentication;
    let or_none = |value: &Option<String>| value.clone().unwrap_or_else(|| "not checked".into());
    let mut out = format!(
        "- SPF: {}\n- DKIM: {}\n- DMARC: {}\n- Domain of the From address: {}\n",
        or_none(&auth.spf),
        or_none(&auth.dkim),
        or_none(&auth.dmarc),
        auth.from_domain.clone().unwrap_or_else(|| "none".into())
    );
    match (signals.spam_score, signals.spam_threshold) {
        (Some(score), Some(threshold)) => {
            out.push_str(&format!("- Spam filter: {score:.1} points, Junk from {threshold:.1}\n"));
        }
        (Some(score), None) => out.push_str(&format!("- Spam filter: {score:.1} points\n")),
        _ => out.push_str("- Spam filter: did not look at this mail\n"),
    }
    if !signals.tests.is_empty() {
        out.push_str(&format!("- Spam filter rules that counted: {}\n", signals.tests.join(", ")));
    }
    out.push_str(&format!("- In the Junk folder now: {}\n", if signals.in_junk { "yes" } else { "no" }));
    let sender = &signals.sender;
    out.push_str(&format!(
        "- Earlier mails from this address: {} ({} of them in Junk); mails the reader sent to it: {}; in the reader's \
address book: {}",
        sender.earlier_messages,
        sender.earlier_in_junk,
        sender.written_to,
        if sender.in_contacts { "yes" } else { "no" }
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(name: &str, value: &str) -> (String, String) {
        (name.to_owned(), value.to_owned())
    }

    #[test]
    fn only_the_receiving_servers_results_count() {
        let headers = vec![
            header("Received", "from mx.example.net by imap.example.org"),
            header(
                "Authentication-Results",
                "mx.example.org; spf=fail smtp.mailfrom=x@bank.example; dkim=none; dkim=pass header.d=bank.example; dmarc=fail header.from=bank.example",
            ),
            header("Received", "from evil.example by mx.example.net"),
            header("Authentication-Results", "evil.example; spf=pass; dmarc=pass"),
            header("X-Spam-Status", "Yes, score=6.0 required=5.0 tests=SPF_FAIL,SPAMHAUS_ZEN"),
        ];
        let auth = authentication(&headers, "service@Bank.example");
        assert_eq!(auth.spf.as_deref(), Some("fail"));
        assert_eq!(auth.dkim.as_deref(), Some("pass"));
        assert_eq!(auth.dmarc.as_deref(), Some("fail"));
        assert_eq!(auth.from_domain.as_deref(), Some("bank.example"));
        // The sender's own claim below the second Received line counts for nothing.
        let forged = [headers[0].clone(), headers[2].clone(), headers[3].clone()];
        assert_eq!(authentication(&forged, "x@bank.example").spf, None);
        assert_eq!(spam_status(&headers), (Some(6.0), Some(5.0), vec!["SPF_FAIL".into(), "SPAMHAUS_ZEN".into()]));
        let none = [header("X-Spam-Status", "No, score=0.0 required=5.0 tests=none")];
        assert_eq!(spam_status(&none), (Some(0.0), Some(5.0), vec![]));
        assert_eq!(spam_status(&[header("X-Spam-Status", "Yes, tests=<script>")]), (None, None, vec![]));
    }

    #[test]
    fn only_aligned_passes_of_the_receiving_server_vouch_for_the_from_address() {
        let results =
            |value: &str| vec![header("Received", "from mx.example.net"), header("Authentication-Results", value)];
        let vouched = |value: &str, from: &str| from_vouched(&results(value), from);
        assert!(vouched("mx.example.org; dmarc=pass header.from=bank.example", "a@bank.example"));
        assert!(vouched("mx.example.org; dmarc=pass", "a@bank.example"));
        assert!(vouched("mx.example.org; dkim=pass header.d=mail.bank.example", "a@bank.example"));
        assert!(vouched("mx.example.org; dkim=pass (good) header.i=@bank.example", "a@Bank.Example"));
        assert!(vouched("mx.example.org; spf=pass smtp.mailfrom=bounce@news.bank.example", "a@bank.example"));
        // Passing for someone else's domain says nothing about the From address.
        assert!(!vouched("mx.example.org; dkim=pass header.d=mailer.example", "a@bank.example"));
        assert!(!vouched("mx.example.org; spf=pass smtp.mailfrom=x@mailer.example", "a@bank.example"));
        assert!(!vouched("mx.example.org; dmarc=pass header.from=mailer.example", "a@bank.example"));
        assert!(!vouched("mx.example.org; dmarc=fail header.from=bank.example; spf=softfail", "a@bank.example"));
        assert!(!vouched("mx.example.org; dkim=pass", "a@bank.example"));
        assert!(!from_vouched(&[], "a@bank.example"));
        assert!(!vouched("mx.example.org; dmarc=pass", ""));
        // A sender's own results below the second Received line count for nothing.
        let forged = [
            header("Received", "from mx.example.net"),
            header("Received", "from evil.example"),
            header("Authentication-Results", "evil.example; dmarc=pass header.from=bank.example"),
        ];
        assert!(!from_vouched(&forged, "a@bank.example"));
    }

    #[test]
    fn findings_are_plain_facts() {
        let signals = SpamSignals {
            sender: SenderSignals { address: "a@example.com".into(), earlier_messages: 3, ..Default::default() },
            ..Default::default()
        };
        let text = findings(&signals);
        assert!(text.contains("- SPF: not checked"));
        assert!(text.contains("Earlier mails from this address: 3 (0 of them in Junk)"));
    }
}
