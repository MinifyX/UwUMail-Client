//! iCalendar objects from CalDAV servers, through the `calcard` crate: into the same JSCalendar
//! shape a UwUMail server sends over JMAP, expanded into occurrences, and written back.

use calcard::icalendar::{ICalendar, ICalendarComponentType, ICalendarProperty, ICalendarValue};
use calcard::jscalendar::JSCalendar;
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use serde_json::{Value, json};

use super::jscal::{self, OccurrenceTime};
use crate::error::{Error, Result};

/// Instances expanded per object at most; an event every minute for years stops here.
pub const MAX_INSTANCES: usize = 20_000;

pub fn parse(text: &str) -> Result<ICalendar> {
    ICalendar::parse(text).map_err(|_| Error::invalid("The calendar server sent an event UwUMail can't read."))
}

/// The object as a JSCalendar group (`{"@type": "Group", "entries": [...]}`).
pub fn to_jscalendar(ical: &ICalendar) -> Result<Value> {
    let converted: JSCalendar<'static, String, String> = ical.clone().into_jscalendar();
    let mut value = serde_json::to_value(&converted)?;
    // A lone event without a VCALENDAR around it comes back as the event itself.
    if value.get("@type").and_then(Value::as_str) != Some("Group") {
        value = json!({ "@type": "Group", "entries": [value] });
    }
    Ok(value)
}

/// The events of a group (tasks and other entries are left alone).
pub fn events(group: &Value) -> impl Iterator<Item = &Value> {
    group.get("entries").and_then(Value::as_array).into_iter().flatten().filter(|entry| {
        entry.get("@type").and_then(Value::as_str).is_none_or(|kind| kind.eq_ignore_ascii_case("Event"))
    })
}

pub fn events_mut(group: &mut Value) -> impl Iterator<Item = &mut Value> {
    group.get_mut("entries").and_then(Value::as_array_mut).into_iter().flatten().filter(|entry| {
        entry.get("@type").and_then(Value::as_str).is_none_or(|kind| kind.eq_ignore_ascii_case("Event"))
    })
}

/// A JSCalendar group written as iCalendar text.
pub fn from_jscalendar(group: &Value) -> Result<String> {
    let text = serde_json::to_string(group)?;
    let parsed = JSCalendar::<String, String>::parse(&text)
        .map_err(|error| Error::internal(format!("The event couldn't be converted: {error}")))?;
    let ical = parsed.into_icalendar().ok_or_else(|| Error::internal("The event couldn't be converted."))?;
    Ok(ical.to_string())
}

/// One occurrence of an object between two instants.
#[derive(Debug, Clone)]
pub struct Instance {
    /// The event with this occurrence's own values: start, overrides, `recurrenceId`.
    pub event: Value,
    /// The event it belongs to, with its rule.
    pub series: Value,
    pub time: OccurrenceTime,
    /// For occurrences of a series: its recurrence id (the original start, local).
    pub recurrence_id: Option<String>,
}

/// Every occurrence of the object's events that overlaps `[from, to)`. Floating and all-day
/// times count in `viewer`'s zone.
pub fn instances(ical: &ICalendar, group: &Value, from: DateTime<Utc>, to: DateTime<Utc>, viewer: Tz) -> Vec<Instance> {
    let expanded = ical.expand_dates(viewer, MAX_INSTANCES);
    let series: Vec<&Value> = events(group).collect();
    let mut found = Vec::new();
    for occurrence in expanded.events {
        let Some(component) = ical.components.get(occurrence.comp_id as usize) else { continue };
        if component.component_type != ICalendarComponentType::VEvent {
            continue;
        }
        let start = occurrence.start.with_timezone(&Utc);
        let end = match occurrence.end {
            calcard::icalendar::dates::TimeOrDelta::Time(end) => end.with_timezone(&Utc),
            calcard::icalendar::dates::TimeOrDelta::Delta(delta) => start + delta,
        };
        // A moment-long event on the edge still shows; everything else must overlap.
        if start >= to || (end <= from && !(end == start && start == from)) {
            continue;
        }
        let uid = component.uid();
        let Some(base) = series
            .iter()
            .find(|event| event.get("uid").and_then(Value::as_str) == uid)
            .or_else(|| (series.len() == 1).then(|| &series[0]))
        else {
            continue;
        };
        let recurring = base.get("recurrenceRule").is_some_and(|rule| !rule.is_null())
            || base.get("recurrenceRules").is_some_and(|rules| !rules.is_null())
            || base.get("recurrenceOverrides").is_some_and(|overrides| !overrides.is_null());
        let local_start = occurrence.start.naive_local();
        let recurrence_id = if recurring {
            Some(recurrence_id_of(component).unwrap_or_else(|| jscal::format_local(local_start)))
        } else {
            None
        };
        let mut event = (*base).clone();
        if let (Some(rid), Some(object)) = (&recurrence_id, event.as_object_mut()) {
            let patch = object
                .get("recurrenceOverrides")
                .and_then(|overrides| overrides.get(rid))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            object.remove("recurrenceRule");
            object.remove("recurrenceRules");
            object.remove("recurrenceOverrides");
            object.remove("excludedRecurrenceRules");
            object.insert("start".into(), json!(rid));
            // Override patches are relative to the event: plain keys or `path/to/key`.
            if let Err(error) = jscal::apply_patch(&mut event, &patch) {
                tracing::debug!("An override didn't apply: {error}");
            }
            if let Some(object) = event.as_object_mut() {
                object.insert("recurrenceId".into(), json!(rid));
            }
        }
        let all_day = jscal::is_all_day(&event);
        let start_local = if all_day {
            event.get("start").and_then(Value::as_str).and_then(jscal::parse_local).unwrap_or(local_start)
        } else {
            local_start
        };
        found.push(Instance {
            series: (*base).clone(),
            time: OccurrenceTime { start: start_local, utc: (!all_day).then_some((start, end)) },
            recurrence_id,
            event,
        });
    }
    found
}

/// The RECURRENCE-ID of an override component, as a JSCalendar local date-time.
fn recurrence_id_of(component: &calcard::icalendar::ICalendarComponent) -> Option<String> {
    let entry = component.property(&ICalendarProperty::RecurrenceId)?;
    match entry.values.first()? {
        ICalendarValue::PartialDateTime(value) => value.to_date_time().map(|dt| jscal::format_local(dt.date_time)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WEEKLY: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n\
BEGIN:VEVENT\r\nUID:yoga-1\r\nDTSTAMP:20260901T100000Z\r\nDTSTART;TZID=Europe/Berlin:20260903T180000\r\n\
DURATION:PT1H\r\nRRULE:FREQ=WEEKLY;BYDAY=TH\r\nEXDATE;TZID=Europe/Berlin:20260917T180000\r\n\
SUMMARY:Yoga\r\nLOCATION:Studio 3\r\nX-SOMETHING-ELSE:keep me\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:yoga-1\r\nDTSTAMP:20260901T100000Z\r\nRECURRENCE-ID;TZID=Europe/Berlin:20260924T180000\r\n\
DTSTART;TZID=Europe/Berlin:20260924T190000\r\nDURATION:PT1H\r\nSUMMARY:Yoga (later)\r\nEND:VEVENT\r\n\
END:VCALENDAR\r\n";

    fn utc(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn expands_a_weekly_series_with_an_exception_and_an_override() {
        let ical = parse(WEEKLY).unwrap();
        let group = to_jscalendar(&ical).unwrap();
        let berlin: Tz = "Europe/Berlin".parse().unwrap();
        let found = instances(&ical, &group, utc("2026-09-01T00:00:00Z"), utc("2026-10-01T00:00:00Z"), berlin);
        let starts: Vec<(String, String)> = found
            .iter()
            .map(|instance| {
                (instance.recurrence_id.clone().unwrap(), instance.event["start"].as_str().unwrap().to_string())
            })
            .collect();
        // 17 September is excluded, 24 September moved to 19:00.
        assert_eq!(
            starts,
            vec![
                ("2026-09-03T18:00:00".into(), "2026-09-03T18:00:00".into()),
                ("2026-09-10T18:00:00".into(), "2026-09-10T18:00:00".into()),
                ("2026-09-24T18:00:00".into(), "2026-09-24T19:00:00".into()),
            ]
        );
        let moved = &found[2];
        assert_eq!(moved.event["title"], "Yoga (later)");
        assert_eq!(moved.time.utc.unwrap().0, utc("2026-09-24T17:00:00Z"));
        let (rule, editable) = jscal::recurrence_of(&moved.series);
        assert!(editable);
        assert_eq!(rule.unwrap().frequency, crate::model::Frequency::Weekly);
        assert_eq!(jscal::location_of(&found[0].event), "Studio 3");
    }

    #[test]
    fn keeps_expansion_bounded() {
        let every_minute = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:m\r\nDTSTART:20000101T000000Z\r\n\
DURATION:PT1M\r\nRRULE:FREQ=MINUTELY\r\nSUMMARY:Tick\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let ical = parse(every_minute).unwrap();
        let group = to_jscalendar(&ical).unwrap();
        let start = std::time::Instant::now();
        // The range lies decades after the last instance the limit allows: nothing, and fast.
        let found = instances(&ical, &group, utc("2026-01-01T00:00:00Z"), utc("2026-02-01T00:00:00Z"), chrono_tz::UTC);
        assert!(found.is_empty());
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn writes_back_what_it_read() {
        let ical = parse(WEEKLY).unwrap();
        let mut group = to_jscalendar(&ical).unwrap();
        let event = events_mut(&mut group).next().unwrap();
        let mut patch = serde_json::Map::new();
        patch.insert("title".into(), json!("Hot Yoga"));
        patch.insert("recurrenceOverrides/2026-10-01T18:00:00".into(), json!({ "excluded": true }));
        jscal::apply_patch(event, &patch).unwrap();
        let text = from_jscalendar(&group).unwrap();
        assert!(text.contains("SUMMARY:Hot Yoga"), "{text}");
        assert!(text.contains("X-SOMETHING-ELSE:keep me"), "unknown properties survive: {text}");
        assert!(text.contains("20261001T180000"), "the new exception: {text}");
        assert!(text.contains("RECURRENCE-ID"), "the override stays: {text}");
        assert!(text.contains("UID:yoga-1"), "{text}");
    }

    #[test]
    fn all_day_events_keep_their_date() {
        let holiday = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:h\r\nDTSTART;VALUE=DATE:20261003\r\n\
DTEND;VALUE=DATE:20261004\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let ical = parse(holiday).unwrap();
        let group = to_jscalendar(&ical).unwrap();
        let tokyo: Tz = "Asia/Tokyo".parse().unwrap();
        let found = instances(&ical, &group, utc("2026-10-01T00:00:00Z"), utc("2026-10-10T00:00:00Z"), tokyo);
        assert_eq!(found.len(), 1);
        assert!(found[0].recurrence_id.is_none());
        assert_eq!(jscal::format_local(found[0].time.start), "2026-10-03T00:00:00");
        assert!(found[0].time.utc.is_none());
    }
}
