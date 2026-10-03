//! Signatures per domain on a UwUMail server (`urn:uwumail:jmap:signatures`, see UwUMail-Server
//! docs/jmap-signatures.md): one signature per domain or for every domain (`*`), single addresses
//! with their own, and the domains' company signatures.
//!
//! The engine only carries them. The rules (what an address sends with, "applies to", the
//! placeholders) live in the page (apps/desktop/src/lib/domainSignatures.ts, the webmail's copy),
//! which also checks every field of the answer.

use serde_json::{Map, Value, json};

use crate::error::{Error, Result};
use crate::jmap::Client;

/// What the server keeps per signature, text and HTML each (its `maxSize`).
pub const MAX_BYTES: usize = 262_144;
/// Signatures one change may carry (its `maxChanges`).
pub const MAX_CHANGES: usize = 500;
/// A domain name or a JMAP id is never longer.
const MAX_KEY: usize = 255;

/// Arguments of `SignatureSettings/get`.
pub fn get_arguments(account_id: &str) -> Value {
    json!({ "accountId": account_id })
}

/// Arguments of `SignatureSettings/set` for a change the page made: `domains` and `identities`,
/// each mapping a domain (or `*`) or an identity id to `{text, html}` or `null`. Anything else is
/// refused here already, so the server never sees half a change.
pub fn set_arguments(account_id: &str, change: &Value) -> Result<Value> {
    let invalid = || Error::invalid("This signature change makes no sense.");
    let change = change.as_object().ok_or_else(invalid)?;
    if change.keys().any(|key| key != "domains" && key != "identities") {
        return Err(invalid());
    }
    let mut arguments = json!({ "accountId": account_id });
    let mut count = 0;
    for part in ["domains", "identities"] {
        let entries = match change.get(part) {
            None | Some(Value::Null) => continue,
            Some(Value::Object(entries)) => entries,
            Some(_) => return Err(invalid()),
        };
        let mut checked = Map::new();
        for (key, value) in entries {
            if key.is_empty() || key.len() > MAX_KEY || key.chars().any(char::is_control) {
                return Err(invalid());
            }
            checked.insert(key.clone(), signature(value)?);
        }
        count += checked.len();
        arguments[part] = Value::Object(checked);
    }
    if count > MAX_CHANGES {
        return Err(Error::invalid("Too many signatures in one change."));
    }
    Ok(arguments)
}

/// `null`, or `{text, html}` with both as strings (missing ones empty) and within the size.
fn signature(value: &Value) -> Result<Value> {
    let Some(object) = value.as_object() else {
        return if value.is_null() { Ok(Value::Null) } else { Err(Error::invalid("A signature is text and HTML.")) };
    };
    if object.keys().any(|key| key != "text" && key != "html") {
        return Err(Error::invalid("A signature is text and HTML."));
    }
    let field = |key: &str| -> Result<String> {
        match object.get(key) {
            None | Some(Value::Null) => Ok(String::new()),
            Some(Value::String(text)) if text.len() <= MAX_BYTES => Ok(text.clone()),
            Some(Value::String(_)) => Err(Error::invalid("This signature is too big. Try a smaller picture.")),
            Some(_) => Err(Error::invalid("A signature is text and HTML.")),
        }
    };
    Ok(json!({ "text": field("text")?, "html": field("html")? }))
}

/// Reads a `SignatureSettings/get` answer; the page checks the fields.
pub fn parse_get(arguments: &Value) -> Result<Value> {
    if !arguments.is_object() || arguments.get("state").and_then(Value::as_str).is_none() {
        return Err(Error::internal("The server's signatures came without a state."));
    }
    Ok(arguments.clone())
}

fn account(client: &Client) -> Result<&str> {
    client
        .session
        .signatures_account_id
        .as_deref()
        .ok_or_else(|| Error::not_supported("This server has no signatures per domain."))
}

pub async fn load(client: &Client) -> Result<Value> {
    let account = account(client)?;
    let responses = client.call(vec![("SignatureSettings/get", get_arguments(account))]).await?;
    parse_get(responses.get(0, "SignatureSettings/get")?)
}

/// Applies a change, all or nothing, and returns the overview after it.
pub async fn save(client: &Client, change: &Value) -> Result<Value> {
    let account = account(client)?;
    let arguments = set_arguments(account, change)?;
    let responses = client
        .call(vec![("SignatureSettings/set", arguments), ("SignatureSettings/get", get_arguments(account))])
        .await?;
    responses.get(0, "SignatureSettings/set")?;
    parse_get(responses.get(1, "SignatureSettings/get")?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_calls() {
        assert_eq!(get_arguments("a1"), json!({ "accountId": "a1" }));
        let change = json!({
            "domains": { "*": { "text": "Mini", "html": "" }, "example.org": null },
            "identities": { "i4": { "html": "<p>{name}</p>" } },
        });
        assert_eq!(
            set_arguments("a1", &change).unwrap(),
            json!({
                "accountId": "a1",
                "domains": { "*": { "text": "Mini", "html": "" }, "example.org": null },
                "identities": { "i4": { "text": "", "html": "<p>{name}</p>" } },
            })
        );
        assert_eq!(set_arguments("a1", &json!({})).unwrap(), json!({ "accountId": "a1" }));
    }

    #[test]
    fn refuses_what_is_no_change() {
        for change in [
            json!(null),
            json!([]),
            json!({ "other": {} }),
            json!({ "domains": [] }),
            json!({ "domains": { "": null } }),
            json!({ "domains": { "a\u{0}b": null } }),
            json!({ "domains": { "example.org": "Mini" } }),
            json!({ "domains": { "example.org": { "text": 1 } } }),
            json!({ "domains": { "example.org": { "text": "", "css": "" } } }),
            json!({ "identities": { "i1": { "html": "x".repeat(MAX_BYTES + 1) } } }),
            json!({ "domains": { "x".repeat(256): null } }),
        ] {
            assert!(set_arguments("a1", &change).is_err(), "{change}");
        }
        let many: Map<String, Value> = (0..=MAX_CHANGES).map(|i| (format!("i{i}"), Value::Null)).collect();
        assert!(set_arguments("a1", &json!({ "identities": many })).is_err());
        // Multi-byte text counts in bytes, like the server counts it.
        let emoji = "🎉".repeat(MAX_BYTES / 4);
        assert!(set_arguments("a1", &json!({ "domains": { "*": { "text": emoji } } })).is_ok());
        let over = format!("{emoji}x");
        assert!(set_arguments("a1", &json!({ "domains": { "*": { "text": over } } })).is_err());
    }

    #[test]
    fn reads_the_overview() {
        let answer = json!({ "accountId": "a1", "state": "3", "allDomains": null, "domains": [], "identities": [] });
        assert_eq!(parse_get(&answer).unwrap(), answer);
        assert!(parse_get(&json!({ "domains": [] })).is_err());
        assert!(parse_get(&json!("3")).is_err());
    }
}
