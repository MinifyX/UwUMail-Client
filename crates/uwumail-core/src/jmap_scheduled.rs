//! "Send later" on a UwUMail server, the way its webmail does it: the mail goes to Sent at once
//! and its `EmailSubmission` waits on the server until `sendAt` (RFC 8621 §7, at most the
//! session's `maxDelayedSend` ahead). While it waits its `undoStatus` is `pending`; setting it
//! to `canceled` stops it. A submission takes no other change, so a new time is a cancel and a
//! new submission of the same mail: the new one only once the server confirmed the cancel, so the
//! mail can never go twice (security review 0.10 SL-1).

use serde_json::{Value, json};

use crate::error::{Error, ErrorCode, Result};
use crate::jmap::{self, Client};
use crate::jmap_sync::ensure_mailbox;
use crate::model::{Address, FolderRole};
use crate::send_later::{self, ScheduledKind, ScheduledSend};
use crate::store::Store;

/// The most pending submissions the list reads per mailbox.
const MAX_LISTED: usize = 500;

fn too_late() -> Error {
    Error::not_found("This mail is already on its way.")
}

fn list(arguments: &Value) -> Vec<Value> {
    arguments.get("list").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn submission_account(client: &Client) -> Result<String> {
    client
        .session
        .submission_account_id
        .clone()
        .ok_or_else(|| Error::not_supported("This JMAP account can't send mail."))
}

/// Whether this login sends later through its server: a UwUMail server that holds mail.
pub fn holds_mail(client: &Client) -> bool {
    client.session.user_settings
        && client.session.submission_account_id.is_some()
        && client.session.max_delayed_send > 0
}

/// Stores the mail in Sent and has the server send it at `send_at` (a JMAP `UTCDate`).
/// Returns the submission's id and the time the server took.
pub async fn submit(
    client: &Client,
    store: &Store,
    account_id: &str,
    raw: Vec<u8>,
    from: &str,
    recipients: &[String],
    send_at: &str,
) -> Result<(String, String)> {
    let submission_account = submission_account(client)?;
    let blob = client.upload(raw, "message/rfc822").await?;
    let sent = ensure_mailbox(client, store, account_id, FolderRole::Sent).await?;
    let identities =
        client.call(vec![("Identity/get", json!({ "accountId": submission_account, "ids": null }))]).await?;
    let identities = list(identities.get(0, "Identity/get")?);
    let identity = identities
        .iter()
        .find(|identity| text(identity, "email").is_some_and(|email| email.eq_ignore_ascii_case(from)))
        .or_else(|| identities.first())
        .and_then(|identity| text(identity, "id"))
        .ok_or_else(|| Error::invalid("This mailbox has no sending identity on the server."))?
        .to_string();
    let rcpt_to: Vec<Value> = recipients.iter().map(|email| json!({ "email": email, "parameters": null })).collect();
    // A lost answer may still have scheduled it: then it shows in the list rather than twice.
    let responses = client
        .call_submission(vec![
            (
                "Email/import",
                json!({
                    "accountId": client.account_id(),
                    "emails": { "outgoing": { "blobId": blob, "mailboxIds": { sent.path.clone(): true }, "keywords": { "$seen": true } } },
                }),
            ),
            (
                "EmailSubmission/set",
                json!({
                    "accountId": submission_account,
                    "create": { "later": {
                        "identityId": identity,
                        "emailId": "#outgoing",
                        "envelope": { "mailFrom": { "email": from, "parameters": null }, "rcptTo": rcpt_to },
                        "sendAt": send_at,
                    } },
                }),
            ),
        ])
        .await?;
    let imported = responses.get(0, "Email/import")?;
    if let Some(error) = jmap::set_errors(imported) {
        return Err(error.into());
    }
    let email_id = imported.pointer("/created/outgoing/id").and_then(Value::as_str).map(String::from);
    let submitted = responses.get(1, "EmailSubmission/set").map_err(Error::from).and_then(|answer| {
        if let Some(error) = jmap::set_errors(answer) {
            return Err(error.into());
        }
        answer.pointer("/created/later").cloned().ok_or_else(|| Error::internal("The server didn't take the mail."))
    });
    match submitted {
        Ok(created) => {
            let id = text(&created, "id").ok_or_else(|| Error::internal("The server didn't take the mail."))?;
            Ok((id.to_string(), text(&created, "sendAt").unwrap_or(send_at).to_string()))
        }
        Err(error) => {
            if let Some(email_id) = email_id {
                let _ = crate::jmap_sync::destroy_emails(client, &[email_id]).await;
            }
            Err(error)
        }
    }
}

/// The mail this login's server still holds, with subject and recipients.
pub async fn pending(client: &Client) -> Result<(Vec<Value>, Vec<Value>)> {
    let submission_account = submission_account(client)?;
    let responses = client
        .call(vec![
            (
                "EmailSubmission/query",
                json!({ "accountId": submission_account, "filter": { "undoStatus": "pending" }, "limit": MAX_LISTED }),
            ),
            (
                "EmailSubmission/get",
                json!({
                    "accountId": submission_account,
                    "#ids": { "resultOf": "0", "name": "EmailSubmission/query", "path": "/ids" },
                    "properties": ["id", "emailId", "sendAt", "undoStatus", "envelope"],
                }),
            ),
            (
                "Email/get",
                json!({
                    "accountId": client.account_id(),
                    "#ids": { "resultOf": "1", "name": "EmailSubmission/get", "path": "/list/*/emailId" },
                    "properties": ["id", "subject", "to"],
                }),
            ),
        ])
        .await?;
    Ok((list(responses.get(1, "EmailSubmission/get")?), list(responses.get(2, "Email/get")?)))
}

fn addresses(value: Option<&Value>) -> Vec<Address> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|entry| {
                    let email = text(entry, "email")?.trim();
                    (!email.is_empty()).then(|| Address {
                        name: text(entry, "name").map(str::trim).filter(|n| !n.is_empty()).map(String::from),
                        email: email.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Pending submissions as the list shows them, soonest first. Ones due within the undo window
/// are somebody's "undo send" rather than mail sent later, and are left out.
pub fn scheduled_from(account_id: &str, submissions: &[Value], emails: &[Value], now: i64) -> Vec<ScheduledSend> {
    let mut scheduled: Vec<(i64, ScheduledSend)> = submissions
        .iter()
        .filter(|submission| text(submission, "undoStatus").is_none_or(|status| status == "pending"))
        .filter_map(|submission| {
            let id = text(submission, "id")?;
            let at = send_later::parse_time(text(submission, "sendAt")?).ok()?;
            if at - now <= send_later::UNDO_WINDOW_MS {
                return None;
            }
            let email = text(submission, "emailId")
                .and_then(|email_id| emails.iter().find(|email| text(email, "id") == Some(email_id)));
            let mut to = addresses(email.and_then(|email| email.get("to")));
            if to.is_empty() {
                to = addresses(submission.pointer("/envelope/rcptTo"));
            }
            Some((
                at,
                ScheduledSend {
                    id: id.to_string(),
                    account_id: account_id.to_string(),
                    kind: ScheduledKind::Server,
                    send_at: send_later::format_time(at),
                    subject: email.and_then(|email| text(email, "subject")).unwrap_or_default().to_string(),
                    to,
                    retrying: false,
                    held: None,
                    held_reason: None,
                },
            ))
        })
        .collect();
    scheduled.sort_by_key(|(at, _)| *at);
    scheduled.into_iter().map(|(_, entry)| entry).collect()
}

/// What `EmailSubmission/set` said about cancelling `id`: confirmed, too late, or not confirmed.
/// Only an `updated` entry for `id` confirms it (security review 0.10 SL-6).
fn cancelled(answer: &Value, id: &str) -> Result<()> {
    if let Some(problem) = answer.get("notUpdated").and_then(|n| n.get(id)) {
        return match text(problem, "type") {
            Some("cannotUnsend" | "notFound") => Err(too_late()),
            _ => Err(Error::internal(
                text(problem, "description").unwrap_or("The server couldn't stop the mail.").to_string(),
            )),
        };
    }
    if let Some(error) = jmap::set_errors(answer) {
        return Err(error.into());
    }
    if !answer.get("updated").and_then(Value::as_object).is_some_and(|updated| updated.contains_key(id)) {
        return Err(Error::internal("The server didn't confirm that the mail was stopped."));
    }
    Ok(())
}

/// Cancels the submission `id` and makes sure it is: when the answer is missing or unclear, the
/// submission is read again and only counts as stopped once the server says `canceled`.
async fn stop(client: &Client, submission_account: &str, id: &str) -> Result<()> {
    let answer = client
        .call(vec![(
            "EmailSubmission/set",
            json!({ "accountId": submission_account, "update": { id: { "undoStatus": "canceled" } } }),
        )])
        .await
        .and_then(|responses| cancelled(responses.get(0, "EmailSubmission/set")?, id));
    match answer {
        Ok(()) => Ok(()),
        Err(error) if error.code == ErrorCode::NotFound => Err(error),
        Err(error) => {
            let again = client
                .call(vec![(
                    "EmailSubmission/get",
                    json!({ "accountId": submission_account, "ids": [id], "properties": ["id", "undoStatus"] }),
                )])
                .await
                .and_then(|responses| Ok(list(responses.get(0, "EmailSubmission/get")?)));
            let Ok(found) = again else { return Err(error) };
            match found.first().and_then(|submission| text(submission, "undoStatus")) {
                Some("canceled") => Ok(()),
                Some("pending") => Err(error),
                _ => Err(too_late()),
            }
        }
    }
}

/// The submission still waiting to send the mail `email_id`, if there is one.
async fn pending_for(client: &Client, submission_account: &str, email_id: &str) -> Result<Option<String>> {
    let responses = client
        .call(vec![(
            "EmailSubmission/query",
            json!({ "accountId": submission_account,
                    "filter": { "emailIds": [email_id], "undoStatus": "pending" }, "limit": 1 }),
        )])
        .await?;
    let answer = responses.get(0, "EmailSubmission/query")?;
    Ok(answer
        .get("ids")
        .and_then(Value::as_array)
        .and_then(|ids| ids.first())
        .and_then(Value::as_str)
        .map(String::from))
}

/// The submission's mail and how it was addressed, while it still waits.
async fn waiting(client: &Client, submission_account: &str, id: &str) -> Result<Value> {
    let responses = client
        .call(vec![(
            "EmailSubmission/get",
            json!({
                "accountId": submission_account,
                "ids": [id],
                "properties": ["id", "identityId", "emailId", "envelope", "undoStatus"],
            }),
        )])
        .await?;
    let submission = list(responses.get(0, "EmailSubmission/get")?).into_iter().next().ok_or_else(too_late)?;
    if text(&submission, "undoStatus").is_some_and(|status| status != "pending") {
        return Err(too_late());
    }
    Ok(submission)
}

/// Stops a held mail. Returns its email id; the mail is still in Sent.
pub async fn cancel(client: &Client, id: &str) -> Result<String> {
    let submission_account = submission_account(client)?;
    let submission = waiting(client, &submission_account, id).await?;
    let email_id = text(&submission, "emailId").ok_or_else(too_late)?.to_string();
    stop(client, &submission_account, id).await?;
    Ok(email_id)
}

/// Puts a stopped mail into Drafts as a draft again (it waited in Sent).
pub async fn to_drafts(client: &Client, store: &Store, account_id: &str, email_id: &str) -> Result<()> {
    let drafts = ensure_mailbox(client, store, account_id, FolderRole::Drafts).await?;
    let responses = client
        .call(vec![(
            "Email/set",
            json!({
                "accountId": client.account_id(),
                "update": { email_id: {
                    "mailboxIds": { drafts.path.clone(): true },
                    "keywords/$draft": true,
                    "keywords/$seen": true,
                } },
            }),
        )])
        .await?;
    if let Some(error) = jmap::set_errors(responses.get(0, "Email/set")?) {
        return Err(error.into());
    }
    Ok(())
}

/// Sends a held mail at another time (`send_at`, a JMAP `UTCDate`): its submission is cancelled,
/// and only once the server confirmed that, the same mail is submitted again in a request of its
/// own. Sending both in one request would let the new one go through even when the old one was
/// already on its way (security review 0.10 SL-1). When the new submission fails the mail is put
/// into Drafts, so it is never left in Sent unsent.
pub async fn resubmit(client: &Client, store: &Store, account_id: &str, id: &str, send_at: &str) -> Result<String> {
    let submission_account = submission_account(client)?;
    let submission = waiting(client, &submission_account, id).await?;
    let email_id = text(&submission, "emailId").ok_or_else(too_late)?.to_string();
    let identity_id = text(&submission, "identityId").ok_or_else(too_late)?;
    let envelope = submission.get("envelope").cloned().unwrap_or(Value::Null);
    stop(client, &submission_account, id).await?;

    let created = client
        .call_submission(vec![(
            "EmailSubmission/set",
            json!({
                "accountId": submission_account,
                "create": { "again": {
                    "identityId": identity_id,
                    "emailId": email_id,
                    "envelope": envelope,
                    "sendAt": send_at,
                } },
            }),
        )])
        .await
        .and_then(|responses| {
            let answer = responses.get(0, "EmailSubmission/set")?;
            if let Some(error) = jmap::set_errors(answer) {
                return Err(Error::from(error));
            }
            answer
                .pointer("/created/again/id")
                .and_then(Value::as_str)
                .map(String::from)
                .ok_or_else(|| Error::internal("The server didn't take the mail."))
        });
    let error = match created {
        Ok(new_id) => return Ok(new_id),
        Err(error) => error,
    };
    // The answer got lost: whether the new submission exists decides where the mail is.
    if error.code == ErrorCode::MaybeSent {
        match pending_for(client, &submission_account, &email_id).await {
            Ok(Some(new_id)) => return Ok(new_id),
            Ok(None) => {}
            Err(_) => {
                return Err(Error::internal(
                    "The new time couldn't be confirmed. Look at the scheduled mail and Sent before trying again.",
                ));
            }
        }
    }
    let kept = to_drafts(client, store, account_id, &email_id).await.is_ok();
    let note = if kept { " It is in Drafts now." } else { " It is stopped and waits in Sent." };
    let (code, message) = if error.code == ErrorCode::MaybeSent {
        (ErrorCode::Internal, "The new time didn't take.")
    } else {
        (error.code, error.message.as_str())
    };
    Err(Error::new(code, format!("{message}{note}")))
}

/// The whole held mail (to open it in the composer) and every address it goes to.
pub async fn download(client: &Client, email_id: &str) -> Result<Vec<u8>> {
    let responses = client
        .call(vec![(
            "Email/get",
            json!({ "accountId": client.account_id(), "ids": [email_id], "properties": ["id", "blobId"] }),
        )])
        .await?;
    let email = list(responses.get(0, "Email/get")?).into_iter().next().ok_or_else(too_late)?;
    let blob = text(&email, "blobId").ok_or_else(too_late)?;
    client.download(blob, "mail.eml", "message/rfc822").await
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000;

    #[test]
    fn the_list_shows_mail_sent_later_but_not_undo_windows() {
        let at = |minutes: i64| send_later::format_time(NOW + minutes * 60_000);
        let submissions = vec![
            json!({ "id": "S2", "emailId": "M2", "sendAt": at(600), "undoStatus": "pending",
                    "envelope": { "rcptTo": [{ "email": "bcc@uwumail.example" }] } }),
            json!({ "id": "S1", "emailId": "M1", "sendAt": at(90), "undoStatus": "pending" }),
            json!({ "id": "UNDO", "emailId": "M3", "sendAt": send_later::format_time(NOW + 10_000), "undoStatus": "pending" }),
            json!({ "id": "GONE", "emailId": "M4", "sendAt": at(90), "undoStatus": "final" }),
            json!({ "id": "BROKEN", "emailId": "M5", "sendAt": "soon", "undoStatus": "pending" }),
        ];
        let emails = vec![
            json!({ "id": "M1", "subject": "Angebot", "to": [{ "name": " Kim ", "email": "kim@uwumail.example" }] }),
            json!({ "id": "M2", "subject": null, "to": [] }),
        ];
        let list = scheduled_from("acc", &submissions, &emails, NOW);
        let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["S1", "S2"], "soonest first; undo windows, sent and broken ones left out");
        assert_eq!(list[0].subject, "Angebot");
        assert_eq!(list[0].to, vec![Address { name: Some("Kim".into()), email: "kim@uwumail.example".into() }]);
        assert_eq!(list[0].send_at, at(90));
        assert_eq!(list[0].kind, ScheduledKind::Server);
        assert_eq!(list[1].subject, "");
        assert_eq!(list[1].to[0].email, "bcc@uwumail.example", "the envelope when the mail names nobody");
    }

    #[test]
    fn stopping_tells_too_late_from_other_trouble() {
        assert!(cancelled(&json!({ "updated": { "S1": null } }), "S1").is_ok());
        // Silence is no confirmation (SL-6).
        assert!(cancelled(&json!({}), "S1").is_err());
        assert!(cancelled(&json!({ "updated": { "S2": null } }), "S1").is_err());
        assert!(cancelled(&json!({ "updated": null }), "S1").is_err());
        let late = cancelled(&json!({ "notUpdated": { "S1": { "type": "cannotUnsend" } } }), "S1").unwrap_err();
        assert_eq!(late.code, ErrorCode::NotFound);
        let other = cancelled(&json!({ "notUpdated": { "S1": { "type": "forbidden", "description": "nope" } } }), "S1");
        assert_eq!(other.unwrap_err().message, "nope");
    }
}
