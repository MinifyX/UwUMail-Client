//! Birthdays kept as events in other calendars, found and matched to contacts: what the UwUMail
//! server's `Birthdays/scan` does (UwUMail-Server `docs/birthdays.md`, "Moving birthdays out of
//! other calendars"), done by the app for mailboxes with CalDAV calendars and CardDAV contacts,
//! with the same rules and limits. The shapes here are also what the app gets from the server.
//!
//! Names are compared by characters, never bytes: lower case, with umlauts both spelled out
//! ("Müller" = "Mueller") and without their dots ("Müller" = "Muller"), and other accents dropped.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{DateKind, PartialDate, card_dates, card_name, is_group, name_part};

/// Events looked at in one scan, and candidates it returns at most.
pub const MAX_SCANNED_EVENTS: usize = 20_000;
pub const MAX_CANDIDATES: usize = 1_000;
/// Contacts offered for one ambiguous name.
pub const MAX_OPTIONS: usize = 10;
/// Entries one import takes at most, as the server's `maxImport`.
pub const MAX_IMPORT: usize = 500;
/// The longest name a title gives, in characters.
const MAX_NAME_CHARS: usize = 200;
/// Titles longer than this are no birthday entries.
const MAX_TITLE_CHARS: usize = 300;

// ------------------------------------------------------------------------------------------------
// What the app sees (camelCase, as the UI and the server's scan spell it)

/// How a found birthday fits the contacts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BirthdayMatch {
    /// One contact, without a birthday (or the same day without the year): moved without asking.
    Matched,
    /// One contact that has this very birthday: only the event is left to delete.
    Known,
    /// One contact with another birthday: the person decides.
    Conflict,
    /// Several contacts: the person picks one.
    Ambiguous,
    /// None: a new contact, or another one the person picks.
    Unmatched,
}

/// A contact a found birthday may belong to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BirthdayChoice {
    pub contact_id: String,
    #[serde(default)]
    pub address_book_id: Option<String>,
    pub name: String,
    /// "YYYY-MM-DD" or "--MM-DD": the birthday it has already.
    pub birthday: Option<String>,
}

/// A birthday event found in one of the account's calendars.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BirthdayCandidate {
    pub event_id: String,
    pub calendar_id: String,
    pub title: String,
    /// The name read from the title.
    pub name: String,
    /// "YYYY-MM-DD", or "--MM-DD" without a year.
    pub birthday: String,
    /// The event said it is a birthday on its own (a category, KDE's property, Google's uid).
    #[serde(default)]
    pub marked: bool,
    /// The event can be deleted afterwards; not in a calendar that is only read.
    pub may_delete_event: bool,
    #[serde(rename = "match")]
    pub state: BirthdayMatch,
    /// Up to ten contacts it may belong to, the match first.
    pub contacts: Vec<BirthdayChoice>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BirthdayScan {
    pub candidates: Vec<BirthdayCandidate>,
    /// There were more events or candidates than one scan looks at.
    pub truncated: bool,
}

/// What to do with one found birthday: into a contact (`contactId`), or into a new one
/// (`newContactName`). Events left out stay as they are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BirthdayImportEntry {
    pub event_id: String,
    #[serde(default)]
    pub contact_id: Option<String>,
    /// Replace another birthday the contact has.
    #[serde(default)]
    pub overwrite: bool,
    #[serde(default)]
    pub new_contact_name: Option<String>,
    /// Where a new contact goes; the default address book without.
    #[serde(default)]
    pub address_book_id: Option<String>,
    /// False keeps the event; it is deleted by default.
    #[serde(default)]
    pub delete_event: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BirthdayImported {
    pub event_id: String,
    pub contact_id: String,
    pub created: bool,
    pub event_deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BirthdayFailed {
    pub event_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BirthdayImportResult {
    pub imported: Vec<BirthdayImported>,
    pub failed: Vec<BirthdayFailed>,
}

/// What birthdays can do for an account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BirthdayFeatures {
    pub account_id: String,
    /// The mail server keeps the birthdays calendar and per-contact reminders (a UwUMail server).
    pub server: bool,
    /// Birthday events of other calendars can be moved into the contacts.
    pub import: bool,
}

// ------------------------------------------------------------------------------------------------
// Names

/// Words of a title that say "birthday", in the forms people write them, after [`fold`].
const BIRTHDAY_WORDS: &[&str] = &[
    "geburtstag",
    "geburtstage",
    "geb",
    "geburtsdatum",
    "birthday",
    "bday",
    "b day",
    "bd",
    "hbd",
    "cumpleanos",
    "anniversaire",
    "verjaardag",
    "compleanno",
];
/// Words around the name that are not part of it.
const FILLER_WORDS: &[&str] =
    &["von", "vom", "der", "des", "hat", "of", "happy", "alles", "gute", "zum", "has", "is", "de", "van", "di", "la"];
/// Pictures people put into birthday titles.
const BIRTHDAY_SIGNS: &[char] = &['🎂', '🎉', '🎈', '🎁', '🥳', '🍰', '🧁', '🎊'];

/// Lower case, umlauts spelled out (`ü` → `ue`), accents dropped, everything that is no letter
/// or digit a space, spaces single.
pub fn fold(text: &str) -> String {
    fold_with(text, true)
}

/// As [`fold`], with umlauts losing their dots instead (`ü` → `u`).
pub fn fold_plain(text: &str) -> String {
    fold_with(text, false)
}

fn fold_with(text: &str, spell_out: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars().flat_map(char::to_lowercase) {
        let mapped: &str = match c {
            'ä' if spell_out => "ae",
            'ö' if spell_out => "oe",
            'ü' if spell_out => "ue",
            'ä' | 'à' | 'á' | 'â' | 'ã' | 'å' | 'ā' | 'ă' | 'ą' => "a",
            'ö' | 'ò' | 'ó' | 'ô' | 'õ' | 'ø' | 'ō' | 'ő' => "o",
            'ü' | 'ù' | 'ú' | 'û' | 'ū' | 'ů' | 'ű' | 'ų' => "u",
            'ß' => "ss",
            'æ' => "ae",
            'œ' => "oe",
            'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => "e",
            'ì' | 'í' | 'î' | 'ï' | 'ī' | 'į' | 'ı' => "i",
            'ç' | 'ć' | 'č' => "c",
            'ñ' | 'ń' | 'ň' => "n",
            'ł' => "l",
            'ś' | 'š' | 'ş' | 'ș' => "s",
            'ź' | 'ż' | 'ž' => "z",
            'ř' => "r",
            'ý' | 'ÿ' => "y",
            'đ' | 'ď' => "d",
            'ğ' => "g",
            'ť' | 'ț' => "t",
            'þ' => "th",
            c if c.is_alphanumeric() => {
                out.push(c);
                continue;
            }
            _ => " ",
        };
        out.push_str(mapped);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A four-digit year a title gives ("(*1990)", "1990", "b. 1990"), if it is a plausible one.
fn year_in(tokens: &[String]) -> Option<(usize, i32)> {
    tokens.iter().enumerate().find_map(|(i, token)| {
        let digits: String = token.chars().filter(char::is_ascii_digit).collect();
        let only_year = token.chars().all(|c| c.is_ascii_digit() || "()*.,:;-–[]".contains(c));
        (only_year && digits.chars().count() == 4)
            .then(|| digits.parse::<i32>().ok())
            .flatten()
            .filter(|year| (1850..=2100).contains(year))
            .map(|year| (i, year))
    })
}

/// Reads the name, and maybe the year, from a birthday title. `None` when the title says nothing
/// of a birthday and `marked` does not either, or leaves no name.
pub fn name_from_title(title: &str, marked: bool) -> Option<(String, Option<i32>)> {
    if title.chars().count() > MAX_TITLE_CHARS {
        return None;
    }
    let signed = title.chars().any(|c| BIRTHDAY_SIGNS.contains(&c));
    let cleaned: String = title.chars().map(|c| if BIRTHDAY_SIGNS.contains(&c) { ' ' } else { c }).collect();
    // "Max's birthday", "Max’ Geburtstag": the possessive goes.
    let cleaned = cleaned.replace(['’', '`', '´'], "'");
    let mut tokens: Vec<String> = cleaned.split_whitespace().map(str::to_owned).collect();
    let year = year_in(&tokens).map(|(i, year)| {
        tokens.remove(i);
        year
    });
    let mut said = signed;
    let mut name: Vec<String> = Vec::new();
    for token in tokens {
        let folded = fold(&token);
        // "b-day" folds to "b day"; "Geburtstag:" to "geburtstag". A party is no birthday.
        if BIRTHDAY_WORDS.contains(&folded.as_str()) || folded.split(' ').any(|word| word == "geburtstag") {
            said = true;
            continue;
        }
        if folded.is_empty()
            || FILLER_WORDS.contains(&folded.as_str())
            || (folded.chars().all(|c| c.is_ascii_digit()) && folded.chars().count() <= 3)
            || token.starts_with('*')
            || folded == "b"
            || folded == "s"
        {
            continue;
        }
        // Brackets and punctuation around a word go; the possessive too.
        let mut word: String = token.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'' && c != '-').to_owned();
        for suffix in ["'s", "'S", "'"] {
            if let Some(stripped) = word.strip_suffix(suffix) {
                word = stripped.to_owned();
                break;
            }
        }
        let word = word.trim_matches(|c: char| !c.is_alphanumeric()).to_owned();
        if !word.is_empty() {
            name.push(word);
        }
    }
    if !said && !marked {
        return None;
    }
    let name: String = name.join(" ").chars().take(MAX_NAME_CHARS).collect();
    (!name.is_empty()).then_some((name, year))
}

// ------------------------------------------------------------------------------------------------
// Events (iCalendar text, as CalDAV hands it out)

/// One property line of an iCalendar component.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Property {
    /// Upper case, without a group.
    name: String,
    /// Names upper case.
    params: Vec<(String, String)>,
    value: String,
}

impl Property {
    fn param(&self, name: &str) -> Option<&str> {
        self.params.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }
}

/// Splits `NAME;P=V;Q="a:b":value` at the first colon outside quotes.
fn parse_line(line: &str) -> Option<Property> {
    let mut quoted = false;
    let mut split = None;
    for (index, c) in line.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ':' if !quoted => {
                split = Some(index);
                break;
            }
            _ => {}
        }
    }
    let split = split?;
    let (head, value) = (&line[..split], &line[split + 1..]);
    let mut parts = Vec::new();
    let mut current = String::new();
    quoted = false;
    for c in head.chars() {
        match c {
            '"' => quoted = !quoted,
            ';' if !quoted => parts.push(std::mem::take(&mut current)),
            c => current.push(c),
        }
    }
    parts.push(current);
    let mut parts = parts.into_iter();
    let name = parts.next()?;
    let name = name.rsplit('.').next().unwrap_or_default().trim().to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    let params = parts
        .filter_map(|part| part.split_once('=').map(|(k, v)| (k.trim().to_ascii_uppercase(), v.trim().to_owned())))
        .collect();
    Some(Property { name, params, value: value.to_owned() })
}

/// The properties of the object's main event: the one without a `RECURRENCE-ID` (an override),
/// else the first. Properties of its alarms are not its own.
fn main_event(content: &str) -> Option<Vec<Property>> {
    let mut lines: Vec<String> = Vec::new();
    for raw in content.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        match (raw.strip_prefix([' ', '\t']), lines.last_mut()) {
            (Some(rest), Some(last)) => last.push_str(rest),
            _ => lines.push(raw.to_owned()),
        }
    }
    let mut stack: Vec<String> = Vec::new();
    let mut events: Vec<Vec<Property>> = Vec::new();
    for line in &lines {
        let Some(property) = parse_line(line) else { continue };
        match property.name.as_str() {
            "BEGIN" => {
                let component = property.value.trim().to_ascii_uppercase();
                if component == "VEVENT" && stack.last().is_some_and(|parent| parent == "VCALENDAR") {
                    events.push(Vec::new());
                }
                stack.push(component);
            }
            "END" => {
                stack.pop();
            }
            _ if stack.len() == 2 && stack[0] == "VCALENDAR" && stack[1] == "VEVENT" => {
                if let Some(event) = events.last_mut() {
                    event.push(property);
                }
            }
            _ => {}
        }
    }
    let main = events.iter().position(|event| !event.iter().any(|p| p.name == "RECURRENCE-ID")).unwrap_or(0);
    events.into_iter().nth(main)
}

/// TEXT as iCalendar escapes it (`\,` `\;` `\n` `\\`), read back; line breaks become spaces.
fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push(' '),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// A birthday found in an event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundBirthday {
    pub title: String,
    pub name: String,
    pub date: PartialDate,
    /// The event says it came from an address book (Google, KDE, a category, ...).
    pub marked: bool,
}

/// Whether an event says it is a birthday on its own: a property named like one (KDE's
/// `X-KDE-KABC-BIRTHDAY`), a category, or a uid like Google's.
fn is_marked(event: &[Property]) -> bool {
    let says = |text: &str| {
        let folded = fold(text);
        folded.contains("birthday") || folded.contains("geburtstag")
    };
    event.iter().any(|p| {
        (p.name.starts_with("X-") && p.name.contains("BIRTHDAY") && !p.name.starts_with("X-UWUMAIL"))
            || (p.name == "CATEGORIES" && says(&p.value))
            || (p.name == "UID" && p.value.to_ascii_lowercase().contains("birthday"))
    })
}

/// The birthday an event (iCalendar text) keeps, if it is one: all day, yearly (or marked), and
/// a title that names someone. The year comes from the title, or from the start of a marked
/// event, which address books write with the year of birth — not before 1900, not after
/// `this_year`.
pub fn birthday_in_event(content: &str, this_year: i32) -> Option<FoundBirthday> {
    let event = main_event(content)?;
    let property = |name: &str| event.iter().find(|p| p.name == name);
    // The server's own birthdays calendar is never read back.
    if property("X-UWUMAIL-BIRTHDAY").is_some() {
        return None;
    }
    let start = property("DTSTART")?;
    let value = start.value.trim();
    let all_day = start.param("VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE"))
        || (value.chars().count() == 8 && value.chars().all(|c| c.is_ascii_digit()));
    if !all_day {
        return None;
    }
    let marked = is_marked(&event);
    let yearly = property("RRULE").is_some_and(|rule| {
        let parts = || rule.value.split(';').map(str::trim);
        parts().any(|part| part.eq_ignore_ascii_case("FREQ=YEARLY"))
            && !parts().any(|part| {
                part.split_once('=')
                    .is_some_and(|(key, value)| key.eq_ignore_ascii_case("INTERVAL") && value.trim() != "1")
            })
    });
    if !yearly && !marked {
        return None;
    }
    let title = unescape(&property("SUMMARY")?.value).trim().to_owned();
    let (name, title_year) = name_from_title(&title, marked)?;
    let digits: String = value.chars().take(8).collect();
    if digits.chars().count() != 8 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let started = PartialDate::new(
        digits.get(0..4)?.parse().ok(),
        digits.get(4..6)?.parse().ok()?,
        digits.get(6..8)?.parse().ok()?,
    )?;
    let start_year = started.year.filter(|year| marked && *year > 1900 && *year <= this_year && *year != 1604);
    let year = title_year.or(start_year);
    let date =
        PartialDate::new(year, started.month, started.day).or(PartialDate::new(None, started.month, started.day))?;
    Some(FoundBirthday { title: title.chars().take(MAX_TITLE_CHARS).collect(), name, date, marked })
}

// ------------------------------------------------------------------------------------------------
// Matching contacts

/// A name as the keys it is compared by: spelled-out and plain umlauts, whole and in words.
#[derive(Debug, Clone)]
struct NameKeys {
    whole: [String; 2],
    words: Vec<[String; 2]>,
}

impl NameKeys {
    fn of(name: &str) -> NameKeys {
        let (spelled, plain) = (fold(name), fold_plain(name));
        let words = spelled.split(' ').zip(plain.split(' ')).map(|(a, b)| [a.to_owned(), b.to_owned()]).collect();
        NameKeys { whole: [spelled, plain], words }
    }

    fn same_as(&self, other: &NameKeys) -> bool {
        !self.whole[0].is_empty() && self.whole.iter().any(|key| other.whole.contains(key))
    }

    /// Every word of `self` is a word of `other`.
    fn words_in(&self, other: &NameKeys) -> bool {
        !self.whole[0].is_empty()
            && self.words.iter().all(|word| other.words.iter().any(|theirs| word.iter().any(|w| theirs.contains(w))))
    }
}

/// A contact that may be the person of a birthday: one the account may change.
#[derive(Debug, Clone)]
pub struct KnownCard {
    pub choice: BirthdayChoice,
    birthday: Option<PartialDate>,
    /// Its name, and the others it goes by (given + surname either way round, nicknames).
    names: Vec<NameKeys>,
}

/// A card (JSContact) as a contact to match; none for a group or a card without a name.
pub fn known_card(contact_id: &str, address_book_id: &str, card: &Value) -> Option<KnownCard> {
    if is_group(card) {
        return None;
    }
    let name = card_name(card);
    if name.is_empty() {
        return None;
    }
    let mut names = vec![NameKeys::of(&name)];
    let (given, surname) = (name_part(card, "given"), name_part(card, "surname"));
    if !given.is_empty() && !surname.is_empty() {
        names.push(NameKeys::of(&format!("{given} {surname}")));
        names.push(NameKeys::of(&format!("{surname} {given}")));
    }
    for nick in card
        .get("nicknames")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|nicknames| nicknames.values())
        .filter_map(|nick| nick.get("name").and_then(Value::as_str))
        .filter(|nick| !nick.trim().is_empty())
        .take(MAX_OPTIONS)
    {
        names.push(NameKeys::of(nick));
    }
    let birthday = card_dates(card).into_iter().find(|date| date.kind == DateKind::Birth).map(|date| date.date);
    Some(KnownCard {
        choice: BirthdayChoice {
            contact_id: contact_id.to_owned(),
            address_book_id: Some(address_book_id.to_owned()),
            name,
            birthday: birthday.map(PartialDate::format),
        },
        birthday,
        names,
    })
}

/// The cards `name` may mean: those with exactly that name when there are any, else those
/// whose names hold every word of it ("Max" for "Max Muster", "Oma" for a nickname).
fn matching<'a>(name: &str, cards: &'a [KnownCard]) -> Vec<&'a KnownCard> {
    let wanted = NameKeys::of(name);
    let exact: Vec<&KnownCard> = cards.iter().filter(|card| card.names.iter().any(|n| wanted.same_as(n))).collect();
    if !exact.is_empty() {
        return exact;
    }
    cards.iter().filter(|card| card.names.iter().any(|n| wanted.words_in(n))).collect()
}

/// The card has this birthday already: the same day, and the year when the event knows one.
pub fn same_birthday(known: &PartialDate, found: &PartialDate) -> bool {
    known.month == found.month && known.day == found.day && (found.year.is_none() || known.year == found.year)
}

/// The event only adds the year to the day the card has.
pub fn adds_year(known: &PartialDate, found: &PartialDate) -> bool {
    known.month == found.month && known.day == found.day && known.year.is_none() && found.year.is_some()
}

fn state_of(found: &PartialDate, choices: &[&KnownCard]) -> BirthdayMatch {
    match choices {
        [] => BirthdayMatch::Unmatched,
        [one] => match &one.birthday {
            None => BirthdayMatch::Matched,
            Some(known) if same_birthday(known, found) => BirthdayMatch::Known,
            Some(known) if adds_year(known, found) => BirthdayMatch::Matched,
            Some(_) => BirthdayMatch::Conflict,
        },
        _ => BirthdayMatch::Ambiguous,
    }
}

/// An event of one of the account's calendars, to look at.
#[derive(Debug, Clone)]
pub struct ScannedEvent {
    pub event_id: String,
    pub calendar_id: String,
    /// iCalendar text.
    pub content: String,
    /// Its calendar lets the event be deleted.
    pub deletable: bool,
}

/// Looks at events one by one, so a calendar's objects needn't all be kept: the birthday
/// events, each matched to the contacts. Looks at no more than [`MAX_SCANNED_EVENTS`] and keeps
/// no more than [`MAX_CANDIDATES`].
pub struct Scanner<'a> {
    cards: &'a [KnownCard],
    this_year: i32,
    seen: usize,
    found: BirthdayScan,
}

impl<'a> Scanner<'a> {
    pub fn new(cards: &'a [KnownCard], this_year: i32) -> Self {
        Scanner { cards, this_year, seen: 0, found: BirthdayScan::default() }
    }

    /// Whether it has looked at as much as one scan does.
    pub fn full(&self) -> bool {
        self.found.truncated
    }

    pub fn add(&mut self, event: &ScannedEvent) {
        if self.found.truncated {
            return;
        }
        if self.seen >= MAX_SCANNED_EVENTS {
            self.found.truncated = true;
            return;
        }
        self.seen += 1;
        let Some(found) = birthday_in_event(&event.content, self.this_year) else { return };
        if self.found.candidates.len() >= MAX_CANDIDATES {
            self.found.truncated = true;
            return;
        }
        let choices = matching(&found.name, self.cards);
        let state = state_of(&found.date, &choices);
        self.found.candidates.push(BirthdayCandidate {
            event_id: event.event_id.clone(),
            calendar_id: event.calendar_id.clone(),
            title: found.title,
            name: found.name,
            birthday: found.date.format(),
            marked: found.marked,
            may_delete_event: event.deletable,
            state,
            contacts: choices.iter().take(MAX_OPTIONS).map(|card| card.choice.clone()).collect(),
        });
    }

    pub fn finish(self) -> BirthdayScan {
        self.found
    }
}

/// [`Scanner`] over a list of events.
pub fn scan(events: &[ScannedEvent], cards: &[KnownCard], this_year: i32) -> BirthdayScan {
    let mut scanner = Scanner::new(cards, this_year);
    for event in events {
        scanner.add(event);
    }
    scanner.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(summary: &str, start: &str, extra: &str) -> String {
        format!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTAMP:20260101T000000Z\r\n\
             DTSTART;VALUE=DATE:{start}\r\nSUMMARY:{summary}\r\n{extra}END:VEVENT\r\nEND:VCALENDAR\r\n"
        )
    }

    fn yearly(summary: &str) -> String {
        event(summary, "20150412", "RRULE:FREQ=YEARLY\r\n")
    }

    fn name(summary: &str) -> Option<String> {
        birthday_in_event(&yearly(summary), 2026).map(|found| found.name)
    }

    #[test]
    fn birthday_titles_in_german_and_english() {
        for title in [
            "Geburtstag von Max",
            "Geburtstag: Max",
            "Max Geburtstag",
            "Geb. Max",
            "Max hat Geburtstag",
            "Max's birthday",
            "Max’s Birthday!",
            "Birthday of Max",
            "bday Max",
            "b-day Max",
            "Happy birthday Max",
            "🎂 Max",
            "Max 🎂",
            "🥳 Max",
        ] {
            assert_eq!(name(title).as_deref(), Some("Max"), "{title}");
        }
        assert_eq!(name("Geburtstag von Jürgen Müller").as_deref(), Some("Jürgen Müller"));
        // A party is no birthday, and a yearly event without the word isn't either.
        assert_eq!(name("Geburtstagsfeier Max"), None);
        assert_eq!(name("Steuererklärung"), None);
        assert_eq!(name("Geburtstag"), None);
    }

    #[test]
    fn the_year_comes_from_the_title_or_a_marked_start() {
        let found = birthday_in_event(&yearly("Geburtstag Max (*1990)"), 2026).unwrap();
        assert_eq!((found.name.as_str(), found.date.format()), ("Max", "1990-04-12".to_owned()));
        assert_eq!(birthday_in_event(&yearly("Max (1990) 🎂"), 2026).unwrap().date.year, Some(1990));
        // An age is no year, and an unmarked start says when the event was made.
        let aged = birthday_in_event(&yearly("Max (30) birthday"), 2026).unwrap();
        assert_eq!((aged.name.as_str(), aged.date.format()), ("Max", "--04-12".to_owned()));
        // Marked (Google's category): the start is the year of birth, and no word is needed.
        let google = event("Leni Muster", "19960229", "RRULE:FREQ=YEARLY\r\nCATEGORIES:Birthday\r\n");
        let found = birthday_in_event(&google, 2026).unwrap();
        assert!(found.marked);
        assert_eq!((found.name.as_str(), found.date.format()), ("Leni Muster", "1996-02-29".to_owned()));
        // KDE marks it with a property, without a rule; a start in the future is no year of birth.
        let kde = event("Otto", "20300101", "X-KDE-KABC-BIRTHDAY:YES\r\n");
        assert_eq!(birthday_in_event(&kde, 2026).unwrap().date.format(), "--01-01");
    }

    #[test]
    fn only_all_day_yearly_or_marked_events_count() {
        assert!(birthday_in_event(&event("Geburtstag Max", "20150412", ""), 2026).is_none(), "once");
        assert!(
            birthday_in_event(&event("Geburtstag Max", "20150412", "RRULE:FREQ=YEARLY;INTERVAL=2\r\n"), 2026).is_none()
        );
        let timed = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20150412T180000Z\r\nRRULE:FREQ=YEARLY\r\nSUMMARY:Geburtstag Max\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        assert!(birthday_in_event(timed, 2026).is_none());
        let bare = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20150412\r\nRRULE:FREQ=YEARLY\r\nSUMMARY:Max\\, Geburtstag\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        assert_eq!(birthday_in_event(bare, 2026).unwrap().name, "Max");
        // The server's own birthdays calendar isn't read back.
        let own =
            event("Max (*1990)", "19900412", "RRULE:FREQ=YEARLY\r\nX-UWUMAIL-BIRTHDAY;X-CARD=1;X-KIND=birth:Max\r\n");
        assert!(birthday_in_event(&own, 2026).is_none());
        // Folded lines are read; an alarm's properties aren't the event's.
        let folded = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:2015\r\n 0412\r\nRRULE:FREQ=YEARLY\r\nSUMMARY:Birthday of\r\n  Max\r\nBEGIN:VALARM\r\nSUMMARY:Geburtstag Nobody\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        assert_eq!(birthday_in_event(folded, 2026).unwrap().name, "Max");
        assert!(birthday_in_event("nonsense", 2026).is_none());
        assert!(birthday_in_event(&yearly(&"x".repeat(400)), 2026).is_none());
    }

    #[test]
    fn names_compare_by_characters_with_umlauts_either_way() {
        assert_eq!(fold("Jürgen Müller"), "juergen mueller");
        assert_eq!(fold_plain("Jürgen Müller"), "jurgen muller");
        assert_eq!(fold("STRASSE Groß"), "strasse gross");
        assert_eq!(fold("Zoë O'Neil"), "zoe o neil");
        let cards = [
            known_card("a:k1", "a:b", &json!({ "name": { "full": "Jürgen Müller" } })).unwrap(),
            known_card("a:k2", "a:b", &json!({ "name": { "full": "Zoë Winter" }, "nicknames": { "n": { "name": "Oma" } } }))
                .unwrap(),
            known_card(
                "a:k3",
                "a:b",
                &json!({ "name": { "components": [{ "kind": "given", "value": "Max" }, { "kind": "surname", "value": "Muster" }] } }),
            )
            .unwrap(),
            known_card("a:k4", "a:b", &json!({ "name": { "full": "Max Otto" } })).unwrap(),
        ];
        let ids = |name: &str| matching(name, &cards).iter().map(|c| c.choice.contact_id.clone()).collect::<Vec<_>>();
        assert_eq!(ids("Juergen Mueller"), ["a:k1"]);
        assert_eq!(ids("Jurgen Muller"), ["a:k1"]);
        assert_eq!(ids("Zoe Winter"), ["a:k2"]);
        assert_eq!(ids("Oma"), ["a:k2"]);
        assert_eq!(ids("Muster Max"), ["a:k3"]);
        assert_eq!(ids("Max"), ["a:k3", "a:k4"]);
        assert!(ids("Leni").is_empty());
        assert!(known_card("a:g", "a:b", &json!({ "kind": "group", "name": { "full": "Family" } })).is_none());
        assert!(known_card("a:n", "a:b", &json!({})).is_none());
    }

    #[test]
    fn scans_match_to_the_contacts() {
        let cards = [
            known_card("a:k1", "a:b", &json!({ "name": { "full": "Mia Mood" } })).unwrap(),
            known_card(
                "a:k2",
                "a:b",
                &json!({ "name": { "full": "Noah Beispiel" }, "anniversaries": { "b": { "kind": "birth", "date": { "month": 4, "day": 12 } } } }),
            )
            .unwrap(),
            known_card(
                "a:k3",
                "a:b",
                &json!({ "name": { "full": "Otto Winter" }, "anniversaries": { "b": { "kind": "birth", "date": { "year": 1970, "month": 1, "day": 1 } } } }),
            )
            .unwrap(),
            known_card("a:k4", "a:b", &json!({ "name": { "full": "Lea Sommer" } })).unwrap(),
            known_card("a:k5", "a:b", &json!({ "name": { "full": "Lea Winter" } })).unwrap(),
        ];
        let events: Vec<ScannedEvent> = [
            ("mia", "Geburtstag von Mia Mood (*1999)"),
            ("noah", "bday Noah"),
            ("noah-year", "Noah Beispiel (*1990) 🎂"),
            ("otto", "Otto's birthday"),
            ("lea", "🎂 Lea"),
            ("oma", "🎂 Oma Hilde"),
            ("work", "Standup"),
        ]
        .into_iter()
        .map(|(id, title)| ScannedEvent {
            event_id: format!("a:/cal/{id}.ics"),
            calendar_id: "a:/cal/".into(),
            content: yearly(title),
            deletable: id != "otto",
        })
        .collect();
        let found = scan(&events, &cards, 2026);
        assert!(!found.truncated);
        let states: Vec<(&str, BirthdayMatch, usize)> =
            found.candidates.iter().map(|c| (c.event_id.as_str(), c.state, c.contacts.len())).collect();
        assert_eq!(
            states,
            [
                ("a:/cal/mia.ics", BirthdayMatch::Matched, 1),
                ("a:/cal/noah.ics", BirthdayMatch::Known, 1),
                ("a:/cal/noah-year.ics", BirthdayMatch::Matched, 1),
                ("a:/cal/otto.ics", BirthdayMatch::Conflict, 1),
                ("a:/cal/lea.ics", BirthdayMatch::Ambiguous, 2),
                ("a:/cal/oma.ics", BirthdayMatch::Unmatched, 0),
            ]
        );
        let mia = &found.candidates[0];
        assert_eq!((mia.birthday.as_str(), mia.name.as_str(), mia.may_delete_event), ("1999-04-12", "Mia Mood", true));
        assert!(!found.candidates[3].may_delete_event);
        assert_eq!(found.candidates[3].contacts[0].birthday.as_deref(), Some("1970-01-01"));
        let json = serde_json::to_value(mia).unwrap();
        assert_eq!(json["match"], "matched");
        assert_eq!(json["mayDeleteEvent"], true);
        assert_eq!(json["contacts"][0]["contactId"], "a:k1");
    }

    #[test]
    fn scans_are_bounded() {
        let events: Vec<ScannedEvent> = (0..MAX_CANDIDATES + 5)
            .map(|n| ScannedEvent {
                event_id: format!("a:/cal/{n}.ics"),
                calendar_id: "a:/cal/".into(),
                content: yearly(&format!("🎂 Person{n}")),
                deletable: true,
            })
            .collect();
        let found = scan(&events, &[], 2026);
        assert_eq!(found.candidates.len(), MAX_CANDIDATES);
        assert!(found.truncated);
    }

    #[test]
    fn import_entries_read_both_forms() {
        let entries: Vec<BirthdayImportEntry> = serde_json::from_value(json!([
            { "eventId": "a:e1", "contactId": "a:k1", "overwrite": true },
            { "eventId": "a:e2", "newContactName": "Oma Hilde" }
        ]))
        .unwrap();
        assert_eq!(entries[0].contact_id.as_deref(), Some("a:k1"));
        assert!(entries[0].overwrite && entries[0].delete_event.is_none());
        assert_eq!(entries[1].new_contact_name.as_deref(), Some("Oma Hilde"));
    }
}
