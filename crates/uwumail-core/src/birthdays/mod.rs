//! Birthdays and anniversaries from the contacts, with the rules of the UwUMail server's
//! birthdays calendar (UwUMail-Server `docs/birthdays.md`).
//!
//! - A UwUMail server makes the birthdays calendar itself and marks it (`uwuBirthdays` on the
//!   calendar, `uwuBirthday` on its events); the app only reads the marks ([`from_jmap`]) and moves
//!   birthday events of other calendars into the contacts with the server's `Birthdays/scan` and
//!   `Birthdays/import` ([`jmap`]).
//! - For other mailboxes (CardDAV contacts) the app makes a read-only birthdays calendar of its
//!   own from the cards ([`card_dates`], [`occurrences`]) and does the scan and the import itself
//!   ([`scan`]), with the same rules.
//!
//! The rules both follow: a date without a year starts nowhere and has no age; 29 February falls
//! on 28 February in years without one, and the age counts from that day on; the first year (age
//! 0) and the years before it show the plain name.

pub mod jmap;
pub mod scan;

use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The server id of the app's own birthdays calendar of a CardDAV account. It is never a CalDAV
/// path (those start with `/`), so no server ever sees it.
pub const LOCAL_CALENDAR: &str = "uwu-birthdays";
/// Dates one card gives at most, as on the server.
const MAX_DATES_PER_CARD: usize = 10;
/// The longest name or label kept, in characters.
const MAX_NAME_CHARS: usize = 200;
/// Apple writes this year for a date without one.
const APPLE_NO_YEAR: i32 = 1604;

pub fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: Option<i32>, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        // Without a year, the 29th may be; with one, only in a leap year.
        2 if year.is_none_or(is_leap_year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// A day of the year, with the year when it is known.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PartialDate {
    pub year: Option<i32>,
    pub month: u32,
    pub day: u32,
}

impl PartialDate {
    /// `None` for a day that does not exist, like 31 April or 29 February 2023.
    pub fn new(year: Option<i32>, month: u32, day: u32) -> Option<PartialDate> {
        if year.is_some_and(|year| !(1..=9999).contains(&year)) {
            return None;
        }
        ((1..=12).contains(&month) && day >= 1 && day <= days_in_month(year, month)).then_some(PartialDate {
            year,
            month,
            day,
        })
    }

    /// The day it falls on in `year`: 29 February is the 28th in a year that has no 29th.
    pub fn in_year(self, year: i32) -> (u32, u32) {
        if self.month == 2 && self.day == 29 && !is_leap_year(year) { (2, 28) } else { (self.month, self.day) }
    }

    /// How many years it is in `year`: the age on a birthday. `None` without a year or before it.
    pub fn years_in(self, year: i32) -> Option<i32> {
        self.year.map(|born| year - born).filter(|years| *years >= 0)
    }

    /// "1996-04-12", or "--04-12" without a year: the way the app's contacts keep it.
    pub fn format(self) -> String {
        match self.year {
            Some(year) => format!("{year:04}-{:02}-{:02}", self.month, self.day),
            None => format!("--{:02}-{:02}", self.month, self.day),
        }
    }
}

/// Reads the dates vCard and its clients write: `1996-04-12`, `19960412`, `--04-12`, `--0412`,
/// also with a time behind it (`1996-04-12T00:00:00Z`), and `0000-04-12` or `1604-04-12` for a date
/// whose year is not known.
pub fn parse_date(text: &str) -> Option<PartialDate> {
    let text = text.trim();
    let date = text.split(['T', 't', ' ']).next().unwrap_or_default();
    let digits: String = date.chars().filter(|c| *c != '-').collect();
    if !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let number = |from: usize, to: usize| -> Option<u32> { digits.get(from..to)?.parse().ok() };
    if date.starts_with("--") {
        return match digits.len() {
            4 => PartialDate::new(None, number(0, 2)?, number(2, 4)?),
            _ => None,
        };
    }
    if digits.len() != 8 {
        return None;
    }
    let year = number(0, 4)? as i32;
    let year = (year != 0 && year != APPLE_NO_YEAR).then_some(year);
    PartialDate::new(year, number(4, 6)?, number(6, 8)?)
}

/// What kind of date an event is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DateKind {
    Birth,
    Wedding,
    /// Another anniversary, named by its label when there is one.
    Other,
}

impl DateKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DateKind::Birth => "birth",
            DateKind::Wedding => "wedding",
            DateKind::Other => "other",
        }
    }
}

/// A date of a card that goes into the birthdays calendar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardDate {
    pub kind: DateKind,
    pub label: Option<String>,
    pub date: PartialDate,
}

/// Leaves out control characters, trims, and keeps at most [`MAX_NAME_CHARS`] characters.
fn clean(text: &str) -> String {
    let cleaned: String = text.chars().filter(|c| !c.is_control()).take(MAX_NAME_CHARS).collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// A name component of a JSContact card (`given`, `surname`, …), the parts of that kind joined.
pub fn name_part(card: &Value, kind: &str) -> String {
    let parts: Vec<&str> = card
        .pointer("/name/components")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|part| text(part, "kind") == Some(kind))
        .filter_map(|part| text(part, "value"))
        .collect();
    clean(&parts.join(" "))
}

/// The name a card goes by, as the address book shows it: its full name, given name and
/// surname, its company, its first address. Empty when it has none.
pub fn card_name(card: &Value) -> String {
    if let Some(full) = card.pointer("/name/full").and_then(Value::as_str).map(clean)
        && !full.is_empty()
    {
        return full;
    }
    let name = clean(&format!("{} {}", name_part(card, "given"), name_part(card, "surname")));
    if !name.is_empty() {
        return name;
    }
    for (map, field) in [("organizations", "name"), ("emails", "address")] {
        if let Some(found) = card
            .get(map)
            .and_then(Value::as_object)
            .and_then(|entries| entries.values().find_map(|entry| text(entry, field)))
            .map(clean)
            .filter(|found| !found.is_empty())
        {
            return found;
        }
    }
    String::new()
}

pub fn is_group(card: &Value) -> bool {
    text(card, "kind").is_some_and(|kind| kind.eq_ignore_ascii_case("group"))
}

/// A JSContact date (`PartialDate` or `Timestamp`) of the anniversary under `key`.
fn jscontact_date(card: &Value, key: &str, date: &Value) -> Option<PartialDate> {
    let parsed = if let Some(utc) = text(date, "utc") {
        parse_date(utc)?
    } else {
        let number = |field: &str| date.get(field).and_then(Value::as_i64);
        let month = u32::try_from(number("month")?).ok()?;
        let day = u32::try_from(number("day")?).ok()?;
        let year = number("year").and_then(|year| i32::try_from(year).ok()).filter(|year| *year != 0);
        let year = year.filter(|year| *year != APPLE_NO_YEAR);
        PartialDate::new(year, month, day)?
    };
    // Apple's "no year" as calcard keeps it: a parameter of the converted BDAY.
    let omitted = card
        .pointer("/vCard/convertedProperties")
        .and_then(Value::as_object)
        .and_then(|converted| converted.get(&format!("anniversaries/{key}/date")))
        .and_then(|entry| entry.get("parameters"))
        .and_then(Value::as_object)
        .is_some_and(|parameters| parameters.keys().any(|name| name.eq_ignore_ascii_case("x-apple-omit-year")));
    Some(if omitted { PartialDate { year: None, ..parsed } } else { parsed })
}

/// Apple's and Google's label of an `X-ABDATE`: its kind, and its text when it has its own.
fn apple_label(label: &str) -> (DateKind, Option<String>) {
    let label = label.trim();
    if let Some(inner) = label.strip_prefix("_$!<").and_then(|rest| rest.strip_suffix(">!$_")) {
        return match inner.to_ascii_lowercase().as_str() {
            "anniversary" => (DateKind::Wedding, None),
            _ => (DateKind::Other, None),
        };
    }
    let cleaned = clean(label);
    (DateKind::Other, (!cleaned.is_empty()).then_some(cleaned))
}

/// The `X-ABDATE` lines calcard kept in `vCard/properties` (`[name, {group, …}, type, value]`),
/// with the kind and label their `X-ABLabel` gives.
fn apple_dates(card: &Value) -> Vec<(DateKind, Option<String>, PartialDate)> {
    let Some(properties) = card.pointer("/vCard/properties").and_then(Value::as_array) else {
        return Vec::new();
    };
    let named =
        |entry: &Value, name: &str| entry.get(0).and_then(Value::as_str).is_some_and(|n| n.eq_ignore_ascii_case(name));
    let group = |entry: &Value| entry.get(1).and_then(|p| p.get("group")).and_then(Value::as_str).map(str::to_owned);
    properties
        .iter()
        .filter(|entry| named(entry, "x-abdate"))
        // Words like "circa 1800" are no date.
        .filter(|entry| !entry.get(2).and_then(Value::as_str).is_some_and(|kind| kind.eq_ignore_ascii_case("text")))
        // Each looks through all properties for its label: a card with thousands of dates would
        // take quadratic time, and only a few of them are kept anyway.
        .take(4 * MAX_DATES_PER_CARD)
        .filter_map(|entry| {
            let date = parse_date(entry.get(3)?.as_str()?)?;
            let label = group(entry).and_then(|wanted| {
                properties.iter().find(|other| {
                    named(other, "x-ablabel") && group(other).is_some_and(|g| g.eq_ignore_ascii_case(&wanted))
                })
            });
            let (kind, label) = label
                .and_then(|other| other.get(3).and_then(Value::as_str))
                .map(apple_label)
                .unwrap_or((DateKind::Other, None));
            Some((kind, label, date))
        })
        .collect()
}

/// The dates of a card (JSContact) that go into the birthdays calendar: the birthday, the
/// wedding anniversary and Apple's other dates, at most ten, one birthday. None for a group.
pub fn card_dates(card: &Value) -> Vec<CardDate> {
    if is_group(card) {
        return Vec::new();
    }
    let mut found: Vec<(DateKind, Option<String>, PartialDate)> = Vec::new();
    if let Some(anniversaries) = card.get("anniversaries").and_then(Value::as_object) {
        for (key, entry) in anniversaries {
            let kind = match text(entry, "kind").map(str::to_ascii_lowercase).as_deref() {
                Some("birth") => DateKind::Birth,
                Some("wedding") => DateKind::Wedding,
                _ => continue,
            };
            if let Some(date) = entry.get("date").and_then(|date| jscontact_date(card, key, date)) {
                found.push((kind, None, date));
            }
        }
    }
    found.extend(apple_dates(card));
    let mut dates: Vec<CardDate> = Vec::new();
    for (kind, label, date) in found {
        let twice = dates
            .iter()
            .any(|known| known.kind == kind && known.date == date && (known.label == label || label.is_none()));
        let second_birthday = kind == DateKind::Birth && dates.iter().any(|known| known.kind == DateKind::Birth);
        if dates.len() < MAX_DATES_PER_CARD && !twice && !second_birthday {
            dates.push(CardDate { kind, label, date });
        }
    }
    dates
}

/// What an event of a birthdays calendar is for, and the years on this occurrence. The
/// server's `uwuBirthday`, with the app's contact id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OccurrenceBirthday {
    pub contact_id: String,
    pub kind: DateKind,
    /// The label of an "other" date ("Kennenlerntag").
    pub label: Option<String>,
    pub name: String,
    /// The year it happened; none when the card doesn't say.
    pub year: Option<i32>,
    /// The age (or the years) on this occurrence; none without a year or in the year itself.
    pub age: Option<i32>,
}

/// The server's `uwuBirthday` of a birthdays calendar event, for the occurrence in `shown_year`.
/// None for every other event, or one whose mark makes no sense.
pub fn from_jmap(mark: Option<&Value>, shown_year: i32, account_id: &str) -> Option<OccurrenceBirthday> {
    let mark = mark?;
    let contact = text(mark, "contactId").filter(|id| !id.is_empty() && id.chars().count() <= 255)?;
    let kind = match text(mark, "kind") {
        Some("birth") => DateKind::Birth,
        Some("wedding") => DateKind::Wedding,
        _ => DateKind::Other,
    };
    let year = mark.get("year").and_then(Value::as_i64).and_then(|year| i32::try_from(year).ok());
    Some(OccurrenceBirthday {
        contact_id: crate::contacts::app_id(account_id, contact),
        kind,
        label: text(mark, "label").map(clean).filter(|label| !label.is_empty()),
        name: text(mark, "name").map(clean).unwrap_or_default(),
        year,
        // The year is the server's word: one far off must not overflow.
        age: year.and_then(|year| shown_year.checked_sub(year)).filter(|age| *age > 0),
    })
}

/// `Hochzeitstag von Max Muster`, `Wedding anniversary of Max Muster`.
fn what(kind: DateKind, label: Option<&str>, name: &str, german: bool) -> String {
    match (kind, label) {
        (DateKind::Birth, _) if german => format!("Geburtstag von {name}"),
        (DateKind::Birth, _) => format!("Birthday of {name}"),
        (DateKind::Wedding, _) if german => format!("Hochzeitstag von {name}"),
        (DateKind::Wedding, _) => format!("Wedding anniversary of {name}"),
        (DateKind::Other, Some(label)) if german => format!("{label} von {name}"),
        (DateKind::Other, Some(label)) => format!("{label} of {name}"),
        (DateKind::Other, None) if german => format!("Jahrestag von {name}"),
        (DateKind::Other, None) => format!("Anniversary of {name}"),
    }
}

/// The title of an occurrence, as the server writes it over JMAP: `Max Muster (30)`,
/// `Hochzeitstag von Max Muster (5 Jahre)`; the plain name in the first year and without one.
/// The app shows the same in the UI's language (`lib/birthdays.ts`).
pub fn title(birthday: &OccurrenceBirthday, german: bool) -> String {
    let what = || what(birthday.kind, birthday.label.as_deref(), &birthday.name, german);
    match (birthday.kind, birthday.age) {
        (DateKind::Birth, None) => birthday.name.clone(),
        (DateKind::Birth, Some(age)) => format!("{} ({age})", birthday.name),
        (_, None) => what(),
        (_, Some(1)) if german => format!("{} (1 Jahr)", what()),
        (_, Some(years)) if german => format!("{} ({years} Jahre)", what()),
        (_, Some(1)) => format!("{} (1 year)", what()),
        (_, Some(years)) => format!("{} ({years} years)", what()),
    }
}

/// One day a card's date falls on in a range, with the years then.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateOccurrence {
    pub day: NaiveDate,
    /// Which of the card's dates (index into [`card_dates`]).
    pub index: usize,
    pub years: Option<i32>,
}

/// Every day the dates fall on in `[from, to)`: none before the year a date happened, 29
/// February on the 28th in other years.
pub fn occurrences(dates: &[CardDate], from: NaiveDate, to: NaiveDate) -> Vec<DateOccurrence> {
    let mut found = Vec::new();
    if to <= from {
        return found;
    }
    for (index, date) in dates.iter().enumerate() {
        for year in from.year()..=to.year() {
            // Before the year it happened, there is nothing yet.
            if date.date.year.is_some_and(|happened| year < happened) {
                continue;
            }
            let (month, day) = date.date.in_year(year);
            let Some(day) = NaiveDate::from_ymd_opt(year, month, day) else { continue };
            if day >= from && day < to {
                found.push(DateOccurrence { day, index, years: date.date.years_in(year) });
            }
        }
    }
    found.sort_by(|a, b| a.day.cmp(&b.day).then(a.index.cmp(&b.index)));
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn day(text: &str) -> NaiveDate {
        NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn dates_in_every_form_cards_write_them() {
        let max = PartialDate { year: Some(1996), month: 4, day: 12 };
        for text in ["1996-04-12", "19960412", "1996-04-12T00:00:00Z", " 1996-04-12 "] {
            assert_eq!(parse_date(text), Some(max), "{text}");
        }
        let yearless = PartialDate { year: None, month: 4, day: 12 };
        for text in ["--04-12", "--0412", "0000-04-12", "1604-04-12"] {
            assert_eq!(parse_date(text), Some(yearless), "{text}");
        }
        for text in ["circa 1800", "2023-02-29", "1996-04-31", "1996-13-01", "12.04.1996", "", "--4-12"] {
            assert_eq!(parse_date(text), None, "{text}");
        }
        assert!(parse_date("2024-02-29").is_some() && parse_date("--02-29").is_some());
        assert_eq!(max.format(), "1996-04-12");
        assert_eq!(yearless.format(), "--04-12");
        assert_eq!(PartialDate { year: Some(812), month: 1, day: 2 }.format(), "0812-01-02");
    }

    #[test]
    fn cards_give_their_birthday_anniversary_and_apple_dates() {
        let card = json!({
            "name": { "full": " Max  Muster " },
            "anniversaries": {
                "k1": { "kind": "birth", "date": { "@type": "PartialDate", "year": 1996, "month": 4, "day": 12 } },
                "k2": { "kind": "wedding", "date": { "@type": "PartialDate", "year": 2021, "month": 6, "day": 12 } },
                "k3": { "kind": "death", "date": { "@type": "PartialDate", "year": 2090, "month": 1, "day": 1 } }
            },
            "vCard": { "properties": [
                ["x-abdate", { "group": "item1" }, "unknown", "2019-05-01"],
                ["x-ablabel", { "group": "ITEM1" }, "unknown", "Kennenlerntag"],
                // Apple writes the wedding anniversary twice: once is enough.
                ["x-abdate", { "group": "item2" }, "unknown", "2021-06-12"],
                ["x-ablabel", { "group": "item2" }, "unknown", "_$!<Anniversary>!$_"],
                ["x-abdate", { "group": "item3" }, "unknown", "1990-07-07"],
                ["x-abdate", { "group": "item4" }, "text", "circa 1800"]
            ] }
        });
        assert_eq!(card_name(&card), "Max Muster");
        let dates = card_dates(&card);
        assert_eq!(dates.len(), 4, "{dates:?}");
        assert_eq!((dates[0].kind, dates[0].date.format()), (DateKind::Birth, "1996-04-12".into()));
        assert_eq!((dates[1].kind, dates[1].date.format()), (DateKind::Wedding, "2021-06-12".into()));
        assert_eq!((dates[2].kind, dates[2].label.as_deref()), (DateKind::Other, Some("Kennenlerntag")));
        assert_eq!((dates[3].kind, dates[3].label.as_deref()), (DateKind::Other, None));

        // Apple's "no year", as calcard keeps it; a group has no dates.
        let apple = json!({
            "name": { "components": [{ "kind": "given", "value": "Leni" }, { "kind": "surname", "value": "Muster" }] },
            "anniversaries": { "k1": { "kind": "birth", "date": { "year": 1604, "month": 2, "day": 29 } } },
            "vCard": { "convertedProperties": { "anniversaries/k1/date": { "parameters": { "x-apple-omit-year": "1604" } } } }
        });
        assert_eq!(card_name(&apple), "Leni Muster");
        assert_eq!(card_dates(&apple)[0].date.format(), "--02-29");
        let stamped = json!({ "anniversaries": { "b": { "kind": "birth", "date": { "@type": "Timestamp", "utc": "1990-01-02T00:00:00Z" } } } });
        assert_eq!(card_dates(&stamped)[0].date.format(), "1990-01-02");
        let group = json!({ "kind": "group", "anniversaries": stamped["anniversaries"].clone() });
        assert!(card_dates(&group).is_empty());
        let email = json!({ "emails": { "e": { "address": "otto@example.org" } } });
        assert_eq!(card_name(&email), "otto@example.org");
        // A day that doesn't exist is left out.
        let wrong =
            json!({ "anniversaries": { "b": { "kind": "birth", "date": { "year": 2023, "month": 2, "day": 29 } } } });
        assert!(card_dates(&wrong).is_empty());
    }

    #[test]
    fn at_most_ten_dates_and_one_birthday() {
        let mut anniversaries = serde_json::Map::new();
        for n in 1..=20 {
            anniversaries.insert(
                format!("k{n}"),
                json!({ "kind": if n % 2 == 0 { "birth" } else { "wedding" }, "date": { "year": 1990 + n, "month": 1, "day": n } }),
            );
        }
        let dates = card_dates(&json!({ "anniversaries": anniversaries }));
        assert_eq!(dates.len(), MAX_DATES_PER_CARD);
        assert_eq!(dates.iter().filter(|date| date.kind == DateKind::Birth).count(), 1);
    }

    #[test]
    fn occurrences_count_the_years_and_stay_in_the_range() {
        let dates = [
            CardDate { kind: DateKind::Birth, label: None, date: PartialDate { year: Some(1996), month: 4, day: 12 } },
            CardDate { kind: DateKind::Wedding, label: None, date: PartialDate { year: None, month: 12, day: 31 } },
        ];
        let found = occurrences(&dates, day("2025-01-01"), day("2027-01-01"));
        let shown: Vec<(String, Option<i32>)> = found.iter().map(|o| (o.day.to_string(), o.years)).collect();
        assert_eq!(
            shown,
            [
                ("2025-04-12".into(), Some(29)),
                ("2025-12-31".into(), None),
                ("2026-04-12".into(), Some(30)),
                ("2026-12-31".into(), None)
            ]
        );
        // The end is exclusive, the start inclusive.
        assert!(occurrences(&dates, day("2026-04-13"), day("2026-12-31")).is_empty());
        assert_eq!(occurrences(&dates, day("2026-04-12"), day("2026-04-13")).len(), 1);
        assert_eq!(occurrences(&dates, day("2026-12-31"), day("2027-01-01")).len(), 1);
        // Nothing before the year it happened; the year itself is age 0.
        assert!(occurrences(&dates[..1], day("1990-01-01"), day("1996-01-01")).is_empty());
        assert_eq!(occurrences(&dates[..1], day("1996-01-01"), day("1997-01-01"))[0].years, Some(0));
        assert!(occurrences(&dates, day("2026-05-01"), day("2026-04-01")).is_empty());
    }

    #[test]
    fn the_29th_of_february_is_the_28th_in_other_years() {
        let leap = [CardDate {
            kind: DateKind::Birth,
            label: None,
            date: PartialDate { year: Some(2000), month: 2, day: 29 },
        }];
        let found = occurrences(&leap, day("2023-01-01"), day("2025-01-01"));
        let shown: Vec<(String, Option<i32>)> = found.iter().map(|o| (o.day.to_string(), o.years)).collect();
        assert_eq!(shown, [("2023-02-28".into(), Some(23)), ("2024-02-29".into(), Some(24))]);
        assert_eq!(occurrences(&leap, day("2100-02-28"), day("2100-03-01"))[0].day, day("2100-02-28"));
        let yearless =
            [CardDate { kind: DateKind::Birth, label: None, date: PartialDate { year: None, month: 2, day: 29 } }];
        assert_eq!(occurrences(&yearless, day("2027-02-01"), day("2027-03-01"))[0].day, day("2027-02-28"));
    }

    #[test]
    fn titles_as_the_server_writes_them() {
        let mut max = OccurrenceBirthday {
            contact_id: "a:k1".into(),
            kind: DateKind::Birth,
            label: None,
            name: "Max Muster".into(),
            year: Some(1996),
            age: Some(30),
        };
        assert_eq!(title(&max, true), "Max Muster (30)");
        max.age = None;
        assert_eq!(title(&max, false), "Max Muster");
        max.kind = DateKind::Wedding;
        max.age = Some(5);
        assert_eq!(title(&max, true), "Hochzeitstag von Max Muster (5 Jahre)");
        assert_eq!(title(&max, false), "Wedding anniversary of Max Muster (5 years)");
        max.age = Some(1);
        assert_eq!(title(&max, true), "Hochzeitstag von Max Muster (1 Jahr)");
        max.kind = DateKind::Other;
        max.label = Some("Kennenlerntag".into());
        max.age = None;
        assert_eq!(title(&max, true), "Kennenlerntag von Max Muster");
        max.label = None;
        assert_eq!(title(&max, false), "Anniversary of Max Muster");
    }

    #[test]
    fn server_marks_are_read_with_the_age_of_the_occurrence() {
        let mark = json!({ "contactId": "k12", "kind": "birth", "label": null, "name": "Max Muster", "year": 1996 });
        let found = from_jmap(Some(&mark), 2026, "acc").unwrap();
        assert_eq!(found.contact_id, "acc:k12");
        assert_eq!((found.kind, found.year, found.age), (DateKind::Birth, Some(1996), Some(30)));
        assert_eq!(from_jmap(Some(&mark), 1996, "acc").unwrap().age, None);
        assert_eq!(from_jmap(Some(&mark), 1990, "acc").unwrap().age, None);
        let odd = json!({ "contactId": "k1", "kind": "anything", "name": "X\u{0}Y", "year": "1990" });
        let odd = from_jmap(Some(&odd), 2026, "acc").unwrap();
        let far = json!({ "contactId": "k1", "kind": "birth", "year": i64::from(i32::MIN), "name": "Far" });
        assert_eq!(from_jmap(Some(&far), 2026, "acc").unwrap().age, None);
        assert_eq!((odd.kind, odd.name.as_str(), odd.year), (DateKind::Other, "XY", None));
        assert!(from_jmap(Some(&json!({ "kind": "birth" })), 2026, "acc").is_none());
        assert!(from_jmap(None, 2026, "acc").is_none());
    }
}
