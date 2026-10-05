//! Microsoft Graph calendars and events in the JSCalendar shape the app works with, and back.
//!
//! Events are read with `Prefer: outlook.timezone="UTC"`, so every time comes in UTC; the zone an
//! event was made in (`originalStartTimeZone`, often a Windows name) gives its own wall time,
//! which repeating events need to keep their hour across daylight saving.
//!
//! Events are written with Windows zone names (`W. Europe Standard Time`), which Graph always takes;
//! whether it takes IANA names everywhere isn't documented. An IANA zone gets the Windows zone it
//! is (or one with the same offsets in winter and summer, so a series keeps its hour). A zone
//! without one is written in UTC: a timed event at its exact instant, an all-day event at
//! midnight UTC of its own date, so no day moves for anyone.

use chrono::{Datelike, Duration as TimeDelta, NaiveDate, NaiveDateTime, Timelike, Utc};
use chrono_tz::Tz;
use serde_json::{Map, Value, json};

use super::jscal::{self, format_local, parse_local};

/// The `Prefer` header for reading events: UTC times, plain-text bodies.
pub const PREFER: &str = "outlook.timezone=\"UTC\", outlook.body-content-type=\"text\"";

/// Graph's calendar colors with what Outlook shows for them.
const COLORS: [(&str, &str); 9] = [
    ("lightBlue", "#a6d1f5"),
    ("lightGreen", "#87d28e"),
    ("lightOrange", "#fcab73"),
    ("lightGray", "#c0c0c0"),
    ("lightYellow", "#f4d07a"),
    ("lightTeal", "#62e1e3"),
    ("lightPink", "#f99fb8"),
    ("lightBrown", "#d5a876"),
    ("lightRed", "#fb8f8f"),
];

/// A calendar as Graph lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct GraphCalendar {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub is_default: bool,
    pub can_edit: bool,
    pub can_remove: bool,
}

pub fn calendar(value: &Value) -> Option<GraphCalendar> {
    let text = |key: &str| value.get(key).and_then(Value::as_str);
    let flag = |key: &str| value.get(key).and_then(Value::as_bool);
    let color = jscal::clean_color(text("hexColor").filter(|hex| !hex.is_empty())).or_else(|| {
        let name = text("color")?;
        COLORS.iter().find(|(known, _)| known.eq_ignore_ascii_case(name)).map(|(_, hex)| (*hex).to_string())
    });
    Some(GraphCalendar {
        id: text("id").filter(|id| !id.is_empty())?.to_string(),
        name: text("name").unwrap_or("Calendar").to_string(),
        color,
        is_default: flag("isDefaultCalendar").unwrap_or(false),
        can_edit: flag("canEdit").unwrap_or(false),
        can_remove: flag("isRemovable").unwrap_or(false),
    })
}

/// The Graph color closest to `#rrggbb` (Graph takes only its own few).
pub fn color_name(hex: &str) -> &'static str {
    let rgb = |hex: &str| -> Option<(i32, i32, i32)> {
        let hex = hex.trim_start_matches('#');
        let part = |at: usize| i32::from_str_radix(hex.get(at..at + 2)?, 16).ok();
        Some((part(0)?, part(2)?, part(4)?))
    };
    let Some((r, g, b)) = rgb(hex) else { return "auto" };
    COLORS
        .iter()
        .min_by_key(|(_, known)| {
            let (kr, kg, kb) = rgb(known).unwrap_or_default();
            (r - kr).pow(2) + (g - kg).pow(2) + (b - kb).pow(2)
        })
        .map_or("auto", |(name, _)| name)
}

/// Windows zone names as Exchange keeps them, with their IANA zone (CLDR's "001" mapping).
const WINDOWS_ZONES: &[(&str, &str)] = &[
    ("UTC", "UTC"),
    ("Coordinated Universal Time", "UTC"),
    ("GMT Standard Time", "Europe/London"),
    ("Greenwich Standard Time", "Atlantic/Reykjavik"),
    ("W. Europe Standard Time", "Europe/Berlin"),
    ("Central Europe Standard Time", "Europe/Budapest"),
    ("Central European Standard Time", "Europe/Warsaw"),
    ("Romance Standard Time", "Europe/Paris"),
    ("E. Europe Standard Time", "Europe/Chisinau"),
    ("FLE Standard Time", "Europe/Kiev"),
    ("GTB Standard Time", "Europe/Bucharest"),
    ("Russian Standard Time", "Europe/Moscow"),
    ("Turkey Standard Time", "Europe/Istanbul"),
    ("Israel Standard Time", "Asia/Jerusalem"),
    ("South Africa Standard Time", "Africa/Johannesburg"),
    ("Egypt Standard Time", "Africa/Cairo"),
    ("W. Central Africa Standard Time", "Africa/Lagos"),
    ("Arabian Standard Time", "Asia/Dubai"),
    ("Arab Standard Time", "Asia/Riyadh"),
    ("Iran Standard Time", "Asia/Tehran"),
    ("Pakistan Standard Time", "Asia/Karachi"),
    ("India Standard Time", "Asia/Kolkata"),
    ("Nepal Standard Time", "Asia/Katmandu"),
    ("Bangladesh Standard Time", "Asia/Dhaka"),
    ("SE Asia Standard Time", "Asia/Bangkok"),
    ("China Standard Time", "Asia/Shanghai"),
    ("Singapore Standard Time", "Asia/Singapore"),
    ("Taipei Standard Time", "Asia/Taipei"),
    ("Tokyo Standard Time", "Asia/Tokyo"),
    ("Korea Standard Time", "Asia/Seoul"),
    ("W. Australia Standard Time", "Australia/Perth"),
    ("Cen. Australia Standard Time", "Australia/Adelaide"),
    ("AUS Central Standard Time", "Australia/Darwin"),
    ("E. Australia Standard Time", "Australia/Brisbane"),
    ("AUS Eastern Standard Time", "Australia/Sydney"),
    ("Tasmania Standard Time", "Australia/Hobart"),
    ("New Zealand Standard Time", "Pacific/Auckland"),
    ("Hawaiian Standard Time", "Pacific/Honolulu"),
    ("Alaskan Standard Time", "America/Anchorage"),
    ("Pacific Standard Time", "America/Los_Angeles"),
    ("US Mountain Standard Time", "America/Phoenix"),
    ("Mountain Standard Time", "America/Denver"),
    ("Central Standard Time", "America/Chicago"),
    ("Central America Standard Time", "America/Guatemala"),
    ("Mexico Standard Time", "America/Mexico_City"),
    ("Central Standard Time (Mexico)", "America/Mexico_City"),
    ("Canada Central Standard Time", "America/Regina"),
    ("Eastern Standard Time", "America/New_York"),
    ("US Eastern Standard Time", "America/Indianapolis"),
    ("SA Pacific Standard Time", "America/Bogota"),
    ("Atlantic Standard Time", "America/Halifax"),
    ("Venezuela Standard Time", "America/Caracas"),
    ("Newfoundland Standard Time", "America/St_Johns"),
    ("E. South America Standard Time", "America/Sao_Paulo"),
    ("Argentina Standard Time", "America/Buenos_Aires"),
    ("Pacific SA Standard Time", "America/Santiago"),
    ("SA Western Standard Time", "America/La_Paz"),
    ("Azores Standard Time", "Atlantic/Azores"),
    ("Cape Verde Standard Time", "Atlantic/Cape_Verde"),
    ("Morocco Standard Time", "Africa/Casablanca"),
    ("Belarus Standard Time", "Europe/Minsk"),
    ("Kaliningrad Standard Time", "Europe/Kaliningrad"),
    ("Georgian Standard Time", "Asia/Tbilisi"),
    ("Caucasus Standard Time", "Asia/Yerevan"),
    ("Azerbaijan Standard Time", "Asia/Baku"),
    ("Ekaterinburg Standard Time", "Asia/Yekaterinburg"),
    ("West Asia Standard Time", "Asia/Tashkent"),
    ("Central Asia Standard Time", "Asia/Almaty"),
    ("N. Central Asia Standard Time", "Asia/Novosibirsk"),
    ("North Asia Standard Time", "Asia/Krasnoyarsk"),
    ("North Asia East Standard Time", "Asia/Irkutsk"),
    ("Yakutsk Standard Time", "Asia/Yakutsk"),
    ("Vladivostok Standard Time", "Asia/Vladivostok"),
    ("Philippines Standard Time", "Asia/Manila"),
    ("Sri Lanka Standard Time", "Asia/Colombo"),
    ("Myanmar Standard Time", "Asia/Rangoon"),
    ("Afghanistan Standard Time", "Asia/Kabul"),
    ("Jordan Standard Time", "Asia/Amman"),
    ("Middle East Standard Time", "Asia/Beirut"),
    ("Syria Standard Time", "Asia/Damascus"),
    ("E. Africa Standard Time", "Africa/Nairobi"),
    ("Fiji Standard Time", "Pacific/Fiji"),
    ("Tonga Standard Time", "Pacific/Tongatapu"),
    ("UTC-11", "Etc/GMT+11"),
    ("UTC-02", "Etc/GMT+2"),
    ("UTC+12", "Etc/GMT-12"),
];

/// The Windows name Graph is sent for `zone`, around `day`: the zone itself, else one with the same
/// UTC offsets in January and July (the same daylight-saving shape). None for UTC and zones
/// without one: those are written in UTC.
pub fn windows_zone(zone: Tz, day: NaiveDate) -> Option<&'static str> {
    if zone == Tz::UTC {
        return None;
    }
    if let Some((windows, _)) = WINDOWS_ZONES.iter().find(|(_, iana)| *iana == zone.name()) {
        return Some(windows);
    }
    use chrono::Offset as _;
    use chrono::TimeZone as _;
    let offsets = |zone: Tz| -> Option<(i32, i32)> {
        let at = |month: u32| {
            let noon = NaiveDate::from_ymd_opt(day.year(), month, 15)?.and_hms_opt(12, 0, 0)?;
            Some(zone.offset_from_utc_datetime(&noon).fix().local_minus_utc())
        };
        Some((at(1)?, at(7)?))
    };
    let wanted = offsets(zone)?;
    WINDOWS_ZONES
        .iter()
        .filter(|(windows, _)| !windows.starts_with("UTC"))
        .find(|(_, iana)| iana.parse::<Tz>().ok().and_then(offsets) == Some(wanted))
        .map(|(windows, _)| *windows)
}

/// A zone as Graph names it: an IANA name, a Windows name, or `tzone://Microsoft/Utc`.
pub fn zone(name: &str) -> Option<Tz> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    if let Some(zone) = jscal::parse_zone(name) {
        return Some(zone);
    }
    if name.eq_ignore_ascii_case("tzone://Microsoft/Utc") {
        return Some(Tz::UTC);
    }
    let name = name.strip_prefix("tzone://Microsoft/").unwrap_or(name);
    WINDOWS_ZONES.iter().find(|(windows, _)| windows.eq_ignore_ascii_case(name)).and_then(|(_, iana)| iana.parse().ok())
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// A `dateTimeTimeZone` as a UTC instant.
fn instant(value: Option<&Value>) -> Option<chrono::DateTime<Utc>> {
    let value = value?;
    let local = parse_local(text(value, "dateTime")?)?;
    let zone = text(value, "timeZone").and_then(zone).unwrap_or(Tz::UTC);
    Some(jscal::to_utc(local, zone))
}

const DAYS: [(&str, &str); 7] = [
    ("monday", "mo"),
    ("tuesday", "tu"),
    ("wednesday", "we"),
    ("thursday", "th"),
    ("friday", "fr"),
    ("saturday", "sa"),
    ("sunday", "su"),
];
const INDEXES: [(&str, i64); 5] = [("first", 1), ("second", 2), ("third", 3), ("fourth", 4), ("last", -1)];

fn day_to_jscal(day: &str) -> Option<&'static str> {
    DAYS.iter().find(|(graph, _)| graph.eq_ignore_ascii_case(day)).map(|(_, short)| *short)
}

fn day_to_graph(day: &str) -> Option<&'static str> {
    DAYS.iter().find(|(_, short)| short.eq_ignore_ascii_case(day)).map(|(graph, _)| *graph)
}

/// A Graph `patternedRecurrence` as a JSCalendar rule. `start` is the series' first day, which a
/// rule repeats on by itself (day of month, month), so those aren't written out.
pub fn rule_from_graph(recurrence: &Value, start: NaiveDate, all_day: bool) -> Option<Value> {
    let pattern = recurrence.get("pattern")?;
    let range = recurrence.get("range");
    let interval = pattern.get("interval").and_then(Value::as_u64).unwrap_or(1).max(1);
    let kind = text(pattern, "type")?;
    let mut rule = Map::new();
    let days = || -> Vec<&'static str> {
        pattern
            .get("daysOfWeek")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(day_to_jscal)
            .collect()
    };
    let nth = || {
        let index = text(pattern, "index").unwrap_or("first");
        INDEXES.iter().find(|(name, _)| name.eq_ignore_ascii_case(index)).map_or(1, |(_, n)| *n)
    };
    let month_day = pattern.get("dayOfMonth").and_then(Value::as_u64).filter(|day| *day > 0);
    let month = pattern.get("month").and_then(Value::as_u64).filter(|month| *month > 0);
    match kind {
        "daily" => {
            rule.insert("frequency".into(), json!("daily"));
        }
        "weekly" => {
            rule.insert("frequency".into(), json!("weekly"));
            let days = days();
            if !days.is_empty() {
                rule.insert("byDay".into(), json!(days.iter().map(|day| json!({ "day": day })).collect::<Vec<_>>()));
            }
            let first = text(pattern, "firstDayOfWeek").and_then(day_to_jscal).unwrap_or("su");
            if interval > 1 && first != "mo" {
                rule.insert("firstDayOfWeek".into(), json!(first));
            }
        }
        "absoluteMonthly" => {
            rule.insert("frequency".into(), json!("monthly"));
            if let Some(day) = month_day.filter(|day| *day != u64::from(start.day())) {
                rule.insert("byMonthDay".into(), json!([day]));
            }
        }
        "relativeMonthly" | "relativeYearly" => {
            let yearly = kind == "relativeYearly";
            rule.insert("frequency".into(), json!(if yearly { "yearly" } else { "monthly" }));
            let n = nth();
            rule.insert(
                "byDay".into(),
                json!(days().iter().map(|day| json!({ "day": day, "nthOfPeriod": n })).collect::<Vec<_>>()),
            );
            if yearly && let Some(month) = month {
                rule.insert("byMonth".into(), json!([month.to_string()]));
            }
        }
        "absoluteYearly" => {
            rule.insert("frequency".into(), json!("yearly"));
            if let Some(month) = month.filter(|month| *month != u64::from(start.month())) {
                rule.insert("byMonth".into(), json!([month.to_string()]));
            }
            if let Some(day) = month_day.filter(|day| *day != u64::from(start.day())) {
                rule.insert("byMonthDay".into(), json!([day]));
            }
        }
        _ => return None,
    }
    if interval > 1 {
        rule.insert("interval".into(), json!(interval));
    }
    match range.and_then(|range| text(range, "type")) {
        Some("endDate") => {
            if let Some(end) = range.and_then(|range| text(range, "endDate")).and_then(parse_local) {
                let until = if all_day { end } else { end.date().and_hms_opt(23, 59, 59).unwrap_or(end) };
                rule.insert("until".into(), json!(format_local(until)));
            }
        }
        Some("numbered") => {
            if let Some(count) = range.and_then(|range| range.get("numberOfOccurrences")).and_then(Value::as_u64) {
                rule.insert("count".into(), json!(count));
            }
        }
        _ => {}
    }
    Some(Value::Object(rule))
}

/// A JSCalendar rule as Graph's `patternedRecurrence`, for a series that starts on `start`.
pub fn rule_to_graph(rule: &Value, start: NaiveDate, zone: &str) -> Option<Value> {
    let frequency = text(rule, "frequency")?.to_ascii_lowercase();
    let interval = rule.get("interval").and_then(Value::as_u64).unwrap_or(1).max(1);
    let by_day: Vec<(&str, Option<i64>)> = rule
        .get("byDay")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|day| Some((text(day, "day")?, day.get("nthOfPeriod").and_then(Value::as_i64))))
        .collect();
    let first_number = |key: &str| -> Option<u64> {
        let first = rule.get(key)?.as_array()?.first()?;
        first.as_u64().or_else(|| first.as_str()?.parse().ok())
    };
    let graph_days = |days: &[(&str, Option<i64>)]| -> Vec<&'static str> {
        days.iter().filter_map(|(day, _)| day_to_graph(day)).collect()
    };
    let weekday = DAYS[start.weekday().num_days_from_monday() as usize].0;
    let index_name = |n: i64| INDEXES.iter().find(|(_, k)| *k == n).map_or("first", |(name, _)| name);
    let pattern = match frequency.as_str() {
        "daily" => json!({ "type": "daily", "interval": interval }),
        "weekly" => {
            let mut days = graph_days(&by_day);
            if days.is_empty() {
                days.push(weekday);
            }
            json!({ "type": "weekly", "interval": interval, "daysOfWeek": days, "firstDayOfWeek": "monday" })
        }
        "monthly" => match by_day.iter().find_map(|(_, n)| *n) {
            Some(n) => json!({
                "type": "relativeMonthly", "interval": interval, "daysOfWeek": graph_days(&by_day), "index": index_name(n)
            }),
            None => json!({
                "type": "absoluteMonthly", "interval": interval,
                "dayOfMonth": first_number("byMonthDay").unwrap_or(u64::from(start.day()))
            }),
        },
        "yearly" => {
            let month = first_number("byMonth").unwrap_or(u64::from(start.month()));
            match by_day.iter().find_map(|(_, n)| *n) {
                Some(n) => json!({
                    "type": "relativeYearly", "interval": interval, "daysOfWeek": graph_days(&by_day),
                    "index": index_name(n), "month": month
                }),
                None => json!({
                    "type": "absoluteYearly", "interval": interval, "month": month,
                    "dayOfMonth": first_number("byMonthDay").unwrap_or(u64::from(start.day()))
                }),
            }
        }
        _ => return None,
    };
    let start_date = start.format("%Y-%m-%d").to_string();
    let range = if let Some(until) = text(rule, "until").and_then(parse_local) {
        json!({ "type": "endDate", "startDate": start_date, "endDate": until.date().format("%Y-%m-%d").to_string(), "recurrenceTimeZone": zone })
    } else if let Some(count) = rule.get("count").and_then(Value::as_u64) {
        json!({ "type": "numbered", "startDate": start_date, "numberOfOccurrences": count, "recurrenceTimeZone": zone })
    } else {
        json!({ "type": "noEnd", "startDate": start_date, "recurrenceTimeZone": zone })
    };
    Some(json!({ "pattern": pattern, "range": range }))
}

/// A Graph event as the app reads it.
#[derive(Debug, Clone)]
pub struct GraphEvent {
    pub id: String,
    /// `singleInstance`, `occurrence`, `exception` or `seriesMaster`.
    pub kind: String,
    pub series_master_id: Option<String>,
    /// The JSCalendar event: start in its own zone (or a date for all-day events), duration,
    /// title, description, location, rule.
    pub event: Value,
    pub start: NaiveDateTime,
    /// Start and end in UTC (timed events).
    pub utc: Option<(chrono::DateTime<Utc>, chrono::DateTime<Utc>)>,
    /// Graph's own rule, kept to write back when only the start moves.
    pub recurrence: Option<Value>,
}

/// Reads an event that came with UTC times.
pub fn event(value: &Value) -> Option<GraphEvent> {
    let id = text(value, "id").filter(|id| !id.is_empty())?.to_string();
    let utc_start = instant(value.get("start"))?;
    let utc_end = instant(value.get("end")).unwrap_or(utc_start).max(utc_start);
    let all_day = value.get("isAllDay").and_then(Value::as_bool).unwrap_or(false);
    let own_zone = text(value, "originalStartTimeZone").and_then(zone);
    let mut event = Map::new();
    event.insert("@type".into(), json!("Event"));
    event.insert("title".into(), json!(text(value, "subject").unwrap_or_default()));
    if let Some(body) = value.get("body") {
        let content = text(body, "content").unwrap_or_default();
        let plain = if text(body, "contentType").is_some_and(|kind| kind.eq_ignore_ascii_case("html")) {
            crate::mime::html_to_text(content)
        } else {
            content.replace("\r\n", "\n")
        };
        let plain = plain.trim_end();
        if !plain.is_empty() {
            event.insert("description".into(), json!(plain));
        }
    }
    if let Some(place) = value.get("location").and_then(|l| text(l, "displayName")).map(str::trim)
        && !place.is_empty()
    {
        event.insert("locations".into(), json!({ "1": { "@type": "Location", "name": place } }));
    }
    let (start, utc) = if all_day {
        // All-day events start at a midnight; in UTC that may be the evening before.
        let day = |time: chrono::DateTime<Utc>| -> NaiveDate {
            let naive = time.naive_utc();
            if naive.time().num_seconds_from_midnight() == 0 {
                return naive.date();
            }
            match own_zone {
                Some(zone) => jscal::in_zone(time, zone).date(),
                None if naive.hour() >= 12 => naive.date().succ_opt().unwrap_or(naive.date()),
                None => naive.date(),
            }
        };
        let (first, last) = (day(utc_start), day(utc_end));
        let days = (last - first).num_days().max(1);
        event.insert("showWithoutTime".into(), json!(true));
        event.insert("duration".into(), json!(jscal::format_duration(days * 86_400)));
        (first.and_hms_opt(0, 0, 0).unwrap_or_default(), None)
    } else {
        let zone = own_zone.unwrap_or(Tz::UTC);
        event.insert("timeZone".into(), json!(zone.name()));
        event.insert("duration".into(), json!(jscal::format_duration((utc_end - utc_start).num_seconds())));
        (jscal::in_zone(utc_start, zone), Some((utc_start, utc_end)))
    };
    event.insert("start".into(), json!(format_local(start)));
    jscal::set_participants(&mut event, &participants(value));
    let recurrence = value.get("recurrence").filter(|r| r.is_object()).cloned();
    if let Some(rule) = recurrence.as_ref().and_then(|r| rule_from_graph(r, start.date(), all_day)) {
        event.insert("recurrenceRule".into(), rule);
    }
    Some(GraphEvent {
        id,
        kind: text(value, "type").unwrap_or("singleInstance").to_string(),
        series_master_id: text(value, "seriesMasterId").filter(|id| !id.is_empty()).map(String::from),
        event: Value::Object(event),
        start,
        utc,
        recurrence,
    })
}

/// Who takes part in a meeting (`attendees`, `organizer`), the organizer first; nobody for an
/// event without invited people, where the organizer is only the calendar's owner.
fn participants(value: &Value) -> Vec<crate::model::EventParticipant> {
    use super::invite::Partstat;
    let Some(attendees) = value.get("attendees").and_then(Value::as_array).filter(|list| !list.is_empty()) else {
        return Vec::new();
    };
    // `{"emailAddress": {"name": …, "address": …}}`: the name and the address.
    fn named(entry: Option<&Value>) -> (Option<&str>, Option<&str>) {
        let person = entry.and_then(|entry| entry.get("emailAddress"));
        (person.and_then(|p| text(p, "name")), person.and_then(|p| text(p, "address")))
    }
    let (organizer_name, organizer_address) = named(value.get("organizer"));
    let organizer = jscal::NamedParticipant {
        name: organizer_name,
        address: organizer_address,
        status: Partstat::Accepted,
        organizer: true,
    };
    let invited = attendees.iter().map(|attendee| {
        let (name, address) = named(Some(attendee));
        let status = match attendee.pointer("/status/response").and_then(Value::as_str) {
            Some("accepted" | "organizer") => Partstat::Accepted,
            Some("tentativelyAccepted") => Partstat::Tentative,
            Some("declined") => Partstat::Declined,
            _ => Partstat::NeedsAction,
        };
        jscal::NamedParticipant { name, address, status, organizer: false }
    });
    jscal::clean_participants(std::iter::once(organizer).chain(invited), organizer_address)
}

/// How an event's times go to Graph: start, end, whether all-day, the zone name sent, and the day
/// the series starts in that zone.
struct Times {
    start: Value,
    end: Value,
    all_day: bool,
    zone: String,
    begin: NaiveDate,
}

/// Start and end as Graph writes them, from a JSCalendar event (see the module's note on zones).
fn times(event: &Value) -> Times {
    let all_day = jscal::is_all_day(event);
    let start = text(event, "start").and_then(parse_local).unwrap_or_default();
    let seconds = text(event, "duration").and_then(jscal::parse_duration).unwrap_or(0).max(0);
    let seconds = if all_day { (seconds / 86_400).max(1) * 86_400 } else { seconds };
    // A duration past what chrono holds (`P99999999999999D`) leaves the end at the start.
    let end = TimeDelta::try_seconds(seconds).and_then(|delta| start.checked_add_signed(delta)).unwrap_or(start);
    // All-day events usually float; one with a zone keeps it.
    let own = text(event, "timeZone").and_then(jscal::parse_zone);
    let (start, end, zone) = match own.and_then(|zone| windows_zone(zone, start.date())) {
        Some(windows) => (start, end, windows),
        // Midnight UTC of the same date for all-day events; the same instant for the rest.
        None if all_day => (start, end, "UTC"),
        None => {
            let zone = own.unwrap_or(Tz::UTC);
            (jscal::to_utc(start, zone).naive_utc(), jscal::to_utc(end, zone).naive_utc(), "UTC")
        }
    };
    Times {
        start: json!({ "dateTime": format_local(start), "timeZone": zone }),
        end: json!({ "dateTime": format_local(end), "timeZone": zone }),
        all_day,
        zone: zone.to_string(),
        begin: start.date(),
    }
}

/// Everything of a JSCalendar event Graph keeps, for a new event.
pub fn new_body(event: &Value) -> Value {
    let times = times(event);
    let mut body = json!({
        "subject": text(event, "title").unwrap_or_default(),
        "body": { "contentType": "text", "content": text(event, "description").unwrap_or_default() },
        "start": times.start,
        "end": times.end,
        "isAllDay": times.all_day,
    });
    let place = jscal::location_of(event);
    if !place.is_empty() {
        body["location"] = json!({ "displayName": place });
    }
    if let Some(rule) = event.get("recurrenceRule").filter(|rule| rule.is_object())
        && let Some(recurrence) = rule_to_graph(rule, times.begin, &times.zone)
    {
        body["recurrence"] = recurrence;
    }
    body
}

/// The Graph change for a JSCalendar patch (`patch` as `jscal::patch_for` made it) of `current`,
/// now `changed`. Only what changed goes: a body Outlook wrote in HTML stays as it is when only
/// the title changes.
pub fn patch_body(current: &GraphEvent, changed: &Value, patch: &Map<String, Value>) -> Map<String, Value> {
    let mut body = Map::new();
    let touched = |key: &str| patch.keys().any(|path| path == key || path.starts_with(&format!("{key}/")));
    if touched("title") {
        body.insert("subject".into(), json!(text(changed, "title").unwrap_or_default()));
    }
    if touched("description") {
        body.insert(
            "body".into(),
            json!({ "contentType": "text", "content": text(changed, "description").unwrap_or_default() }),
        );
    }
    if touched("locations") {
        body.insert("location".into(), json!({ "displayName": jscal::location_of(changed) }));
    }
    let retimed = ["start", "duration", "showWithoutTime", "timeZone"].iter().any(|key| touched(key));
    let Times { start, end, all_day, zone, begin } = times(changed);
    let zone = zone.as_str();
    if retimed {
        body.insert("start".into(), start);
        body.insert("end".into(), end);
        body.insert("isAllDay".into(), json!(all_day));
    }
    let new_rule = touched("recurrenceRule") || touched("recurrenceRules");
    if new_rule {
        let rule = changed.get("recurrenceRule").filter(|rule| rule.is_object());
        body.insert("recurrence".into(), rule.and_then(|rule| rule_to_graph(rule, begin, zone)).unwrap_or(Value::Null));
    } else if retimed && let Some(recurrence) = &current.recurrence {
        // Graph's own rule, only starting where the series starts now.
        let mut recurrence = recurrence.clone();
        if let Some(range) = recurrence.get_mut("range").and_then(Value::as_object_mut) {
            range.insert("startDate".into(), json!(begin.format("%Y-%m-%d").to_string()));
            range.insert("recurrenceTimeZone".into(), json!(zone));
        }
        body.insert("recurrence".into(), recurrence);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A duration past what chrono holds must not panic (as the server's DATES-H1).
    #[test]
    fn an_endless_duration_leaves_the_end_at_the_start() {
        for all_day in [false, true] {
            let event =
                json!({ "start": "2026-10-03T10:00:00", "duration": "P99999999999999D", "showWithoutTime": all_day });
            let times = times(&event);
            assert_eq!(times.start, times.end, "{all_day}");
        }
    }

    #[test]
    fn reads_calendars_and_colors() {
        let found = calendar(&json!({
            "id": "AAMk-1", "name": "Calendar", "color": "lightGreen", "hexColor": "", "isDefaultCalendar": true,
            "canEdit": true, "isRemovable": false
        }))
        .unwrap();
        assert_eq!(found.color.as_deref(), Some("#87d28e"));
        assert!(found.is_default && found.can_edit && !found.can_remove);
        let own = calendar(&json!({ "id": "x", "name": "Team", "hexColor": "#E3008C" })).unwrap();
        assert_eq!(own.color.as_deref(), Some("#e3008c"));
        assert!(calendar(&json!({ "name": "no id" })).is_none());
        assert_eq!(color_name("#ff9090"), "lightRed");
        assert_eq!(color_name("#a0d0f0"), "lightBlue");
        assert_eq!(color_name("nonsense"), "auto");
    }

    #[test]
    fn knows_windows_zones() {
        assert_eq!(zone("W. Europe Standard Time"), Some(chrono_tz::Europe::Berlin));
        assert_eq!(zone("Europe/Vienna"), Some(chrono_tz::Europe::Vienna));
        assert_eq!(zone("tzone://Microsoft/Utc"), Some(Tz::UTC));
        assert_eq!(zone("Pacific Standard Time"), Some(chrono_tz::America::Los_Angeles));
        assert_eq!(zone("Somewhere Else Time"), None);
    }

    #[test]
    fn reads_a_weekly_series_in_its_own_zone() {
        let series = event(&json!({
            "id": "S1", "type": "seriesMaster", "subject": "Yoga", "isAllDay": false,
            "body": { "contentType": "text", "content": "Bring a mat\r\n" },
            "location": { "displayName": "Studio 3" },
            "start": { "dateTime": "2026-09-03T16:00:00.0000000", "timeZone": "UTC" },
            "end": { "dateTime": "2026-09-03T17:00:00.0000000", "timeZone": "UTC" },
            "originalStartTimeZone": "W. Europe Standard Time",
            "recurrence": {
                "pattern": { "type": "weekly", "interval": 1, "daysOfWeek": ["thursday"], "firstDayOfWeek": "sunday" },
                "range": { "type": "endDate", "startDate": "2026-09-03", "endDate": "2026-12-31" }
            }
        }))
        .unwrap();
        assert_eq!(series.event["start"], "2026-09-03T18:00:00", "Berlin wall time");
        assert_eq!(series.event["timeZone"], "Europe/Berlin");
        assert_eq!(series.event["duration"], "PT1H");
        assert_eq!(series.event["description"], "Bring a mat");
        assert_eq!(jscal::location_of(&series.event), "Studio 3");
        let (rule, editable) = jscal::recurrence_of(&series.event);
        assert!(editable, "{}", series.event);
        let rule = rule.unwrap();
        assert_eq!(rule.by_day, Some(vec![crate::model::Weekday::Th]));
        assert_eq!(rule.until.as_deref(), Some("2026-12-31"));

        // Back to Graph: the same pattern, starting that day, in that zone.
        let back = new_body(&series.event);
        assert_eq!(back["start"], json!({ "dateTime": "2026-09-03T18:00:00", "timeZone": "W. Europe Standard Time" }));
        assert_eq!(back["recurrence"]["range"]["recurrenceTimeZone"], "W. Europe Standard Time");
        assert_eq!(back["recurrence"]["pattern"]["daysOfWeek"], json!(["thursday"]));
        assert_eq!(back["recurrence"]["range"]["endDate"], "2026-12-31");
    }

    #[test]
    fn reads_all_day_events_on_their_day() {
        let holiday = event(&json!({
            "id": "H", "subject": "Holiday", "isAllDay": true,
            "start": { "dateTime": "2026-10-02T22:00:00.0000000", "timeZone": "UTC" },
            "end": { "dateTime": "2026-10-03T22:00:00.0000000", "timeZone": "UTC" },
            "originalStartTimeZone": "W. Europe Standard Time"
        }))
        .unwrap();
        assert_eq!(holiday.event["start"], "2026-10-03T00:00:00");
        assert_eq!(holiday.event["duration"], "P1D");
        assert!(holiday.utc.is_none());
        let midnight = event(&json!({
            "id": "H2", "subject": "Trip", "isAllDay": true,
            "start": { "dateTime": "2026-10-03T00:00:00.0000000", "timeZone": "UTC" },
            "end": { "dateTime": "2026-10-06T00:00:00.0000000", "timeZone": "UTC" }
        }))
        .unwrap();
        assert_eq!(
            (midnight.event["start"].as_str(), midnight.event["duration"].as_str()),
            (Some("2026-10-03T00:00:00"), Some("P3D"))
        );
    }

    #[test]
    fn maps_monthly_and_yearly_rules() {
        let day = NaiveDate::from_ymd_opt(2026, 9, 15).unwrap();
        let same_day = json!({ "pattern": { "type": "absoluteMonthly", "interval": 1, "dayOfMonth": 15 }, "range": { "type": "noEnd" } });
        assert_eq!(rule_from_graph(&same_day, day, false).unwrap(), json!({ "frequency": "monthly" }));
        let second_tuesday = json!({ "pattern": { "type": "relativeMonthly", "interval": 2, "daysOfWeek": ["tuesday"], "index": "second" }, "range": { "type": "numbered", "numberOfOccurrences": 5 } });
        let rule = rule_from_graph(&second_tuesday, day, false).unwrap();
        assert_eq!(
            rule,
            json!({ "frequency": "monthly", "interval": 2, "byDay": [{ "day": "tu", "nthOfPeriod": 2 }], "count": 5 })
        );
        assert!(!jscal::recurrence_of(&json!({ "recurrenceRule": rule.clone() })).1);
        let back = rule_to_graph(&rule, day, "Europe/Berlin").unwrap();
        assert_eq!(back["pattern"]["type"], "relativeMonthly");
        assert_eq!(back["pattern"]["index"], "second");
        assert_eq!(back["range"]["numberOfOccurrences"], 5);
        let yearly = rule_to_graph(&json!({ "frequency": "yearly" }), day, "UTC").unwrap();
        assert_eq!(yearly["pattern"], json!({ "type": "absoluteYearly", "interval": 1, "month": 9, "dayOfMonth": 15 }));
        assert_eq!(yearly["range"]["type"], "noEnd");
    }

    #[test]
    fn patches_only_what_changed() {
        let current = event(&json!({
            "id": "S1", "type": "seriesMaster", "subject": "Yoga",
            "body": { "contentType": "html", "content": "<p>Bring a <b>mat</b></p>" },
            "start": { "dateTime": "2026-09-03T16:00:00", "timeZone": "UTC" },
            "end": { "dateTime": "2026-09-03T17:00:00", "timeZone": "UTC" },
            "originalStartTimeZone": "Europe/Berlin",
            "recurrence": { "pattern": { "type": "weekly", "interval": 1, "daysOfWeek": ["thursday"] },
                "range": { "type": "noEnd", "startDate": "2026-09-03" } }
        }))
        .unwrap();
        let mut changed = current.event.clone();
        let mut patch = Map::new();
        patch.insert("title".into(), json!("Yin Yoga"));
        jscal::apply_patch(&mut changed, &patch).unwrap();
        let body = patch_body(&current, &changed, &patch);
        assert_eq!(Value::Object(body), json!({ "subject": "Yin Yoga" }), "the HTML body stays");

        let mut patch = Map::new();
        patch.insert("start".into(), json!("2026-09-03T19:00:00"));
        let mut moved = current.event.clone();
        jscal::apply_patch(&mut moved, &patch).unwrap();
        let body = patch_body(&current, &moved, &patch);
        assert_eq!(body["start"], json!({ "dateTime": "2026-09-03T19:00:00", "timeZone": "W. Europe Standard Time" }));
        assert_eq!(body["end"]["dateTime"], "2026-09-03T20:00:00");
        assert_eq!(body["recurrence"]["pattern"]["daysOfWeek"], json!(["thursday"]), "Graph's own rule goes back");
    }

    #[test]
    fn writes_zones_graph_always_takes_and_keeps_all_day_dates() {
        let day = NaiveDate::from_ymd_opt(2026, 10, 3).unwrap();
        assert_eq!(windows_zone(chrono_tz::Europe::Berlin, day), Some("W. Europe Standard Time"));
        // Not in the table: one with the same winter and summer offsets.
        assert!(windows_zone(chrono_tz::Europe::Vienna, day).is_some());
        assert_eq!(windows_zone(Tz::UTC, day), None);

        // A timed event in a zone without a Windows name goes in UTC, at the same instant.
        let timed = json!({ "@type": "Event", "title": "Call", "start": "2026-10-03T09:00:00", "duration": "PT30M",
            "timeZone": "Pacific/Chatham" });
        assert_eq!(windows_zone(chrono_tz::Pacific::Chatham, day), None);
        let body = new_body(&timed);
        assert_eq!(body["start"], json!({ "dateTime": "2026-10-02T19:15:00", "timeZone": "UTC" }), "+13:45");
        assert_eq!(body["end"]["dateTime"], "2026-10-02T19:45:00");

        // An all-day day stays that day, floating or in Berlin (UTC+2 in October).
        for zone in [None, Some("Europe/Berlin")] {
            let mut holiday = json!({ "@type": "Event", "title": "Holiday", "start": "2026-10-03T00:00:00",
                "duration": "P1D", "showWithoutTime": true });
            if let Some(zone) = zone {
                holiday["timeZone"] = json!(zone);
            }
            let body = new_body(&holiday);
            assert_eq!(body["isAllDay"], true);
            assert_eq!(body["start"]["dateTime"], "2026-10-03T00:00:00", "{body}");
            assert_eq!(body["end"]["dateTime"], "2026-10-04T00:00:00");
            assert_eq!(body["start"]["timeZone"], body["end"]["timeZone"]);
            // Graph answers in UTC: midnight in that zone, which is read back as the same day.
            let utc = if zone.is_some() {
                ("2026-10-02T22:00:00", "2026-10-03T22:00:00")
            } else {
                ("2026-10-03T00:00:00", "2026-10-04T00:00:00")
            };
            let read = event(&json!({ "id": "H", "isAllDay": true,
                "start": { "dateTime": utc.0, "timeZone": "UTC" }, "end": { "dateTime": utc.1, "timeZone": "UTC" },
                "originalStartTimeZone": body["start"]["timeZone"] }))
            .unwrap();
            assert_eq!(read.event["start"], "2026-10-03T00:00:00");
            assert_eq!(read.event["duration"], "P1D");
        }
    }

    #[test]
    fn reads_who_takes_part_in_a_meeting() {
        use crate::calendar::invite::Partstat;
        let base = |extra: Value| {
            let mut value = json!({
                "id": "m", "subject": "Planning", "isAllDay": false,
                "start": { "dateTime": "2026-10-03T10:00:00", "timeZone": "UTC" },
                "end": { "dateTime": "2026-10-03T11:00:00", "timeZone": "UTC" },
            });
            value.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            jscal::participants_of(&event(&value).unwrap().event)
        };
        let found = base(json!({
            "organizer": { "emailAddress": { "name": "Kim", "address": "KIM@example.com" } },
            "attendees": [
                { "status": { "response": "declined" }, "emailAddress": { "name": "Nyu\u{202e}\u{0}", "address": "nyu@example.com" } },
                { "status": { "response": "organizer" }, "emailAddress": { "name": "Kim", "address": "kim@example.com" } },
                { "status": { "response": "notResponded" }, "emailAddress": { "address": "a\u{7}b@example.com" } },
                { "status": { "response": "accepted" }, "emailAddress": { "name": "Long", "address": format!("{}@example.com", "x".repeat(300)) } },
            ],
        }));
        let shown: Vec<_> = found.iter().map(|p| (p.name.as_str(), p.email.as_str(), p.status, p.organizer)).collect();
        assert_eq!(
            shown,
            [
                ("Kim", "kim@example.com", Partstat::Accepted, true),
                ("Nyu", "nyu@example.com", Partstat::Declined, false),
                ("Long", "", Partstat::Accepted, false),
            ]
        );
        // Without invited people the organizer is only the owner: no list.
        assert!(
            base(json!({ "organizer": { "emailAddress": { "address": "kim@example.com" } }, "attendees": [] }))
                .is_empty()
        );
        assert!(base(json!({ "attendees": "nonsense" })).is_empty());

        let many: Vec<Value> = (0..400)
            .map(|i| json!({ "emailAddress": { "name": "N".repeat(1000), "address": format!("p{i}@example.com") } }))
            .collect();
        let found =
            base(json!({ "organizer": { "emailAddress": { "address": "boss@example.com" } }, "attendees": many }));
        assert_eq!(found.len(), jscal::MAX_PARTICIPANTS);
        assert!(found[0].organizer && found[0].name == "boss@example.com");
        assert!(found[1..].iter().all(|p| p.name.chars().count() == 200 && p.status == Partstat::NeedsAction));
    }
}
