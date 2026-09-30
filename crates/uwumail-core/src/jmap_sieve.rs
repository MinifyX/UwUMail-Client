//! Mail rules on a UwUMail server: one Sieve script called "UwUMail", through JMAP for Sieve
//! Scripts (RFC 9661, `urn:ietf:params:jmap:sieve`).
//!
//! The engine only carries the script. Turning rules into Sieve and back is the page's business
//! (apps/desktop/src/lib/sieveRules.ts, the same file as in the webmail).

use serde_json::{Value, json};

use crate::error::{Error, Result};
use crate::jmap::{Client, MethodError};
use crate::model::MailRules;

/// The one script UwUMail edits.
pub const SCRIPT_NAME: &str = "UwUMail";
const SIEVE_TYPE: &str = "application/sieve";
/// Scripts larger than this are refused before anything is uploaded; servers allow far less.
pub const MAX_SCRIPT: usize = 1024 * 1024;

fn account(client: &Client) -> Result<&str> {
    client
        .session
        .sieve_account_id
        .as_deref()
        .ok_or_else(|| Error::not_supported("This mail server doesn't keep mail rules."))
}

/// The script called "UwUMail" in a `SieveScript/get` answer: (id, blob id, active).
pub fn find_script(arguments: &Value) -> Option<(String, String, bool)> {
    arguments.get("list")?.as_array()?.iter().find_map(|script| {
        let text = |key: &str| script.get(key).and_then(Value::as_str);
        (text("name")? == SCRIPT_NAME).then(|| {
            (
                text("id").unwrap_or_default().to_string(),
                text("blobId").unwrap_or_default().to_string(),
                script.get("isActive").and_then(Value::as_bool).unwrap_or(false),
            )
        })
    })
}

/// The name of an active script other than "UwUMail" in a `SieveScript/get` answer. The server
/// runs one script, so saving the rules (which activates "UwUMail") switches that one off.
pub fn other_active_script(arguments: &Value) -> Option<String> {
    arguments.get("list")?.as_array()?.iter().find_map(|script| {
        let name = script.get("name").and_then(Value::as_str).unwrap_or_default();
        let active = script.get("isActive").and_then(Value::as_bool).unwrap_or(false);
        (active && name != SCRIPT_NAME).then(|| name.chars().filter(|c| !c.is_control()).take(200).collect())
    })
}

/// A problem with the script from a `SetError`, as a person can read it.
fn script_problem(error: &MethodError) -> String {
    match error.kind.as_str() {
        "invalidSieve" if !error.description.is_empty() => error.description.clone(),
        "invalidSieve" => "The mail server can't read these rules.".into(),
        "tooLarge" => "These rules are too big for the mail server.".into(),
        "overQuota" => "The mail server has no room for more rules.".into(),
        _ if !error.description.is_empty() => format!("{} ({})", error.description, error.kind),
        _ => format!("The mail server refused the rules ({}).", error.kind),
    }
}

/// The first `SetError` of an answer, taken from `notCreated`/`notUpdated` or the `error` of
/// `SieveScript/validate`.
fn set_error(value: &Value) -> MethodError {
    MethodError {
        kind: value.get("type").and_then(Value::as_str).unwrap_or("serverFail").to_string(),
        description: value.get("description").and_then(Value::as_str).unwrap_or_default().to_string(),
    }
}

/// Every script's id, name, blob and whether it's active (`SieveScript/get`).
async fn scripts(client: &Client) -> Result<Value> {
    let responses = client
        .call(vec![(
            "SieveScript/get",
            json!({ "accountId": account(client)?, "ids": null, "properties": ["id", "name", "blobId", "isActive"] }),
        )])
        .await?;
    Ok(responses.get(0, "SieveScript/get")?.clone())
}

async fn existing(client: &Client) -> Result<Option<(String, String, bool)>> {
    Ok(find_script(&scripts(client).await?))
}

/// The "UwUMail" script and whether it is the active one (no script yet is `None`), and another
/// app's script the server runs instead.
pub async fn load(client: &Client) -> Result<MailRules> {
    let list = scripts(client).await?;
    let other_active = other_active_script(&list);
    let Some((_, blob_id, active)) = find_script(&list) else {
        return Ok(MailRules { script: None, active: false, other_active });
    };
    // Read only as far as rules may go: a bigger one stops arriving (audit C-14).
    let bytes = client
        .download_within(account(client)?, &blob_id, "UwUMail.sieve", SIEVE_TYPE, MAX_SCRIPT)
        .await
        .map_err(|error| match error.code {
            crate::error::ErrorCode::ConnectionFailed if error.message.contains("too big") => {
                Error::invalid("The mail rules on the server are too big to show.")
            }
            _ => error,
        })?;
    let script = String::from_utf8(bytes).map_err(|_| Error::invalid("The mail rules on the server aren't text."))?;
    Ok(MailRules { script: Some(script), active, other_active })
}

fn check_size(script: &str) -> Result<()> {
    if script.len() > MAX_SCRIPT {
        return Err(Error::invalid("These rules are too big for the mail server."));
    }
    Ok(())
}

/// Stores the script as "UwUMail" and makes it the active one.
pub async fn save(client: &Client, script: &str) -> Result<()> {
    check_size(script)?;
    let account = account(client)?;
    let blob_id = client.upload_for(account, script.as_bytes().to_vec(), SIEVE_TYPE).await?;
    let arguments = match existing(client).await? {
        Some((id, _, _)) => json!({
            "accountId": account,
            "update": { id.clone(): { "blobId": blob_id } },
            "onSuccessActivateScript": id,
        }),
        None => json!({
            "accountId": account,
            "create": { "rules": { "name": SCRIPT_NAME, "blobId": blob_id } },
            "onSuccessActivateScript": "#rules",
        }),
    };
    let responses = client.call(vec![("SieveScript/set", arguments)]).await?;
    let answer = responses.get(0, "SieveScript/set")?;
    let failure =
        ["notCreated", "notUpdated"].iter().find_map(|key| answer.get(*key)?.as_object()?.values().next().cloned());
    match failure {
        Some(failure) => Err(Error::invalid(script_problem(&set_error(&failure)))),
        None => Ok(()),
    }
}

/// Asks the server whether it can run the script. `None` when it can, otherwise what's wrong.
pub async fn validate(client: &Client, script: &str) -> Result<Option<String>> {
    check_size(script)?;
    let account = account(client)?;
    let blob_id = client.upload_for(account, script.as_bytes().to_vec(), SIEVE_TYPE).await?;
    let responses =
        client.call(vec![("SieveScript/validate", json!({ "accountId": account, "blobId": blob_id }))]).await?;
    Ok(validation_problem(responses.get(0, "SieveScript/validate")?))
}

/// What a `SieveScript/validate` answer says is wrong, if anything.
pub fn validation_problem(arguments: &Value) -> Option<String> {
    arguments.get("error").filter(|error| !error.is_null()).map(|error| script_problem(&set_error(error)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_uwumail_script() {
        let answer = json!({
            "list": [
                { "id": "s1", "name": "vacation", "blobId": "b1", "isActive": false },
                { "id": "s2", "name": "UwUMail", "blobId": "b2", "isActive": true },
            ]
        });
        assert_eq!(find_script(&answer), Some(("s2".into(), "b2".into(), true)));
        assert_eq!(find_script(&json!({ "list": [{ "id": "s1", "name": "uwumail" }] })), None);
        assert_eq!(find_script(&json!({})), None);
    }

    #[test]
    fn names_another_app_s_active_script() {
        let answer = json!({
            "list": [
                { "id": "s1", "name": "roundcube", "blobId": "b1", "isActive": true },
                { "id": "s2", "name": "UwUMail", "blobId": "b2", "isActive": false },
            ]
        });
        assert_eq!(other_active_script(&answer).as_deref(), Some("roundcube"));
        let ours = json!({ "list": [{ "id": "s2", "name": "UwUMail", "isActive": true }, { "name": "old" }] });
        assert_eq!(other_active_script(&ours), None);
        let odd = json!({ "list": [{ "name": "a\nb", "isActive": true }] });
        assert_eq!(other_active_script(&odd).as_deref(), Some("ab"));
    }

    #[test]
    fn explains_why_a_script_was_refused() {
        assert_eq!(validation_problem(&json!({ "error": null })), None);
        let invalid = json!({ "error": { "type": "invalidSieve", "description": "line 3: unknown command" } });
        assert_eq!(validation_problem(&invalid).as_deref(), Some("line 3: unknown command"));
        let bare = json!({ "error": { "type": "invalidSieve" } });
        assert_eq!(validation_problem(&bare).as_deref(), Some("The mail server can't read these rules."));
        let big = json!({ "error": { "type": "tooLarge" } });
        assert!(validation_problem(&big).unwrap().contains("too big"));
    }
}
