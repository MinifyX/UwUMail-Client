//! JMAP Calendars (draft-ietf-jmap-calendars) on a UwUMail server: calendars, events expanded
//! by the server in the viewer's zone, and changes as JMAP patches.

use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};

use crate::error::{Error, Result};
use crate::jmap::{self, Client};
use crate::model::{CalendarOwner, CalendarSharing, Person};

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
    /// The server's birthdays calendar (`uwuBirthdays`), made from the contacts and read-only.
    pub is_birthdays: bool,
    /// Who shares it, and with whom (`uwuSharedBy`, `shareWith`, `myRights.mayShare`).
    pub sharing: CalendarSharing,
}

pub fn parse_calendar(value: &Value) -> Option<JmapCalendar> {
    let rights = value.get("myRights");
    let right = |key: &str| rights.and_then(|r| r.get(key)).and_then(Value::as_bool);
    let is_birthdays = value.get("uwuBirthdays").and_then(Value::as_bool).unwrap_or(false);
    Some(JmapCalendar {
        id: value.get("id")?.as_str()?.to_string(),
        name: value.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
        color: super::jscal::clean_color(value.get("color").and_then(Value::as_str)),
        sort_order: value.get("sortOrder").and_then(Value::as_i64).unwrap_or(0),
        is_visible: value.get("isVisible").and_then(Value::as_bool).unwrap_or(true),
        is_default: value.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
        // Without rights, the calendars are the login's own.
        // Its events come from the contacts; the server refuses writes and deleting it.
        may_write: !is_birthdays
            && (rights.is_none() || right("mayWriteAll").unwrap_or(false) || right("mayWriteOwn").unwrap_or(false)),
        may_delete: !is_birthdays && (rights.is_none() || right("mayDelete").unwrap_or(false)),
        is_birthdays,
        sharing: sharing_of(value, !is_birthdays && rights.is_some() && right("mayShare") == Some(true)),
    })
}

/// A short text of the server's, without control characters or the ones that turn text around.
fn clean(text: &str, max: usize) -> String {
    let shown = |c: &char| !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}');
    text.chars().filter(shown).take(max).collect::<String>().trim().to_string()
}

/// A JMAP id: what may go into a patch path (`shareWith/<id>`) and nothing else (RFC 8620 §1.2).
pub fn valid_principal(id: &str) -> bool {
    !id.is_empty() && id.len() <= 255 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The calendar's owner when somebody shares it with the account, and who it is shared with where
/// the account may share it.
fn sharing_of(value: &Value, may_share: bool) -> CalendarSharing {
    let shared_by = value.get("uwuSharedBy").filter(|owner| owner.is_object()).and_then(|owner| {
        let email = clean(owner.get("email").and_then(Value::as_str)?, 320);
        let name = clean(owner.get("name").and_then(Value::as_str).unwrap_or_default(), 200);
        (!email.is_empty()).then(|| CalendarOwner { name: if name.is_empty() { email.clone() } else { name }, email })
    });
    let shared_with = value.get("shareWith").and_then(Value::as_object).map(|share_with| {
        share_with
            .iter()
            .filter(|(principal, _)| valid_principal(principal))
            .filter_map(|(principal, rights)| Some((principal.clone(), share_level(rights.as_object()?).to_string())))
            .take(1000)
            .collect::<BTreeMap<_, _>>()
    });
    CalendarSharing { may_share, shared_by, shared_with: if may_share { shared_with } else { None } }
}

/// The level CalendarRights amount to: sharing on means everything, any writing means write.
pub fn share_level(rights: &Map<String, Value>) -> &'static str {
    let on = |key: &str| rights.get(key).and_then(Value::as_bool) == Some(true);
    if on("mayShare") {
        "all"
    } else if on("mayWriteAll") || on("mayWriteOwn") || on("mayUpdatePrivate") || on("mayRSVP") {
        "write"
    } else {
        "read"
    }
}

/// The CalendarRights a level stands for, as `shareWith` takes them.
pub fn rights_for(level: &str) -> Result<Value> {
    let read = json!({ "mayReadFreeBusy": true, "mayReadItems": true });
    let mut rights = read;
    match level {
        "read" => {}
        "write" | "all" => {
            for key in ["mayWriteAll", "mayWriteOwn", "mayUpdatePrivate", "mayRSVP"] {
                rights[key] = json!(true);
            }
            if level == "all" {
                rights["mayShare"] = json!(true);
            }
        }
        _ => return Err(Error::invalid("A calendar is shared to read, to read and write, or with everything.")),
    }
    Ok(rights)
}

/// Shares a calendar with a person at a level (`read`, `write`, `all`), or stops sharing it with
/// them (`None`).
pub async fn share_calendar(client: &Client, id: &str, principal: &str, level: Option<&str>) -> Result<()> {
    if !valid_principal(principal) {
        return Err(Error::invalid("That person isn't on this server."));
    }
    let rights = match level {
        Some(level) => rights_for(level)?,
        None => Value::Null,
    };
    let mut patch = Map::new();
    patch.insert(format!("shareWith/{principal}"), rights);
    update_calendar(client, id, patch).await
}

/// The people of the server to share with: individuals but the login itself, by name.
pub async fn people(client: &Client) -> Result<Vec<Person>> {
    if !client.session.principals {
        return Err(Error::not_supported("This server doesn't share calendars."));
    }
    let arguments = json!({ "accountId": client.account_id(), "ids": null,
        "properties": ["id", "type", "name", "email"] });
    let responses = client.call(vec![("Principal/get", arguments)]).await?;
    let own_email = client.session.username.to_lowercase();
    let own_id = client.session.own_principal_id.as_deref();
    let mut people: Vec<Person> = list(responses.get(0, "Principal/get")?)
        .iter()
        .take(20_000)
        .filter(|p| p.get("type").and_then(Value::as_str).unwrap_or("individual") == "individual")
        .filter_map(|p| {
            let id = p.get("id").and_then(Value::as_str).filter(|id| valid_principal(id))?;
            let email = clean(p.get("email").and_then(Value::as_str).unwrap_or_default(), 320);
            if Some(id) == own_id || (!email.is_empty() && email.to_lowercase() == own_email) {
                return None;
            }
            let name = clean(p.get("name").and_then(Value::as_str).unwrap_or_default(), 200);
            let name = if !name.is_empty() {
                name
            } else if !email.is_empty() {
                email.clone()
            } else {
                id.to_string()
            };
            Some(Person { id: id.to_string(), name, email })
        })
        .collect();
    people.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.email.cmp(&b.email)));
    Ok(people)
}

pub async fn calendars(client: &Client) -> Result<Vec<JmapCalendar>> {
    let responses = client
        .call(vec![(
            "Calendar/get",
            json!({
                "accountId": account(client)?,
                "ids": null,
                "properties": ["id", "name", "color", "sortOrder", "isVisible", "isDefault", "myRights", "uwuBirthdays",
                    "shareWith", "uwuSharedBy"],
            }),
        )])
        .await?;
    let mut calendars: Vec<JmapCalendar> =
        list(responses.get(0, "Calendar/get")?).iter().filter_map(parse_calendar).collect();
    // Sharing needs the people of the server to choose from.
    if !client.session.principals {
        for calendar in &mut calendars {
            calendar.sharing.may_share = false;
            calendar.sharing.shared_with = None;
        }
    }
    Ok(calendars)
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

const INSTANCE_PROPERTIES: [&str; 18] = [
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
    // Events of the birthdays calendar: whose date (UwUMail-Server docs/birthdays.md).
    "uwuBirthday",
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

        // The birthdays calendar is read-only and stays, whatever its rights say.
        let birthdays = json!({ "id": "c3", "name": "Geburtstage", "uwuBirthdays": true,
            "myRights": { "mayWriteAll": true, "mayDelete": true } });
        let birthdays = parse_calendar(&birthdays).unwrap();
        assert!(birthdays.is_birthdays && !birthdays.may_write && !birthdays.may_delete);
        assert!(!own.is_birthdays);
    }

    #[test]
    fn reads_who_shares_and_with_whom() {
        let own = json!({ "id": "c1", "name": "Privat", "myRights": { "mayWriteAll": true, "mayDelete": true, "mayShare": true },
            "shareWith": { "p3": { "mayReadItems": true }, "p4": { "mayWriteAll": true }, "p5": { "mayShare": true },
                           "../x": { "mayShare": true }, "p6": null } });
        let own = parse_calendar(&own).unwrap();
        assert!(own.sharing.may_share && own.sharing.shared_by.is_none());
        let levels = own.sharing.shared_with.unwrap();
        assert_eq!(levels.get("p3").map(String::as_str), Some("read"));
        assert_eq!(levels.get("p4").map(String::as_str), Some("write"));
        assert_eq!(levels.get("p5").map(String::as_str), Some("all"));
        assert_eq!(levels.len(), 3);

        let shared = json!({ "id": "c2", "name": "Team", "myRights": { "mayReadItems": true, "mayDelete": true },
            "uwuSharedBy": { "email": "leni@example.org", "name": "  \u{7}", "principalId": "p3" },
            "shareWith": { "p9": { "mayReadItems": true } } });
        let shared = parse_calendar(&shared).unwrap();
        assert!(!shared.sharing.may_share && shared.may_delete);
        assert_eq!(
            shared.sharing.shared_by,
            Some(CalendarOwner { email: "leni@example.org".into(), name: "leni@example.org".into() })
        );
        // Who else sees it is the owner's business.
        assert!(shared.sharing.shared_with.is_none());
    }

    #[test]
    fn levels_are_rights_and_back() {
        for level in ["read", "write", "all"] {
            let rights = rights_for(level).unwrap();
            assert_eq!(share_level(rights.as_object().unwrap()), level);
        }
        assert!(rights_for("admin").is_err());
        assert!(valid_principal("p12") && !valid_principal("p/1") && !valid_principal("") && !valid_principal("a~b"));
    }
}
