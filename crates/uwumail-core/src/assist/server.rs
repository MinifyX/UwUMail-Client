//! A UwUMail account's assistant: its server makes every call to a model (docs/jmap-assist.md of
//! UwUMail Server). The answers are handed on in the server's shapes; the page normalizes them
//! (apps/desktop/src/backend/assistConvert.ts). Email ids are the server's here; the engine maps them
//! to and from the app's message ids.

use serde_json::{Map, Value, json};

use super::sse::{self, Flow, StreamLimits};
use super::{StreamEvent, StreamSink};
use crate::error::{Error, Result};
use crate::jmap::Client;

/// Whether the login has the assistant for its own account: the capability object, or `None`.
pub fn options(client: &Client) -> Option<&Value> {
    client.session.assist.as_ref().map(|assist| &assist.options).filter(|options| options.is_object())
}

/// Per feature, whether the person can use it now; `None` without the assistant or with none of
/// its features.
pub fn features(client: &Client) -> Option<Value> {
    let features = options(client)?.get("features")?.as_object()?;
    let flags: Map<String, Value> = super::Feature::ALL
        .iter()
        .map(|f| (f.as_str().to_string(), Value::Bool(features.get(f.as_str()).and_then(Value::as_bool) == Some(true))))
        .collect();
    flags.values().any(|on| on == &Value::Bool(true)).then_some(Value::Object(flags))
}

fn unavailable() -> Error {
    Error::assist("assistUnavailable", "This mail server has no assistant for this mailbox.")
}

/// A method error of the extension as the assistant's refusal, with `retryAfter` where given.
fn refusal(arguments: &Value) -> Error {
    let kind = arguments.get("type").and_then(Value::as_str).unwrap_or("serverFail");
    let description = arguments.get("description").and_then(Value::as_str).map(short).unwrap_or_default();
    let message = if description.is_empty() { format!("The assistant refused ({kind}).") } else { description };
    Error::assist(kind, message)
        .with_retry_after(arguments.get("retryAfter").and_then(Value::as_f64).map(|s| s.max(0.0).ceil() as u64))
}

fn short(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(300).collect()
}

/// Calls one method of the extension in the login's own account.
pub async fn call(client: &Client, method: &str, mut arguments: Value) -> Result<Value> {
    if options(client).is_none() {
        return Err(unavailable());
    }
    if let Some(object) = arguments.as_object_mut() {
        object.insert("accountId".into(), Value::String(client.account_id().to_string()));
    }
    let responses = client.call(vec![(method, arguments)]).await?;
    if let Some(error) = responses.error_arguments(0) {
        return Err(refusal(error));
    }
    Ok(responses.get(0, method)?.clone())
}

/// A `/set` of the extension; a refused object becomes the assistant's refusal naming its fields.
async fn set(client: &Client, method: &str, arguments: Value) -> Result<Value> {
    let answer = call(client, method, arguments).await?;
    for key in ["notCreated", "notUpdated", "notDestroyed"] {
        if let Some((_, problem)) = answer.get(key).and_then(Value::as_object).and_then(|m| m.iter().next()) {
            let kind = problem.get("type").and_then(Value::as_str).unwrap_or("invalidProperties");
            let description = problem.get("description").and_then(Value::as_str).map(short);
            let properties = problem
                .get("properties")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).take(10).map(String::from).collect())
                .unwrap_or_default();
            return Err(Error::assist(kind, description.unwrap_or_else(|| format!("The server refused it ({kind}).")))
                .with_properties(properties));
        }
    }
    Ok(answer)
}

fn list(answer: &Value) -> Value {
    answer.get("list").cloned().filter(Value::is_array).unwrap_or_else(|| json!([]))
}

pub async fn providers(client: &Client) -> Result<Value> {
    Ok(list(&call(client, "AssistProvider/get", json!({ "ids": null })).await?))
}

/// Creates an own provider and answers it as the server has it now.
pub async fn create_provider(client: &Client, input: Value) -> Result<Value> {
    let answer = set(client, "AssistProvider/set", json!({ "create": { "p": input } })).await?;
    let id = answer
        .pointer("/created/p/id")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::assist("serverFail", "The server made no provider."))?
        .to_string();
    let found = call(client, "AssistProvider/get", json!({ "ids": [id] })).await?;
    list(&found).as_array().and_then(|l| l.first().cloned()).ok_or_else(|| Error::not_found("The provider is gone."))
}

pub async fn update_provider(client: &Client, id: &str, patch: Value) -> Result<()> {
    set(client, "AssistProvider/set", json!({ "update": { id: patch } })).await.map(|_| ())
}

pub async fn delete_provider(client: &Client, id: &str) -> Result<()> {
    set(client, "AssistProvider/set", json!({ "destroy": [id] })).await.map(|_| ())
}

pub async fn models(client: &Client, provider_id: &str) -> Result<Value> {
    call(client, "AssistProvider/models", json!({ "providerId": provider_id })).await
}

pub async fn chatgpt_login(client: &Client, provider_id: &str) -> Result<Value> {
    call(client, "AssistProvider/chatgptLogin", json!({ "providerId": provider_id })).await
}

pub async fn chatgpt_poll(client: &Client, provider_id: &str) -> Result<Value> {
    call(client, "AssistProvider/chatgptPoll", json!({ "providerId": provider_id })).await
}

pub async fn settings(client: &Client) -> Result<Value> {
    let answer = call(client, "AssistSettings/get", json!({ "ids": ["singleton"] })).await?;
    Ok(list(&answer).as_array().and_then(|l| l.first().cloned()).unwrap_or_else(|| json!({})))
}

pub async fn update_settings(client: &Client, patch: Value) -> Result<()> {
    set(client, "AssistSettings/set", json!({ "update": { "singleton": patch } })).await.map(|_| ())
}

pub async fn usage(client: &Client, days: u32) -> Result<Value> {
    call(client, "Assist/usage", json!({ "days": days.clamp(1, 90) })).await
}

pub async fn labels(client: &Client) -> Result<Value> {
    Ok(list(&call(client, "AssistLabel/get", json!({ "ids": null })).await?))
}

pub async fn create_label(client: &Client, input: Value) -> Result<Value> {
    let answer = set(client, "AssistLabel/set", json!({ "create": { "g": input } })).await?;
    let created = answer.pointer("/created/g").cloned().unwrap_or(Value::Null);
    let id = created.get("id").and_then(Value::as_str).ok_or_else(|| Error::assist("serverFail", "No label made."))?;
    let found = call(client, "AssistLabel/get", json!({ "ids": [id] })).await?;
    list(&found).as_array().and_then(|l| l.first().cloned()).ok_or_else(|| Error::not_found("The label is gone."))
}

pub async fn update_label(client: &Client, id: &str, patch: Value) -> Result<()> {
    set(client, "AssistLabel/set", json!({ "update": { id: patch } })).await.map(|_| ())
}

pub async fn delete_label(client: &Client, id: &str) -> Result<()> {
    set(client, "AssistLabel/set", json!({ "destroy": [id] })).await.map(|_| ())
}

/// The label log, with the server's email ids.
pub async fn label_log(client: &Client, email_ids: Option<&[String]>, limit: u32) -> Result<Vec<Value>> {
    let answer =
        call(client, "AssistLabel/log", json!({ "emailIds": email_ids, "limit": limit.clamp(1, 500) })).await?;
    Ok(list(&answer).as_array().cloned().unwrap_or_default())
}

pub async fn undo_labels(client: &Client, log_ids: &[String]) -> Result<()> {
    call(client, "AssistLabel/undo", json!({ "ids": log_ids })).await.map(|_| ())
}

/// Asks for labels now: label ids per server email id.
pub async fn apply_labels(client: &Client, email_ids: &[String]) -> Result<Map<String, Value>> {
    let answer = call(client, "AssistLabel/apply", json!({ "emailIds": email_ids })).await?;
    Ok(answer.get("labeled").and_then(Value::as_object).cloned().unwrap_or_default())
}

pub async fn spam_check(client: &Client, email_id: &str, language: Option<&str>) -> Result<Value> {
    call(client, "Assist/spamCheck", json!({ "emailId": email_id, "language": language })).await
}

pub async fn extract_events(client: &Client, email_id: &str, include_images: bool) -> Result<Value> {
    call(client, "Assist/extractEvents", json!({ "emailId": email_id, "includeImages": include_images })).await
}

/// `Assist/compose` or `Assist/summarize`: streamed through the server's stream endpoint when
/// `sink` is given and the server has one, else one call. The answer is the method's response.
pub async fn stream_or_call(
    client: &Client,
    method: &str,
    arguments: Value,
    sink: Option<StreamSink>,
) -> Result<Value> {
    let stream_url = client.session.assist.as_ref().and_then(|assist| assist.stream_url.clone());
    let (Some(sink), Some(url)) = (sink, stream_url) else { return call(client, method, arguments).await };
    if options(client).is_none() {
        return Err(unavailable());
    }
    let mut arguments = arguments;
    if let Some(object) = arguments.as_object_mut() {
        object.insert("accountId".into(), Value::String(client.account_id().to_string()));
    }
    let response = client.post_assist_stream(&url, method, arguments).await?;
    read_stream(response, &sink).await
}

/// Reads the server's `subject` / `delta` / `done` / `error` events.
pub async fn read_stream(response: reqwest::Response, sink: &StreamSink) -> Result<Value> {
    let mut result: Option<Value> = None;
    let limits = StreamLimits { max_bytes: 8 * 1024 * 1024, ..StreamLimits::default() };
    sse::read_events(response, limits, |event| {
        let value: Value = serde_json::from_str(&event.data).unwrap_or(Value::Null);
        match event.event.as_str() {
            "subject" => {
                if let Some(subject) = value.get("subject").and_then(Value::as_str) {
                    sink(StreamEvent::Subject { subject: subject.to_string() });
                }
            }
            "delta" => {
                if let Some(text) = value.get("text").and_then(Value::as_str) {
                    sink(StreamEvent::Delta { text: text.to_string() });
                }
            }
            "done" => {
                result = Some(value);
                return Ok(Flow::Stop);
            }
            "error" => return Err(refusal(&value)),
            _ => {}
        }
        Ok(Flow::Continue)
    })
    .await?;
    result.ok_or_else(|| Error::connection("The answer broke off."))
}
