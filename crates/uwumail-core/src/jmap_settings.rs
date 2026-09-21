//! The settings a UwUMail server keeps for a login (`urn:uwumail:jmap:settings`, see
//! UwUMail-Server docs/jmap-settings.md): one `UserSettings` object with a flat map of keys to
//! JSON values, shared by the webmail and the apps.
//!
//! The engine only carries them. Which keys exist, how they map onto the app's settings and how
//! both copies are merged is the page's business (apps/desktop/src/lib/settingsSync.ts).

use serde_json::{Map, Value, json};

use crate::error::{Error, Result};
use crate::jmap::{Client, MethodError};
use crate::model::{UserSettings, UserSettingsSaved};

const SINGLETON: &str = "singleton";

/// A key as a JSON pointer segment of the patch (RFC 6901: `~` → `~0`, `/` → `~1`).
pub fn patch_path(key: &str) -> String {
    format!("values/{}", key.replace('~', "~0").replace('/', "~1"))
}

/// Arguments of `UserSettings/get`.
pub fn get_arguments(account_id: &str) -> Value {
    json!({ "accountId": account_id, "ids": [SINGLETON] })
}

/// Arguments of `UserSettings/set` that set each key to its value, or remove it for `null`.
pub fn set_arguments(account_id: &str, changes: &Map<String, Value>, if_in_state: Option<&str>) -> Value {
    let patch: Map<String, Value> = changes.iter().map(|(key, value)| (patch_path(key), value.clone())).collect();
    let mut arguments = json!({ "accountId": account_id, "update": { SINGLETON: patch } });
    if let Some(state) = if_in_state {
        arguments["ifInState"] = Value::String(state.to_string());
    }
    arguments
}

/// Reads a `UserSettings/get` answer.
pub fn parse_get(arguments: &Value) -> Result<UserSettings> {
    let state = arguments
        .get("state")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::internal("The server's settings came without a state."))?;
    let values = arguments
        .get("list")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(SINGLETON)))
        .and_then(|item| item.get("values"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    Ok(UserSettings { state: state.to_string(), values })
}

/// Reads a `UserSettings/set` answer, or the method error that came instead. Races
/// (`stateMismatch`) and refused keys are outcomes the page deals with, not errors.
pub fn parse_set(answer: std::result::Result<&Value, MethodError>) -> Result<UserSettingsSaved> {
    let arguments = match answer {
        Ok(arguments) => arguments,
        Err(error) if error.kind == "stateMismatch" => {
            return Ok(UserSettingsSaved { ok: false, state: None, kind: Some(error.kind), properties: Vec::new() });
        }
        Err(error) => return Err(error.into()),
    };
    if let Some(problem) = arguments.get("notUpdated").and_then(|failed| failed.get(SINGLETON)) {
        let properties = problem
            .get("properties")
            .and_then(Value::as_array)
            .map(|keys| keys.iter().filter_map(Value::as_str).map(String::from).collect())
            .unwrap_or_default();
        let kind = problem.get("type").and_then(Value::as_str).unwrap_or("serverFail").to_string();
        return Ok(UserSettingsSaved { ok: false, state: None, kind: Some(kind), properties });
    }
    if arguments.get("updated").and_then(|updated| updated.get(SINGLETON)).is_none() {
        return Err(Error::internal("The server didn't say whether it kept the settings."));
    }
    let state = arguments.get("newState").and_then(Value::as_str).map(String::from);
    Ok(UserSettingsSaved { ok: true, state, kind: None, properties: Vec::new() })
}

fn require(client: &Client) -> Result<()> {
    if client.session.user_settings {
        Ok(())
    } else {
        Err(Error::not_supported("This server doesn't keep settings for its apps."))
    }
}

pub async fn load(client: &Client) -> Result<UserSettings> {
    require(client)?;
    let responses = client.call(vec![("UserSettings/get", get_arguments(client.account_id()))]).await?;
    parse_get(responses.get(0, "UserSettings/get")?)
}

pub async fn save(
    client: &Client,
    changes: &Map<String, Value>,
    if_in_state: Option<&str>,
) -> Result<UserSettingsSaved> {
    require(client)?;
    let arguments = set_arguments(client.account_id(), changes, if_in_state);
    let responses = client.call(vec![("UserSettings/set", arguments)]).await?;
    parse_set(responses.get(0, "UserSettings/set"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_keys_as_pointer_segments() {
        assert_eq!(patch_path("theme"), "values/theme");
        assert_eq!(patch_path("linkDomains:a/b~c"), "values/linkDomains:a~1b~0c");
        assert_eq!(patch_path("x~1"), "values/x~01");
    }

    #[test]
    fn builds_the_calls() {
        assert_eq!(get_arguments("a1"), json!({ "accountId": "a1", "ids": ["singleton"] }));
        let mut changes = Map::new();
        changes.insert("theme".into(), json!("dark"));
        changes.insert("trustedSenders:@shop.example".into(), Value::Null);
        assert_eq!(
            set_arguments("a1", &changes, Some("42")),
            json!({
                "accountId": "a1",
                "ifInState": "42",
                "update": { "singleton": { "values/theme": "dark", "values/trustedSenders:@shop.example": null } },
            })
        );
        assert!(set_arguments("a1", &changes, None).get("ifInState").is_none());
    }

    #[test]
    fn reads_the_settings() {
        let answer = json!({
            "accountId": "a1",
            "state": "7",
            "list": [{ "id": "singleton", "values": { "theme": "dark", "linkDomains:uwumail.test": true } }],
            "notFound": [],
        });
        let settings = parse_get(&answer).unwrap();
        assert_eq!(settings.state, "7");
        assert_eq!(settings.values.get("theme"), Some(&json!("dark")));
        assert_eq!(settings.values.len(), 2);

        let empty = parse_get(&json!({ "state": "0", "list": [] })).unwrap();
        assert!(empty.values.is_empty());
        assert!(parse_get(&json!({ "list": [] })).is_err());
    }

    #[test]
    fn reads_how_a_write_went() {
        let saved = parse_set(Ok(&json!({ "newState": "8", "updated": { "singleton": null } }))).unwrap();
        assert_eq!(saved, UserSettingsSaved { ok: true, state: Some("8".into()), kind: None, properties: vec![] });

        let refused = parse_set(Ok(&json!({
            "newState": "8",
            "notUpdated": { "singleton": { "type": "invalidProperties", "properties": ["colour"] } },
        })))
        .unwrap();
        assert!(!refused.ok);
        assert_eq!(refused.kind.as_deref(), Some("invalidProperties"));
        assert_eq!(refused.properties, vec!["colour".to_string()]);

        let full = parse_set(Ok(&json!({ "notUpdated": { "singleton": { "type": "overQuota" } } }))).unwrap();
        assert_eq!(full.kind.as_deref(), Some("overQuota"));

        let raced = parse_set(Err(MethodError { kind: "stateMismatch".into(), description: String::new() })).unwrap();
        assert_eq!(raced.kind.as_deref(), Some("stateMismatch"));

        assert!(parse_set(Err(MethodError { kind: "serverFail".into(), description: String::new() })).is_err());
        assert!(parse_set(Ok(&json!({ "newState": "8" }))).is_err());
    }
}
