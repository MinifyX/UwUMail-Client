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
    if auth.dmarc.as_deref() == Some("pass") {
        let domain = auth.from_domain.as_deref().unwrap_or("the From address");
        out.push_str(&format!(
            "- DMARC passed for {domain}: the mail really comes from the domain in its From address.\n"
        ));
    }
    let meaning = "fewer points mean more likely wanted mail; 0 or less means the filter rates it as wanted mail";
    match (signals.spam_score, signals.spam_threshold) {
        (Some(score), Some(threshold)) => out.push_str(&format!(
            "- Spam filter: {score:.1} points, Junk from {threshold:.1} ({meaning}); {}\n",
            if score >= threshold { "this mail is over the limit" } else { "this mail is under the limit" }
        )),
        (Some(score), None) => out.push_str(&format!("- Spam filter: {score:.1} points ({meaning})\n")),
        _ => out.push_str("- Spam filter: did not look at this mail\n"),
    }
    if !signals.tests.is_empty() {
        out.push_str("- Spam filter rules that counted:\n");
        for test in &signals.tests {
            match RULE_MEANINGS.iter().find(|(rule, _)| rule == test) {
                Some((_, meaning)) => out.push_str(&format!("  - {test}: {meaning}\n")),
                None => out.push_str(&format!("  - {test}\n")),
            }
        }
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

/// Whether the facts clearly speak for a mail: the reader knows the sender (earlier mail of it on
/// this device, none in Junk; or in the address book; or written to), the From domain is authentic
/// (DMARC passed, or without a DMARC result both DKIM and SPF passed), the receiving server's spam
/// filter rates it as wanted (0 points or less) and it is not in Junk. The same rule as in UwUMail
/// Server.
pub fn clearly_good(signals: &SpamSignals) -> bool {
    let (auth, sender) = (&signals.authentication, &signals.sender);
    let passed = |result: &Option<String>| result.as_deref() == Some("pass");
    let authentic = match auth.dmarc.as_deref() {
        Some("pass") => true,
        None | Some("none") => passed(&auth.dkim) && passed(&auth.spf),
        Some(_) => false,
    };
    let known =
        (sender.earlier_messages >= 1 && sender.earlier_in_junk == 0) || sender.in_contacts || sender.written_to >= 1;
    authentic && known && !signals.in_junk && signals.spam_score.is_some_and(|score| score <= 0.0)
}

/// The model's verdict, held to the facts: "spam" or "phishing" for a mail they clearly speak for
/// becomes "suspicious", at most half sure, since small models sometimes see a scam in an ordinary
/// invoice. The third value is the model's own verdict when it was lowered.
pub fn held_to_facts(verdict: String, confidence: f64, signals: &SpamSignals) -> (String, f64, Option<String>) {
    if matches!(verdict.as_str(), "spam" | "phishing") && clearly_good(signals) {
        ("suspicious".into(), confidence.min(0.5), Some(verdict))
    } else {
        (verdict, confidence, None)
    }
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
            sender: SenderSignals {
                address: "invoice@billing.example".into(),
                earlier_messages: 4,
                ..SenderSignals::default()
            },
        }
    }

    #[test]
    fn verdicts_the_facts_contradict_are_lowered() {
        let good = invoice_signals();
        assert_eq!(held_to_facts("spam".into(), 0.9, &good), ("suspicious".into(), 0.5, Some("spam".into())));
        assert_eq!(held_to_facts("phishing".into(), 0.3, &good), ("suspicious".into(), 0.3, Some("phishing".into())));
        for verdict in ["legitimate", "suspicious"] {
            assert_eq!(held_to_facts(verdict.into(), 0.9, &good), (verdict.into(), 0.9, None));
        }
        // Without a DMARC result, DKIM and SPF together vouch for the domain.
        let mut no_dmarc = good.clone();
        no_dmarc.authentication.dmarc = None;
        assert!(clearly_good(&no_dmarc));
        no_dmarc.authentication.spf = Some("softfail".into());
        assert!(!clearly_good(&no_dmarc));
        // A known sender in the address book or written to counts without earlier mail.
        let mut contact = good.clone();
        contact.sender.earlier_messages = 0;
        assert!(!clearly_good(&contact));
        contact.sender.in_contacts = true;
        assert!(clearly_good(&contact));
        contact.sender.in_contacts = false;
        contact.sender.written_to = 1;
        assert!(clearly_good(&contact));
        // Any one fact against the mail leaves the model's verdict alone.
        let spoiled: [fn(&mut SpamSignals); 6] = [
            |s| s.authentication.dmarc = Some("fail".into()),
            |s| s.spam_score = Some(0.5),
            |s| s.spam_score = None,
            |s| s.in_junk = true,
            |s| s.sender.earlier_in_junk = 1,
            |s| s.authentication = AuthenticationSignals::default(),
        ];
        for spoil in spoiled {
            let mut signals = good.clone();
            spoil(&mut signals);
            assert_eq!(held_to_facts("spam".into(), 0.9, &signals), ("spam".into(), 0.9, None), "{signals:?}");
        }
    }

    #[test]
    fn findings_explain_themselves() {
        let text = findings(&invoice_signals());
        assert!(text.contains("DMARC passed for billing.example"), "{text}");
        assert!(text.contains("-5.5 points, Junk from 5.0 (fewer points mean"), "{text}");
        assert!(text.contains("under the limit"), "{text}");
        assert!(text.contains("  - BAYES_HAM: the filter learned"), "{text}");
        assert!(text.contains("  - KNOWN_GOOD_SENDER: this sender's"), "{text}");
        assert!(text.contains("  - SOME_OTHER_RULE\n"), "{text}");
    }
}
