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
    /// The domains whose DKIM signatures passed (`header.d`, or the domain of `header.i`), to tell
    /// whether a pass belongs to the From domain (R2-M1 of the server, C3-1 here).
    #[serde(skip)]
    pub dkim_pass_domains: Vec<String>,
    /// The envelope sender's domain SPF passed for (`smtp.mailfrom`).
    #[serde(skip)]
    pub spf_pass_domain: Option<String>,
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
/// [`receiving_results`] for which one counts), read the way RFC 8601 reads it
/// ([`auth_results_parts`]), with the domains DKIM and SPF passed for, so that
/// [`super::spam::authentic`] can tell whether a pass belongs to the From domain (C3-1, C3-2; the
/// server's R2-M1). A DMARC result the server names for another From domain is left out. The
/// headers are only as trustworthy as that server.
pub fn authentication(headers: &[(String, String)], from_email: &str) -> AuthenticationSignals {
    let from_domain = from_email
        .rsplit_once('@')
        .map(|(_, domain)| domain.trim().trim_end_matches('>').to_ascii_lowercase())
        .filter(|domain| !domain.is_empty());
    let mut signals = AuthenticationSignals { from_domain, ..AuthenticationSignals::default() };
    let Some(value) = receiving_results(headers) else { return signals };
    // Every part is read, however many DKIM results stand before SPF and DMARC; only what is kept
    // of the DKIM ones is capped (C4-2, the server's R3-L1).
    let (mut first_dkim, mut dkim_passed) = (None, false);
    let mut parts = auth_results_parts(value);
    for part in parts.by_ref().skip(1) {
        let Some((method, result)) = part.first().and_then(|first| first.split_once('=')) else { continue };
        let result: String =
            result.chars().filter(|c| c.is_ascii_alphanumeric()).take(20).collect::<String>().to_ascii_lowercase();
        if result.is_empty() {
            continue;
        }
        let property = |key: &str| {
            part.iter().skip(1).find_map(|token| {
                let (name, value) = token.split_once('=')?;
                name.eq_ignore_ascii_case(key).then_some(value)
            })
        };
        match method.to_ascii_lowercase().as_str() {
            "spf" if signals.spf.is_none() => {
                if result == "pass" {
                    signals.spf_pass_domain = property("smtp.mailfrom").and_then(domain_part);
                }
                signals.spf = Some(result);
            }
            "dmarc" if signals.dmarc.is_none() => {
                let other_from = property("header.from")
                    .and_then(domain_part)
                    .is_some_and(|named| signals.from_domain.as_deref().is_some_and(|from| from != named));
                if !other_from {
                    signals.dmarc = Some(result);
                }
            }
            "dkim" => {
                if result == "pass" {
                    dkim_passed = true;
                    if signals.dkim_pass_domains.len() < MAX_DKIM_PASS_DOMAINS
                        && let Some(domain) =
                            property("header.d").or_else(|| property("header.i")).and_then(domain_part)
                        && !signals.dkim_pass_domains.contains(&domain)
                    {
                        signals.dkim_pass_domains.push(domain);
                    }
                }
                first_dkim.get_or_insert(result);
            }
            _ => {}
        }
    }
    signals.dkim = if dkim_passed { Some("pass".into()) } else { first_dkim };
    // Something was left out for a limit: the DMARC result may be what went. Then only an explicit
    // pass counts, and no DKIM or SPF pass can stand in for a missing DMARC (C5-3).
    if parts.dropped && signals.dmarc.as_deref() != Some("pass") {
        signals.dkim_pass_domains.clear();
        signals.spf_pass_domain = None;
    }
    signals
}

/// The most DKIM signers kept from one `Authentication-Results`.
const MAX_DKIM_PASS_DOMAINS: usize = 16;

/// The domain of an `Authentication-Results` value: `header.d=signer.example`, the part after the
/// last `@` of `smtp.mailfrom=user@envelope.example` or `header.i=@signer.example`.
fn domain_part(value: &str) -> Option<String> {
    let domain = value.rsplit('@').next().unwrap_or(value).trim().trim_end_matches('.').to_ascii_lowercase();
    // A domain with a space of any kind in it is no domain (C5-2, defence in depth).
    (!domain.is_empty() && domain.len() <= 253 && domain.contains('.') && !domain.chars().any(char::is_whitespace))
        .then_some(domain)
}

/// UwUMail Server's `uwumail_smtp::headers` reader of `Authentication-Results` (R3-L1/R3-L2 there,
/// C4-1/C4-2 here), kept the same.
/// The longest word of an `Authentication-Results` value that is kept; a longer one is skipped
/// and reading goes on behind it.
const MAX_AUTH_WORD: usize = 1024;
/// The most words of one `;` part; a part with more is left out as a whole.
const MAX_AUTH_PART_WORDS: usize = 32;

/// The authserv-id of an `Authentication-Results` value: the first word of its first part, read
/// as [`auth_results_parts`] reads it, without a trailing dot.
pub(crate) fn authserv_id(value: &str) -> Option<String> {
    let first = auth_results_parts(value).next()?;
    let id = first.into_iter().next()?;
    let id = id.trim_end_matches('.');
    (!id.is_empty()).then(|| id.to_owned())
}

/// An `Authentication-Results` value as its `;` parts, each as its words, read the way RFC 8601
/// reads it: comments in parentheses (nested too) are left out, and a quoted string is part of a
/// word without its quotes, so a quoted envelope sender (`"a;dmarc=pass"@attacker.example`) can
/// neither end a part nor start a result of its own.
///
/// One pass, part by part, so a value of any length costs time in its length and memory in one
/// part, and every part is read (security review 0.22 R3-L1). What a limit cuts is never kept in
/// part: a word longer than [`MAX_AUTH_WORD`] is left out whole, and a part of more than
/// [`MAX_AUTH_PART_WORDS`] words comes out empty — a cut `header.d=victim.example` of
/// `victim.example.attacker.example` would otherwise read as the victim's (client review C4-1).
/// Callers hand in the whole value, never a cut one. The assistant reads our own results with it,
/// and the strip of forged ones its authserv-id ([`authserv_id`]).
pub(crate) fn auth_results_parts(value: &str) -> AuthResultsParts<'_> {
    AuthResultsParts { chars: value.chars(), done: false, dropped: false }
}

/// See [`auth_results_parts`].
pub(crate) struct AuthResultsParts<'a> {
    chars: std::str::Chars<'a>,
    done: bool,
    /// A word or a part was left out for a limit (this device's addition, C5-3): what was read
    /// may then lack the result that mattered.
    pub(crate) dropped: bool,
}

impl Iterator for AuthResultsParts<'_> {
    type Item = Vec<String>;

    fn next(&mut self) -> Option<Vec<String>> {
        if self.done {
            return None;
        }
        let mut part: Vec<String> = Vec::new();
        let mut overflow = false;
        let mut word = String::new();
        let mut too_long = false;
        let mut quoted = false;
        let mut depth = 0usize;
        let mut lost = false;
        let end_word = |part: &mut Vec<String>, overflow: &mut bool, word: &mut String, too_long: &mut bool| {
            if !word.is_empty() && !*too_long {
                if part.len() < MAX_AUTH_PART_WORDS {
                    part.push(std::mem::take(word));
                } else {
                    *overflow = true;
                }
            }
            word.clear();
            *too_long = false;
        };
        let push = |word: &mut String, too_long: &mut bool, c: char| {
            if *too_long {
                return;
            }
            if word.len() + c.len_utf8() > MAX_AUTH_WORD {
                *too_long = true;
                word.clear();
            } else {
                word.push(c);
            }
        };
        loop {
            let Some(c) = self.chars.next() else {
                self.done = true;
                {
                    lost |= too_long;
                    end_word(&mut part, &mut overflow, &mut word, &mut too_long);
                }
                self.dropped |= lost || overflow;
                return Some(if overflow { Vec::new() } else { part });
            };
            if quoted {
                match c {
                    '\\' => {
                        if let Some(next) = self.chars.next() {
                            push(&mut word, &mut too_long, next);
                        }
                    }
                    '"' => quoted = false,
                    c => push(&mut word, &mut too_long, c),
                }
            } else if depth > 0 {
                match c {
                    '\\' => {
                        self.chars.next();
                    }
                    '(' => depth += 1,
                    ')' => depth -= 1,
                    _ => {}
                }
            } else {
                match c {
                    '"' => quoted = true,
                    '(' => {
                        {
                            lost |= too_long;
                            end_word(&mut part, &mut overflow, &mut word, &mut too_long);
                        }
                        depth = 1;
                    }
                    ';' => {
                        {
                            lost |= too_long;
                            end_word(&mut part, &mut overflow, &mut word, &mut too_long);
                        }
                        self.dropped |= lost || overflow;
                        return Some(if overflow { Vec::new() } else { part });
                    }
                    // Only the whitespace of RFC 8601's CFWS: a DKIM `d=` may carry a no-break or other
                    // Unicode space, and `victim.example<U+00A0>x` must stay one word, never read as
                    // `victim.example` (C5-2, the server's R4 I-2).
                    ' ' | '\t' | '\r' | '\n' => {
                        lost |= too_long;
                        end_word(&mut part, &mut overflow, &mut word, &mut too_long)
                    }
                    c => push(&mut word, &mut too_long, c),
                }
            }
        }
    }
}

/// Whether `domain` (a DKIM signer, an SPF-checked envelope domain) is the From domain, a parent of
/// it or below it: what makes a pass vouch for the From when no DMARC policy judges it. The same as
/// UwUMail Server's `uwumail_smtp::related_domains` (R2-M1).
pub fn related_domains(from_domain: &str, domain: &str) -> bool {
    let from = from_domain.trim().trim_end_matches('.').to_ascii_lowercase();
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    !from.is_empty()
        && domain.contains('.')
        && (from == domain || from.ends_with(&format!(".{domain}")) || domain.ends_with(&format!(".{from}")))
}

/// The longest value of a trace or verdict header (`Received`, `Authentication-Results`,
/// `X-Spam-Status`) that is read at all. A longer one is read as empty, never cut: a cut
/// `header.i=@victim.example.attacker.example` would read as the victim's, with the `dmarc=fail`
/// behind it gone (C4-1). The readers are linear, so this is generous.
pub const MAX_TRACE_VALUE: usize = 16_000;

/// Whether a header is one the trust checks read (see [`MAX_TRACE_VALUE`]).
pub fn is_trace_header(name: &str) -> bool {
    ["Received", "Authentication-Results", "X-Spam-Status"].iter().any(|known| known.eq_ignore_ascii_case(name.trim()))
}

/// A trace header's value whole, or empty when it is longer than [`MAX_TRACE_VALUE`].
pub fn whole_or_empty(value: &str) -> String {
    if value.chars().nth(MAX_TRACE_VALUE).is_some() { String::new() } else { value.to_owned() }
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
/// itself: the IP addresses of the `from` part, which must all be loopback, private or link-local;
/// or no `from` part at all (Gmail's internal `by …` hops).
///
/// What the connecting side chose proves nothing (C2-1, C3-3): the HELO name right after `from`
/// (Postfix, sendmail, Gmail: `from <helo> (<rdns> [<ip>])`) unless that is itself the bracketed
/// address Exim writes there (`from [<ip>] (helo=<helo>)`), and every `helo=`/`ident=` value or
/// word after `HELO` (Exim, qmail). Addresses count in brackets, or alone in parentheses as
/// Microsoft and qmail write them (`(192.0.2.7)`, C3-7).
fn local_hop(value: &str) -> bool {
    let lower = value.trim_start().to_ascii_lowercase();
    // A value too long to be read whole is read as empty (C4-1): nothing shows it internal.
    if lower.is_empty() {
        return false;
    }
    let Some(rest) = lower.strip_prefix("from") else { return true };
    // The from part, up to where the receiving server names itself.
    let tokens: Vec<&str> = rest.split_whitespace().take_while(|token| *token != "by").collect();
    let mut literals: Vec<&str> = Vec::new();
    let mut skip_next = false;
    for (index, token) in tokens.iter().enumerate() {
        if std::mem::take(&mut skip_next) {
            continue;
        }
        let bare = token.trim_start_matches('(');
        if index == 0 && !bare.starts_with('[') {
            continue;
        }
        if bare.starts_with("helo=") || bare.starts_with("ident=") {
            continue;
        }
        // qmail's `(HELO <name>)`: only that shape, a name closing the comment without a bracketed
        // literal, is the HELO; a `[ip]` behind a word "helo" is never one (C4-4).
        if *token == "(helo" && tokens.get(index + 1).is_some_and(|next| next.ends_with(')') && !next.contains('[')) {
            skip_next = true;
            continue;
        }
        if let Some((_, inside)) = token.split_once('[') {
            literals.push(inside.split(']').next().unwrap_or_default());
        } else if token.starts_with('(') && token.ends_with(')') {
            let inside = token.trim_matches(|c| c == '(' || c == ')');
            if inside.parse::<std::net::IpAddr>().is_ok() {
                literals.push(inside);
            }
        }
    }
    !literals.is_empty() && literals.iter().all(|literal| internal_address(literal))
}

/// A loopback, private or link-local address (`IPv6:` prefix allowed).
fn internal_address(literal: &str) -> bool {
    match literal.trim().trim_start_matches("ipv6:").parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(std::net::IpAddr::V6(ip)) => {
            ip.is_loopback()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
                || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback() || v4.is_private())
        }
        Err(_) => false,
    }
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
    // One emptied for its length (see [`whole_or_empty`]) hides no second one of the server (C5-5).
    if let Some((_, value)) = headers[..boundary].iter().find(|(name, value)| is_results(name) && !value.is_empty()) {
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
            let id = authserv_id(value).unwrap_or_default();
            return aligned(&id, &host).then_some(value.as_str());
        }
    }
    None
}

/// Whether the receiving server's `Authentication-Results` vouch for the domain of the From
/// address, as [`super::spam::authentic`] decides it, like UwUMail Server's labels (C3-5): DMARC
/// passed, or without a DMARC policy a DKIM or SPF (`smtp.mailfrom`) pass for the From domain, a
/// parent or a subdomain of it; a DMARC failure never. Labels without a model only give learned
/// senders' labels to such mail (`from_trusted` in docs/labels.md of UwUMail Server), since anyone
/// can write a known address into `From`. No results, or none that vouch: `false`.
pub fn from_vouched(headers: &[(String, String)], from_email: &str) -> bool {
    let auth = authentication(headers, from_email);
    auth.from_domain.is_some() && super::spam::authentic(&auth)
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
        // Exim writes the connecting address first, and leaves the HELO out when it is the same.
        assert!(local_hop("from [127.0.0.1] by mx.example.org"));
        assert!(local_hop("from localhost\r\n\t(localhost [127.0.0.1])\r\n\tby mail.example.org"));
        assert!(!local_hop("from x ([127.0.0.1] [203.0.113.9]) by y"));
        assert!(!local_hop("from [127.0.0.1] (unknown [2001:db8::7]) by y"));
        // A bracket in the server's own part after "by" doesn't count for the from part.
        assert!(!local_hop("from evil.example (evil.example [192.0.2.7]) by mx [127.0.0.1]"));
    }

    /// C3-3: Exim writes the address itself and the HELO as `helo=`; only the address counts.
    #[test]
    fn an_exim_helo_does_not_make_a_hop_internal() {
        let headers = [
            header("Received", "from [192.0.2.7] (helo=[127.0.0.1])\r\n\tby mx.example.org with esmtp (Exim 4.97)"),
            header("X-Spam-Status", "No, score=-50.0 required=5.0 tests=BAYES_HAM"),
            header("Authentication-Results", "mx.example.org; spf=pass smtp.mailfrom=bank.example; dmarc=pass"),
            header("Received", "from mail.bank.example (mail.bank.example [198.51.100.1]) by relay.bank.example"),
        ];
        assert_eq!(spam_status(&headers), (None, None, vec![]));
        assert_eq!(authentication(&headers, "service@bank.example").dmarc, None);
        assert!(!from_vouched(&headers, "service@bank.example"));
        assert!(receiving_headers(&headers).is_empty());

        assert!(!local_hop("from [192.0.2.7] (helo=[127.0.0.1]) by mx.example.org"));
        assert!(!local_hop("from [192.0.2.7] (helo=localhost) by mx.example.org"));
        assert!(!local_hop("from evil.example ([192.0.2.7] helo=[10.0.0.1]) by mx.example.org"));
        assert!(!local_hop("from evil.example ([192.0.2.7]:4711 helo=[10.0.0.1] ident=[127.0.0.1]) by mx"));
        assert!(!local_hop("from unknown (HELO [127.0.0.1]) (192.0.2.7) by mx.example.org"));
        // Exim's and qmail's own internal hops.
        assert!(local_hop("from localhost ([127.0.0.1] helo=mail.example.org) by mail.example.org"));
        assert!(local_hop("from [127.0.0.1] (helo=localhost) by mail.example.org with esmtp"));
        assert!(local_hop("from unknown (HELO mail.example.org) (127.0.0.1) by mail.example.org"));
    }

    /// C4-1/C4-2: every part is read however many come first, and a word a limit cuts is left out
    /// whole, never read as the victim's domain.
    #[test]
    fn long_results_are_read_whole_and_cut_words_dropped() {
        let read = |results: String| {
            let headers = [
                header("Authentication-Results", &results),
                header("Received", "from a.example (a.example [192.0.2.1]) by mx.example.org"),
            ];
            (authentication(&headers, "x@victim.example"), from_vouched(&headers, "x@victim.example"))
        };
        let (auth, vouched) = read(format!("mx.example.org; {}spf=fail; dmarc=fail", "dkim=permerror; ".repeat(70)));
        assert_eq!((auth.spf.as_deref(), auth.dmarc.as_deref()), (Some("fail"), Some("fail")));
        assert!(!vouched);
        let long_local = "a".repeat(1_100);
        let (auth, vouched) =
            read(format!("mx.example.org; dkim=pass header.i={long_local}@victim.example.attacker.example"));
        assert!(auth.dkim_pass_domains.is_empty(), "{auth:?}");
        assert!(!vouched);
        // At most 16 signers are kept, each once.
        let many: String = (0..40).map(|n| format!("dkim=pass header.d=s{}.example; ", n % 20)).collect();
        assert_eq!(read(format!("mx.example.org; {many}")).0.dkim_pass_domains.len(), 16);
        assert_eq!(authserv_id("(c) \"mx.example.org.\" ; spf=pass").as_deref(), Some("mx.example.org"));
    }

    /// C5-2: only ASCII whitespace ends a word, and a domain with any space in it is none.
    #[test]
    fn unicode_spaces_do_not_split_a_word() {
        for space in ['\u{a0}', '\u{2002}', '\u{3000}'] {
            let value = format!("mx.example.org; dkim=pass header.d=victim.example{space}x.attacker.example");
            let parts: Vec<Vec<String>> = auth_results_parts(&value).collect();
            assert_eq!(parts[1], ["dkim=pass".to_owned(), format!("header.d=victim.example{space}x.attacker.example")]);
            let headers = [
                header("Authentication-Results", &format!("{value}; dmarc=none")),
                header("Received", "from a.example (a.example [192.0.2.1]) by mx.example.org"),
            ];
            assert!(authentication(&headers, "x@victim.example").dkim_pass_domains.is_empty());
            assert!(!from_vouched(&headers, "x@victim.example"));
        }
        let parts: Vec<Vec<String>> =
            auth_results_parts("mx.example.org;\tspf=pass\r\n smtp.mailfrom=a.example").collect();
        assert_eq!(parts[1], ["spf=pass", "smtp.mailfrom=a.example"]);
    }

    /// C5-3: when the reader left something out, only an explicit DMARC pass counts.
    #[test]
    fn a_dropped_part_leaves_only_an_explicit_dmarc_pass() {
        let read = |results: String| {
            let headers = [
                header("Authentication-Results", &results),
                header("Received", "from a.example (a.example [192.0.2.1]) by mx.example.org"),
            ];
            from_vouched(&headers, "x@victim.example")
        };
        let crowded = format!("dmarc=fail {}", "x=y ".repeat(40));
        assert!(!read(format!("mx.example.org; dkim=pass header.d=victim.example; {crowded}")));
        let long = "a".repeat(1_100);
        assert!(!read(format!("mx.example.org; dkim=pass header.d=victim.example; spf=none smtp.mailfrom={long}")));
        assert!(read(format!("mx.example.org; dkim=pass header.d=victim.example; dmarc=pass; {crowded}")));
        // Nothing left out: the aligned fallback still works.
        assert!(read("mx.example.org; dkim=pass header.d=victim.example; dmarc=none".into()));
        // An emptied first header hides no second one of the server (C5-5).
        let headers = [
            header("Authentication-Results", ""),
            header("Authentication-Results", "mx.example.org; dmarc=fail"),
            header("Received", "from a.example (a.example [192.0.2.1]) by mx.example.org"),
        ];
        assert_eq!(authentication(&headers, "x@victim.example").dmarc.as_deref(), Some("fail"));
    }

    /// C4-4: only qmail's own `(HELO name)` is skipped; a bracketed address behind a word "helo"
    /// still counts.
    #[test]
    fn a_reverse_name_helo_does_not_hide_the_address() {
        assert!(!local_hop("from [127.0.0.1] (helo [192.0.2.7]) by mx.example.org"));
        assert!(!local_hop("from [127.0.0.1] (helo [192.0.2.7] ) by mx.example.org"));
        assert!(local_hop("from unknown (HELO mail.example.org) (127.0.0.1) by mail.example.org"));
        // A value too long to read whole (read as empty) is an intake line.
        assert!(!local_hop(""));
    }

    /// C3-7: Microsoft and qmail write the address alone in parentheses.
    #[test]
    fn addresses_in_parentheses_count() {
        assert!(local_hop(
            "from AM0PR01MB1234.eurprd01.prod.outlook.com (10.167.16.153) by AM0PR01CA0001.outlook.office365.com (2603:10a6:208::14) with Microsoft SMTP Server"
        ));
        assert!(!local_hop("from mail.sender.example (198.51.100.1) by AM0PR01CA0001.outlook.office365.com"));
        // Only a whole token is an address: a name or a mixed pair is not.
        assert!(!local_hop("from x (10.0.0.1 is me) by y"));
        assert!(!local_hop("from x (10.0.0.1) (192.0.2.7) by y"));
    }

    /// C3-1/C3-2 (the server's R2-M1): a From counts as authenticated only when a pass belongs to
    /// its domain, never against a DMARC failure, and the results are read as RFC 8601 reads them.
    #[test]
    fn authentication_needs_a_pass_aligned_with_the_from_domain() {
        let auth_for = |from: &str, results: &str| {
            let headers = vec![
                header("Authentication-Results", &format!("mx.example.org;\r\n\t{results}")),
                header("Received", "from a.example (a.example [192.0.2.1]) by mx.example.org"),
            ];
            authentication(&headers, from)
        };
        let authentic = |from: &str, results: &str| crate::assist::spam::authentic(&auth_for(from, results));
        // The attacker's own domain signs and passes SPF; the From domain publishes no DMARC policy.
        let unaligned = "dkim=pass header.d=attacker.example header.s=s1 header.b=abc; \
             spf=pass (mx.example.org: domain of x@attacker.example designates 192.0.2.1 as permitted sender) \
             smtp.mailfrom=x@attacker.example; dmarc=none header.from=smallbank.example";
        assert!(!authentic("service@smallbank.example", unaligned));
        let parsed = auth_for("service@smallbank.example", unaligned);
        assert_eq!(parsed.dkim_pass_domains, ["attacker.example"]);
        assert_eq!(parsed.spf_pass_domain.as_deref(), Some("attacker.example"));
        // The same passes for the From domain, a parent or a subdomain of it, do vouch.
        assert!(authentic("service@smallbank.example", "dkim=pass header.d=smallbank.example; dmarc=none"));
        assert!(authentic("service@mail.smallbank.example", "dkim=pass header.i=@smallbank.example; dmarc=none"));
        assert!(authentic(
            "service@smallbank.example",
            "spf=pass smtp.mailfrom=bounce@news.smallbank.example; dkim=none; dmarc=none"
        ));
        // HELO checks vouch for nothing.
        assert!(!authentic("service@smallbank.example", "spf=pass smtp.helo=smallbank.example"));
        // DMARC failing (a spoofed address at a p=none domain) is never outweighed.
        assert!(!authentic(
            "friend@contact.example",
            "dkim=pass header.d=contact.example; spf=pass smtp.mailfrom=x@contact.example; dmarc=fail"
        ));
        assert!(authentic("service@bank.example", "dmarc=pass header.from=bank.example"));
        // A quoted envelope sender can neither end a part nor start a result of its own.
        let injected =
            r#"spf=pass smtp.mailfrom="a;dmarc=pass header.d=smallbank.example"@attacker.example; dmarc=none"#;
        let parsed = auth_for("service@smallbank.example", injected);
        assert_eq!(parsed.dmarc.as_deref(), Some("none"));
        assert_eq!(parsed.spf_pass_domain.as_deref(), Some("attacker.example"));
        assert!(!authentic("service@smallbank.example", injected));
        assert!(!from_vouched(
            &[
                header("Authentication-Results", &format!("mx.example.org; {injected}")),
                header("Received", "from a.example (a.example [192.0.2.1]) by mx.example.org"),
            ],
            "service@smallbank.example"
        ));
        // Nor can a comment.
        let commented = "spf=pass (dmarc=pass; smtp.mailfrom=x@smallbank.example) smtp.mailfrom=x@attacker.example";
        let parsed = auth_for("service@smallbank.example", commented);
        assert_eq!((parsed.dmarc, parsed.spf_pass_domain.as_deref()), (None, Some("attacker.example")));
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
                ..AuthenticationSignals::default()
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
