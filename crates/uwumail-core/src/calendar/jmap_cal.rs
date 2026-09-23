//! JMAP Calendars (draft-ietf-jmap-calendars) on a UwUMail server: calendars, events expanded
//! by the server in the viewer's zone, and changes as JMAP patches.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};

use crate::error::{Error, Result};
use crate::jmap::{self, Client};

/// Instances asked for at once; the server allows 5000.
const QUERY_LIMIT: usize = 5000;

fn account(client: &Client) -> Result<&str> {
    client
        .session
        .calendar_account_id
        .as_deref()
        .ok_or_else(|| Error::not_supported("This mail server has no calendars."))
}

fn list(arguments: &Value) -> Vec<Value> {
    arguments.get("list").and_then(Value::as_array).cloned().unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq)]
pub struct JmapCalendar {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i64,
    pub is_visible: bool,
    pub is_default: bool,
    pub may_write: bool,
    pub may_delete: bool,
}

pub fn parse_calendar(value: &Value) -> Option<JmapCalendar> {
    let rights = value.get("myRights");
    let right = |key: &str| rights.and_then(|r| r.get(key)).and_then(Value::as_bool);
    Some(JmapCalendar {
        id: value.get("id")?.as_str()?.to_string(),
        name: value.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
        color: super::jscal::clean_color(value.get("color").and_then(Value::as_str)),
        sort_order: value.get("sortOrder").and_then(Value::as_i64).unwrap_or(0),
        is_visible: value.get("isVisible").and_then(Value::as_bool).unwrap_or(true),
        is_default: value.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
        // Without rights, the calendars are the login's own.
        may_write: rights.is_none() || right("mayWriteAll").unwrap_or(false) || right("mayWriteOwn").unwrap_or(false),
        may_delete: rights.is_none() || right("mayDelete").unwrap_or(false),
    })
}

pub async fn calendars(client: &Client) -> Result<Vec<JmapCalendar>> {
    let responses = client
        .call(vec![(
            "Calendar/get",
            json!({
                "accountId": account(client)?,
                "ids": null,
                "properties": ["id", "name", "color", "sortOrder", "isVisible", "isDefault", "myRights"],
            }),
        )])
        .await?;
    Ok(list(responses.get(0, "Calendar/get")?).iter().filter_map(parse_calendar).collect())
}

/// A `/set` answer's first problem, as an error.
fn refused(arguments: &Value, fallback: &str) -> Error {
    match jmap::set_errors(arguments) {
        Some(error) if error.kind == "calendarHasEvent" => Error::invalid("This calendar still has events."),
        Some(error) if error.kind == "noSupportedScheduleMethods" => {
            Error::invalid("Invitations aren't possible here yet.")
        }
        Some(error) => error.into(),
        None => Error::internal(fallback.to_string()),
    }
}

async fn calendar_set(client: &Client, mut arguments: Map<String, Value>, fallback: &str) -> Result<Value> {
    arguments.insert("accountId".into(), json!(account(client)?));
    let responses = client.call(vec![("Calendar/set", Value::Object(arguments))]).await?;
    let answer = responses.get(0, "Calendar/set")?.clone();
    if jmap::set_errors(&answer).is_some() {
        return Err(refused(&answer, fallback));
    }
    Ok(answer)
}

pub async fn create_calendar(client: &Client, name: &str, color: Option<&str>) -> Result<String> {
    let mut calendar = json!({ "name": name, "isVisible": true });
    if let Some(color) = color {
        calendar["color"] = json!(color);
    }
    let mut arguments = Map::new();
    arguments.insert("create".into(), json!({ "new": calendar }));
    let answer = calendar_set(client, arguments, "The calendar wasn't created.").await?;
    answer
        .pointer("/created/new/id")
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| Error::internal("The calendar wasn't created."))
}

pub async fn update_calendar(client: &Client, id: &str, patch: Map<String, Value>) -> Result<()> {
    if patch.is_empty() {
        return Ok(());
    }
    let mut arguments = Map::new();
    arguments.insert("update".into(), json!({ id: patch }));
    calendar_set(client, arguments, "The calendar wasn't changed.").await.map(|_| ())
}

/// Deletes a calendar with its events.
pub async fn delete_calendar(client: &Client, id: &str) -> Result<()> {
    let mut arguments = Map::new();
    arguments.insert("destroy".into(), json!([id]));
    arguments.insert("onDestroyRemoveEvents".into(), json!(true));
    calendar_set(client, arguments, "The calendar wasn't deleted.").await.map(|_| ())
}

pub async fn set_default(client: &Client, id: &str) -> Result<()> {
    let mut arguments = Map::new();
    arguments.insert("update".into(), json!({ id: {} }));
    arguments.insert("onSuccessSetIsDefault".into(), json!(id));
    calendar_set(client, arguments, "The default calendar wasn't changed.").await.map(|_| ())
}

/// One occurrence the server expanded: its own values, the event it belongs to, and when it
/// is in UTC.
#[derive(Debug, Clone)]
pub struct JmapInstance {
    pub event: Value,
    pub base: Option<Value>,
    pub utc: Option<(DateTime<Utc>, DateTime<Utc>)>,
}

const INSTANCE_PROPERTIES: [&str; 17] = [
    "id",
    "baseEventId",
    "calendarIds",
    "isOrigin",
    "title",
    "description",
    "locations",
    "start",
    "duration",
    "timeZone",
    "showWithoutTime",
    "recurrenceId",
    "recurrenceRule",
    "recurrenceRules",
    "color",
    "utcStart",
    "utcEnd",
];

fn utc(value: Option<&Value>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value?.as_str()?).ok().map(|time| time.with_timezone(&Utc))
}

/// Every occurrence between two wall times in `zone` (IANA), expanded by the server.
pub async fn occurrences(client: &Client, from: &str, to: &str, zone: &str) -> Result<Vec<JmapInstance>> {
    let account = account(client)?;
    let responses = client
        .call(vec![(
            "CalendarEvent/query",
            json!({
                "accountId": account,
                "filter": { "after": from, "before": to },
                "sort": [{ "property": "start", "isAscending": true }],
                "expandRecurrences": true,
                "timeZone": zone,
                "limit": QUERY_LIMIT,
            }),
        )])
        .await?;
    let ids: Vec<String> = responses
        .get(0, "CalendarEvent/query")?
        .get("ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(String::from)
        .collect();
    let mut events = Vec::new();
    for chunk in jmap::chunks(&ids, client.session.max_objects_in_get) {
        let responses = client
            .call(vec![(
                "CalendarEvent/get",
                json!({ "accountId": account, "ids": chunk, "properties": INSTANCE_PROPERTIES, "timeZone": zone }),
            )])
            .await?;
        events.extend(list(responses.get(0, "CalendarEvent/get")?));
    }
    // The rule lives on the event the instances belong to.
    let mut base_ids: Vec<String> = events
        .iter()
        .filter_map(|event| event.get("baseEventId").and_then(Value::as_str).map(String::from))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    base_ids.sort();
    let mut bases = Vec::new();
    for chunk in jmap::chunks(&base_ids, client.session.max_objects_in_get) {
        let responses = client
            .call(vec![(
                "CalendarEvent/get",
                json!({ "accountId": account, "ids": chunk, "properties": ["id", "recurrenceRule", "recurrenceRules"] }),
            )])
            .await?;
        bases.extend(list(responses.get(0, "CalendarEvent/get")?));
    }
    Ok(events
        .into_iter()
        .map(|event| {
            let base = event
                .get("baseEventId")
                .and_then(Value::as_str)
                .and_then(|id| bases.iter().find(|base| base.get("id").and_then(Value::as_str) == Some(id)))
                .cloned();
            let utc = utc(event.get("utcStart")).zip(utc(event.get("utcEnd")));
            JmapInstance { event, base, utc }
        })
        .collect())
}

/// An event with all its properties.
pub async fn event(client: &Client, id: &str) -> Result<Value> {
    let responses =
        client.call(vec![("CalendarEvent/get", json!({ "accountId": account(client)?, "ids": [id] }))]).await?;
    list(responses.get(0, "CalendarEvent/get")?)
        .into_iter()
        .next()
        .ok_or_else(|| Error::not_found("This event no longer exists."))
}

/// The id of the event an occurrence belongs to (itself for single events).
pub async fn base_of(client: &Client, id: &str) -> Result<String> {
    let responses = client
        .call(vec![(
            "CalendarEvent/get",
            json!({ "accountId": account(client)?, "ids": [id], "properties": ["id", "baseEventId"] }),
        )])
        .await?;
    let found = list(responses.get(0, "CalendarEvent/get")?)
        .into_iter()
        .next()
        .ok_or_else(|| Error::not_found("This event no longer exists."))?;
    Ok(found.get("baseEventId").and_then(Value::as_str).unwrap_or(id).to_string())
}

async fn event_set(client: &Client, key: &str, value: Value, fallback: &str) -> Result<Value> {
    let responses = client
        .call(vec![(
            "CalendarEvent/set",
            json!({ "accountId": account(client)?, key: value, "sendSchedulingMessages": false }),
        )])
        .await?;
    let answer = responses.get(0, "CalendarEvent/set")?.clone();
    if let Some(error) = jmap::set_errors(&answer) {
        if error.kind == "notFound" && key == "destroy" {
            return Ok(answer);
        }
        return Err(refused(&answer, fallback));
    }
    Ok(answer)
}

pub async fn create_event(client: &Client, calendar_id: &str, mut event: Map<String, Value>) -> Result<String> {
    event.insert("calendarIds".into(), json!({ calendar_id: true }));
    let answer = event_set(client, "create", json!({ "new": event }), "The event wasn't created.").await?;
    answer
        .pointer("/created/new/id")
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| Error::internal("The event wasn't created."))
}

pub async fn update_event(client: &Client, id: &str, patch: Map<String, Value>) -> Result<()> {
    if patch.is_empty() {
        return Ok(());
    }
    event_set(client, "update", json!({ id: patch }), "The event wasn't changed.").await.map(|_| ())
}

/// Deletes an event, or with an expanded occurrence's id just that occurrence.
pub async fn destroy_event(client: &Client, id: &str) -> Result<()> {
    event_set(client, "destroy", json!([id]), "The event wasn't deleted.").await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_calendars_and_rights() {
        let own = json!({ "id": "c1", "name": "Privat", "color": "#FF66AA", "sortOrder": 2, "isDefault": true });
        let own = parse_calendar(&own).unwrap();
        assert_eq!(own.color.as_deref(), Some("#ff66aa"));
        assert!(own.may_write && own.may_delete && own.is_default && own.is_visible);

        let shared = json!({ "id": "c2", "name": "Team", "isVisible": false,
            "myRights": { "mayReadItems": true, "mayWriteAll": false, "mayWriteOwn": false, "mayDelete": false } });
        let shared = parse_calendar(&shared).unwrap();
        assert!(!shared.may_write && !shared.may_delete && !shared.is_visible);
        assert!(parse_calendar(&json!({ "name": "no id" })).is_none());
    }
}
