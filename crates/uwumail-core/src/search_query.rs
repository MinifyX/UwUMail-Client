//! The search field's little language: `from:` `to:` `subject:` `has:attachment` `is:unread`
//! `is:flagged` `before:YYYY-MM-DD` `after:YYYY-MM-DD`, `"exact phrases"` and free words.
//!
//! One parser for every place that searches: the local store (full-text index and columns),
//! IMAP `SEARCH` and JMAP `Email/query`. Anything that isn't a known operator with a valid value
//! (`foo:bar`, `before:someday`) is searched for as text, so nothing typed is silently dropped.

use chrono::{NaiveDate, TimeZone};

/// What a search asks for. Every part must hold.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchQuery {
    /// Free words and quoted phrases (a phrase keeps its spaces).
    pub words: Vec<String>,
    pub from: Vec<String>,
    /// To or Cc.
    pub to: Vec<String>,
    pub subject: Vec<String>,
    pub has_attachment: bool,
    pub unread: bool,
    pub flagged: bool,
    /// Mail from before this day (local time), the day itself not included.
    pub before: Option<NaiveDate>,
    /// Mail from this day (local time) on.
    pub after: Option<NaiveDate>,
}

/// Longest value kept per term; a search field has no business holding more.
const TERM_MAX: usize = 200;
/// Terms kept per search, so a pasted novel can't become a huge query.
const TERMS_MAX: usize = 32;

/// Splits the input into terms: `word`, `"a phrase"`, `op:value`, `op:"a value"`. An unclosed
/// quote runs to the end.
fn terms(input: &str) -> Vec<(Option<String>, String)> {
    let mut terms = Vec::new();
    let mut chars = input.chars().peekable();
    let quoted = |chars: &mut std::iter::Peekable<std::str::Chars<'_>>| {
        let mut value = String::new();
        for c in chars.by_ref() {
            if c == '"' {
                break;
            }
            value.push(c);
        }
        value
    };
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        if c == '"' {
            chars.next();
            terms.push((None, quoted(&mut chars)));
            continue;
        }
        let mut word = String::new();
        let mut operator = None;
        while let Some(&c) = chars.peek() {
            if c.is_whitespace() {
                break;
            }
            chars.next();
            if c == ':' && operator.is_none() && !word.is_empty() && word.chars().all(|c| c.is_ascii_alphabetic()) {
                operator = Some(std::mem::take(&mut word));
                if chars.peek() == Some(&'"') {
                    chars.next();
                    word = quoted(&mut chars);
                    break;
                }
                continue;
            }
            word.push(c);
        }
        terms.push((operator, word));
    }
    terms
}

/// `YYYY-MM-DD` exactly (four-digit year, as the page's parser takes it), so IMAP and JMAP get
/// dates they can read.
fn date(value: &str) -> Option<NaiveDate> {
    let bytes = value.as_bytes();
    let shape = bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| if i == 4 || i == 7 { *b == b'-' } else { b.is_ascii_digit() });
    shape.then(|| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()).flatten()
}

impl SearchQuery {
    pub fn parse(input: &str) -> Self {
        let mut query = Self::default();
        for (operator, value) in terms(input).into_iter().take(TERMS_MAX) {
            let value: String =
                value.chars().map(|c| if c.is_control() { ' ' } else { c }).take(TERM_MAX).collect::<String>();
            let value = value.trim().to_string();
            let lower = value.to_lowercase();
            let known = match operator.as_deref().map(str::to_ascii_lowercase).as_deref() {
                None => false,
                Some("from") if !value.is_empty() => {
                    query.from.push(value.clone());
                    true
                }
                Some("to") if !value.is_empty() => {
                    query.to.push(value.clone());
                    true
                }
                Some("subject") if !value.is_empty() => {
                    query.subject.push(value.clone());
                    true
                }
                Some("has") if matches!(lower.as_str(), "attachment" | "attachments") => {
                    query.has_attachment = true;
                    true
                }
                Some("is") if lower == "unread" => {
                    query.unread = true;
                    true
                }
                Some("is") if matches!(lower.as_str(), "flagged" | "starred") => {
                    query.flagged = true;
                    true
                }
                Some("before") => date(&value).map(|day| query.before = Some(day)).is_some(),
                Some("after") => date(&value).map(|day| query.after = Some(day)).is_some(),
                Some(_) => false,
            };
            if known {
                continue;
            }
            // Not an operator after all: the whole term is text.
            let text = match operator {
                Some(operator) => format!("{operator}:{value}"),
                None => value,
            };
            if !text.trim().is_empty() {
                query.words.push(text);
            }
        }
        query
    }

    /// Nothing to look for at all.
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// Only text: no operator that a list filter or a date would cover.
    pub fn has_text(&self) -> bool {
        !(self.words.is_empty() && self.from.is_empty() && self.to.is_empty() && self.subject.is_empty())
    }

    /// The FTS5 query for the text parts, every term a prefix: `leni from:shop` →
    /// `"leni"* sender : "shop"*`. Quotes inside terms are dropped, so the input can't break out.
    pub fn fts(&self) -> Option<String> {
        let phrase = |text: &str| {
            let clean = text.replace('"', " ");
            let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
            (!clean.is_empty()).then(|| format!("\"{clean}\"*"))
        };
        let mut parts: Vec<String> = self.words.iter().filter_map(|w| phrase(w)).collect();
        for (column, values) in [("sender", &self.from), ("recipients", &self.to), ("subject", &self.subject)] {
            parts.extend(values.iter().filter_map(|v| phrase(v)).map(|p| format!("{column} : {p}")));
        }
        (!parts.is_empty()).then(|| parts.join(" "))
    }

    /// The `before:`/`after:` days as Unix seconds in `zone`: mail is older than the first, and
    /// not older than the second.
    pub fn bounds<Tz: TimeZone>(&self, zone: &Tz) -> (Option<i64>, Option<i64>) {
        let start = |day: NaiveDate| {
            let midnight = day.and_hms_opt(0, 0, 0)?;
            // A day that starts in a time change starts at its first existing moment.
            zone.from_local_datetime(&midnight)
                .earliest()
                .or_else(|| zone.from_local_datetime(&(midnight + chrono::TimeDelta::hours(1))).earliest())
                .map(|time| time.timestamp())
        };
        (self.before.and_then(start), self.after.and_then(start))
    }

    /// IMAP `SEARCH` criteria. Without any, every message (`ALL`); `has:attachment` has no IMAP
    /// criterion and is checked here afterwards.
    pub fn imap_criteria(&self, quote: impl Fn(&str) -> String) -> String {
        let mut parts = Vec::new();
        parts.extend(self.words.iter().map(|w| format!("TEXT {}", quote(w))));
        parts.extend(self.from.iter().map(|v| format!("FROM {}", quote(v))));
        parts.extend(self.to.iter().map(|v| format!("OR TO {0} CC {0}", quote(v))));
        parts.extend(self.subject.iter().map(|v| format!("SUBJECT {}", quote(v))));
        if self.unread {
            parts.push("UNSEEN".into());
        }
        if self.flagged {
            parts.push("FLAGGED".into());
        }
        let imap_date = |day: NaiveDate| day.format("%-d-%b-%Y").to_string();
        if let Some(day) = self.before {
            parts.push(format!("BEFORE {}", imap_date(day)));
        }
        if let Some(day) = self.after {
            parts.push(format!("SINCE {}", imap_date(day)));
        }
        if parts.is_empty() { "ALL".into() } else { parts.join(" ") }
    }

    /// A JMAP `Email/query` filter, the days in `zone`.
    pub fn jmap_filter<Tz: TimeZone>(&self, mailbox: Option<&str>, zone: &Tz) -> serde_json::Value {
        use serde_json::json;
        let mut conditions = Vec::new();
        conditions.extend(self.words.iter().map(|w| json!({ "text": w })));
        conditions.extend(self.from.iter().map(|v| json!({ "from": v })));
        conditions
            .extend(self.to.iter().map(|v| json!({ "operator": "OR", "conditions": [{ "to": v }, { "cc": v }] })));
        conditions.extend(self.subject.iter().map(|v| json!({ "subject": v })));
        if self.has_attachment {
            conditions.push(json!({ "hasAttachment": true }));
        }
        if self.unread {
            conditions.push(json!({ "notKeyword": "$seen" }));
        }
        if self.flagged {
            conditions.push(json!({ "hasKeyword": "$flagged" }));
        }
        let utc = |seconds: i64| {
            chrono::DateTime::from_timestamp(seconds, 0).map(|t| t.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        };
        let (before, after) = self.bounds(zone);
        if let Some(before) = before.and_then(utc) {
            conditions.push(json!({ "before": before }));
        }
        if let Some(after) = after.and_then(utc) {
            conditions.push(json!({ "after": after }));
        }
        if let Some(mailbox) = mailbox {
            conditions.push(json!({ "inMailbox": mailbox }));
        }
        match conditions.len() {
            0 => json!({}),
            1 => conditions.remove(0),
            _ => json!({ "operator": "AND", "conditions": conditions }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn day(text: &str) -> Option<NaiveDate> {
        date(text)
    }

    #[test]
    fn operators_phrases_and_free_text() {
        let query = SearchQuery::parse(
            r#"Rechnung from:shop@x.example to:"Leni Clip" subject:"März 2026" has:attachment is:unread
               is:Flagged before:2026-10-01 after:2026-09-01 "genau so" rest"#,
        );
        assert_eq!(
            query,
            SearchQuery {
                words: vec!["Rechnung".into(), "genau so".into(), "rest".into()],
                from: vec!["shop@x.example".into()],
                to: vec!["Leni Clip".into()],
                subject: vec!["März 2026".into()],
                has_attachment: true,
                unread: true,
                flagged: true,
                before: day("2026-10-01"),
                after: day("2026-09-01"),
            }
        );
    }

    #[test]
    fn unknown_or_broken_operators_stay_text() {
        let query = SearchQuery::parse("foo:bar before:someday is:great from: http://x.example/a:b");
        assert_eq!(
            query.words,
            vec!["foo:bar", "before:someday", "is:great", "from:", "http://x.example/a:b"],
            "{query:?}"
        );
        assert!(!query.unread && query.before.is_none());
        assert!(SearchQuery::parse("   ").is_empty());
        // An unclosed quote runs to the end.
        assert_eq!(SearchQuery::parse("subject:\"halb offen").subject, vec!["halb offen"]);
        assert_eq!(SearchQuery::parse("\"unbalanced").words, vec!["unbalanced"]);
        assert_eq!(SearchQuery::parse("FROM:Leni").from, vec!["Leni"]);
        // Only YYYY-MM-DD with a four-digit year is a day.
        for odd in
            ["before:+12026-01-01", "before:2026-1-5", "before:-001-01-01", "after:2026-02-30", "after:２０２６-01-01"]
        {
            let query = SearchQuery::parse(odd);
            assert!(query.before.is_none() && query.after.is_none(), "{odd}");
            assert_eq!(query.words.len(), 1, "{odd}");
        }
    }

    #[test]
    fn fts_query_keeps_terms_in_their_columns_and_quotes_out() {
        let query = SearchQuery::parse(r#"leni cl"ip from:shop subject:"a b" "two words""#);
        assert_eq!(query.fts().unwrap(), r#""leni"* "cl ip"* "two words"* sender : "shop"* subject : "a b"*"#);
        assert_eq!(SearchQuery::parse("is:unread").fts(), None);
        assert!(!SearchQuery::parse("is:unread before:2026-01-01").has_text());
    }

    #[test]
    fn days_start_at_local_midnight() {
        let berlin = FixedOffset::east_opt(2 * 3600).unwrap();
        let query = SearchQuery::parse("before:2026-10-02 after:2026-10-01");
        let (before, after) = query.bounds(&berlin);
        let utc = |d: u32| chrono::Utc.with_ymd_and_hms(2026, 9, d, 22, 0, 0).unwrap().timestamp();
        assert_eq!(before, Some(utc(30) + 86_400), "2026-10-01T22:00:00Z");
        assert_eq!(after, Some(utc(30)));
    }

    #[test]
    fn imap_criteria() {
        let quote = |text: &str| format!("\"{text}\"");
        let query = SearchQuery::parse("rechnung from:shop to:leni subject:Mai is:unread is:flagged after:2026-03-05");
        assert_eq!(
            query.imap_criteria(quote),
            r#"TEXT "rechnung" FROM "shop" OR TO "leni" CC "leni" SUBJECT "Mai" UNSEEN FLAGGED SINCE 5-Mar-2026"#
        );
        assert_eq!(SearchQuery::parse("has:attachment").imap_criteria(quote), "ALL");
        assert_eq!(SearchQuery::parse("before:2026-12-24").imap_criteria(quote), "BEFORE 24-Dec-2026");
    }

    #[test]
    fn jmap_filter() {
        let utc = FixedOffset::east_opt(0).unwrap();
        let query = SearchQuery::parse("rechnung has:attachment is:unread before:2026-10-02");
        assert_eq!(
            query.jmap_filter(Some("Inbox"), &utc),
            serde_json::json!({ "operator": "AND", "conditions": [
                { "text": "rechnung" },
                { "hasAttachment": true },
                { "notKeyword": "$seen" },
                { "before": "2026-10-02T00:00:00Z" },
                { "inMailbox": "Inbox" },
            ]})
        );
        assert_eq!(SearchQuery::parse("leni").jmap_filter(None, &utc), serde_json::json!({ "text": "leni" }));
    }
}
