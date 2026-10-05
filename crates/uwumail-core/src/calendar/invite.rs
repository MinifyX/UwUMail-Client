//! Invitations in mail (iMIP, RFC 6047): what a mail's iCalendar part says, as the reader shows it,
//! the attendee's own copy of the event, and the REPLY that goes back to the organizer.
//!
//! Everything here is pure; finding the event in a calendar, storing it and sending the mail is
//! `engine::invite_ops`. The objects come from strangers, so reading is bounded: at most
//! [`MAX_ICS_BYTES`], the line and depth limits of [`itip::Component::parse`], and texts cut by
//! characters (never by bytes) before they are shown.

use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeDelta, Utc};
use lettre::Message;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use serde::{Deserialize, Serialize};

use super::itip::{self, Component, Property};
use super::{graph_cal, jscal};
use crate::error::{Error, Result};
use crate::model::Address;

/// The biggest iCalendar part read; real invitations are a few kilobytes.
pub const MAX_ICS_BYTES: usize = 1024 * 1024;
/// Attendees shown at most; the rest is a count.
pub const MAX_ATTENDEES: usize = 50;
/// Characters of a title, place or name shown at most.
const MAX_TEXT_CHARS: usize = 500;
/// A UID longer than this is no one's real event.
const MAX_UID_CHARS: usize = 1000;
/// Characters of a comment sent along with an answer at most.
pub const MAX_COMMENT_CHARS: usize = 2000;

/// An attendee's answer (`PARTSTAT`), as the webmail names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Partstat {
    NeedsAction,
    Accepted,
    Tentative,
    Declined,
}

impl Partstat {
    /// `ACCEPTED`, `tentative`, …; anything unknown (`DELEGATED`, `X-…`) counts as not answered.
    pub fn from_ical(value: &str) -> Self {
        match value.trim().to_ascii_uppercase().as_str() {
            "ACCEPTED" => Self::Accepted,
            "TENTATIVE" => Self::Tentative,
            "DECLINED" => Self::Declined,
            _ => Self::NeedsAction,
        }
    }

    pub fn ical(self) -> &'static str {
        match self {
            Self::NeedsAction => "NEEDS-ACTION",
            Self::Accepted => "ACCEPTED",
            Self::Tentative => "TENTATIVE",
            Self::Declined => "DECLINED",
        }
    }
}

/// What a scheduling mail says it is (its METHOD).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    Request,
    Cancel,
    Reply,
    Other,
}

impl Method {
    fn of(value: Option<&str>) -> Self {
        match value.map(|m| m.trim().to_ascii_uppercase()).as_deref() {
            // A part without METHOD is an event sent along, which most programs offer like an invitation.
            None | Some("REQUEST") => Self::Request,
            Some("CANCEL") => Self::Cancel,
            Some("REPLY") => Self::Reply,
            Some(_) => Self::Other,
        }
    }
}

/// A point in time as an event names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Moment {
    /// A whole day (`VALUE=DATE`).
    Date(NaiveDate),
    /// A UTC instant (`…Z`, or a known `TZID`).
    Utc(DateTime<Utc>),
    /// A wall time without a zone (floating, or a zone no one knows).
    Floating(NaiveDateTime),
}

impl Moment {
    /// `2026-09-20` for a day, `2026-09-20T07:00:00Z` for an instant, `2026-09-20T09:00:00` floating.
    pub fn text(self) -> String {
        match self {
            Self::Date(date) => date.format("%Y-%m-%d").to_string(),
            Self::Utc(time) => time.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            Self::Floating(time) => jscal::format_local(time),
        }
    }

    fn shifted(self, seconds: i64) -> Self {
        let delta = TimeDelta::try_seconds(seconds).unwrap_or_default();
        match self {
            Self::Date(date) => Self::Date(
                date.checked_add_signed(TimeDelta::try_days(seconds / 86_400).unwrap_or_default()).unwrap_or(date),
            ),
            Self::Utc(time) => Self::Utc(time.checked_add_signed(delta).unwrap_or(time)),
            Self::Floating(time) => Self::Floating(time.checked_add_signed(delta).unwrap_or(time)),
        }
    }

    /// The instant, where there is one.
    pub fn utc(self) -> Option<DateTime<Utc>> {
        match self {
            Self::Utc(time) => Some(time),
            _ => None,
        }
    }
}

/// A `TZID` as a zone: IANA, Windows (Outlook), or the `/mozilla.org/…/Europe/Berlin` kind.
fn zone_of(tzid: &str) -> Option<chrono_tz::Tz> {
    let tzid = tzid.trim().trim_matches('"');
    graph_cal::zone(tzid).or_else(|| {
        // The last two segments of a path-like name.
        let mut parts = tzid.rsplit('/');
        let city = parts.next()?;
        let area = parts.next()?;
        jscal::parse_zone(&format!("{area}/{city}"))
    })
}

/// The moment of a `DTSTART`, `DTEND` or `RECURRENCE-ID` line. Only ASCII digits are cut up, so
/// a value with other characters is no date (never a panic at a byte inside a character).
pub fn moment(property: &Property) -> Option<Moment> {
    let value = property.value.trim();
    if !value.is_ascii() {
        return None;
    }
    let date = |text: &str| {
        (text.len() == 8 && text.bytes().all(|b| b.is_ascii_digit()))
            .then(|| NaiveDate::parse_from_str(text, "%Y%m%d").ok())
            .flatten()
            .filter(|date| (1..=9999).contains(&chrono::Datelike::year(date)))
    };
    let is_date = property.param("VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE")) || !value.contains('T');
    if is_date {
        return date(value).map(Moment::Date);
    }
    let (day, time) = value.split_once('T')?;
    let day = date(day)?;
    let (time, utc) = match time.strip_suffix(['Z', 'z']) {
        Some(time) => (time, true),
        None => (time, false),
    };
    if time.len() != 6 || !time.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let local = day.and_time(chrono::NaiveTime::parse_from_str(time, "%H%M%S").ok()?);
    if utc {
        return Some(Moment::Utc(local.and_utc()));
    }
    match property.param("TZID").and_then(zone_of) {
        Some(zone) => Some(Moment::Utc(jscal::to_utc(local, zone))),
        None => Some(Moment::Floating(local)),
    }
}

/// A TEXT value as shown: unescaped, without control characters but line breaks, at most `max` characters.
fn shown_text(value: &str, max: usize) -> String {
    let text = itip::unescape(value);
    let mut out: String = text.chars().filter(|c| !c.is_control() || *c == '\n').take(max).collect();
    if out.trim().is_empty() {
        out.clear();
    }
    out.trim().to_string()
}

/// A name from a `CN` parameter: one line, no control characters.
fn shown_name(value: Option<&str>) -> Option<String> {
    let name: String =
        value?.chars().map(|c| if c.is_control() { ' ' } else { c }).take(MAX_TEXT_CHARS).collect::<String>();
    let name = name.trim().trim_matches('"').trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Someone an event names, with their answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub email: String,
    pub name: Option<String>,
    pub status: Partstat,
}

/// What a mail's iCalendar part says.
#[derive(Debug, Clone)]
pub struct Invite {
    /// The whole object, as it came.
    pub calendar: Component,
    pub method: Method,
    pub uid: String,
    pub sequence: i64,
    /// The single date the mail is about when it names no whole event (only `RECURRENCE-ID`s).
    pub occurrence: Option<Moment>,
    pub organizer: Option<Person>,
    /// Everyone the event (or the date) invites, each once.
    pub attendees: Vec<Person>,
    pub title: String,
    pub location: String,
    pub start: Option<Moment>,
    pub end: Option<Moment>,
    pub repeats: bool,
    /// The event (or the date) says it is cancelled, by METHOD or STATUS.
    pub cancelled: bool,
}

impl Invite {
    pub fn all_day(&self) -> bool {
        matches!(self.start, Some(Moment::Date(_)))
    }

    /// The attendee with one of `own` (lower case) as their address.
    pub fn own_attendee(&self, own: &[String]) -> Option<&Person> {
        self.attendees.iter().find(|person| own.contains(&person.email))
    }

    pub fn organizer_email(&self) -> Option<&str> {
        self.organizer.as_ref().map(|person| person.email.as_str())
    }
}

/// Reads a mail's iCalendar part. `None` for anything that isn't a scheduling object with an event.
pub fn read(text: &str) -> Option<Invite> {
    if text.len() > MAX_ICS_BYTES {
        return None;
    }
    let calendar = Component::parse(text)?;
    let main = calendar.main_event()?;
    let uid = main.value("UID").map(str::trim).filter(|uid| !uid.is_empty())?;
    if uid.chars().count() > MAX_UID_CHARS || uid.chars().any(char::is_control) {
        return None;
    }
    let uid = uid.to_string();
    let occurrence = calendar
        .events()
        .all(|event| event.recurrence_id().is_some())
        .then(|| main.property("RECURRENCE-ID").and_then(moment))
        .flatten();
    let organizer = main.property("ORGANIZER").and_then(|property| {
        Some(Person { email: property.address()?, name: shown_name(property.param("CN")), status: Partstat::Accepted })
    });
    let mut attendees: Vec<Person> = Vec::new();
    for property in main.properties_named("ATTENDEE") {
        let Some(email) = property.address() else { continue };
        if attendees.iter().any(|known| known.email == email) {
            continue;
        }
        attendees.push(Person {
            email,
            name: shown_name(property.param("CN")),
            status: Partstat::from_ical(property.param("PARTSTAT").unwrap_or("NEEDS-ACTION")),
        });
    }
    let start = main.property("DTSTART").and_then(moment);
    let end = main.property("DTEND").and_then(moment).or_else(|| {
        let seconds = jscal::parse_duration(main.value("DURATION")?)?;
        Some(start?.shifted(seconds))
    });
    let method = Method::of(calendar.value("METHOD"));
    Some(Invite {
        method,
        sequence: itip::sequence(&calendar),
        occurrence,
        organizer,
        attendees,
        title: shown_text(main.value("SUMMARY").unwrap_or_default(), MAX_TEXT_CHARS),
        location: shown_text(main.value("LOCATION").unwrap_or_default(), MAX_TEXT_CHARS),
        start,
        end,
        repeats: main.property("RRULE").is_some() || main.property("RDATE").is_some(),
        cancelled: method == Method::Cancel
            || main.value("STATUS").is_some_and(|s| s.trim().eq_ignore_ascii_case("CANCELLED")),
        uid,
        calendar,
    })
}

/// A lower-case mail address, if `value` is one (`From` of a mail).
pub fn plain_address(value: &str) -> Option<String> {
    let address = value.trim().trim_start_matches("mailto:").trim().to_lowercase();
    (address.contains('@') && !address.contains(|c: char| c.is_whitespace() || c.is_control() || c == '<' || c == '>'))
        .then_some(address)
}

/// Whether the mail may speak for the event, the way the UwUMail server checks it (security-audit
/// 0.16.0 WEBMAIL-2): an invitation, an update or a cancellation only from its organizer; an
/// answer only from someone it names. `from` is the mail's From, lower case.
pub fn from_may_say(invite: &Invite, from: &str) -> bool {
    match invite.method {
        Method::Reply => invite.attendees.iter().any(|person| person.email == from),
        _ => invite.organizer_email() == Some(from),
    }
}

/// Text for a TEXT value (RFC 5545, 3.3.11): escaped, one line per `\n`, no other control characters.
fn escaped(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// A comment as it goes out: trimmed, at most [`MAX_COMMENT_CHARS`]; `None` when empty.
pub fn clean_comment(comment: Option<&str>) -> Option<String> {
    let comment: String = comment?.replace("\r\n", "\n").chars().take(MAX_COMMENT_CHARS).collect();
    let comment = comment.trim();
    (!comment.is_empty()).then(|| comment.to_string())
}

/// The REPLY to the organizer: `me` answers `status` for every event of the mail's object that
/// invites them (RFC 5546, 3.2.3), with a comment if there is one.
pub fn reply(invite: &Invite, me: &str, status: Partstat, comment: Option<&str>, now: i64) -> Component {
    let mut out = itip::reply(&invite.calendar, me, Some(status.ical()), now);
    if let Some(comment) = comment {
        for event in out.components.iter_mut().filter(|c| c.name == "VEVENT") {
            event.properties.push(Property::new("COMMENT", escaped(comment)));
        }
    }
    out
}

/// The events of `calendar` with this recurrence id (`None`: the series or a single event).
fn event_index(calendar: &Component, rid: &Option<String>) -> Option<usize> {
    calendar.components.iter().position(|c| c.name == "VEVENT" && c.recurrence_id() == *rid)
}

/// The attendee's own copy of the event after the mail: the organizer's object (or, for a mail
/// about single dates, the stored series with those dates replaced), the attendee's alarms and,
/// while the times stay, their answers. With `status`, `me` answered that for every event the
/// mail names. The organizer's line carries `SCHEDULE-AGENT=CLIENT`: the app tells the organizer
/// itself, so a CalDAV server must not send its own reply too (RFC 6638, 7.1).
pub fn attendee_copy(
    invite: &Invite,
    current: Option<&Component>,
    own: &[String],
    me: &str,
    status: Option<Partstat>,
) -> Component {
    let fresh = itip::attendee_copy(&invite.calendar, current, own);
    let mut copy = match current {
        Some(current) if invite.calendar.events().all(|e| e.recurrence_id().is_some()) => {
            let mut merged = current.clone();
            merged.remove("METHOD");
            for event in fresh.events() {
                let rid = event.recurrence_id();
                match event_index(&merged, &rid) {
                    Some(index) => merged.components[index] = event.clone(),
                    None => merged.components.push(event.clone()),
                }
            }
            merged
        }
        _ => fresh,
    };
    let named: Vec<Option<String>> = invite.calendar.events().map(Component::recurrence_id).collect();
    for event in copy.components.iter_mut().filter(|c| c.name == "VEVENT") {
        let in_mail = named.contains(&event.recurrence_id());
        for property in event.properties.iter_mut() {
            if property.name == "ATTENDEE" && property.address().as_deref() == Some(me) && in_mail {
                if let Some(status) = status {
                    property.set_param("PARTSTAT", status.ical());
                    property.remove_param("RSVP");
                }
            } else if property.name == "ORGANIZER" {
                property.set_param("SCHEDULE-AGENT", "CLIENT");
            }
        }
    }
    if copy.property("PRODID").is_none() {
        copy.properties.push(Property::new("PRODID", "-//UwUMail//Client//EN"));
    }
    if copy.property("VERSION").is_none() {
        copy.properties.insert(0, Property::new("VERSION", "2.0"));
    }
    copy
}

/// How an answer of `me` stands in a stored copy: of the date the mail names, else of the event.
pub fn answer_in(copy: &Component, invite: &Invite, me: &str) -> Partstat {
    let wanted = invite.calendar.main_event().and_then(Component::recurrence_id);
    let answers = itip::partstats(copy, me);
    answers
        .iter()
        .find(|(rid, _)| *rid == wanted)
        .or_else(|| answers.iter().find(|(rid, _)| rid.is_none()))
        .map_or(Partstat::NeedsAction, |(_, status)| Partstat::from_ical(status))
}

/// Whether a stored copy is newer than the mail, the same, or older (RFC 5546, 2.1.5: SEQUENCE).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Revision {
    /// Nothing is stored yet.
    New,
    /// The stored copy is this version.
    Same,
    /// The mail changes the stored copy.
    Update,
    /// The calendar already has a newer version: the mail is out of date.
    Outdated,
}

pub fn revision(stored: Option<i64>, mail: i64) -> Revision {
    match stored {
        None => Revision::New,
        Some(stored) if stored > mail => Revision::Outdated,
        Some(stored) if stored < mail => Revision::Update,
        Some(_) => Revision::Same,
    }
}

/// What remains of a stored copy once the organizer cancelled what the mail names: `None` when the
/// whole event goes, else the series without the cancelled dates (`EXDATE`, overrides removed).
pub fn without_cancelled(copy: &Component, invite: &Invite) -> Option<Component> {
    let dates: Vec<Property> =
        invite.calendar.events().filter_map(|event| event.property("RECURRENCE-ID").cloned()).collect();
    if dates.is_empty() || invite.calendar.events().any(|event| event.recurrence_id().is_none()) {
        return None;
    }
    let mut out = copy.clone();
    let rids: Vec<String> = dates.iter().map(|date| date.value.trim().to_string()).collect();
    out.components.retain(|c| !(c.name == "VEVENT" && c.recurrence_id().is_some_and(|rid| rids.contains(&rid))));
    let series = out.components.iter_mut().find(|c| c.name == "VEVENT" && c.recurrence_id().is_none())?;
    for date in dates {
        let mut exdate = date;
        exdate.name = "EXDATE".into();
        exdate.remove_param("RANGE");
        series.properties.push(exdate);
    }
    let sequence = itip::sequence(&invite.calendar).max(itip::sequence(copy));
    series.set(Property::new("SEQUENCE", sequence.to_string()));
    Some(out)
}

/// The language of the text part of an answer mail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    De,
    #[default]
    En,
}

impl Language {
    pub fn of(code: Option<&str>) -> Self {
        match code.map(|c| c.trim().to_ascii_lowercase()) {
            Some(code) if code == "de" || code.starts_with("de-") => Self::De,
            _ => Self::En,
        }
    }
}

/// The subject and text of an answer mail, as the UwUMail server writes them.
pub fn reply_texts(
    language: Language,
    status: Partstat,
    who: &str,
    title: &str,
    when: &str,
    place: &str,
) -> (String, String) {
    let (untitled, when_label, place_label, footer) = match language {
        Language::De => {
            ("Termin", "Wann", "Wo", "Ihr Kalenderprogramm kann diese Nachricht aus dem Anhang übernehmen.")
        }
        Language::En => ("Event", "When", "Where", "Your calendar app can take this message from the attachment."),
    };
    let title = if title.trim().is_empty() { untitled } else { title.trim() };
    let (prefix, sentence) = match (language, status) {
        (Language::De, Partstat::Accepted) => ("Angenommen", format!("{who} hat die Einladung angenommen:")),
        (Language::De, Partstat::Declined) => ("Abgelehnt", format!("{who} hat die Einladung abgelehnt:")),
        (Language::De, Partstat::Tentative) => {
            ("Vorbehaltlich", format!("{who} hat die Einladung vorbehaltlich angenommen:"))
        }
        (Language::De, Partstat::NeedsAction) => ("Antwort", format!("{who} hat auf die Einladung geantwortet:")),
        (Language::En, Partstat::Accepted) => ("Accepted", format!("{who} accepted the invitation:")),
        (Language::En, Partstat::Declined) => ("Declined", format!("{who} declined the invitation:")),
        (Language::En, Partstat::Tentative) => ("Tentative", format!("{who} tentatively accepted the invitation:")),
        (Language::En, Partstat::NeedsAction) => ("Reply", format!("{who} replied to the invitation:")),
    };
    let mut body = format!("{sentence}\n\n{title}\n");
    if !when.is_empty() {
        body.push_str(&format!("{when_label}: {when}\n"));
    }
    if !place.is_empty() {
        body.push_str(&format!("{place_label}: {place}\n"));
    }
    body.push_str(&format!("\n{footer}\n"));
    (format!("{prefix}: {title}"), body)
}

fn single_line(text: &str) -> String {
    text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().to_string()
}

fn mailbox(address: &Address) -> Result<Mailbox> {
    let email = address
        .email
        .trim()
        .parse()
        .map_err(|_| Error::invalid(format!("\"{}\" isn't a valid email address.", single_line(&address.email))))?;
    Ok(Mailbox::new(address.name.as_deref().map(single_line).filter(|n| !n.is_empty()), email))
}

/// The answer as a mail (RFC 6047): a text for people, the REPLY for calendar programs, and the
/// same as an attachment for programs that only look there.
pub fn reply_mail(
    from: &Address,
    organizer: &Address,
    reply: &Component,
    status: Partstat,
    comment: Option<&str>,
    language: Language,
) -> Result<Message> {
    let summary = itip::summary(reply);
    let who = from.name.as_deref().map(single_line).filter(|n| !n.is_empty()).unwrap_or_else(|| from.email.clone());
    let (subject, mut body) = reply_texts(language, status, &who, &summary.title, &summary.when, &summary.location);
    if let Some(comment) = comment {
        body = format!("{comment}\n\n---\n{body}");
    }
    let ics = reply.to_ics();
    let calendar_type = |kind: &str| {
        ContentType::parse(&format!("{kind}; method=REPLY; charset=utf-8"))
            .map_err(|_| Error::internal("The answer couldn't be built."))
    };
    let alternative = MultiPart::alternative()
        .singlepart(SinglePart::plain(body))
        .singlepart(SinglePart::builder().header(calendar_type("text/calendar")?).body(ics.clone()));
    let mixed = MultiPart::mixed()
        .multipart(alternative)
        .singlepart(Attachment::new("invite.ics".into()).body(ics, calendar_type("application/ics")?));
    Message::builder()
        .from(mailbox(from)?)
        .to(mailbox(organizer)?)
        .subject(single_line(&subject))
        .message_id(Some(format!("<{}>", crate::smtp::new_message_id(&from.email))))
        .user_agent("UwUMail".into())
        .multipart(mixed)
        .map_err(|e| Error::invalid(format!("Couldn't build the answer: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const INVITE: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//Test//EN\r\nMETHOD:REQUEST\r\n\
BEGIN:VEVENT\r\nUID:kaffee@example.org\r\nDTSTAMP:20260917T080000Z\r\n\
DTSTART;TZID=W. Europe Standard Time:20260920T090000\r\nDTEND;TZID=W. Europe Standard Time:20260920T100000\r\n\
SUMMARY:Kaffee\\, Kuchen\r\nLOCATION:Café Nyu\r\nSEQUENCE:2\r\nRRULE:FREQ=WEEKLY\r\n\
ORGANIZER;CN=Emma Vogt:mailto:Emma@Example.org\r\n\
ATTENDEE;CN=Emma Vogt;PARTSTAT=ACCEPTED:mailto:emma@example.org\r\n\
ATTENDEE;CN=Mini;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:Mini@Example.com\r\n\
ATTENDEE;PARTSTAT=TENTATIVE:mailto:leni@example.net\r\n\
BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    fn own() -> Vec<String> {
        vec!["mini@example.com".into()]
    }

    #[test]
    fn reads_what_the_reader_shows() {
        let invite = read(INVITE).unwrap();
        assert_eq!(invite.method, Method::Request);
        assert_eq!(invite.uid, "kaffee@example.org");
        assert_eq!(invite.sequence, 2);
        assert_eq!(invite.title, "Kaffee, Kuchen");
        assert_eq!(invite.location, "Café Nyu");
        assert_eq!(invite.organizer_email(), Some("emma@example.org"));
        assert_eq!(invite.organizer.as_ref().unwrap().name.as_deref(), Some("Emma Vogt"));
        // The Windows zone is Berlin: 09:00 there is 07:00 UTC in September.
        assert_eq!(invite.start.unwrap().text(), "2026-09-20T07:00:00Z");
        assert_eq!(invite.end.unwrap().text(), "2026-09-20T08:00:00Z");
        assert!(invite.repeats);
        assert!(!invite.cancelled);
        assert!(invite.occurrence.is_none());
        assert_eq!(invite.attendees.len(), 3);
        assert_eq!(invite.own_attendee(&own()).unwrap().status, Partstat::NeedsAction);
        assert_eq!(invite.attendees[2].status, Partstat::Tentative);
        assert!(from_may_say(&invite, "emma@example.org"));
        assert!(!from_may_say(&invite, "mallory@example.net"));
    }

    #[test]
    fn times_of_every_kind() {
        let at = |line: &str| {
            let text = format!(
                "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\n{line}\r\nDURATION:P1D\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
            );
            let invite = read(&text).unwrap();
            (invite.start.map(Moment::text), invite.end.map(Moment::text))
        };
        assert_eq!(at("DTSTART;VALUE=DATE:20261003"), (Some("2026-10-03".into()), Some("2026-10-04".into())));
        assert_eq!(at("DTSTART:20261003T100000Z").0.as_deref(), Some("2026-10-03T10:00:00Z"));
        assert_eq!(at("DTSTART;TZID=Europe/Berlin:20261003T100000").0.as_deref(), Some("2026-10-03T08:00:00Z"));
        assert_eq!(
            at("DTSTART;TZID=/mozilla.org/20070129_1/Europe/Berlin:20261003T100000").0.as_deref(),
            Some("2026-10-03T08:00:00Z")
        );
        assert_eq!(at("DTSTART;TZID=Somewhere odd:20261003T100000").0.as_deref(), Some("2026-10-03T10:00:00"));
        assert_eq!(at("DTSTART:20261003T100000").0.as_deref(), Some("2026-10-03T10:00:00"));
        // No dates, no panics: characters where digits belong, cut values, years off the calendar.
        for odd in [
            "DTSTART:202é1003T100000Z",
            "DTSTART:2026",
            "DTSTART:00000000T000000Z",
            "DTSTART:20261003T1é0000",
            "DTSTART:",
        ] {
            assert_eq!(at(odd).0, None, "{odd}");
        }
    }

    #[test]
    fn answers_go_to_the_organizer_with_a_comment() {
        let invite = read(INVITE).unwrap();
        let reply = reply(
            &invite,
            "mini@example.com",
            Partstat::Accepted,
            Some("Bringe Kuchen; mit Sahne, klar\nBis dann"),
            1_790_000_000,
        );
        let text = reply.to_ics();
        let back = Component::parse(&text).unwrap();
        assert_eq!(itip::method(&back).as_deref(), Some("REPLY"));
        assert_eq!(itip::uid(&back).as_deref(), Some("kaffee@example.org"));
        assert_eq!(itip::sequence(&back), 2);
        let attendees = itip::attendees(&back);
        assert_eq!(attendees.len(), 1, "only the one who answers: {text}");
        assert_eq!(attendees[0].address, "mini@example.com");
        assert_eq!(attendees[0].partstat, "ACCEPTED");
        assert!(!text.contains("RSVP"), "{text}");
        assert!(!text.contains("VALARM"), "{text}");
        let event = back.main_event().unwrap();
        assert_eq!(itip::unescape(event.value("COMMENT").unwrap()), "Bringe Kuchen; mit Sahne, klar\nBis dann");
        assert!(event.value("ORGANIZER").is_some());

        // Read the way the organizer's server reads it: the answer lands in their copy.
        let mut organizer_copy = Component::parse(INVITE).unwrap();
        assert!(itip::apply_reply(&mut organizer_copy, &back, "mini@example.com"));
        assert_eq!(itip::partstats(&organizer_copy, "mini@example.com"), vec![(None, "ACCEPTED".to_string())]);
    }

    #[test]
    fn the_answer_mail_carries_the_reply() {
        let invite = read(INVITE).unwrap();
        let reply = reply(&invite, "mini@example.com", Partstat::Declined, None, 1_790_000_000);
        let from = Address { name: Some("Mini".into()), email: "mini@example.com".into() };
        let to = Address { name: Some("Emma\r\nBcc: x@example.net".into()), email: "emma@example.org".into() };
        let mail = reply_mail(&from, &to, &reply, Partstat::Declined, None, Language::De).unwrap();
        let raw = String::from_utf8(mail.formatted()).unwrap();
        assert!(raw.contains("Subject: Abgelehnt: Kaffee, Kuchen"), "{raw}");
        assert!(raw.contains("text/calendar; method=REPLY; charset=utf-8"), "{raw}");
        assert!(raw.contains("application/ics"), "{raw}");
        assert!(!raw.contains("\r\nBcc:"), "a name never starts a header: {raw}");
        use mail_parser::MimeHeaders;
        let parsed = mail_parser::MessageParser::default().parse(raw.as_bytes()).unwrap();
        let calendar = parsed
            .parts
            .iter()
            .find(|part| part.content_type().is_some_and(|ct| ct.ctype() == "text" && ct.subtype() == Some("calendar")))
            .and_then(|part| part.text_contents())
            .unwrap();
        let back = Component::parse(calendar).unwrap();
        assert_eq!(itip::partstats(&back, "mini@example.com"), vec![(None, "DECLINED".to_string())]);
        assert!(
            reply_mail(
                &from,
                &Address { name: None, email: "not an address".into() },
                &reply,
                Partstat::Declined,
                None,
                Language::En
            )
            .is_err()
        );
    }

    #[test]
    fn the_own_copy_keeps_answers_alarms_and_tells_no_server() {
        let invite = read(INVITE).unwrap();
        let copy = attendee_copy(&invite, None, &own(), "mini@example.com", Some(Partstat::Tentative));
        let text = copy.to_ics();
        assert!(copy.property("METHOD").is_none(), "{text}");
        assert_eq!(answer_in(&copy, &invite, "mini@example.com"), Partstat::Tentative);
        assert!(text.contains("SCHEDULE-AGENT=CLIENT"), "{text}");
        assert!(!text.contains("VALARM"), "the organizer's alarms stay theirs: {text}");
        // It reads back, also through calcard, as the calendars do.
        assert!(super::super::ical::parse(&text).is_ok());

        // An update at another time: the answer is asked for again.
        let moved = INVITE.replace("20260920T090000", "20260921T090000").replace("SEQUENCE:2", "SEQUENCE:3");
        let update = read(&moved).unwrap();
        assert_eq!(revision(Some(itip::sequence(&copy)), update.sequence), Revision::Update);
        let updated = attendee_copy(&update, Some(&copy), &own(), "mini@example.com", None);
        assert_eq!(answer_in(&updated, &update, "mini@example.com"), Partstat::NeedsAction);
        // The same time: the answer stays.
        let retitled = INVITE.replace("Kaffee\\, Kuchen", "Kaffee").replace("SEQUENCE:2", "SEQUENCE:3");
        let same_time = read(&retitled).unwrap();
        let kept = attendee_copy(&same_time, Some(&copy), &own(), "mini@example.com", None);
        assert_eq!(answer_in(&kept, &same_time, "mini@example.com"), Partstat::Tentative);
        // An older mail than the calendar has.
        assert_eq!(revision(Some(3), 2), Revision::Outdated);
        assert_eq!(revision(None, 0), Revision::New);
    }

    #[test]
    fn single_dates_change_and_go_on_their_own() {
        let invite = read(INVITE).unwrap();
        let copy = attendee_copy(&invite, None, &own(), "mini@example.com", Some(Partstat::Accepted));
        let one_date = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:kaffee@example.org\r\n\
RECURRENCE-ID;TZID=W. Europe Standard Time:20260927T090000\r\nDTSTART;TZID=W. Europe Standard Time:20260927T110000\r\n\
DTEND;TZID=W. Europe Standard Time:20260927T120000\r\nSUMMARY:Kaffee später\r\nSEQUENCE:2\r\n\
ORGANIZER;CN=Emma Vogt:mailto:emma@example.org\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:mini@example.com\r\n\
END:VEVENT\r\nEND:VCALENDAR\r\n";
        let moved = read(one_date).unwrap();
        assert_eq!(moved.occurrence.unwrap().text(), "2026-09-27T07:00:00Z");
        let merged = attendee_copy(&moved, Some(&copy), &own(), "mini@example.com", Some(Partstat::Declined));
        assert_eq!(merged.events().count(), 2, "the series stays, the date is added");
        assert_eq!(answer_in(&merged, &moved, "mini@example.com"), Partstat::Declined);
        assert_eq!(answer_in(&merged, &invite, "mini@example.com"), Partstat::Accepted, "the series keeps its answer");

        let cancel_one = one_date.replace("METHOD:REQUEST", "METHOD:CANCEL");
        let cancel = read(&cancel_one).unwrap();
        assert!(cancel.cancelled);
        let left = without_cancelled(&merged, &cancel).unwrap();
        assert_eq!(left.events().count(), 1);
        assert!(left.to_ics().contains("EXDATE;TZID=W. Europe Standard Time:20260927T090000"), "{}", left.to_ics());
        let whole = read(&INVITE.replace("METHOD:REQUEST", "METHOD:CANCEL")).unwrap();
        assert!(without_cancelled(&merged, &whole).is_none(), "the whole event goes");
    }

    /// Strangers send these: none may panic, hang or be read as an invitation.
    #[test]
    fn hostile_parts_are_no_invitations() {
        let started = std::time::Instant::now();
        let deep = format!(
            "BEGIN:VCALENDAR\r\n{}{}END:VCALENDAR\r\n",
            "BEGIN:VEVENT\r\n".repeat(10_000),
            "END:VEVENT\r\n".repeat(10_000)
        );
        assert!(read(&deep).is_none());
        let huge = format!(
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:{}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
            "a".repeat(MAX_ICS_BYTES)
        );
        assert!(read(&huge).is_none());
        let lines = format!(
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\n{}END:VEVENT\r\nEND:VCALENDAR\r\n",
            "X-A:b\r\n".repeat(120_000)
        );
        assert!(read(&lines).is_none());
        let long_uid =
            format!("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:{}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n", "u".repeat(2000));
        assert!(read(&long_uid).is_none());
        assert!(read("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:no uid\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n").is_none());
        assert!(read("BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:t\r\nEND:VTODO\r\nEND:VCALENDAR\r\n").is_none());
        assert!(read("not a calendar at all").is_none());
        assert!(read(" folded first line\r\nBEGIN:VCALENDAR\r\n").is_none());
        // Names and texts: control characters out, cut by characters, folded lines in the middle of one.
        let odd = format!(
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:o\r\nSUMMARY:{}\r\n \u{1F431}\u{0007}end\r\n\
ORGANIZER;CN=\"Evil\u{202E}Name\":mailto:evil@example.net\r\nATTENDEE;CN=\u{0000}:mailto:a@example.com\r\n\
ATTENDEE:http://example.com/not-mail\r\nDURATION:P99999999999999999999D\r\nDTSTART:20261003T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
            "ä".repeat(600)
        );
        let invite = read(&odd).unwrap();
        assert_eq!(invite.title.chars().count(), MAX_TEXT_CHARS);
        assert_eq!(invite.attendees.len(), 1);
        assert_eq!(invite.attendees[0].name, None);
        assert!(invite.end.is_none());
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        // A part with many attendees reads them all once (the reader shows the first ones).
        let many = format!(
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:m\r\n{}END:VEVENT\r\nEND:VCALENDAR\r\n",
            (0..3000)
                .map(|n| format!("ATTENDEE:mailto:p{}@example.com\r\nATTENDEE:mailto:p{}@example.com\r\n", n, n))
                .collect::<String>()
        );
        assert_eq!(read(&many).unwrap().attendees.len(), 3000);
    }

    #[test]
    fn comments_and_languages() {
        assert_eq!(clean_comment(Some("  ")), None);
        assert_eq!(clean_comment(None), None);
        assert_eq!(clean_comment(Some(&"ö".repeat(3000))).unwrap().chars().count(), MAX_COMMENT_CHARS);
        assert_eq!(escaped("a,b;c\\d\ne\u{7}"), "a\\,b\\;c\\\\d\\ne");
        assert_eq!(Language::of(Some("de-AT")), Language::De);
        assert_eq!(Language::of(Some("en")), Language::En);
        assert_eq!(Language::of(None), Language::En);
        let (subject, body) = reply_texts(Language::En, Partstat::Tentative, "Mini", "", "2026-09-20 09:00 (UTC)", "");
        assert_eq!(subject, "Tentative: Event");
        assert!(body.contains("When: 2026-09-20 09:00 (UTC)"));
        assert_eq!(Partstat::from_ical("delegated"), Partstat::NeedsAction);
        assert_eq!(plain_address("Mini@Example.COM"), Some("mini@example.com".into()));
        assert_eq!(plain_address("a b@example.com"), None);
    }
}
