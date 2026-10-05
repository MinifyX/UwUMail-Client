//! Masked addresses on a UwUMail server: Fastmail's JMAP extension `MaskedEmail`, with UwUMail's
//! additions (the domains the account may use, a `domain` for a new one; UwUMail-Server
//! docs/jmap-masked-email.md). Only the own account has them.
//!
//! Everything the page sends is checked against the server's limits before it leaves, and every
//! answer is read field by field with bounds: the server is trusted, its data isn't.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::error::{Error, ErrorCode, Result};
use crate::jmap::{self, Client};

/// The server's limits (docs/jmap-masked-email.md "Limits").
pub const MAX_DESCRIPTION: usize = 200;
pub const MAX_FOR_DOMAIN: usize = 200;
pub const MAX_URL: usize = 2000;
pub const MAX_PREFIX: usize = 64;
/// An account keeps at most 5000 that are not deleted; the deleted ones come along in the list.
const MAX_LISTED: usize = 20_000;
/// Domain names and JMAP ids are never longer.
const MAX_NAME: usize = 255;
/// An address is never longer (RFC 5321 path limit).
const MAX_EMAIL: usize = 320;

/// Where the account may make masked addresses: `domains` is `None` when the server doesn't say
/// (it decides), empty when nobody enabled them for the account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskedOptions {
    pub domains: Option<Vec<String>>,
    pub default_domain: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskedAddress {
    pub id: String,
    pub email: String,
    /// `pending`, `enabled`, `disabled` or `deleted`.
    pub state: String,
    pub for_domain: String,
    pub description: String,
    pub url: Option<String>,
    pub created_at: String,
    pub last_message_at: Option<String>,
    pub created_by: String,
}

/// A new masked address, made by hand and so `enabled` at once.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskedInput {
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub for_domain: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub email_prefix: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
}

/// A change of one: its state (never back to `pending`) or what it says about itself. `url`
/// is `Some(None)` to remove the link.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskedPatch {
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub for_domain: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub url: Option<Option<String>>,
}

/// Tells a field given as `null` (`Some(None)`) from one left out (`None`).
fn nullable<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

const STATES: [&str; 4] = ["pending", "enabled", "disabled", "deleted"];

/// What the own account's capability says; `None` without the extension.
pub fn options(client: &Client) -> Option<MaskedOptions> {
    options_from(client.session.masked.as_ref()?)
}

pub fn options_from(capability: &Value) -> Option<MaskedOptions> {
    let capability = capability.as_object()?;
    let domains = capability.get("domains").and_then(Value::as_array).map(|list| {
        let mut domains: Vec<String> = Vec::new();
        for domain in list.iter().filter_map(Value::as_str).map(|d| d.trim().to_lowercase()) {
            if valid_domain(&domain) && !domains.contains(&domain) && domains.len() < 100 {
                domains.push(domain);
            }
        }
        domains
    });
    let default_domain = capability
        .get("defaultDomain")
        .and_then(Value::as_str)
        .map(|d| d.trim().to_lowercase())
        .filter(|d| valid_domain(d) && domains.as_ref().is_none_or(|list| list.contains(d)));
    Some(MaskedOptions { domains, default_domain })
}

fn valid_domain(domain: &str) -> bool {
    !domain.is_empty()
        && domain.len() <= MAX_NAME
        && domain.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '-')
        && !domain.starts_with('.')
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_NAME && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn has_control(text: &str) -> bool {
    text.chars().any(char::is_control)
}

fn checked_text(text: &str, max: usize, what: &str) -> Result<String> {
    let text = text.trim();
    if text.chars().count() > max {
        return Err(Error::invalid(format!("The {what} is longer than {max} characters.")));
    }
    if has_control(text) {
        return Err(Error::invalid(format!("The {what} can't have line breaks or control characters.")));
    }
    Ok(text.to_string())
}

fn checked_url(url: &str) -> Result<Option<String>> {
    let url = url.trim();
    if url.is_empty() {
        return Ok(None);
    }
    if url.chars().count() > MAX_URL || has_control(url) || url.chars().any(char::is_whitespace) {
        return Err(Error::invalid("That link can't be used for a masked address."));
    }
    Ok(Some(url.to_string()))
}

fn checked_prefix(prefix: &str) -> Result<Option<String>> {
    let prefix = prefix.trim().to_lowercase();
    if prefix.is_empty() {
        return Ok(None);
    }
    if prefix.len() > MAX_PREFIX || !prefix.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') {
        return Err(Error::invalid("A prefix is up to 64 of a–z, 0–9 and _."));
    }
    Ok(Some(prefix))
}

/// The create object for `MaskedEmail/set`, checked against the server's limits and the domains
/// the account may use.
pub fn create_object(input: &MaskedInput, options: &MaskedOptions) -> Result<Value> {
    let mut object = json!({
        "state": "enabled",
        "description": checked_text(&input.description, MAX_DESCRIPTION, "description")?,
        "forDomain": checked_text(&input.for_domain, MAX_FOR_DOMAIN, "website")?,
    });
    if let Some(url) = checked_url(input.url.as_deref().unwrap_or_default())? {
        object["url"] = json!(url);
    }
    if let Some(prefix) = checked_prefix(input.email_prefix.as_deref().unwrap_or_default())? {
        object["emailPrefix"] = json!(prefix);
    }
    if let Some(domain) = input.domain.as_deref().map(|d| d.trim().to_lowercase()).filter(|d| !d.is_empty()) {
        let allowed = match &options.domains {
            Some(domains) => domains.contains(&domain),
            None => valid_domain(&domain),
        };
        if !allowed {
            return Err(Error::new(ErrorCode::Forbidden, "Masked addresses can't go on that domain."));
        }
        object["domain"] = json!(domain);
    }
    Ok(object)
}

/// The update object: only what the patch names, checked.
pub fn update_object(patch: &MaskedPatch) -> Result<Value> {
    let mut object = Map::new();
    if let Some(state) = &patch.state {
        if !["enabled", "disabled", "deleted"].contains(&state.as_str()) {
            return Err(Error::invalid("A masked address is on, off or deleted."));
        }
        object.insert("state".into(), json!(state));
    }
    if let Some(description) = &patch.description {
        object.insert("description".into(), json!(checked_text(description, MAX_DESCRIPTION, "description")?));
    }
    if let Some(for_domain) = &patch.for_domain {
        object.insert("forDomain".into(), json!(checked_text(for_domain, MAX_FOR_DOMAIN, "website")?));
    }
    if let Some(url) = &patch.url {
        object.insert("url".into(), checked_url(url.as_deref().unwrap_or_default())?.map_or(Value::Null, Value::from));
    }
    Ok(Value::Object(object))
}

/// A string field of an answer, without control characters and cut to `max` characters.
fn field(value: &Value, key: &str, max: usize) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().chars().filter(|c| !c.is_control()).take(max).collect()
}

fn optional(value: &Value, key: &str, max: usize) -> Option<String> {
    Some(field(value, key, max)).filter(|text| !text.is_empty())
}

/// One masked address of an answer; `None` for one without a usable id or address.
pub fn parse_address(value: &Value) -> Option<MaskedAddress> {
    let id = value.get("id").and_then(Value::as_str).filter(|id| valid_id(id))?;
    let email = value.get("email").and_then(Value::as_str).map(str::trim)?;
    if email.is_empty() || email.len() > MAX_EMAIL || !email.contains('@') || has_control(email) {
        return None;
    }
    let state = value.get("state").and_then(Value::as_str).filter(|state| STATES.contains(state)).unwrap_or("enabled");
    Some(MaskedAddress {
        id: id.to_string(),
        email: email.to_string(),
        state: state.to_string(),
        for_domain: field(value, "forDomain", MAX_FOR_DOMAIN),
        description: field(value, "description", MAX_DESCRIPTION),
        url: optional(value, "url", MAX_URL),
        created_at: optional(value, "createdAt", 40).unwrap_or_else(|| "1970-01-01T00:00:00Z".into()),
        last_message_at: optional(value, "lastMessageAt", 40),
        created_by: field(value, "createdBy", 200),
    })
}

/// A refused create or update: `forbidden` for a domain or limit the account may not have,
/// `notFound`, or the server's complaint about the values.
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
        "invalidProperties" | "invalidPatch" => Error::invalid(description),
        _ => Error::internal(description),
    }
}

fn require(client: &Client) -> Result<MaskedOptions> {
    options(client).ok_or_else(|| Error::not_supported("This server makes no masked addresses."))
}

async fn call(client: &Client, method: &str, mut arguments: Value) -> Result<Value> {
    arguments["accountId"] = json!(client.account_id());
    let responses = client.call(vec![(method, arguments)]).await?;
    match responses.get(0, method) {
        Ok(answer) => Ok(answer.clone()),
        Err(error) if error.kind == "forbidden" => Err(Error::new(ErrorCode::Forbidden, error.description)),
        Err(error) => Err(error.into()),
    }
}

/// Every masked address of the account, deleted ones included, newest first.
pub async fn list(client: &Client) -> Result<Vec<MaskedAddress>> {
    require(client)?;
    let answer = call(client, "MaskedEmail/get", json!({ "ids": null })).await?;
    let mut list: Vec<MaskedAddress> = answer
        .get("list")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_LISTED)
        .filter_map(parse_address)
        .collect();
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(list)
}

/// Makes one, `enabled`, and returns it as the server made it.
pub async fn create(client: &Client, input: &MaskedInput) -> Result<MaskedAddress> {
    let options = require(client)?;
    let object = create_object(input, &options)?;
    let answer = call(client, "MaskedEmail/set", json!({ "create": { "new": object } })).await?;
    if let Some(problem) = answer.pointer("/notCreated/new") {
        return Err(refusal(problem));
    }
    let created =
        answer.pointer("/created/new").ok_or_else(|| Error::internal("The server didn't make the address."))?;
    // What the server sends back are only its own fields; the rest is what was asked for.
    let mut whole = object;
    if let (Some(whole), Some(created)) = (whole.as_object_mut(), created.as_object()) {
        whole.extend(created.iter().map(|(key, value)| (key.clone(), value.clone())));
    }
    parse_address(&whole).ok_or_else(|| Error::internal("The server didn't make the address."))
}

/// Changes its state or what it says about itself.
pub async fn update(client: &Client, id: &str, patch: &MaskedPatch) -> Result<()> {
    require(client)?;
    if !valid_id(id) {
        return Err(Error::invalid("That masked address id makes no sense."));
    }
    let object = update_object(patch)?;
    if object.as_object().is_some_and(Map::is_empty) {
        return Ok(());
    }
    let answer = call(client, "MaskedEmail/set", json!({ "update": { id: object } })).await?;
    if let Some(problem) = answer.get("notUpdated").and_then(|failed| failed.get(id)) {
        return Err(refusal(problem));
    }
    if jmap::set_errors(&answer).is_some() {
        return Err(Error::internal("The server didn't change the address."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_where_masked_addresses_may_go() {
        let options =
            options_from(&json!({ "domains": ["Example.org", "masked.example", "example.org", "bad domain", 7],
            "defaultDomain": "MASKED.example" }))
            .unwrap();
        assert_eq!(options.domains, Some(vec!["example.org".to_string(), "masked.example".to_string()]));
        assert_eq!(options.default_domain.as_deref(), Some("masked.example"));
        // A default that isn't allowed is no default; an older server's `{}` leaves the choice to it.
        let options = options_from(&json!({ "domains": ["example.org"], "defaultDomain": "other.example" })).unwrap();
        assert_eq!(options.default_domain, None);
        assert_eq!(options_from(&json!({})).unwrap(), MaskedOptions { domains: None, default_domain: None });
        assert_eq!(options_from(&json!({ "domains": [] })).unwrap().domains, Some(vec![]));
        assert!(options_from(&json!("x")).is_none());
    }

    #[test]
    fn checks_a_new_one_against_the_limits() {
        let options = MaskedOptions { domains: Some(vec!["example.org".into()]), default_domain: None };
        let input = MaskedInput {
            description: " Shop ".into(),
            for_domain: "https://shop.example.com".into(),
            url: Some("".into()),
            email_prefix: Some(" Shop_1 ".into()),
            domain: Some("EXAMPLE.org".into()),
        };
        assert_eq!(
            create_object(&input, &options).unwrap(),
            json!({ "state": "enabled", "description": "Shop", "forDomain": "https://shop.example.com",
                    "emailPrefix": "shop_1", "domain": "example.org" })
        );
        let refused = |change: fn(&mut MaskedInput)| {
            let mut input = MaskedInput::default();
            change(&mut input);
            create_object(&input, &options).unwrap_err()
        };
        assert_eq!(refused(|i| i.domain = Some("evil.example".into())).code, ErrorCode::Forbidden);
        assert_eq!(refused(|i| i.description = "ä".repeat(201)).code, ErrorCode::InvalidInput);
        assert_eq!(refused(|i| i.description = "a\u{0}b".into()).code, ErrorCode::InvalidInput);
        assert_eq!(refused(|i| i.url = Some("https://a.example/ b".into())).code, ErrorCode::InvalidInput);
        assert_eq!(refused(|i| i.email_prefix = Some("no-dash".into())).code, ErrorCode::InvalidInput);
        assert_eq!(refused(|i| i.email_prefix = Some("a".repeat(65))).code, ErrorCode::InvalidInput);
        // Multi-byte text counts in characters, like the server counts it.
        let mut input = MaskedInput { description: "ä".repeat(200), ..MaskedInput::default() };
        assert!(create_object(&input, &options).is_ok());
        input.domain = None;
        assert!(create_object(&input, &MaskedOptions { domains: None, default_domain: None }).is_ok());
    }

    #[test]
    fn changes_name_only_what_changes() {
        let patch: MaskedPatch = serde_json::from_value(json!({ "state": "disabled", "url": null })).unwrap();
        assert_eq!(update_object(&patch).unwrap(), json!({ "state": "disabled", "url": null }));
        let patch: MaskedPatch = serde_json::from_value(json!({ "description": "Neu" })).unwrap();
        assert_eq!(update_object(&patch).unwrap(), json!({ "description": "Neu" }));
        let back: MaskedPatch = serde_json::from_value(json!({ "state": "pending" })).unwrap();
        assert!(update_object(&back).is_err());
    }

    #[test]
    fn reads_hostile_answers_safely() {
        let read = parse_address(&json!({ "id": "x7", "email": " shop.maple@example.org ", "state": "weird",
            "description": format!("a\u{7}{}", "b".repeat(500)), "url": 5, "createdAt": "2026-09-27T10:00:00Z" }))
        .unwrap();
        assert_eq!(read.email, "shop.maple@example.org");
        assert_eq!(read.state, "enabled");
        assert_eq!(read.description.chars().count(), MAX_DESCRIPTION);
        assert!(!read.description.contains('\u{7}'));
        assert_eq!(read.url, None);
        assert!(parse_address(&json!({ "id": "../x", "email": "a@example.org" })).is_none());
        assert!(parse_address(&json!({ "id": "x1", "email": "nobody" })).is_none());
        assert!(parse_address(&json!({ "id": "x1" })).is_none());
    }

    #[test]
    fn refusals_say_what_went_wrong() {
        assert_eq!(refusal(&json!({ "type": "forbidden" })).code, ErrorCode::Forbidden);
        assert_eq!(refusal(&json!({ "type": "notFound" })).code, ErrorCode::NotFound);
        assert_eq!(refusal(&json!({ "type": "invalidProperties", "description": "x\u{0}" })).message, "x");
    }
}
