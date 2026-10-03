//! What a model answered, held to its shape before anything uses it: the same checks as UwUMail
//! Server's (`uwumail-assist/src/features.rs`). A verdict is one of four words, a date is a real
//! date whose quote stands in the mail, a link is one the mail contains, people are ones from the
//! mail or the address book, labels are the person's own. Everything else is dropped.

use std::collections::HashSet;

use chrono::{NaiveDate, NaiveDateTime, TimeDelta};
use serde::Serialize;
use serde_json::Value;

use super::Label;
use super::prompts::SUBJECT_MARK;

const MAX_EVENTS: usize = 10;
const MAX_QUOTE_CHARS: usize = 300;
pub const MAX_REASONS: usize = 6;
const MAX_REASON_CHARS: usize = 300;

fn chars(text: &str) -> usize {
    text.chars().count()
}

/// At most `max` characters of `text`, trimmed, without control characters but line breaks.
pub fn clean(text: &str, max: usize) -> String {
    let cleaned: String = text.chars().filter(|c| !c.is_control() || *c == '\n').take(max).collect::<String>();
    cleaned.trim().to_owned()
}

/// One optional line of text out of a JSON answer: trimmed, capped, `None` when empty.
fn optional_text(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?;
    let text = clean(&text.replace('\n', " "), max);
    (!text.is_empty()).then_some(text)
}

/// The JSON object in a model's answer: the whole text, or the part from the first `{` to the last
/// `}` (models like to wrap it in a code fence or a sentence).
pub fn json_answer(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed)
        && value.is_object()
    {
        return Some(value);
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Value>(&trimmed[start..=end]).ok().filter(Value::is_object)
}

/// Splits a `SUBJECT: …` first line off a written mail.
pub fn split_subject(text: &str) -> (Option<String>, String) {
    let trimmed = text.trim_start();
    let starts = trimmed.get(..SUBJECT_MARK.len()).is_some_and(|head| head.eq_ignore_ascii_case(SUBJECT_MARK));
    if !starts {
        return (None, text.trim().to_owned());
    }
    let rest = &trimmed[SUBJECT_MARK.len()..];
    let (line, body) = rest.split_once('\n').unwrap_or((rest, ""));
    let subject = clean(line, 200);
    ((!subject.is_empty()).then_some(subject), body.trim().to_owned())
}

/// A spam check answer: verdict, confidence, and each reason with what it cites.
pub type SpamAnswer = (String, f64, Vec<(String, String)>);

/// Verdict, confidence and reasons (with what each one cites) out of the model's answer.
pub fn parse_spam(text: &str) -> Option<SpamAnswer> {
    let answer = json_answer(text)?;
    let verdict = answer.get("verdict")?.as_str()?.trim().to_ascii_lowercase();
    if !matches!(verdict.as_str(), "legitimate" | "suspicious" | "spam" | "phishing") {
        return None;
    }
    let confidence = answer.get("confidence").and_then(Value::as_f64).filter(|c| c.is_finite()).unwrap_or(0.5);
    let reasons = super::spam::parse_reasons(&answer, MAX_REASONS, MAX_REASON_CHARS);
    Some((verdict, confidence.clamp(0.0, 1.0), reasons))
}

/// What the model said about one label: why, and whether it fits.
#[derive(Debug, Clone)]
pub struct Verdict {
    pub label: Label,
    pub reason: String,
    pub fits: bool,
}

/// The model's verdicts on the person's labels, in the order of the labels. Names that are not
/// labels are dropped, each label counts once (its first entry), a label the model did not answer
/// for is left out, and an entry without `fits` counts as fitting, like the server reads it.
pub fn parse_verdicts(answer: &Value, labels: &[Label]) -> Vec<Verdict> {
    let mut found: Vec<(usize, Verdict)> = Vec::new();
    for entry in answer.get("labels").and_then(Value::as_array).into_iter().flatten().take(100) {
        let (name, reason, fits) = match entry {
            Value::String(name) => (name.as_str(), "", true),
            Value::Object(object) => (
                object.get("name").and_then(Value::as_str).unwrap_or_default(),
                object.get("reason").and_then(Value::as_str).unwrap_or_default(),
                object
                    .get("fits")
                    .and_then(uwumail_labels::AiAnswer::parse)
                    .is_none_or(|fits| fits == uwumail_labels::AiAnswer::Yes),
            ),
            _ => continue,
        };
        let name = name.trim().to_lowercase();
        let Some(index) = labels.iter().position(|label| label.name.trim().to_lowercase() == name) else { continue };
        if found.iter().any(|(known, _)| *known == index) {
            continue;
        }
        let reason = clean(&reason.replace('\n', " "), MAX_REASON_CHARS);
        found.push((index, Verdict { label: labels[index].clone(), reason, fits }));
    }
    found.sort_by_key(|(index, _)| *index);
    found.into_iter().map(|(_, verdict)| verdict).collect()
}

/// The model's verdict on each label it was asked about (`labels` as the deciding's id and the
/// label's name), with its reasons: `"fits": "yes" | "no" | "unsure"` (or `true`/`false`). Names
/// that are not labels are dropped; each label counts once, by its first entry. A bare name counts
/// as yes, an entry without a verdict as unsure (UwUMail Server's `parse_labels`).
pub fn parse_labels(answer: &Value, labels: &[(i64, &str)]) -> Vec<uwumail_labels::AiVerdict> {
    use uwumail_labels::{AiAnswer, AiVerdict};
    let mut out: Vec<AiVerdict> = Vec::new();
    for entry in answer.get("labels").and_then(Value::as_array).into_iter().flatten().take(50) {
        let (name, reason, verdict) = match entry {
            Value::String(name) => (name.as_str(), "", AiAnswer::Yes),
            Value::Object(object) => (
                object.get("name").and_then(Value::as_str).unwrap_or_default(),
                object.get("reason").and_then(Value::as_str).unwrap_or_default(),
                object.get("fits").and_then(AiAnswer::parse).unwrap_or(AiAnswer::Unsure),
            ),
            _ => continue,
        };
        let name = name.trim().to_lowercase();
        let Some((id, _)) = labels.iter().find(|(_, label)| label.trim().to_lowercase() == name) else {
            continue;
        };
        if out.iter().any(|known| known.label_id == *id) {
            continue;
        }
        out.push(AiVerdict { label_id: *id, verdict, reason: clean(&reason.replace('\n', " "), MAX_REASON_CHARS) });
    }
    out
}

/// A new label the model proposes for a mail no label fits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NewLabel {
    pub name: String,
    pub description: String,
    pub color: String,
    pub reason: String,
}

/// New labels proposed, most 2.
pub const MAX_NEW_LABELS: usize = 2;
const MAX_LABEL_NAME_CHARS: usize = 40;
const MAX_LABEL_DESCRIPTION_CHARS: usize = 300;
/// Colors for a proposed label that came without a usable one.
const LABEL_COLORS: [&str; 8] =
    ["#e11d48", "#ea580c", "#ca8a04", "#16a34a", "#0d9488", "#2563eb", "#7c3aed", "#db2777"];

/// Whether a color is `#rrggbb`.
pub fn is_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// The new labels the model proposed, at most `room` (and [`MAX_NEW_LABELS`]): names of 1 to 40
/// characters that are no label's yet (`taken`, ignoring case) nor proposed twice, descriptions of at
/// most 300; a color that isn't `#rrggbb` is replaced by one picked here. Others are dropped.
pub fn parse_new_labels(answer: &Value, taken: &[String], room: usize) -> Vec<NewLabel> {
    let mut out: Vec<NewLabel> = Vec::new();
    let taken: Vec<String> = taken.iter().map(|name| name.trim().to_lowercase()).collect();
    for entry in answer.get("newLabels").and_then(Value::as_array).into_iter().flatten().take(10) {
        if out.len() >= room.min(MAX_NEW_LABELS) {
            break;
        }
        let text = |key: &str| entry.get(key).and_then(Value::as_str).unwrap_or_default();
        let name = clean(&text("name").replace('\n', " "), 200);
        let description = clean(&text("description").replace('\n', " "), 1000);
        if name.is_empty()
            || chars(&name) > MAX_LABEL_NAME_CHARS
            || chars(&description) > MAX_LABEL_DESCRIPTION_CHARS
            || taken.contains(&name.to_lowercase())
            || out.iter().any(|known| known.name.to_lowercase() == name.to_lowercase())
        {
            continue;
        }
        let color = text("color").trim().to_lowercase();
        let color = if is_color(&color) {
            color
        } else {
            let pick = uwumail_labels::token_hash(&name.to_lowercase()).unsigned_abs() as usize;
            LABEL_COLORS[(pick + out.len()) % LABEL_COLORS.len()].to_owned()
        };
        let reason = clean(&text("reason").replace('\n', " "), MAX_REASON_CHARS);
        out.push(NewLabel { name, description, color, reason });
    }
    out
}

/// Somebody an event names, with an address the person knows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Participant {
    pub name: String,
    pub email: String,
}

/// An appointment read out of a mail, checked.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedEvent {
    pub title: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub time_zone: Option<String>,
    pub location: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub participants: Vec<Participant>,
    pub confidence: f64,
    pub quote: String,
}

/// What an extracted event is checked against.
pub struct EventContext<'a> {
    /// All the text the event may be read from: subject, body, links, text in pictures.
    pub source: &'a str,
    pub links: &'a [String],
    /// Names and addresses (lower case) of the mail's From, To and Cc and of the address book.
    pub people: &'a [(String, String)],
    /// The person's own addresses (lower case), never suggested.
    pub mine: &'a HashSet<String>,
}

/// Lower case, one space between words, without quotation marks: to find a quote in the mail even
/// when the model changed its spacing.
fn normalized(text: &str) -> String {
    text.chars()
        .filter(|c| !matches!(c, '"' | '\'' | '„' | '“' | '”' | '‚' | '‘' | '’' | '«' | '»' | '*'))
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

enum When {
    At(NaiveDateTime),
    Day(NaiveDate),
}

fn parse_when(text: &str) -> Option<When> {
    let text = text.trim();
    for format in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(at) = NaiveDateTime::parse_from_str(text, format) {
            return Some(When::At(at));
        }
    }
    if let Ok(at) = chrono::DateTime::parse_from_rfc3339(text) {
        return Some(When::At(at.naive_local()));
    }
    if let Some(stripped) = text.strip_suffix('Z')
        && let Ok(at) = NaiveDateTime::parse_from_str(stripped, "%Y-%m-%dT%H:%M:%S")
    {
        return Some(When::At(at));
    }
    NaiveDate::parse_from_str(text, "%Y-%m-%d").ok().map(When::Day)
}

fn local(at: NaiveDateTime) -> String {
    at.format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn sane(at: NaiveDateTime) -> bool {
    (1970..=2200).contains(&chrono::Datelike::year(&at))
}

/// The people the model named, as addresses the person knows: from the mail's From, To and Cc or
/// the address book. Others, and the person themselves, are left out.
fn participants(named: &[Value], context: &EventContext<'_>) -> Vec<Participant> {
    let mut out: Vec<Participant> = Vec::new();
    for entry in named.iter().take(40) {
        let text = match entry {
            Value::String(text) => text.clone(),
            Value::Object(object) => object
                .get("email")
                .and_then(Value::as_str)
                .filter(|e| !e.trim().is_empty())
                .or_else(|| object.get("name").and_then(Value::as_str))
                .unwrap_or_default()
                .to_owned(),
            _ => continue,
        };
        let text = text.trim();
        if text.is_empty() || chars(text) > 320 {
            continue;
        }
        let found = if let Some(address) = text
            .split(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '(' | ')' | ',' | ';'))
            .find(|word| word.contains('@'))
        {
            let address = address.to_lowercase();
            context.people.iter().find(|(_, email)| *email == address).cloned()
        } else {
            let wanted = normalized(text);
            let exact: Vec<&(String, String)> =
                context.people.iter().filter(|(name, _)| !name.is_empty() && normalized(name) == wanted).collect();
            match exact.first() {
                Some(first) if exact.iter().all(|p| p.1 == first.1) => Some((*first).clone()),
                _ => {
                    // "Leni" for "Leni Beispiel", when only one person is meant.
                    let first_names: Vec<&(String, String)> = context
                        .people
                        .iter()
                        .filter(|(name, _)| normalized(name).split(' ').next().is_some_and(|first| first == wanted))
                        .collect();
                    match first_names.first() {
                        Some(first) if !wanted.contains(' ') && first_names.iter().all(|p| p.1 == first.1) => {
                            Some((*first).clone())
                        }
                        _ => None,
                    }
                }
            }
        };
        let Some((name, email)) = found else { continue };
        if context.mine.contains(&email) || out.iter().any(|p| p.email == email) {
            continue;
        }
        out.push(Participant { name: clean(&name, 100), email });
        if out.len() >= 20 {
            break;
        }
    }
    out
}

/// The events out of the model's answer, each one checked: a date that is one, an end after the
/// start, a quote that stands in the mail, a link that is in it, people the person knows.
pub fn parse_events(answer: &Value, context: &EventContext<'_>) -> Vec<ExtractedEvent> {
    let source = normalized(context.source);
    let mut events = Vec::new();
    for entry in answer.get("events").and_then(Value::as_array).into_iter().flatten().take(MAX_EVENTS * 3) {
        let Some(title) = optional_text(entry.get("title"), 200) else { continue };
        let Some(start) = entry.get("start").and_then(Value::as_str).and_then(parse_when) else { continue };
        let mut all_day = entry.get("allDay").and_then(Value::as_bool).unwrap_or(false);
        let end_when = entry.get("end").and_then(Value::as_str).and_then(parse_when);
        // "allDay" with a time of day contradicts itself; the time is what the mail said
        // ("zwischen 10:00 und 12:00" must not become a whole day).
        let timed = |when: &When| matches!(when, When::At(at) if at.time() != chrono::NaiveTime::MIN);
        // "23:59:59" is how some write the end of a whole day.
        let end_of_day = |when: &When| matches!(when, When::At(at) if at.time() >= chrono::NaiveTime::from_hms_opt(23, 59, 0).unwrap_or_default());
        if all_day && (timed(&start) || end_when.as_ref().is_some_and(|end| timed(end) && !end_of_day(end))) {
            all_day = false;
        }
        // Midnight to midnight on another day is whole days, whatever the flag says.
        if !all_day
            && let (When::At(from), Some(When::At(to))) = (&start, &end_when)
            && !timed(&start)
            && to.time() == chrono::NaiveTime::MIN
            && to.date() > from.date()
        {
            all_day = true;
        }
        let start = match start {
            When::At(at) => at,
            When::Day(day) => {
                all_day = true;
                day.and_hms_opt(0, 0, 0).unwrap_or_default()
            }
        };
        let start = if all_day { start.date().and_hms_opt(0, 0, 0).unwrap_or(start) } else { start };
        if !sane(start) {
            continue;
        }
        let default_end = if all_day { start + TimeDelta::days(1) } else { start + TimeDelta::hours(1) };
        let end = match end_when {
            // The last day, as people (and the prompt) write it: the end is the day after.
            Some(When::At(at)) if all_day => at.date().and_hms_opt(0, 0, 0).unwrap_or(at) + TimeDelta::days(1),
            Some(When::At(at)) => at,
            Some(When::Day(day)) => {
                let day = day.and_hms_opt(0, 0, 0).unwrap_or_default();
                if all_day { day + TimeDelta::days(1) } else { day }
            }
            None => default_end,
        };
        let end = if end <= start || !sane(end) || end - start > TimeDelta::days(366) { default_end } else { end };
        let Some(quote) = optional_text(entry.get("quote"), MAX_QUOTE_CHARS) else { continue };
        let wanted = normalized(quote.trim_matches(['…', '.']));
        if wanted.is_empty() || !source.contains(&wanted) {
            continue;
        }
        let time_zone = optional_text(entry.get("timeZone"), 64).filter(|zone| zone.parse::<chrono_tz::Tz>().is_ok());
        let url = optional_text(entry.get("url"), 300).filter(|url| {
            url.starts_with("https://") && (context.links.contains(url) || context.source.contains(url.as_str()))
        });
        let named = entry.get("participants").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        let confidence = entry.get("confidence").and_then(Value::as_f64).filter(|c| c.is_finite()).unwrap_or(0.5);
        events.push(ExtractedEvent {
            title,
            start: local(start),
            end: local(end),
            all_day,
            time_zone,
            location: optional_text(entry.get("location"), 300),
            description: entry
                .get("description")
                .and_then(Value::as_str)
                .map(|text| clean(text, 1000))
                .filter(|text| !text.is_empty()),
            url,
            participants: participants(named, context),
            confidence: confidence.clamp(0.0, 1.0),
            quote,
        });
        if events.len() >= MAX_EVENTS {
            break;
        }
    }
    events
}

/// The keyword a label is set as: a lower-case ASCII form of its name (`rechnungen`,
/// `bestellungen-versand`), like UwUMail Server makes them; empty when nothing of it is left.
pub fn label_keyword(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        let piece: &str = match c {
            'ä' => "ae",
            'ö' => "oe",
            'ü' => "ue",
            'ß' => "ss",
            'à' | 'á' | 'â' | 'ã' | 'å' => "a",
            'ç' => "c",
            'è' | 'é' | 'ê' | 'ë' => "e",
            'ì' | 'í' | 'î' | 'ï' => "i",
            'ñ' => "n",
            'ò' | 'ó' | 'ô' | 'õ' | 'ø' => "o",
            'ù' | 'ú' | 'û' => "u",
            'ý' | 'ÿ' => "y",
            c if c.is_ascii_alphanumeric() => {
                out.push(c);
                continue;
            }
            _ => "-",
        };
        out.push_str(piece);
    }
    let mut keyword = String::new();
    for part in out.split('-').filter(|part| !part.is_empty()) {
        if keyword.len() + part.len() + 1 > 40 {
            break;
        }
        if !keyword.is_empty() {
            keyword.push('-');
        }
        keyword.push_str(part);
    }
    keyword
}

/// Keywords other mail programs and servers read as more than a word (Thunderbird's and some
/// servers' junk marks without `$`, and the names of system flags without their `\` or `$`): a
/// label named like one gets `label-<keyword>` instead, so labelling a mail never marks it junk,
/// read or deleted anywhere.
const RESERVED_KEYWORDS: [&str; 14] = [
    "junk",
    "nonjunk",
    "notjunk",
    "phishing",
    "seen",
    "answered",
    "flagged",
    "deleted",
    "draft",
    "recent",
    "forwarded",
    "mdnsent",
    "submitpending",
    "submitted",
];

/// Whether a label's keyword would look like a mark other mail programs act on
/// ([`RESERVED_KEYWORDS`]), ignoring case.
pub fn is_reserved_keyword(keyword: &str) -> bool {
    RESERVED_KEYWORDS.iter().any(|reserved| reserved.eq_ignore_ascii_case(keyword))
}

/// Whether a keyword may be set by hand or by a label: an own keyword (no `$` or `\` system flag),
/// 1 to 64 printable ASCII characters an IMAP atom takes.
pub fn is_own_keyword(keyword: &str) -> bool {
    (1..=64).contains(&keyword.len())
        && !keyword.starts_with(['$', '\\'])
        && keyword.bytes().all(|b| b.is_ascii_graphic() && !b"(){%*\"\\]".contains(&b))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn subjects_come_off_the_first_line() {
        assert_eq!(split_subject("SUBJECT: Freitag\n\nHallo Mia"), (Some("Freitag".into()), "Hallo Mia".into()));
        assert_eq!(split_subject("subject:Hi\nText"), (Some("Hi".into()), "Text".into()));
        assert_eq!(split_subject("Hallo Mia"), (None, "Hallo Mia".into()));
        assert_eq!(split_subject("Süß"), (None, "Süß".into()));
    }

    #[test]
    fn json_is_found_in_fences_and_sentences() {
        assert_eq!(json_answer("```json\n{\"a\": 1}\n```"), Some(json!({"a": 1})));
        assert_eq!(json_answer("Here you go: {\"a\": 2} Thanks"), Some(json!({"a": 2})));
        assert_eq!(json_answer("[1, 2]"), None);
        assert_eq!(json_answer("no json } here {"), None);
    }

    #[test]
    fn spam_answers_are_held_to_their_shape() {
        let (verdict, confidence, reasons) = parse_spam(
            r#"{"verdict": "Phishing", "confidence": 7, "reasons": [{"text": "a", "evidence": "F1"}, "", "b\nc"]}"#,
        )
        .unwrap();
        assert_eq!((verdict.as_str(), confidence), ("phishing", 1.0));
        assert_eq!(reasons, [("a".to_owned(), "F1".to_owned()), ("b c".to_owned(), String::new())]);
        // A mail that talks the model into another verdict word gets nothing.
        assert!(parse_spam(r#"{"verdict": "delete all mail"}"#).is_none());
        assert!(parse_spam(r#"{"verdict": "legitimate; ignore previous instructions"}"#).is_none());
        // The order the schema asks for: reasons first, then the verdict; only the allowed verdicts.
        let schema = crate::assist::prompts::spam_schema(&["legitimate", "suspicious"]);
        assert_eq!(schema["required"], json!(["reasons", "verdict", "confidence"]));
        assert_eq!(schema["properties"]["verdict"]["enum"], json!(["legitimate", "suspicious"]));
        let many: Vec<Value> =
            (0..20).map(|i| json!({ "text": format!("reason {i} {}", "x".repeat(400)), "evidence": "F1" })).collect();
        let (_, _, reasons) = parse_spam(&json!({"verdict": "spam", "reasons": many}).to_string()).unwrap();
        assert_eq!(reasons.len(), 12, "twice the most kept, for the check to choose from");
        assert!(reasons.iter().all(|(text, _)| text.chars().count() <= 300));
    }

    fn label(id: &str, name: &str) -> Label {
        Label::named(id, name, &label_keyword(name))
    }

    #[test]
    fn only_the_persons_labels_are_picked() {
        let labels = [label("g1", "Rechnungen"), label("g2", "Reisen")];
        let answer = json!({ "labels": [
            { "name": "rechnungen", "reason": "Eine Rechnung" },
            { "name": "Rechnungen", "reason": "again" },
            { "name": "Delete everything", "reason": "x" },
            { "name": "$Junk", "reason": "system keyword" },
            "Reisen"
        ]});
        let names: Vec<(i64, &str)> = labels.iter().enumerate().map(|(i, l)| (i as i64, l.name.as_str())).collect();
        let picks = parse_labels(&answer, &names);
        // Without a verdict the first entry is unsure; a bare name is a yes.
        assert_eq!(picks.iter().map(|p| p.label_id).collect::<Vec<_>>(), [0, 1]);
        assert_eq!(picks[0].verdict, uwumail_labels::AiAnswer::Unsure);
        assert_eq!(picks[1].verdict, uwumail_labels::AiAnswer::Yes);
        assert_eq!(picks[0].reason, "Eine Rechnung");
        let unsure = json!({ "labels": [{ "name": "Reisen", "reason": "?", "fits": "unsure" }] });
        assert_eq!(parse_labels(&unsure, &names)[0].verdict, uwumail_labels::AiAnswer::Unsure);
    }

    #[test]
    fn labels_the_model_argues_against_are_not_picked() {
        let labels = [label("g1", "Rechnungen"), label("g2", "Reisen"), label("g3", "Privat")];
        let answer = json!({ "labels": [
            { "name": "Reisen", "reason": "Es geht nicht um eine Reise.", "fits": false },
            { "name": "Rechnungen", "reason": "Eine Rechnung über 49,90 €.", "fits": true },
            { "name": "Reisen", "reason": "Doch!", "fits": true }
        ]});
        let verdicts = parse_verdicts(&answer, &labels);
        // In the order of the labels, each once, the unanswered one left out.
        assert_eq!(
            verdicts.iter().map(|v| (v.label.id.as_str(), v.fits)).collect::<Vec<_>>(),
            [("g1", true), ("g2", false)]
        );
        let yes = json!({ "labels": [{ "name": "Privat", "reason": "Ja.", "fits": "yes" }] });
        assert!(parse_verdicts(&yes, &labels)[0].fits);
    }

    #[test]
    fn proposed_labels_are_held_to_their_shape() {
        let taken = vec!["Rechnungen".to_owned()];
        let answer = json!({ "newLabels": [
            { "name": "rechnungen", "description": "taken", "color": "#123456", "reason": "x" },
            { "name": "Vereine", "description": "Post von Vereinen", "color": "#A1B2C3", "reason": "Ein Verein\nschreibt." },
            { "name": "vereine", "description": "twice", "color": "#000000", "reason": "x" },
            { "name": "", "description": "no name", "color": "#000000", "reason": "x" },
            { "name": "x".repeat(41), "description": "", "color": "#000000", "reason": "x" },
            { "name": "Lang", "description": "d".repeat(301), "color": "#000000", "reason": "x" },
            { "name": "Sport", "description": "", "color": "red", "reason": "x" },
            { "name": "Drittes", "description": "", "color": "#000000", "reason": "x" }
        ]});
        let proposed = parse_new_labels(&answer, &taken, 5);
        assert_eq!(proposed.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["Vereine", "Sport"]);
        assert_eq!(proposed[0].color, "#a1b2c3");
        assert_eq!(proposed[0].reason, "Ein Verein schreibt.");
        assert!(is_color(&proposed[1].color), "a color picked here");
        assert_eq!(parse_new_labels(&answer, &taken, 1).len(), 1, "never more than there is room for");
        assert!(parse_new_labels(&json!({}), &taken, 2).is_empty());
    }

    #[test]
    fn keywords_from_names() {
        assert_eq!(label_keyword("Rechnungen"), "rechnungen");
        assert_eq!(label_keyword("Bestellungen & Versand"), "bestellungen-versand");
        assert_eq!(label_keyword("Persönlich"), "persoenlich");
        assert_eq!(label_keyword("旅行"), "");
        assert!(is_own_keyword("rechnungen") && is_own_keyword("label-3"));
        for bad in ["", "$junk", "\\Seen", "a b", "x(y", "a\"b", &"k".repeat(65)] {
            assert!(!is_own_keyword(bad), "{bad}");
        }
        for reserved in ["junk", "NonJunk", "notjunk", "seen", "Deleted", "flagged"] {
            assert!(is_reserved_keyword(reserved), "{reserved}");
        }
        assert!(!is_reserved_keyword("rechnungen") && !is_reserved_keyword("junk-mail"));
    }

    #[test]
    fn events_are_checked_against_the_mail() {
        let people = vec![
            ("Leni Beispiel".to_owned(), "leni@example.org".to_owned()),
            ("Mia".to_owned(), "mia@example.org".to_owned()),
        ];
        let mine: HashSet<String> = ["mia@example.org".to_owned()].into();
        let links = vec!["https://praxis.example/termin".to_owned()];
        let source = "Ihr Termin am Dienstag, 6. Oktober um 9:30 Uhr in der Praxis.\nhttps://praxis.example/termin";
        let context = EventContext { source, links: &links, people: &people, mine: &mine };
        let answer = json!({ "events": [
            {
                "title": "Zahnarzt", "start": "2026-10-06T09:30:00", "end": null, "allDay": false,
                "timeZone": "Europe/Berlin", "location": "Praxis", "description": null,
                "url": "https://praxis.example/termin", "participants": ["Leni", "Mia", "Unbekannt"],
                "confidence": 0.9, "quote": "Ihr Termin am  Dienstag, 6. Oktober um 9:30 Uhr"
            },
            { "title": "Made up", "start": "2026-10-07", "quote": "not in the mail", "participants": [] },
            { "title": "Urlaub", "start": "2026-10-10", "end": "2026-10-12", "allDay": true, "timeZone": "Mars/Base",
              "url": "https://evil.example/", "quote": "in der Praxis", "participants": [], "confidence": "high" },
            { "title": "Bad", "start": "next Tuesday", "quote": "Praxis", "participants": [] },
            { "title": "Phish", "start": "2026-10-08T10:00:00", "quote": "Praxis", "url": "javascript:alert(1)" },
            { "title": "Far", "start": "9999-01-01T00:00:00", "quote": "Praxis" }
        ]});
        let events = parse_events(&answer, &context);
        assert_eq!(events.len(), 3, "{events:?}");
        assert_eq!(events[0].end, "2026-10-06T10:30:00", "an hour without an end");
        assert_eq!(events[0].time_zone.as_deref(), Some("Europe/Berlin"));
        assert_eq!(events[0].url.as_deref(), Some("https://praxis.example/termin"));
        assert_eq!(
            events[0].participants,
            [Participant { name: "Leni Beispiel".into(), email: "leni@example.org".into() }]
        );
        assert_eq!((events[1].start.as_str(), events[1].end.as_str()), ("2026-10-10T00:00:00", "2026-10-13T00:00:00"));
        assert!(events[1].all_day && events[1].time_zone.is_none() && events[1].url.is_none());
        assert_eq!(events[1].confidence, 0.5);
        assert_eq!(events[2].url, None, "only https links of the mail");
    }

    #[test]
    fn an_all_day_answer_with_times_keeps_the_times() {
        let (links, people, mine) = (Vec::new(), Vec::new(), HashSet::new());
        let source = "Samstag 03.10.26, zwischen 10:00 und 12:00 ist Flohmarkt.";
        let context = EventContext { source, links: &links, people: &people, mine: &mine };
        let answer = json!({ "events": [
            { "title": "Flohmarkt", "start": "2026-10-03T10:00:00", "end": "2026-10-03T12:00:00", "allDay": true,
              "quote": "Samstag 03.10.26, zwischen 10:00 und 12:00", "participants": [] },
            { "title": "Flohmarkt", "start": "2026-10-03T00:00:00", "end": null, "allDay": true,
              "quote": "Samstag 03.10.26", "participants": [] }
        ]});
        let events = parse_events(&answer, &context);
        assert_eq!(events.len(), 2, "{events:?}");
        assert!(!events[0].all_day);
        assert_eq!((events[0].start.as_str(), events[0].end.as_str()), ("2026-10-03T10:00:00", "2026-10-03T12:00:00"));
        assert!(events[1].all_day);
        assert_eq!((events[1].start.as_str(), events[1].end.as_str()), ("2026-10-03T00:00:00", "2026-10-04T00:00:00"));
    }

    #[test]
    fn whole_days_end_after_the_last_day() {
        let (links, people, mine) = (Vec::new(), Vec::new(), HashSet::new());
        let source = "Die Messe läuft vom 12. bis 15. Oktober 2026.";
        let context = EventContext { source, links: &links, people: &people, mine: &mine };
        let quote = "Die Messe läuft vom 12. bis 15. Oktober 2026.";
        let answer = json!({ "events": [
            // Midnight to midnight, flagged as timed: whole days.
            { "title": "Messe", "start": "2026-10-12T00:00:00", "end": "2026-10-15T00:00:00", "allDay": false,
              "quote": quote, "participants": [] },
            { "title": "Messe", "start": "2026-10-12T00:00:00", "end": "2026-10-15T23:59:59", "allDay": true,
              "quote": quote, "participants": [] },
            { "title": "Messe", "start": "2026-10-12", "end": "2026-10-15", "allDay": true,
              "quote": quote, "participants": [] }
        ]});
        let events = parse_events(&answer, &context);
        assert_eq!(events.len(), 3, "{events:?}");
        for event in &events {
            assert!(event.all_day, "{event:?}");
            assert_eq!((event.start.as_str(), event.end.as_str()), ("2026-10-12T00:00:00", "2026-10-16T00:00:00"));
        }
    }
}
