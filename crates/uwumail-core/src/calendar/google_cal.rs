//! Google Calendar (API v3) calendars and events in the JSCalendar shape the app works with, and
//! back. Google names zones the IANA way and keeps rules as iCalendar `RRULE` lines.

use chrono::{DateTime, Duration as TimeDelta, NaiveDate, NaiveDateTime, Utc};
use chrono_tz::Tz;
use serde_json::{Map, Value, json};

use super::jscal::{self, format_local, parse_local};

/// Google's calendar of contacts' birthdays: the app makes its own from the same contacts.
pub const CONTACTS_BIRTHDAYS: &str = "addressbook#contacts@group.v.calendar.google.com";

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// A calendar of the person's calendar list.
#[derive(Debug, Clone, PartialEq)]
pub struct GoogleCalendar {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub primary: bool,
    pub can_write: bool,
    pub owner: bool,
    pub zone: Option<Tz>,
}

pub fn calendar(value: &Value) -> Option<GoogleCalendar> {
    let id = text(value, "id").filter(|id| !id.is_empty())?.to_string();
    if id == CONTACTS_BIRTHDAYS || value.get("deleted").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let role = text(value, "accessRole").unwrap_or("reader");
    Some(GoogleCalendar {
        name: text(value, "summaryOverride").or_else(|| text(value, "summary")).unwrap_or(&id).to_string(),
        color: jscal::clean_color(text(value, "backgroundColor")),
        primary: value.get("primary").and_then(Value::as_bool).unwrap_or(false),
        can_write: matches!(role, "owner" | "writer"),
        owner: role == "owner",
        zone: text(value, "timeZone").and_then(jscal::parse_zone),
        id,
    })
}

/// An `RRULE` line (without `RRULE:`) as a JSCalendar rule. Parts the app doesn't know stay in the
/// rule under their own name, which makes it one the editor can't change.
///
/// `zone` is the event's own zone: a JSCalendar `until` is a wall time there, while iCalendar's
/// `UNTIL` of a timed event is in UTC. All-day rules end on a date.
pub fn rule_from_rrule(line: &str, zone: Option<Tz>, all_day: bool) -> Option<Value> {
    let mut rule = Map::new();
    for part in line.split(';') {
        let (key, value) = part.split_once('=')?;
        let key = key.trim().to_ascii_uppercase();
        let value = value.trim();
        match key.as_str() {
            "FREQ" => {
                rule.insert("frequency".into(), json!(value.to_ascii_lowercase()));
            }
            "INTERVAL" => {
                rule.insert("interval".into(), json!(value.parse::<u64>().ok()?));
            }
            "COUNT" => {
                rule.insert("count".into(), json!(value.parse::<u64>().ok()?));
            }
            "UNTIL" => {
                let until = match NaiveDateTime::parse_from_str(value.trim_end_matches('Z'), "%Y%m%dT%H%M%S") {
                    // A UTC instant: the same instant as a wall time in the event's zone.
                    Ok(time) if value.ends_with('Z') => jscal::in_zone(time.and_utc(), zone.unwrap_or(Tz::UTC)),
                    Ok(time) => time,
                    Err(_) => NaiveDate::parse_from_str(value, "%Y%m%d").ok()?.and_hms_opt(0, 0, 0)?,
                };
                let until = if all_day { until.date().and_hms_opt(0, 0, 0).unwrap_or(until) } else { until };
                rule.insert("until".into(), json!(format_local(until)));
            }
            "BYDAY" => {
                let days: Option<Vec<Value>> = value
                    .split(',')
                    .map(|day| {
                        let day = day.trim();
                        // The day is the last two letters, "-1FR" or "MO"; anything else (also
                        // letters outside ASCII, which byte offsets would cut apart) isn't one.
                        let split = day.len().checked_sub(2)?;
                        if !day.is_char_boundary(split) {
                            return None;
                        }
                        let (nth, name) = day.split_at(split);
                        if !name.bytes().all(|b| b.is_ascii_alphabetic()) {
                            return None;
                        }
                        let mut entry = json!({ "day": name.to_ascii_lowercase() });
                        if !nth.is_empty() {
                            entry["nthOfPeriod"] = json!(nth.parse::<i64>().ok()?);
                        }
                        Some(entry)
                    })
                    .collect();
                rule.insert("byDay".into(), json!(days?));
            }
            "BYMONTHDAY" => {
                let days: Vec<i64> = value.split(',').filter_map(|d| d.trim().parse().ok()).collect();
                rule.insert("byMonthDay".into(), json!(days));
            }
            "BYMONTH" => {
                let months: Vec<String> = value.split(',').map(|m| m.trim().to_string()).collect();
                rule.insert("byMonth".into(), json!(months));
            }
            "WKST" => {
                rule.insert("firstDayOfWeek".into(), json!(value.to_ascii_lowercase()));
            }
            other => {
                rule.insert(format!("x-{}", other.to_ascii_lowercase()), json!(value));
            }
        }
    }
    rule.contains_key("frequency").then_some(Value::Object(rule))
}

/// A JSCalendar rule as an `RRULE:` line. `until` is a wall time in `zone`; iCalendar wants it in UTC
/// for timed events, as a date for all-day ones.
pub fn rule_to_rrule(rule: &Value, all_day: bool, zone: Option<Tz>) -> Option<String> {
    let frequency = text(rule, "frequency")?.to_ascii_uppercase();
    let mut parts = vec![format!("FREQ={frequency}")];
    if let Some(interval) = rule.get("interval").and_then(Value::as_u64).filter(|n| *n > 1) {
        parts.push(format!("INTERVAL={interval}"));
    }
    if let Some(days) = rule.get("byDay").and_then(Value::as_array).filter(|days| !days.is_empty()) {
        let days: Vec<String> = days
            .iter()
            .filter_map(|day| {
                let name = text(day, "day")?.to_ascii_uppercase();
                Some(match day.get("nthOfPeriod").and_then(Value::as_i64) {
                    Some(n) => format!("{n}{name}"),
                    None => name,
                })
            })
            .collect();
        parts.push(format!("BYDAY={}", days.join(",")));
    }
    let list = |key: &str| -> Option<String> {
        let items: Vec<String> = rule
            .get(key)?
            .as_array()?
            .iter()
            .filter_map(|item| item.as_i64().map(|n| n.to_string()).or_else(|| item.as_str().map(String::from)))
            .collect();
        (!items.is_empty()).then(|| items.join(","))
    };
    if let Some(months) = list("byMonth") {
        parts.push(format!("BYMONTH={months}"));
    }
    if let Some(days) = list("byMonthDay") {
        parts.push(format!("BYMONTHDAY={days}"));
    }
    if let Some(first) = text(rule, "firstDayOfWeek") {
        parts.push(format!("WKST={}", first.to_ascii_uppercase()));
    }
    if let Some(until) = text(rule, "until").and_then(parse_local) {
        if all_day {
            parts.push(format!("UNTIL={}", until.format("%Y%m%d")));
        } else {
            let utc = jscal::to_utc(until, zone.unwrap_or(Tz::UTC));
            parts.push(format!("UNTIL={}", utc.format("%Y%m%dT%H%M%SZ")));
        }
    } else if let Some(count) = rule.get("count").and_then(Value::as_u64) {
        parts.push(format!("COUNT={count}"));
    }
    Some(format!("RRULE:{}", parts.join(";")))
}

/// A Google event as the app reads it.
#[derive(Debug, Clone)]
pub struct GoogleEvent {
    pub id: String,
    pub recurring_event_id: Option<String>,
    /// The JSCalendar event (start in its own zone, or a date for all-day events).
    pub event: Value,
    pub start: NaiveDateTime,
    pub utc: Option<(DateTime<Utc>, DateTime<Utc>)>,
    /// Google's own `recurrence` lines (RRULE, EXDATE, ...).
    pub recurrence: Vec<String>,
}

fn instant(value: Option<&Value>) -> Option<DateTime<Utc>> {
    let text = text(value?, "dateTime")?;
    DateTime::parse_from_rfc3339(text).ok().map(|time| time.with_timezone(&Utc))
}

fn date(value: Option<&Value>) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(text(value?, "date")?, "%Y-%m-%d").ok()
}

/// Reads an event; `calendar_zone` stands in for events that don't name their own. Cancelled
/// ones (deleted occurrences) are `None`.
pub fn event(value: &Value, calendar_zone: Option<Tz>) -> Option<GoogleEvent> {
    if text(value, "status") == Some("cancelled") {
        return None;
    }
    let id = text(value, "id").filter(|id| !id.is_empty())?.to_string();
    let mut event = Map::new();
    event.insert("@type".into(), json!("Event"));
    event.insert("title".into(), json!(text(value, "summary").unwrap_or_default()));
    if let Some(description) = text(value, "description").map(str::trim_end).filter(|d| !d.is_empty()) {
        let plain = if description.contains("</") || description.contains("<br") {
            crate::mime::html_to_text(description)
        } else {
            description.to_string()
        };
        event.insert("description".into(), json!(plain));
    }
    if let Some(place) = text(value, "location").map(str::trim).filter(|place| !place.is_empty()) {
        event.insert("locations".into(), json!({ "1": { "@type": "Location", "name": place } }));
    }
    let (start, utc) = if let Some(first) = date(value.get("start")) {
        let last = date(value.get("end")).or_else(|| first.checked_add_signed(TimeDelta::days(1))).unwrap_or(first);
        let days = (last - first).num_days().max(1);
        event.insert("showWithoutTime".into(), json!(true));
        event.insert("duration".into(), json!(jscal::format_duration(days * 86_400)));
        (first.and_hms_opt(0, 0, 0).unwrap_or_default(), None)
    } else {
        let utc_start = instant(value.get("start"))?;
        let utc_end = instant(value.get("end")).unwrap_or(utc_start).max(utc_start);
        let zone = value
            .get("start")
            .and_then(|start| text(start, "timeZone"))
            .and_then(jscal::parse_zone)
            .or(calendar_zone)
            .unwrap_or(Tz::UTC);
        event.insert("timeZone".into(), json!(zone.name()));
        event.insert("duration".into(), json!(jscal::format_duration((utc_end - utc_start).num_seconds())));
        (jscal::in_zone(utc_start, zone), Some((utc_start, utc_end)))
    };
    event.insert("start".into(), json!(format_local(start)));
    let all_day = utc.is_none();
    let rule_zone = event.get("timeZone").and_then(Value::as_str).and_then(jscal::parse_zone).or(calendar_zone);
    let recurrence: Vec<String> = value
        .get("recurrence")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(String::from)
        .collect();
    let rules: Vec<Value> = recurrence
        .iter()
        .filter_map(|line| line.strip_prefix("RRULE:"))
        .filter_map(|line| rule_from_rrule(line, rule_zone, all_day))
        .collect();
    match rules.len() {
        0 => {}
        1 => {
            event.insert("recurrenceRule".into(), rules[0].clone());
        }
        _ => {
            event.insert("recurrenceRules".into(), json!(rules));
        }
    }
    Some(GoogleEvent {
        id,
        recurring_event_id: text(value, "recurringEventId").filter(|id| !id.is_empty()).map(String::from),
        event: Value::Object(event),
        start,
        utc,
        recurrence,
    })
}

/// Start and end as Google writes them.
fn times(event: &Value) -> (Value, Value) {
    let start = text(event, "start").and_then(parse_local).unwrap_or_default();
    let seconds = text(event, "duration").and_then(jscal::parse_duration).unwrap_or(0).max(0);
    if jscal::is_all_day(event) {
        let days = (seconds / 86_400).max(1);
        // A duration past what chrono holds (`P99999999999999D`) leaves the end at the start.
        let end =
            TimeDelta::try_days(days).and_then(|delta| start.date().checked_add_signed(delta)).unwrap_or(start.date());
        let day =
            |d: NaiveDate| json!({ "date": d.format("%Y-%m-%d").to_string(), "dateTime": null, "timeZone": null });
        (day(start.date()), day(end))
    } else {
        let zone = text(event, "timeZone").unwrap_or("UTC");
        // A duration past what chrono holds (`P99999999999999D`) leaves the end at the start.
        let end = TimeDelta::try_seconds(seconds).and_then(|delta| start.checked_add_signed(delta)).unwrap_or(start);
        let at = |t: NaiveDateTime| json!({ "dateTime": format_local(t), "timeZone": zone, "date": null });
        (at(start), at(end))
    }
}

fn rrule_of(event: &Value) -> Option<String> {
    let rule = event.get("recurrenceRule").filter(|rule| rule.is_object())?;
    rule_to_rrule(rule, jscal::is_all_day(event), text(event, "timeZone").and_then(jscal::parse_zone))
}

/// Everything of a JSCalendar event Google keeps, for a new event.
pub fn new_body(event: &Value) -> Value {
    let (start, end) = times(event);
    let mut body = json!({
        "summary": text(event, "title").unwrap_or_default(),
        "start": start,
        "end": end,
    });
    if let Some(description) = text(event, "description").filter(|d| !d.is_empty()) {
        body["description"] = json!(description);
    }
    let place = jscal::location_of(event);
    if !place.is_empty() {
        body["location"] = json!(place);
    }
    if let Some(line) = rrule_of(event) {
        body["recurrence"] = json!([line]);
    }
    body
}

/// The Google change for a JSCalendar patch of `current`, now `changed`; only what changed goes.
pub fn patch_body(current: &GoogleEvent, changed: &Value, patch: &Map<String, Value>) -> Map<String, Value> {
    let mut body = Map::new();
    let touched = |key: &str| patch.keys().any(|path| path == key || path.starts_with(&format!("{key}/")));
    if touched("title") {
        body.insert("summary".into(), json!(text(changed, "title").unwrap_or_default()));
    }
    if touched("description") {
        body.insert("description".into(), json!(text(changed, "description").unwrap_or_default()));
    }
    if touched("locations") {
        body.insert("location".into(), json!(jscal::location_of(changed)));
    }
    let retimed = ["start", "duration", "showWithoutTime", "timeZone"].iter().any(|key| touched(key));
    if retimed {
        let (start, end) = times(changed);
        body.insert("start".into(), start);
        body.insert("end".into(), end);
    }
    // A new rule replaces the RRULE line; exceptions (EXDATE) and the rest stay. All-day and timed
    // rules end differently, so switching writes it anew too.
    let rule_changed = touched("recurrenceRule") || touched("recurrenceRules") || touched("showWithoutTime");
    if rule_changed && (touched("recurrenceRule") || touched("recurrenceRules") || !current.recurrence.is_empty()) {
        let mut lines: Vec<String> =
            current.recurrence.iter().filter(|line| !line.starts_with("RRULE:")).cloned().collect();
        match rrule_of(changed) {
            Some(line) => lines.insert(0, line),
            None => lines.clear(),
        }
        body.insert("recurrence".into(), json!(lines));
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
            let (start, end) = times(&event);
            assert_eq!(start, end, "{all_day}");
        }
    }

    #[test]
    fn reads_the_calendar_list() {
        let primary = calendar(&json!({
            "id": "mini@example.com", "summary": "mini@example.com", "summaryOverride": "Mine",
            "backgroundColor": "#9FE1E7", "accessRole": "owner", "primary": true, "timeZone": "Europe/Berlin"
        }))
        .unwrap();
        assert_eq!(primary.name, "Mine");
        assert_eq!(primary.color.as_deref(), Some("#9fe1e7"));
        assert!(primary.primary && primary.can_write && primary.owner);
        assert_eq!(primary.zone, Some(chrono_tz::Europe::Berlin));
        let holidays = calendar(&json!({ "id": "de.german#holiday@group.v.calendar.google.com", "summary": "Feiertage", "accessRole": "reader" })).unwrap();
        assert!(!holidays.can_write);
        assert!(calendar(&json!({ "id": CONTACTS_BIRTHDAYS, "accessRole": "reader" })).is_none());
    }

    #[test]
    fn reads_and_writes_rules() {
        let rule = rule_from_rrule("FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T225959Z", None, false).unwrap();
        assert_eq!(
            rule,
            json!({ "frequency": "weekly", "byDay": [{ "day": "mo" }, { "day": "we" }], "until": "2026-12-31T22:59:59" })
        );
        assert!(jscal::recurrence_of(&json!({ "recurrenceRule": rule.clone() })).1);
        let nth = rule_from_rrule("FREQ=MONTHLY;BYDAY=-1FR;INTERVAL=2", None, false).unwrap();
        assert_eq!(nth["byDay"], json!([{ "day": "fr", "nthOfPeriod": -1 }]));
        assert_eq!(rule_to_rrule(&nth, false, None).unwrap(), "RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR");
        let odd = rule_from_rrule("FREQ=DAILY;BYHOUR=9", None, false).unwrap();
        assert!(!jscal::recurrence_of(&json!({ "recurrenceRule": odd })).1, "more than the editor knows");
        assert!(rule_from_rrule("nonsense", None, false).is_none());
        // Day names outside ASCII are no days (and cut nothing apart).
        for odd in ["FREQ=WEEKLY;BYDAY=\u{e9}A", "FREQ=WEEKLY;BYDAY=1\u{e9}", "FREQ=WEEKLY;BYDAY=\u{1F600}"] {
            assert!(rule_from_rrule(odd, None, false).is_none(), "{odd}");
        }

        let berlin = Some(chrono_tz::Europe::Berlin);
        let until = json!({ "frequency": "weekly", "until": "2026-12-31T23:59:59" });
        assert_eq!(rule_to_rrule(&until, false, berlin).unwrap(), "RRULE:FREQ=WEEKLY;UNTIL=20261231T225959Z");
        let days = json!({ "frequency": "yearly", "until": "2030-10-03T00:00:00" });
        assert_eq!(rule_to_rrule(&days, true, None).unwrap(), "RRULE:FREQ=YEARLY;UNTIL=20301003");
    }

    #[test]
    fn utc_until_is_read_as_a_wall_time_of_the_events_zone() {
        // The end of 30 September in New York is 04:00 UTC on 1 October; read as a wall time it
        // would add a day to the series.
        let ny = Some(chrono_tz::America::New_York);
        let rule = rule_from_rrule("FREQ=DAILY;UNTIL=20261001T035959Z", ny, false).unwrap();
        assert_eq!(rule["until"], "2026-09-30T23:59:59");
        // And back to the same UNTIL, however often it is written.
        assert_eq!(rule_to_rrule(&rule, false, ny).unwrap(), "RRULE:FREQ=DAILY;UNTIL=20261001T035959Z");
        let berlin = Some(chrono_tz::Europe::Berlin);
        let rule = rule_from_rrule("FREQ=WEEKLY;UNTIL=20261231T225959Z", berlin, false).unwrap();
        assert_eq!(rule["until"], "2026-12-31T23:59:59");
        // All-day series end on a date, also when UNTIL came as a UTC time.
        let rule = rule_from_rrule("FREQ=YEARLY;UNTIL=20301002T220000Z", berlin, true).unwrap();
        assert_eq!(rule["until"], "2030-10-03T00:00:00");
        let rule = rule_from_rrule("FREQ=YEARLY;UNTIL=20301003", None, true).unwrap();
        assert_eq!(rule["until"], "2030-10-03T00:00:00");

        // Through a whole event: the series' own zone counts, not the calendar's.
        let read = event(
            &json!({ "id": "s", "summary": "Standup",
                "start": { "dateTime": "2026-09-01T09:00:00-04:00", "timeZone": "America/New_York" },
                "end": { "dateTime": "2026-09-01T09:15:00-04:00", "timeZone": "America/New_York" },
                "recurrence": ["RRULE:FREQ=DAILY;UNTIL=20261001T035959Z"] }),
            Some(chrono_tz::Europe::Berlin),
        )
        .unwrap();
        assert_eq!(read.event["recurrenceRule"]["until"], "2026-09-30T23:59:59");
    }

    #[test]
    fn extreme_dates_do_not_panic() {
        let _ = event(&json!({ "id": "x", "start": { "date": "262142-12-31" } }), None);
        let long = json!({ "@type": "Event", "start": "2026-10-03T00:00:00", "duration": "P99999999D",
            "showWithoutTime": true });
        let _ = new_body(&long);
    }

    #[test]
    fn reads_timed_all_day_and_cancelled_events() {
        let timed = event(
            &json!({
                "id": "e1", "summary": "Call", "location": "Phone",
                "start": { "dateTime": "2026-09-24T09:00:00-04:00", "timeZone": "America/New_York" },
                "end": { "dateTime": "2026-09-24T09:30:00-04:00", "timeZone": "America/New_York" },
                "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=TH", "EXDATE;TZID=America/New_York:20261001T090000"]
            }),
            None,
        )
        .unwrap();
        assert_eq!(timed.event["start"], "2026-09-24T09:00:00");
        assert_eq!(timed.event["timeZone"], "America/New_York");
        assert_eq!(timed.event["duration"], "PT30M");
        assert_eq!(timed.utc.unwrap().0.to_rfc3339(), "2026-09-24T13:00:00+00:00");
        assert_eq!(timed.event["recurrenceRule"]["frequency"], "weekly");

        let day = event(&json!({ "id": "e2", "summary": "Trip", "start": { "date": "2026-10-03" }, "end": { "date": "2026-10-06" } }), None).unwrap();
        assert_eq!(
            (day.event["start"].as_str(), day.event["duration"].as_str()),
            (Some("2026-10-03T00:00:00"), Some("P3D"))
        );
        assert!(event(&json!({ "id": "e3", "status": "cancelled" }), None).is_none());

        // Written back, the exception stays and only the rule changes.
        let mut changed = timed.event.clone();
        let mut patch = Map::new();
        patch.insert("recurrenceRule".into(), json!({ "frequency": "daily" }));
        jscal::apply_patch(&mut changed, &patch).unwrap();
        let body = patch_body(&timed, &changed, &patch);
        assert_eq!(
            Value::Object(body),
            json!({ "recurrence": ["RRULE:FREQ=DAILY", "EXDATE;TZID=America/New_York:20261001T090000"] })
        );

        let new = new_body(&day.event);
        assert_eq!(new["start"]["date"], "2026-10-03");
        assert_eq!(new["end"]["date"], "2026-10-06");
    }
}
