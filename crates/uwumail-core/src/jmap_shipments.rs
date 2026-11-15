//! Shipments on a UwUMail server: `Shipment/query`, `/get` and `/set` of
//! `urn:uwumail:jmap:shipments` (UwUMail-Server docs/jmap-shipments.md). Only the own account
//! has them. What the server sends is read with bounds: the server is trusted, its data isn't.

use serde_json::{Value, json};

use crate::error::{Error, ErrorCode, Result};
use crate::jmap::Client;
use crate::shipments::{self, MAX_EVENTS, MAX_PER_ACCOUNT, Shipment};

const CARRIERS: [&str; 9] = ["dhl", "deutschePost", "dpd", "hermes", "gls", "ups", "amazonLogistics", "fedex", "other"];
/// Ids and short fields are never longer.
const MAX_ID: usize = 255;

fn require(client: &Client) -> Result<()> {
    if client.session.shipments { Ok(()) } else { Err(Error::not_supported("This server keeps no shipments.")) }
}

/// A refused create, update or destroy.
fn refusal(problem: &Value) -> Error {
    let kind = problem.get("type").and_then(Value::as_str).unwrap_or("serverFail");
    let description: String = problem
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or(kind)
        .chars()
        .filter(|c| !c.is_control())
        .take(300)
        .collect();
    match kind {
        "forbidden" | "overQuota" => Error::new(ErrorCode::Forbidden, description),
        "notFound" => Error::not_found(description),
        "alreadyExists" => Error::invalid("This shipment is already being followed."),
        "invalidProperties" | "invalidPatch" => Error::invalid(description),
        _ => Error::internal(description),
    }
}

fn clip(value: &mut Option<String>, max: usize) {
    if let Some(text) = value {
        *text = text.chars().filter(|c| !c.is_control()).take(max).collect();
    }
}

/// One shipment as the server sent it, made safe to show; `None` without a usable id.
pub fn parse(value: &Value) -> Option<Shipment> {
    let mut shipment: Shipment = serde_json::from_value(value.clone()).ok()?;
    if shipment.id.is_empty() || shipment.id.len() > MAX_ID {
        return None;
    }
    if !CARRIERS.contains(&shipment.carrier.as_str()) {
        shipment.carrier = "other".into();
    }
    // A status this app doesn't know yet still means the parcel is on its way.
    if uwumail_labels::ShipmentStatus::from_id(&shipment.status).is_none() {
        shipment.status = "inTransit".into();
    }
    shipment.tracking_url = shipment.tracking_url.and_then(|url| crate::links::external_url(&url).ok());
    for field in [&mut shipment.number, &mut shipment.order_ref] {
        clip(field, 40);
    }
    for field in [&mut shipment.title, &mut shipment.merchant] {
        clip(field, shipments::TITLE_MAX_CHARS);
    }
    shipment.events.truncate(MAX_EVENTS);
    shipment.email_ids.truncate(MAX_EVENTS);
    shipment.events.sort_by_key(|event| shipments::seconds(&event.at));
    Some(shipment)
}

async fn call(client: &Client, calls: Vec<(&str, Value)>) -> Result<Vec<Value>> {
    let names: Vec<String> = calls.iter().map(|(name, _)| name.to_string()).collect();
    let responses = client.call(calls).await?;
    names
        .iter()
        .enumerate()
        .map(|(index, name)| match responses.get(index, name) {
            Ok(answer) => Ok(answer.clone()),
            Err(error) if error.kind == "forbidden" => Err(Error::new(ErrorCode::Forbidden, error.description)),
            Err(error) => Err(error.into()),
        })
        .collect()
}

/// The shipments that are hidden, or those that aren't, last changed first. Email ids are the
/// server's.
pub async fn list(client: &Client, hidden: bool) -> Result<Vec<Shipment>> {
    require(client)?;
    let account = client.session.account_id.clone();
    let answers = call(
        client,
        vec![
            (
                "Shipment/query",
                json!({ "accountId": account, "filter": { "hidden": hidden },
                        "sort": [{ "property": "updated", "isAscending": false }], "limit": MAX_PER_ACCOUNT }),
            ),
            (
                "Shipment/get",
                json!({ "accountId": account, "#ids": { "resultOf": "0", "name": "Shipment/query", "path": "/ids" } }),
            ),
        ],
    )
    .await?;
    Ok(answers[1]
        .get("list")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_PER_ACCOUNT)
        .filter_map(parse)
        .collect())
}

async fn set(client: &Client, arguments: Value, key: &str, id: &str) -> Result<Value> {
    require(client)?;
    let mut arguments = arguments;
    arguments["accountId"] = json!(client.session.account_id);
    let answer = call(client, vec![("Shipment/set", arguments)]).await?.remove(0);
    if let Some(problem) = answer.get(key).and_then(|failed| failed.get(id)) {
        return Err(refusal(problem));
    }
    Ok(answer)
}

/// Follows a shipment by hand; the server starts it as shipped. Returns its id.
pub async fn create(client: &Client, carrier: &str, number: &str, title: Option<&str>) -> Result<String> {
    let number = shipments::normalize_number(number)?;
    let title = shipments::normalize_title(title)?;
    let carrier = if CARRIERS.contains(&carrier) { carrier } else { "other" };
    let mut object = json!({ "carrier": carrier, "number": number });
    if let Some(title) = title {
        object["title"] = json!(title);
    }
    let answer = set(client, json!({ "create": { "new": object } }), "notCreated", "new").await?;
    answer
        .pointer("/created/new/id")
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| Error::internal("The server didn't add the shipment."))
}

fn valid_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > MAX_ID || id.chars().any(|c| c.is_control()) {
        return Err(Error::invalid("That shipment id makes no sense."));
    }
    Ok(())
}

/// Renames (`Some(None)` goes back to the shop's name) or hides one.
pub async fn update(client: &Client, id: &str, title: Option<Option<&str>>, hidden: Option<bool>) -> Result<()> {
    valid_id(id)?;
    let mut object = json!({});
    if let Some(title) = title {
        object["title"] = json!(shipments::normalize_title(title)?);
    }
    if let Some(hidden) = hidden {
        object["hidden"] = json!(hidden);
    }
    set(client, json!({ "update": { id: object } }), "notUpdated", id).await.map(|_| ())
}

pub async fn destroy(client: &Client, id: &str) -> Result<()> {
    valid_id(id)?;
    set(client, json!({ "destroy": [id] }), "notDestroyed", id).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_the_server_sends_with_bounds() {
        let shipment = parse(&json!({
            "id": "s7", "carrier": "rocket", "number": "123", "status": "teleported",
            "trackingUrl": "javascript:alert(1)", "title": "a\u{0}b", "hidden": true,
            "expected": { "from": "2026-11-15T10:00:00+01:00", "to": null, "allDay": false },
            "emailIds": ["M1"], "events": [
                { "at": "2026-11-12T10:00:00Z", "status": "delivered", "source": "client", "clientName": "HA" },
                { "at": "2026-11-11T10:00:00Z", "status": "shipped", "source": "mail", "emailId": "M1" }
            ],
            "unknown": 1
        }))
        .unwrap();
        assert_eq!(shipment.carrier, "other");
        assert_eq!(shipment.status, "inTransit");
        assert_eq!(shipment.tracking_url, None);
        assert_eq!(shipment.title.as_deref(), Some("ab"));
        assert_eq!(shipment.events[0].status, "shipped");
        assert_eq!(shipment.events[1].client_name.as_deref(), Some("HA"));
        assert!(shipment.expected.is_some_and(|expected| !expected.all_day));
        assert_eq!(parse(&json!({ "carrier": "dhl" })), None);
        assert_eq!(parse(&json!({ "id": 5 })), None);
        let tracked = parse(&json!({ "id": "s1", "trackingUrl": "https://tracking.example/?n=1" })).unwrap();
        assert_eq!(tracked.tracking_url.as_deref(), Some("https://tracking.example/?n=1"));
    }

    #[test]
    fn refusals_say_what_went_wrong() {
        assert_eq!(refusal(&json!({ "type": "overQuota" })).code, ErrorCode::Forbidden);
        assert_eq!(refusal(&json!({ "type": "alreadyExists" })).code, ErrorCode::InvalidInput);
        assert_eq!(refusal(&json!({ "type": "notFound" })).code, ErrorCode::NotFound);
    }
}
