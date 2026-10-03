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
    pub address: Option<String>,
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
    /// `None` for a mail whose history nobody knows (the shape is the server's); always set here.
    pub sender: Option<SenderSignals>,
}

/// SPF, DKIM and DMARC from the receiving server's `Authentication-Results` (see
/// [`receiving_results`] for which one counts). The headers are only as trustworthy as that server.
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

/// Where the receiving server's own header fields end: the first `Received:` (top first) that
/// records the mail coming in from another host, and the host that wrote it (its `by` part).
/// Everything above that line the receiving server wrote; everything below it came with the mail,
/// so the sender may have written it. Hops inside the server (see [`local_hop`]) don't end it.
/// With only such hops, the first `Received:` ends it and no host is named. No `Received:` at all:
/// nothing is the server's.
fn intake(headers: &[(String, String)]) -> Option<(usize, Option<String>)> {
    let mut first = None;
    for (index, (name, value)) in headers.iter().enumerate() {
        if !name.eq_ignore_ascii_case("Received") {
            continue;
        }
        first.get_or_insert(index);
        if !local_hop(value) {
            return Some((index, by_host(value)));
        }
    }
    first.map(|index| (index, None))
}

/// A `Received:` of a hop inside the receiving server, judged only by what that server writes
/// itself: the IP addresses in brackets of the `from` part, which must all be loopback, private or
/// link-local; or no `from` part at all (Gmail's internal `by …` hops). The name after `from` is
/// the HELO the connecting side chose, so "from localhost" proves nothing (C2-1).
fn local_hop(value: &str) -> bool {
    let lower = value.trim_start().to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("from") else { return true };
    // The from part without the HELO itself (it may be an address literal the sender chose), up to
    // where the receiving server names itself.
    let clause = rest.split_whitespace().skip(1).take_while(|token| *token != "by").collect::<Vec<_>>().join(" ");
    let mut literals = clause
        .split('[')
        .skip(1)
        .filter_map(|part| part.split(']').next())
        .map(|literal| literal.trim().trim_start_matches("ipv6:"))
        .peekable();
    if literals.peek().is_none() {
        return false;
    }
    literals.all(|literal| match literal.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(std::net::IpAddr::V6(ip)) => {
            ip.is_loopback()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
                || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback() || v4.is_private())
        }
        Err(_) => false,
    })
}

/// The host a `Received:` names after `by`.
fn by_host(value: &str) -> Option<String> {
    let mut tokens = value.split_whitespace();
    while let Some(token) = tokens.next() {
        if token.eq_ignore_ascii_case("by") {
            return tokens.next().and_then(|host| domain_of(host.trim_end_matches(';')));
        }
    }
    None
}

/// Receivers known to write their `Authentication-Results` right below their intake line, by
/// registrable domain. Anywhere else, one there may be the sender's (C2-2).
const RESULTS_BELOW_INTAKE: &[&str] = &["google.com", "googlemail.com"];

/// The receiving server's own `Authentication-Results`, read top first: one above its intake line
/// (see [`intake`]), or, for the hosts of [`RESULTS_BELOW_INTAKE`], one right below it (before the
/// next `Received:`) whose authserv-id belongs to the host that wrote the intake line. One the
/// sender wrote counts for nothing, so a sender can't vouch for itself on a server that adds none.
fn receiving_results(headers: &[(String, String)]) -> Option<&str> {
    let (boundary, host) = intake(headers)?;
    let is_results = |name: &str| name.eq_ignore_ascii_case("Authentication-Results");
    if let Some((_, value)) = headers[..boundary].iter().find(|(name, _)| is_results(name)) {
        return Some(value);
    }
    let host = host?;
    if !psl::domain_str(&host).is_some_and(|domain| RESULTS_BELOW_INTAKE.contains(&domain)) {
        return None;
    }
    for (name, value) in &headers[boundary + 1..] {
        if name.eq_ignore_ascii_case("Received") {
            return None;
        }
        if is_results(name) {
            let authserv_id = value.split(';').next().and_then(|id| id.split_whitespace().next()).unwrap_or_default();
            return aligned(authserv_id, &host).then_some(value.as_str());
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

/// The header fields of the spam check the receiving server wrote, top first: its
/// `Authentication-Results` (see [`receiving_results`]) and its `X-Spam-Status` (see
/// [`spam_status`]). What goes to a UwUMail server checking a mail of another account.
pub fn receiving_headers(headers: &[(String, String)]) -> Vec<(String, String)> {
    let results = receiving_results(headers);
    let ours = intake(headers).map_or(0, |(boundary, _)| boundary);
    headers
        .iter()
        .enumerate()
        .filter(|(index, (name, value))| {
            (name.eq_ignore_ascii_case("X-Spam-Status") && *index < ours)
                || results.is_some_and(|wanted| std::ptr::eq(wanted, value.as_str()))
        })
        .map(|(_, header)| header.clone())
        .collect()
}

/// The receiving server's spam filter: `X-Spam-Status: Yes, score=6.0 required=5.0 tests=A,B`.
/// Only one above the server's intake line counts (see [`intake`]): Gmail, Outlook and many other
/// hosts write none of their own, and the one a sender writes would vouch for its own mail.
pub fn spam_status(headers: &[(String, String)]) -> (Option<f64>, Option<f64>, Vec<String>) {
    let ours = intake(headers).map_or(&headers[..0], |(boundary, _)| &headers[..boundary]);
    let Some((_, value)) = ours.iter().find(|(name, _)| name.eq_ignore_ascii_case("X-Spam-Status")) else {
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

/// What the rules of UwUMail Server's spam filter mean, for the model. Rules of other filters stay
/// bare. The same list as in UwUMail Server's `features.rs`.
const RULE_MEANINGS: &[(&str, &str)] = &[
    ("BAYES_HAM", "the filter learned from mail marked as wanted or junk, and its words look like wanted mail"),
    ("BAYES_SPAM", "the filter learned from mail marked as wanted or junk, and its words look like junk"),
    ("KNOWN_GOOD_SENDER", "this sender's domain or network delivered mail here before, hardly any of it junk"),
    ("KNOWN_JUNK_SENDER", "much of this sender's earlier mail here was junk"),
    ("SPF_FAIL", "the sending server is not allowed to send for the envelope domain"),
    ("DKIM_FAIL", "a signature of the mail is broken"),
    ("DMARC_FAIL", "the From domain is not backed by SPF or DKIM: it may be forged"),
    ("NO_AUTH", "neither SPF nor DKIM vouched for the sender"),
    ("NO_REVERSE_DNS", "the sending server's address has no name"),
    ("GENERIC_REVERSE_DNS", "the sending server's name looks like a home connection"),
    ("HELO_NOT_A_NAME", "the sending server greeted with something that is not its name"),
    ("SPAMHAUS_ZEN", "the sending server is on a blocklist"),
    ("SPAMCOP", "the sending server is on a blocklist"),
    ("BARRACUDA", "the sending server is on a blocklist"),
    ("SPAMHAUS_DBL", "a domain in the mail is on a blocklist"),
    ("SPAMHAUS_DBL_ABUSED", "a domain in the mail is on a blocklist for abused domains"),
    ("SPAMHAUS_DBL_MALICIOUS", "a domain in the mail is on a blocklist for malware or phishing"),
    ("BAD_WORDS", "words typical of spam"),
    ("MALWARE_LINK", "a link leads to known malware or phishing"),
    ("MALWARE_ATTACHMENT", "an attachment is known malware"),
    ("DISPOSABLE_FROM", "the From address is a throwaway address"),
    ("FREEMAIL_REPLYTO", "answers go to a free mail address other than the sender"),
    ("LINK_SHORTENER", "a link goes through a link shortener"),
    ("PHISHING_LINK_TEXT", "a link shows one address and leads to another"),
    ("LINK_TO_IP", "a link leads to a bare IP address"),
    ("LOOKALIKE_LINK", "a link leads to a domain that imitates a known one"),
    ("FROM_NAME_SPOOFS_ADDRESS", "the sender's name shows an address other than the real one"),
    ("LOOKALIKE_BRAND_FROM", "the sender's domain is spelled to look like a known brand's"),
    ("BRAND_IN_FROM_DOMAIN", "the sender's domain carries a known brand's name but is not the brand's"),
    ("LOOKALIKE_CONTACT_FROM", "the sender's domain looks like the domain of one of the reader's contacts"),
    ("BRAND_IN_FROM_NAME", "the sender's name claims a known brand, the address is not the brand's"),
    ("REPLY_TO_OTHER_SITE", "answers go to another domain than the sender's"),
    ("LOOKALIKE_BRAND_LINK", "a link leads to a domain spelled to look like a known brand's"),
    ("BRAND_LINK_TEXT", "a link shows a known brand's or contact's address and leads somewhere else"),
    ("BRAND_IN_SUBJECT", "the subject names a known brand and asks to log in or confirm data, from another domain"),
    ("CREDENTIAL_REQUEST", "the mail asks to log in or confirm data, with links to another domain than the sender's"),
    ("HIDDEN_TEXT", "the mail hides text from the reader"),
    ("HTML_ONLY", "the mail has no plain text part"),
    ("BASE64_TEXT", "the text is encoded in an unusual way"),
    ("MISSING_DATE", "the mail has no date"),
    ("DATE_IN_FUTURE", "the mail is dated in the future"),
    ("DATE_IN_PAST", "the mail is dated long ago"),
    ("MISSING_MESSAGE_ID", "the mail has no Message-ID"),
    ("SUBJECT_ALL_CAPS", "the subject is in capitals"),
    ("EXECUTABLE_ATTACHMENT", "an attachment is a program"),
    ("MACRO_ATTACHMENT", "an attachment is a document with macros"),
    ("HTML_ATTACHMENT", "an attachment is a web page"),
    ("DISGUISED_ATTACHMENT", "an attachment's name hides its real type"),
    ("ARCHIVE_WITH_PROGRAM", "an archive attached holds a program"),
    ("FETCHED", "the mail was fetched from another mailbox"),
    ("PROVIDER_JUNK", "the other mail provider had put it in Junk"),
    ("PROVIDER_SPAM_FLAG", "the other mail provider marked it as spam"),
    ("NOT_ADDRESSED", "the mailbox it was fetched from is not among the recipients"),
    ("PROVIDER_SPF_FAIL", "the other mail provider's SPF check failed"),
    ("PROVIDER_DKIM_FAIL", "the other mail provider's DKIM check failed"),
    ("PROVIDER_DMARC_FAIL", "the other mail provider's DMARC check failed"),
    ("FETCHED_NO_AUTH", "nothing vouches for the sender of this fetched mail"),
];

/// What a rule of the receiving server's spam filter or of the phishing checks means, for the model.
pub fn rule_meaning(rule: &str) -> Option<&'static str> {
    RULE_MEANINGS.iter().find(|(known, _)| *known == rule).map(|(_, meaning)| *meaning)
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
            header("X-Spam-Status", "Yes, score=6.0 required=5.0 tests=SPF_FAIL,SPAMHAUS_ZEN"),
            header(
                "Authentication-Results",
                "mx.example.org; spf=fail smtp.mailfrom=x@bank.example; dkim=none; dkim=pass header.d=bank.example; dmarc=fail header.from=bank.example",
            ),
            header("Received", "from mx.example.net by imap.example.org"),
            header("Received", "from evil.example by mx.example.net"),
            header("Authentication-Results", "evil.example; spf=pass; dmarc=pass"),
            header("X-Spam-Status", "No, score=-50.0 required=5.0 tests=BAYES_HAM"),
        ];
        let auth = authentication(&headers, "service@Bank.example");
        assert_eq!(auth.spf.as_deref(), Some("fail"));
        assert_eq!(auth.dkim.as_deref(), Some("pass"));
        assert_eq!(auth.dmarc.as_deref(), Some("fail"));
        assert_eq!(auth.from_domain.as_deref(), Some("bank.example"));
        // The sender's own claim below the second Received line counts for nothing.
        let forged = [headers[2].clone(), headers[3].clone(), headers[4].clone()];
        assert_eq!(authentication(&forged, "x@bank.example").spf, None);
        assert_eq!(spam_status(&headers), (Some(6.0), Some(5.0), vec!["SPF_FAIL".into(), "SPAMHAUS_ZEN".into()]));
        let received = header("Received", "from mx.example.net by imap.example.org");
        let none = [header("X-Spam-Status", "No, score=0.0 required=5.0 tests=none"), received.clone()];
        assert_eq!(spam_status(&none), (Some(0.0), Some(5.0), vec![]));
        let script = [header("X-Spam-Status", "Yes, tests=<script>"), received];
        assert_eq!(spam_status(&script), (None, None, vec![]));
        // With no Received line at all, nothing is the receiving server's.
        assert_eq!(spam_status(&[header("X-Spam-Status", "Yes, score=6.0")]), (None, None, vec![]));
    }

    /// A Gmail-shaped mail (Gmail writes no X-Spam-Status) whose sender wrote its own good-looking
    /// headers: they count for nothing, and Gmail's own results, right below its intake line, do.
    #[test]
    fn a_senders_own_headers_cannot_vouch_for_its_mail() {
        let gmail_intake = header(
            "Received",
            "from mail.scam.example (mail.scam.example. [192.0.2.7]) by mx.google.com with ESMTPS id x; Fri, 2 Oct 2026",
        );
        let forged = [
            header("Received", "by 2002:a05:6000:1::1 with SMTP id y; Fri, 2 Oct 2026"),
            gmail_intake.clone(),
            header("X-Spam-Status", "No, score=-50.0 required=5.0 tests=BAYES_HAM,KNOWN_GOOD_SENDER"),
            header("Authentication-Results", "mx.example.org; spf=pass; dkim=pass header.d=bank.example; dmarc=pass"),
            header("From", "Bank <service@bank.example>"),
        ];
        assert_eq!(spam_status(&forged), (None, None, vec![]));
        assert_eq!(authentication(&forged, "service@bank.example").dmarc, None);
        assert!(!from_vouched(&forged, "service@bank.example"));
        // The same trick on a server that adds nothing of its own, with only its intake line.
        assert_eq!(authentication(&forged[1..], "service@bank.example").dmarc, None);

        // Gmail's own results right below its intake line count.
        let real = [
            header("Received", "by 2002:a05:6000:1::1 with SMTP id y; Fri, 2 Oct 2026"),
            gmail_intake,
            header("Authentication-Results", "mx.google.com; spf=fail smtp.mailfrom=scam.example; dmarc=fail"),
            header("Authentication-Results", "mx.google.com; dmarc=pass"),
        ];
        assert_eq!(authentication(&real, "service@bank.example").dmarc.as_deref(), Some("fail"));

        // A spam filter stamping through a local hop (amavis) is the server's.
        let amavis = [
            header("Received", "from localhost (localhost [127.0.0.1]) by mail.example.org"),
            header("X-Spam-Status", "Yes, score=7.1 required=5.0 tests=BAYES_SPAM"),
            header("Received", "from mail.scam.example by mail.example.org"),
            header("X-Spam-Status", "No, score=-50.0 required=5.0"),
        ];
        assert_eq!(spam_status(&amavis).0, Some(7.1));
    }

    /// C2-1: "from localhost" is only the HELO the sender chose; the receiving server's bracketed
    /// address shows where the mail really came from.
    #[test]
    fn a_helo_of_localhost_does_not_make_a_hop_internal() {
        let headers = [
            header("Received", "from localhost (unknown [192.0.2.7]) by mx.example.org with ESMTP id z"),
            header("X-Spam-Status", "No, score=-50.0 required=5.0 tests=BAYES_HAM"),
            header("Authentication-Results", "mx.example.org; spf=pass; dkim=pass header.d=bank.example; dmarc=pass"),
            header("Received", "from mail.bank.example (mail.bank.example [198.51.100.1]) by relay.bank.example"),
        ];
        assert_eq!(spam_status(&headers), (None, None, vec![]));
        assert_eq!(authentication(&headers, "service@bank.example").dmarc, None);
        assert!(!from_vouched(&headers, "service@bank.example"));
        assert!(receiving_headers(&headers).is_empty());

        assert!(local_hop("from localhost (localhost [127.0.0.1]) by mail.example.org"));
        assert!(local_hop("from mx1.example.org (mx1.example.org [10.0.0.5]) by store.example.org"));
        assert!(local_hop("from x (x [IPv6:::1]) by y"));
        assert!(local_hop("from x (x [fe80::1]) by y"));
        assert!(local_hop("by 2002:a05:6000:1::1 with SMTP id y"));
        assert!(!local_hop("from localhost (unknown [192.0.2.7]) by mx.example.org"));
        assert!(!local_hop("from localhost by mx.example.org"));
        assert!(!local_hop("from [127.0.0.1] by mx.example.org"));
        assert!(local_hop("from localhost\r\n\t(localhost [127.0.0.1])\r\n\tby mail.example.org"));
        assert!(!local_hop("from x ([127.0.0.1] [203.0.113.9]) by y"));
        assert!(!local_hop("from [127.0.0.1] (unknown [2001:db8::7]) by y"));
        // A bracket in the server's own part after "by" doesn't count for the from part.
        assert!(!local_hop("from evil.example (evil.example [192.0.2.7]) by mx [127.0.0.1]"));
    }

    /// C2-2: right below the intake line only the hosts known to put theirs there count.
    #[test]
    fn results_below_the_intake_line_count_only_for_known_hosts() {
        let below = |by: &str, authserv: &str| {
            [
                header("Received", &format!("from mail.scam.example (mail.scam.example [192.0.2.7]) by {by}")),
                header("Authentication-Results", &format!("{authserv}; dmarc=pass")),
            ]
        };
        assert_eq!(authentication(&below("mx.example.org", "mx.example.org"), "a@bank.example").dmarc, None);
        assert_eq!(
            authentication(&below("mx.google.com", "mx.google.com"), "a@bank.example").dmarc.as_deref(),
            Some("pass")
        );
        assert_eq!(authentication(&below("mx.google.com", "mx.example.org"), "a@bank.example").dmarc, None);
    }

    #[test]
    fn only_aligned_passes_of_the_receiving_server_vouch_for_the_from_address() {
        let results = |value: &str| {
            vec![header("Authentication-Results", value), header("Received", "from mx.example.net by mx.example.org")]
        };
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
            header("Received", "from mx.example.net by mx.example.org"),
            header("Received", "from evil.example by mx.example.net"),
            header("Authentication-Results", "evil.example; dmarc=pass header.from=bank.example"),
        ];
        assert!(!from_vouched(&forged, "a@bank.example"));
    }

    /// The invoice of a user report: authentic, wanted by the filter, from a sender who wrote before.
    fn invoice_signals() -> SpamSignals {
        SpamSignals {
            authentication: AuthenticationSignals {
                spf: Some("pass".into()),
                dkim: Some("pass".into()),
                dmarc: Some("pass".into()),
                from_domain: Some("billing.example".into()),
            },
            spam_score: Some(-5.5),
            spam_threshold: Some(5.0),
            tests: vec!["BAYES_HAM".into(), "KNOWN_GOOD_SENDER".into(), "SOME_OTHER_RULE".into()],
            in_junk: false,
            sender: Some(SenderSignals {
                address: Some("invoice@billing.example".into()),
                earlier_messages: 4,
                ..SenderSignals::default()
            }),
        }
    }

    #[test]
    fn facts_explain_themselves() {
        let signals = invoice_signals();
        let facts = crate::assist::spam::facts(&signals, &crate::assist::spam::assess(&signals, &[], ""), rule_meaning);
        let text = facts.iter().map(|fact| format!("{}: {}", fact.id, fact.text)).collect::<Vec<_>>().join("\n");
        assert!(text.contains("DMARC passed for billing.example"), "{text}");
        assert!(text.contains("-5.5 points, Junk from 5.0; this mail is under the limit"), "{text}");
        assert!(text.contains("Spam filter rule BAYES_HAM: the filter learned"), "{text}");
        assert!(text.contains("Spam filter rule KNOWN_GOOD_SENDER: this sender's"), "{text}");
        assert!(text.contains("Spam filter rule SOME_OTHER_RULE\n"), "{text}");
        assert!(text.starts_with("F1: SPF: pass"), "{text}");
    }

    #[test]
    fn a_known_authenticated_invoice_stays_legitimate_whatever_the_model_says() {
        let signals = invoice_signals();
        let assessment = crate::assist::spam::assess(&signals, &[], "Ihre Rechnung");
        assert_eq!(assessment.allowed, ["legitimate"]);
        let (verdict, confidence, moved) = crate::assist::spam::settle(&assessment, "spam", 0.9);
        assert_eq!((verdict.as_str(), moved.as_deref()), ("legitimate", Some("spam")));
        assert!(confidence <= 0.6);
    }
}
