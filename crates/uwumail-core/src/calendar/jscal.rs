//! JSCalendar events (as the `calcard` crate writes them, and as a UwUMail server sends them over
//! JMAP) and the app's own calendar model: occurrences in the viewer's wall time, events as the
//! editor fills them in, and the smallest patch between the two.

use chrono::{Duration as TimeDelta, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::{Map, Value, json};

use crate::error::{Error, Result};
use crate::model::{CalendarOccurrence, EventInput, Frequency, Recurrence, Weekday};

pub const LOCAL_FORMAT: &str = "%Y-%m-%dT%H:%M:%S";
/// Longest title and location, in characters, and description, in bytes.
const MAX_TITLE: usize = 1024;
const MAX_DESCRIPTION: usize = 64 * 1024;
/// An event may last at most this long; longer ones are typing mistakes.
const MAX_DURATION_DAYS: i64 = 3660;

/// A JSCalendar `LocalDateTime` (`2026-09-23T14:00:00`); a bare date counts as its midnight.
pub fn parse_local(text: &str) -> Option<NaiveDateTime> {
    let text = text.trim();
    let text = text.strip_suffix('Z').unwrap_or(text);
    let text = text.split_once('.').map_or(text, |(whole, _)| whole);
    NaiveDateTime::parse_from_str(text, LOCAL_FORMAT)
        .ok()
        .or_else(|| NaiveDate::parse_from_str(text, "%Y-%m-%d").ok().and_then(|date| date.and_hms_opt(0, 0, 0)))
}

pub fn format_local(time: NaiveDateTime) -> String {
    time.format(LOCAL_FORMAT).to_string()
}

/// A JSCalendar (ISO 8601) duration in seconds: `P1W`, `P2D`, `PT1H30M`, `P1DT2H`, `-PT15M`.
pub fn parse_duration(text: &str) -> Option<i64> {
    let (negative, rest) = match text.trim().strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.trim().strip_prefix('+').unwrap_or(text.trim())),
    };
    let rest = rest.strip_prefix('P')?;
    let (date, time) = rest.split_once('T').unwrap_or((rest, ""));
    let mut seconds: i64 = 0;
    let mut number = String::new();
    let mut read = |part: &str, units: &[(char, i64)]| -> Option<()> {
        for c in part.chars() {
            if c.is_ascii_digit() {
                number.push(c);
                continue;
            }
            let factor = units.iter().find(|(unit, _)| *unit == c)?.1;
            let value: i64 = number.parse().ok()?;
            number.clear();
            seconds = seconds.checked_add(value.checked_mul(factor)?)?;
        }
        number.is_empty().then_some(())
    };
    read(date, &[('W', 7 * 86_400), ('D', 86_400)])?;
    read(time, &[('H', 3_600), ('M', 60), ('S', 1)])?;
    Some(if negative { -seconds } else { seconds })
}

/// Seconds as a JSCalendar duration; whole days stay days (`P2D`), the rest is time (`PT1H30M`).
pub fn format_duration(seconds: i64) -> String {
    let seconds = seconds.max(0);
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    let (hours, minutes, secs) = (rest / 3_600, rest % 3_600 / 60, rest % 60);
    let mut out = String::from("P");
    if days > 0 {
        out.push_str(&format!("{days}D"));
    }
    if rest > 0 || days == 0 {
        out.push('T');
        if hours > 0 {
            out.push_str(&format!("{hours}H"));
        }
        if minutes > 0 {
            out.push_str(&format!("{minutes}M"));
        }
        if secs > 0 || (hours == 0 && minutes == 0) {
            out.push_str(&format!("{secs}S"));
        }
    }
    out
}

pub fn parse_zone(name: &str) -> Option<Tz> {
    name.trim().parse::<Tz>().ok()
}

/// A wall time in a zone as a UTC instant. In a gap (spring forward) the time after it counts;
/// when it's there twice (fall back), the first one.
pub fn to_utc(local: NaiveDateTime, zone: Tz) -> chrono::DateTime<Utc> {
    match zone.from_local_datetime(&local) {
        chrono::LocalResult::Single(time) | chrono::LocalResult::Ambiguous(time, _) => time.with_timezone(&Utc),
        chrono::LocalResult::None => zone
            .from_local_datetime(&(local + TimeDelta::hours(1)))
            .earliest()
            .map_or_else(|| Utc.from_utc_datetime(&local), |time| time.with_timezone(&Utc)),
    }
}

pub fn in_zone(time: chrono::DateTime<Utc>, zone: Tz) -> NaiveDateTime {
    time.with_timezone(&zone).naive_local()
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// A CSS color the page can use as is: `#rgb` or `#rrggbb`; `#rrggbbaa` loses its alpha.
pub fn clean_color(color: Option<&str>) -> Option<String> {
    let color = color?.trim();
    let hex = color.strip_prefix('#')?;
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    match hex.len() {
        3 => Some(format!("#{}", hex.chars().flat_map(|c| [c, c]).collect::<String>().to_ascii_lowercase())),
        6 | 8 => Some(format!("#{}", hex[..6].to_ascii_lowercase())),
        _ => None,
    }
}

impl Weekday {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mo => "mo",
            Self::Tu => "tu",
            Self::We => "we",
            Self::Th => "th",
            Self::Fr => "fr",
            Self::Sa => "sa",
            Self::Su => "su",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Some(match text.to_ascii_lowercase().as_str() {
            "mo" => Self::Mo,
            "tu" => Self::Tu,
            "we" => Self::We,
            "th" => Self::Th,
            "fr" => Self::Fr,
            "sa" => Self::Sa,
            "su" => Self::Su,
            _ => return None,
        })
    }
}

impl Frequency {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
            Self::Yearly => "yearly",
        }
    }
}

/// The series rule of an event as the editor knows it, and whether the editor can say all of
/// it. `(None, true)` is an event that doesn't repeat.
pub fn recurrence_of(event: &Value) -> (Option<Recurrence>, bool) {
    let rule = match (event.get("recurrenceRule"), event.get("recurrenceRules")) {
        (Some(rule), _) if rule.is_object() => rule,
        (_, Some(Value::Array(rules))) if !rules.is_empty() => {
            let (recurrence, editable) = rule_to_recurrence(&rules[0]);
            return (recurrence, editable && rules.len() == 1);
        }
        _ => return (None, true),
    };
    rule_to_recurrence(rule)
}

fn rule_to_recurrence(rule: &Value) -> (Option<Recurrence>, bool) {
    let Some(fields) = rule.as_object() else { return (None, false) };
    let frequency = match text(rule, "frequency").map(str::to_ascii_lowercase).as_deref() {
        Some("daily") => Frequency::Daily,
        Some("weekly") => Frequency::Weekly,
        Some("monthly") => Frequency::Monthly,
        Some("yearly") => Frequency::Yearly,
        _ => return (None, false),
    };
    let mut editable = true;
    let interval = match rule.get("interval") {
        None | Some(Value::Null) => 1,
        Some(value) => match value.as_u64().filter(|n| (1..=1000).contains(n)) {
            Some(n) => n as u32,
            None => {
                editable = false;
                1
            }
        },
    };
    let by_day = match rule.get("byDay").and_then(Value::as_array) {
        None => None,
        Some(days) => {
            let parsed: Vec<Weekday> = days
                .iter()
                .filter(|day| day.get("nthOfPeriod").is_none_or(Value::is_null))
                .filter_map(|day| text(day, "day").and_then(Weekday::parse))
                .collect();
            if parsed.len() != days.len() || frequency != Frequency::Weekly {
                editable = false;
            }
            (frequency == Frequency::Weekly && !parsed.is_empty()).then_some(parsed)
        }
    };
    let until = text(rule, "until").and_then(parse_local).map(|time| time.date().format("%Y-%m-%d").to_string());
    let count = rule.get("count").and_then(Value::as_u64).map(|n| n.min(u64::from(u32::MAX)) as u32);
    // Everything else a rule can say (BYMONTHDAY, BYSETPOS, a different week start, ...) is
    // more than the editor shows.
    let known = ["@type", "frequency", "interval", "byDay", "until", "count"];
    for (key, value) in fields {
        let default = match key.as_str() {
            "rscale" => value.as_str().is_some_and(|v| v.eq_ignore_ascii_case("gregorian")),
            "skip" => value.as_str().is_some_and(|v| v.eq_ignore_ascii_case("omit")),
            "firstDayOfWeek" => value.as_str().is_some_and(|v| v.eq_ignore_ascii_case("mo")),
            _ => false,
        };
        if !known.contains(&key.as_str()) && !default && !value.is_null() {
            editable = false;
        }
    }
    (Some(Recurrence { frequency, interval, by_day, until, count }), editable)
}

/// A rule as JSCalendar writes it. `until` is inclusive: the end of that day, or its midnight
/// for all-day events.
pub fn recurrence_to_rule(recurrence: &Recurrence, all_day: bool) -> Result<Value> {
    let mut rule = Map::new();
    rule.insert("frequency".into(), json!(recurrence.frequency.as_str()));
    if recurrence.interval == 0 || recurrence.interval > 1000 {
        return Err(Error::invalid("The repeat interval must be between 1 and 1000."));
    }
    if recurrence.interval > 1 {
        rule.insert("interval".into(), json!(recurrence.interval));
    }
    if let Some(days) = recurrence.by_day.as_ref().filter(|days| !days.is_empty())
        && recurrence.frequency == Frequency::Weekly
    {
        let mut days = days.clone();
        days.sort_by_key(|day| *day as u8);
        days.dedup();
        rule.insert("byDay".into(), json!(days.iter().map(|day| json!({ "day": day.as_str() })).collect::<Vec<_>>()));
    }
    if let Some(until) = &recurrence.until {
        let date = NaiveDate::parse_from_str(until, "%Y-%m-%d")
            .map_err(|_| Error::invalid("The repeat end date isn't a date."))?;
        let time = if all_day { date.and_hms_opt(0, 0, 0) } else { date.and_hms_opt(23, 59, 59) };
        rule.insert("until".into(), json!(format_local(time.unwrap_or_default())));
    }
    if let Some(count) = recurrence.count {
        if count == 0 {
            return Err(Error::invalid("An event that repeats needs at least one time."));
        }
        rule.insert("count".into(), json!(count));
    }
    Ok(Value::Object(rule))
}

/// The name of an event's first location (by key, so it's stable), or "".
pub fn location_of(event: &Value) -> String {
    first_location(event).map(|(_, name)| name).unwrap_or_default()
}

fn first_location(event: &Value) -> Option<(String, String)> {
    let locations = event.get("locations")?.as_object()?;
    locations.iter().find_map(|(key, location)| text(location, "name").map(|name| (key.clone(), name.to_string())))
}

/// Where and when one occurrence is, for [`occurrence`].
#[derive(Debug, Clone)]
pub struct OccurrenceTime {
    /// The instance's start in the event's own zone, or floating.
    pub start: NaiveDateTime,
    /// The instance's start and end in UTC, when known (JMAP's utcStart/utcEnd, CalDAV's expansion).
    pub utc: Option<(chrono::DateTime<Utc>, chrono::DateTime<Utc>)>,
}

/// The ids and rights that come from outside the event.
#[derive(Debug, Clone)]
pub struct OccurrenceIds {
    pub id: String,
    pub event_id: String,
    pub account_id: String,
    pub calendar_id: String,
    pub read_only: bool,
}

/// The seconds an event lasts; all-day events last at least a day.
fn duration_of(event: &Value, all_day: bool) -> i64 {
    let seconds = text(event, "duration").and_then(parse_duration).unwrap_or(0).clamp(0, MAX_DURATION_DAYS * 86_400);
    if all_day { (seconds / 86_400).max(1) * 86_400 } else { seconds }
}

pub fn is_all_day(event: &Value) -> bool {
    event.get("showWithoutTime").and_then(Value::as_bool).unwrap_or(false)
}

/// One occurrence as the page shows it: `instance` is the event with this occurrence's own
/// values (overrides applied), `series` the event whose rule it follows.
pub fn occurrence(
    ids: OccurrenceIds,
    instance: &Value,
    series: Option<&Value>,
    time: &OccurrenceTime,
    viewer: Tz,
) -> CalendarOccurrence {
    let all_day = is_all_day(instance);
    let zone = text(instance, "timeZone").and_then(parse_zone);
    let duration = TimeDelta::seconds(duration_of(instance, all_day));
    let (start, end) = if all_day {
        let start = time.start.date().and_hms_opt(0, 0, 0).unwrap_or(time.start);
        (start, start + duration)
    } else if let Some((utc_start, utc_end)) = time.utc {
        (in_zone(utc_start, viewer), in_zone(utc_end.max(utc_start), viewer))
    } else if let Some(zone) = zone {
        let utc_start = to_utc(time.start, zone);
        (in_zone(utc_start, viewer), in_zone(utc_start + duration, viewer))
    } else {
        // Floating: the same wall time wherever the viewer is.
        (time.start, time.start + duration)
    };
    let (recurrence, recurrence_editable) = recurrence_of(series.unwrap_or(instance));
    CalendarOccurrence {
        id: ids.id,
        event_id: ids.event_id,
        account_id: ids.account_id,
        calendar_id: ids.calendar_id,
        title: text(instance, "title").unwrap_or_default().to_string(),
        description: text(instance, "description").unwrap_or_default().to_string(),
        location: location_of(instance),
        all_day,
        start: format_local(start),
        end: format_local(end),
        time_zone: if all_day { None } else { zone.map(|zone| zone.name().to_string()) },
        recurrence,
        recurrence_editable,
        recurrence_id: text(instance, "recurrenceId").map(String::from),
        read_only: ids.read_only,
        color: clean_color(text(instance, "color")),
    }
}

/// What the editor's input means as JSCalendar, checked. Keys: title, description, locations,
/// start, duration, timeZone, showWithoutTime, recurrenceRule.
#[derive(Debug, Clone, PartialEq)]
pub struct EventFields {
    pub title: String,
    pub description: String,
    pub location: String,
    pub all_day: bool,
    pub start: NaiveDateTime,
    pub duration: i64,
    pub time_zone: Option<String>,
}

pub fn fields_of(input: &EventInput) -> Result<EventFields> {
    let title = input.title.trim().to_string();
    let location = input.location.trim().to_string();
    if title.chars().count() > MAX_TITLE || location.chars().count() > MAX_TITLE {
        return Err(Error::invalid("The title or place is too long."));
    }
    if input.description.len() > MAX_DESCRIPTION {
        return Err(Error::invalid("The description is too long."));
    }
    let start = parse_local(&input.start).ok_or_else(|| Error::invalid("The start isn't a date and time."))?;
    let end = parse_local(&input.end).ok_or_else(|| Error::invalid("The end isn't a date and time."))?;
    let (start, duration, time_zone) = if input.all_day {
        let start = start.date().and_hms_opt(0, 0, 0).unwrap_or(start);
        let days = (end.date() - start.date()).num_days().max(1);
        (start, days * 86_400, None)
    } else {
        let zone = input
            .time_zone
            .as_deref()
            .map(|name| parse_zone(name).ok_or_else(|| Error::invalid(format!("\"{name}\" isn't a known time zone."))))
            .transpose()?;
        let seconds = (end - start).num_seconds();
        if seconds < 0 {
            return Err(Error::invalid("The event ends before it starts."));
        }
        (start, seconds, zone.map(|zone| zone.name().to_string()))
    };
    if duration > MAX_DURATION_DAYS * 86_400 {
        return Err(Error::invalid("That event is too long."));
    }
    Ok(EventFields {
        title,
        description: input.description.replace("\r\n", "\n"),
        location,
        all_day: input.all_day,
        start,
        duration,
        time_zone,
    })
}

/// A new event as JSCalendar properties (without ids and calendars).
pub fn new_event(input: &EventInput) -> Result<Map<String, Value>> {
    let fields = fields_of(input)?;
    let mut event = Map::new();
    event.insert("@type".into(), json!("Event"));
    event.insert("title".into(), json!(fields.title));
    if !fields.description.is_empty() {
        event.insert("description".into(), json!(fields.description));
    }
    if !fields.location.is_empty() {
        event.insert("locations".into(), json!({ "1": { "@type": "Location", "name": fields.location } }));
    }
    event.insert("start".into(), json!(format_local(fields.start)));
    event.insert("duration".into(), json!(format_duration(fields.duration)));
    if fields.all_day {
        event.insert("showWithoutTime".into(), json!(true));
    } else if let Some(zone) = &fields.time_zone {
        event.insert("timeZone".into(), json!(zone));
    }
    if let Some(recurrence) = &input.recurrence {
        event.insert("recurrenceRule".into(), recurrence_to_rule(recurrence, fields.all_day)?);
    }
    Ok(event)
}

/// Escapes a key for a JMAP patch path (RFC 6901).
pub fn pointer_segment(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// Whether an event has a rule at all, even one the editor can't show.
fn repeats(event: &Value) -> bool {
    event.get("recurrenceRule").is_some_and(Value::is_object)
        || event.get("recurrenceRules").and_then(Value::as_array).is_some_and(|rules| !rules.is_empty())
}

/// Moves a series by as much as the occurrence the edit began from was moved (`shown` is where
/// that occurrence was, in the viewer's wall time), instead of onto that occurrence's date. A
/// timed series keeps its own zone.
fn shift_series(current: &Value, fields: &mut EventFields, shown: &str) -> Result<()> {
    let shown = parse_local(shown).ok_or_else(|| Error::invalid("The occurrence's start isn't a date and time."))?;
    let Some(current_start) = text(current, "start").and_then(parse_local) else { return Ok(()) };
    let days = TimeDelta::days((fields.start.date() - shown.date()).num_days());
    if fields.all_day {
        fields.start = (current_start.date() + days).and_hms_opt(0, 0, 0).unwrap_or(fields.start);
    } else if is_all_day(current) {
        fields.start = (current_start.date() + days).and_time(fields.start.time());
    } else {
        fields.start = current_start + (fields.start - shown);
        fields.time_zone = text(current, "timeZone").and_then(parse_zone).map(|zone| zone.name().to_string());
    }
    Ok(())
}

/// The patch that turns `current` into what the editor says, touching only what changed. The
/// rule stays untouched when the editor couldn't show it and it came back as shown.
///
/// `occurrence_start` is where the occurrence the edit began from was shown: a series then moves
/// by as much as that occurrence was moved, instead of jumping to its date.
pub fn patch_for(current: &Value, input: &EventInput, occurrence_start: Option<&str>) -> Result<Map<String, Value>> {
    let mut fields = fields_of(input)?;
    if let Some(shown) = occurrence_start
        && repeats(current)
    {
        shift_series(current, &mut fields, shown)?;
    }
    let mut patch = Map::new();
    if text(current, "title").unwrap_or_default() != fields.title {
        patch.insert("title".into(), json!(fields.title));
    }
    if text(current, "description").unwrap_or_default() != fields.description {
        patch.insert("description".into(), json!(fields.description));
    }
    match (first_location(current), fields.location.is_empty()) {
        (Some((_, name)), false) if name == fields.location => {}
        (Some((key, _)), false) => {
            patch.insert(format!("locations/{}/name", pointer_segment(&key)), json!(fields.location));
        }
        (Some((key, _)), true) => {
            patch.insert(format!("locations/{}", pointer_segment(&key)), Value::Null);
        }
        (None, false) => {
            let mut locations = current.get("locations").and_then(Value::as_object).cloned().unwrap_or_default();
            locations.insert("1".into(), json!({ "@type": "Location", "name": fields.location }));
            patch.insert("locations".into(), Value::Object(locations));
        }
        (None, true) => {}
    }
    let current_all_day = is_all_day(current);
    let current_start = text(current, "start").and_then(parse_local);
    if current_start != Some(fields.start) {
        patch.insert("start".into(), json!(format_local(fields.start)));
    }
    if duration_of(current, current_all_day) != fields.duration || current.get("duration").is_none() {
        patch.insert("duration".into(), json!(format_duration(fields.duration)));
    }
    if current_all_day != fields.all_day {
        patch.insert("showWithoutTime".into(), json!(fields.all_day));
    }
    let current_zone = text(current, "timeZone").and_then(parse_zone).map(|zone| zone.name().to_string());
    if current_zone != fields.time_zone {
        patch.insert("timeZone".into(), fields.time_zone.as_ref().map_or(Value::Null, |zone| json!(zone)));
    }
    let (current_rule, editable) = recurrence_of(current);
    // A rule the editor couldn't show comes back as the part it showed: then it stays as it is.
    // All-day and timed rules end differently (`until`), so switching rewrites one the editor knows.
    let changed = current_rule != input.recurrence;
    let retimed = editable && current_rule.is_some() && current_all_day != fields.all_day;
    if changed || retimed {
        let rule = input.recurrence.as_ref().map(|r| recurrence_to_rule(r, fields.all_day)).transpose()?;
        patch.insert("recurrenceRule".into(), rule.unwrap_or(Value::Null));
        if current.get("recurrenceRules").is_some_and(|rules| !rules.is_null()) {
            patch.insert("recurrenceRules".into(), Value::Null);
        }
    }
    Ok(patch)
}

/// Applies a JMAP patch (`path/to/key` → value, `null` removes) to a JSON object, like a server
/// does. Paths through missing objects create them.
pub fn apply_patch(target: &mut Value, patch: &Map<String, Value>) -> Result<()> {
    for (path, value) in patch {
        let segments: Vec<String> = path.split('/').map(|s| s.replace("~1", "/").replace("~0", "~")).collect();
        let (last, parents) = segments.split_last().ok_or_else(|| Error::internal("An empty patch path."))?;
        let mut node = &mut *target;
        for segment in parents {
            let object = node.as_object_mut().ok_or_else(|| Error::internal("A patch path runs through a value."))?;
            node = object.entry(segment.clone()).or_insert_with(|| Value::Object(Map::new()));
        }
        let object = node.as_object_mut().ok_or_else(|| Error::internal("A patch path runs through a value."))?;
        if value.is_null() {
            object.remove(last);
        } else {
            object.insert(last.clone(), value.clone());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(start: &str, end: &str, all_day: bool) -> EventInput {
        EventInput {
            calendar_id: "c".into(),
            title: "Yoga".into(),
            description: String::new(),
            location: "Studio 3".into(),
            all_day,
            start: start.into(),
            end: end.into(),
            time_zone: (!all_day).then(|| "Europe/Berlin".into()),
            recurrence: None,
        }
    }

    #[test]
    fn reads_and_writes_durations() {
        assert_eq!(parse_duration("PT1H30M"), Some(5400));
        assert_eq!(parse_duration("P1W"), Some(7 * 86_400));
        assert_eq!(parse_duration("P1DT2H"), Some(86_400 + 7200));
        assert_eq!(parse_duration("-PT15M"), Some(-900));
        assert_eq!(parse_duration("PT0S"), Some(0));
        assert_eq!(parse_duration("1H"), None);
        assert_eq!(parse_duration("PT1X"), None);
        assert_eq!(parse_duration("PT99999999999999999999H"), None);
        assert_eq!(format_duration(5400), "PT1H30M");
        assert_eq!(format_duration(2 * 86_400), "P2D");
        assert_eq!(format_duration(86_400 + 60), "P1DT1M");
        assert_eq!(format_duration(0), "PT0S");
    }

    #[test]
    fn reads_local_times_and_colors() {
        assert_eq!(format_local(parse_local("2026-09-23T14:05:00").unwrap()), "2026-09-23T14:05:00");
        assert_eq!(format_local(parse_local("2026-09-23").unwrap()), "2026-09-23T00:00:00");
        assert_eq!(format_local(parse_local("2026-09-23T14:05:00.123Z").unwrap()), "2026-09-23T14:05:00");
        assert!(parse_local("tomorrow").is_none());
        assert_eq!(clean_color(Some("#FF8800CC")).as_deref(), Some("#ff8800"));
        assert_eq!(clean_color(Some("#f80")).as_deref(), Some("#ff8800"));
        assert_eq!(clean_color(Some("red")), None);
        assert_eq!(clean_color(Some("#12345g")), None);
        assert_eq!(clean_color(Some("url(javascript:x)")), None);
    }

    #[test]
    fn maps_rules_the_editor_can_show() {
        let weekly = json!({ "recurrenceRule": {
            "@type": "RecurrenceRule", "frequency": "weekly", "interval": 2,
            "byDay": [{ "@type": "NDay", "day": "mo" }, { "day": "we" }], "until": "2026-12-31T23:59:59"
        }});
        let (rule, editable) = recurrence_of(&weekly);
        assert!(editable);
        let rule = rule.unwrap();
        assert_eq!(rule.frequency, Frequency::Weekly);
        assert_eq!(rule.interval, 2);
        assert_eq!(rule.by_day, Some(vec![Weekday::Mo, Weekday::We]));
        assert_eq!(rule.until.as_deref(), Some("2026-12-31"));

        // The second Monday of each month is more than the editor can say.
        let nth = json!({ "recurrenceRule": { "frequency": "monthly", "byDay": [{ "day": "mo", "nthOfPeriod": 2 }] }});
        assert!(!recurrence_of(&nth).1);
        let month_day = json!({ "recurrenceRule": { "frequency": "monthly", "byMonthDay": [15] }});
        assert!(!recurrence_of(&month_day).1);
        let hourly = json!({ "recurrenceRule": { "frequency": "hourly" }});
        assert_eq!(recurrence_of(&hourly), (None, false));
        let defaults = json!({ "recurrenceRule": { "frequency": "daily", "rscale": "gregorian", "skip": "omit" }});
        assert!(recurrence_of(&defaults).1);
        let two = json!({ "recurrenceRules": [{ "frequency": "daily" }, { "frequency": "weekly" }] });
        assert!(!recurrence_of(&two).1);
        assert_eq!(recurrence_of(&json!({ "title": "once" })), (None, true));
    }

    #[test]
    fn builds_new_events() {
        let mut timed = input("2026-09-24T18:00:00", "2026-09-24T19:30:00", false);
        timed.recurrence = Some(Recurrence {
            frequency: Frequency::Weekly,
            interval: 1,
            by_day: Some(vec![Weekday::Th]),
            until: None,
            count: Some(10),
        });
        let event = Value::Object(new_event(&timed).unwrap());
        assert_eq!(event["start"], "2026-09-24T18:00:00");
        assert_eq!(event["duration"], "PT1H30M");
        assert_eq!(event["timeZone"], "Europe/Berlin");
        assert_eq!(event["locations"]["1"]["name"], "Studio 3");
        assert_eq!(event["recurrenceRule"], json!({ "frequency": "weekly", "byDay": [{ "day": "th" }], "count": 10 }));
        assert!(event.get("showWithoutTime").is_none());

        let all_day = Value::Object(new_event(&input("2026-10-03T00:00:00", "2026-10-05T00:00:00", true)).unwrap());
        assert_eq!(all_day["duration"], "P2D");
        assert_eq!(all_day["showWithoutTime"], true);
        assert!(all_day.get("timeZone").is_none());

        let mut backwards = input("2026-09-24T18:00:00", "2026-09-24T17:00:00", false);
        assert!(new_event(&backwards).is_err());
        backwards.end = "2026-09-24T19:00:00".into();
        backwards.time_zone = Some("Mars/Olympus_Mons".into());
        assert!(new_event(&backwards).is_err());
    }

    #[test]
    fn patches_only_what_changed() {
        let current = json!({
            "@type": "Event", "uid": "u1", "title": "Yoga", "start": "2026-09-24T18:00:00", "duration": "PT1H",
            "timeZone": "Europe/Berlin", "locations": { "loc1": { "@type": "Location", "name": "Studio 3" } },
            "recurrenceRule": { "frequency": "monthly", "byMonthDay": [24] }, "x-custom": 1
        });
        let mut edit = input("2026-09-24T18:00:00", "2026-09-24T19:00:00", false);
        // The editor couldn't show the rule, so it came back as the lossy version it was shown.
        edit.recurrence = recurrence_of(&current).0;
        assert!(patch_for(&current, &edit, None).unwrap().is_empty());

        edit.title = "Yin Yoga".into();
        edit.location = "Studio 4".into();
        edit.end = "2026-09-24T19:30:00".into();
        let patch = patch_for(&current, &edit, None).unwrap();
        assert_eq!(
            Value::Object(patch.clone()),
            json!({ "title": "Yin Yoga", "locations/loc1/name": "Studio 4", "duration": "PT1H30M" })
        );

        // Replacing the rule on purpose.
        edit.recurrence = None;
        let patch = patch_for(&current, &edit, None).unwrap();
        assert_eq!(patch["recurrenceRule"], Value::Null);

        let mut applied = current.clone();
        apply_patch(&mut applied, &patch).unwrap();
        assert_eq!(applied["title"], "Yin Yoga");
        assert_eq!(applied["locations"]["loc1"]["name"], "Studio 4");
        assert!(applied.get("recurrenceRule").is_none());
        assert_eq!(applied["x-custom"], 1, "unknown properties stay");

        // Turning it into an all-day event drops the zone.
        let day = input("2026-09-24T00:00:00", "2026-09-25T00:00:00", true);
        let patch = patch_for(&current, &day, None).unwrap();
        assert_eq!(patch["showWithoutTime"], true);
        assert_eq!(patch["timeZone"], Value::Null);
        assert_eq!(patch["duration"], "P1D");
        assert_eq!(patch["start"], "2026-09-24T00:00:00");
    }

    #[test]
    fn shifts_a_series_by_as_much_as_the_edited_occurrence_moved() {
        let weekly = Recurrence { frequency: Frequency::Weekly, interval: 1, by_day: None, until: None, count: None };
        let series = json!({
            "@type": "Event", "title": "Yoga", "start": "2026-09-01T18:30:00", "duration": "PT1H",
            "timeZone": "Europe/Berlin", "locations": { "1": { "@type": "Location", "name": "Studio 3" } },
            "recurrenceRule": { "frequency": "weekly" }
        });
        // The occurrence on 22 September moved half an hour later: so does the series, from its own start.
        let mut edit = input("2026-09-22T19:00:00", "2026-09-22T20:00:00", false);
        edit.recurrence = Some(weekly.clone());
        let patch = patch_for(&series, &edit, Some("2026-09-22T18:30:00")).unwrap();
        assert_eq!(Value::Object(patch), json!({ "start": "2026-09-01T19:00:00" }));

        // Unmoved, nothing changes; without the occurrence it jumps to the date it was edited on.
        edit.start = "2026-09-22T18:30:00".into();
        edit.end = "2026-09-22T19:30:00".into();
        assert!(patch_for(&series, &edit, Some("2026-09-22T18:30:00")).unwrap().is_empty());
        assert_eq!(patch_for(&series, &edit, None).unwrap()["start"], "2026-09-22T18:30:00");

        // A series kept in another zone moves by the same time and keeps its zone.
        let mut elsewhere = series.clone();
        elsewhere["timeZone"] = json!("America/New_York");
        elsewhere["start"] = json!("2026-09-01T12:30:00");
        edit.start = "2026-09-23T18:30:00".into();
        edit.end = "2026-09-23T19:30:00".into();
        let patch = patch_for(&elsewhere, &edit, Some("2026-09-22T18:30:00")).unwrap();
        assert_eq!(Value::Object(patch), json!({ "start": "2026-09-02T12:30:00" }));

        // All-day series move by whole days.
        let days = json!({
            "@type": "Event", "title": "Yoga", "start": "2026-09-01T00:00:00", "duration": "P1D",
            "showWithoutTime": true, "locations": { "1": { "@type": "Location", "name": "Studio 3" } },
            "recurrenceRule": { "frequency": "weekly" }
        });
        let mut day = input("2026-09-24T00:00:00", "2026-09-25T00:00:00", true);
        day.recurrence = Some(weekly);
        let patch = patch_for(&days, &day, Some("2026-09-22T00:00:00")).unwrap();
        assert_eq!(Value::Object(patch), json!({ "start": "2026-09-03T00:00:00" }));

        // An all-day series that gets a time keeps its day shift and takes the new time.
        let mut timed = day.clone();
        timed.all_day = false;
        timed.start = "2026-09-23T09:00:00".into();
        timed.end = "2026-09-23T10:00:00".into();
        timed.time_zone = Some("Europe/Berlin".into());
        let patch = patch_for(&days, &timed, Some("2026-09-22T00:00:00")).unwrap();
        assert_eq!(patch["start"], "2026-09-02T09:00:00");
        assert_eq!(patch["showWithoutTime"], false);
        assert_eq!(patch["timeZone"], "Europe/Berlin");

        // A single event ignores where it was shown.
        let single = json!({ "@type": "Event", "title": "Yoga", "start": "2026-09-01T18:30:00", "duration": "PT1H",
            "timeZone": "Europe/Berlin", "locations": { "1": { "@type": "Location", "name": "Studio 3" } } });
        let once = input("2026-09-22T19:00:00", "2026-09-22T20:00:00", false);
        let patch = patch_for(&single, &once, Some("2026-09-01T18:30:00")).unwrap();
        assert_eq!(Value::Object(patch), json!({ "start": "2026-09-22T19:00:00" }));
    }

    #[test]
    fn shows_occurrences_in_the_viewers_wall_time() {
        let ids = || OccurrenceIds {
            id: "a:e1".into(),
            event_id: "a:e1".into(),
            account_id: "a".into(),
            calendar_id: "a:c1".into(),
            read_only: false,
        };
        let event = json!({ "title": "Call", "start": "2026-09-24T09:00:00", "duration": "PT30M", "timeZone": "America/New_York" });
        let time = OccurrenceTime { start: parse_local("2026-09-24T09:00:00").unwrap(), utc: None };
        let berlin = parse_zone("Europe/Berlin").unwrap();
        let occurrence = occurrence(ids(), &event, None, &time, berlin);
        assert_eq!(occurrence.start, "2026-09-24T15:00:00");
        assert_eq!(occurrence.end, "2026-09-24T15:30:00");
        assert_eq!(occurrence.time_zone.as_deref(), Some("America/New_York"));
        assert!(occurrence.recurrence.is_none() && occurrence.recurrence_editable);

        let holiday =
            json!({ "title": "Holiday", "start": "2026-10-03T00:00:00", "duration": "P1D", "showWithoutTime": true });
        let time = OccurrenceTime { start: parse_local("2026-10-03T00:00:00").unwrap(), utc: None };
        let shown = super::occurrence(ids(), &holiday, None, &time, parse_zone("Asia/Tokyo").unwrap());
        assert_eq!((shown.start.as_str(), shown.end.as_str()), ("2026-10-03T00:00:00", "2026-10-04T00:00:00"));
        assert!(shown.all_day && shown.time_zone.is_none());

        // Floating times stay where they are.
        let floating = json!({ "title": "Wake up", "start": "2026-09-24T07:00:00", "duration": "PT5M" });
        let time = OccurrenceTime { start: parse_local("2026-09-24T07:00:00").unwrap(), utc: None };
        assert_eq!(super::occurrence(ids(), &floating, None, &time, berlin).start, "2026-09-24T07:00:00");
    }

    #[test]
    fn handles_daylight_saving_gaps() {
        let berlin = parse_zone("Europe/Berlin").unwrap();
        // 02:30 on 29 March 2026 doesn't exist in Berlin; the hour after it does.
        let gap = to_utc(parse_local("2026-03-29T02:30:00").unwrap(), berlin);
        assert_eq!(in_zone(gap, berlin), parse_local("2026-03-29T03:30:00").unwrap());
    }
}
