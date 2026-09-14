//! Keeps the local store in step with a JMAP account and carries changes made
//! in UwUMail back to the server.
//!
//! JMAP mailboxes become folders whose path is the mailbox id. An email that
//! lives in several mailboxes is shown in one of them (see
//! [`jmap::primary_mailbox`]). Sync resumes from the saved `Email` state, so
//! after the first run only changes travel.

use std::collections::{HashMap, HashSet};

use futures::StreamExt;
use serde_json::{Map, Value, json};

use crate::error::{Error, ErrorCode, Result};
use crate::imap::INITIAL_WINDOW;
use crate::jmap::{self, Client};
use crate::mime;
use crate::model::*;
use crate::store::{FolderInfo, FolderRecord, Store};

const EMAIL_STATE: &str = "Email";
/// Larger emails are stored headers-only and downloaded when opened, like over IMAP.
const FULL_DOWNLOAD_LIMIT: u64 = 2 * 1024 * 1024;
const PARALLEL_DOWNLOADS: usize = 6;
const MAX_CHANGES: usize = 500;
const LIGHT_PROPERTIES: [&str; 6] = ["id", "blobId", "mailboxIds", "keywords", "size", "receivedAt"];

#[derive(Debug, Default)]
pub struct EmailSync {
    pub new_message_ids: Vec<String>,
    pub changed: bool,
    /// False on the very first sync, so an initial import doesn't ring.
    pub had_messages: bool,
}

fn list(arguments: &Value) -> Vec<Value> {
    arguments.get("list").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn folder_name(role: FolderRole) -> &'static str {
    match role {
        FolderRole::Archive => "Archive",
        FolderRole::Trash => "Trash",
        FolderRole::Sent => "Sent",
        FolderRole::Drafts => "Drafts",
        FolderRole::Junk => "Junk",
        FolderRole::Inbox => "Inbox",
    }
}

/// Mirrors the account's mailboxes as folders. `keep` are folder paths to keep
/// even if missing, e.g. mailboxes UwUMail created a moment ago.
pub async fn sync_mailboxes(client: &Client, store: &Store, account_id: &str, keep: &HashSet<String>) -> Result<bool> {
    type Snapshot = Vec<(String, String, Option<FolderRole>, Option<String>)>;
    let snapshot = |store: &Store| -> Result<Snapshot> {
        let mut folders: Vec<_> =
            store.folders(Some(account_id))?.into_iter().map(|f| (f.path, f.name, f.role, f.parent_id)).collect();
        folders.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(folders)
    };
    let before = snapshot(store)?;

    let responses = client
        .call(vec![(
            "Mailbox/get",
            json!({ "accountId": client.account_id(), "ids": null, "properties": ["id", "name", "parentId", "role"] }),
        )])
        .await?;
    let mailboxes = list(responses.get(0, "Mailbox/get")?);
    let mut paths = keep.clone();
    let mut roles = HashSet::new();
    for mailbox in &mailboxes {
        let (Some(id), Some(name)) = (text(mailbox, "id"), text(mailbox, "name")) else { continue };
        let role = jmap::role_from_jmap(text(mailbox, "role")).filter(|role| roles.insert(*role));
        store.upsert_folder(
            account_id,
            &FolderInfo {
                path: id,
                name,
                role,
                delimiter: None,
                selectable: true,
                parent_ref: text(mailbox, "parentId"),
            },
        )?;
        paths.insert(id.to_string());
    }
    store.retain_folders(account_id, &paths)?;
    Ok(snapshot(store)? != before)
}

enum Listing {
    Changes {
        emails: Vec<Value>,
        destroyed: Vec<String>,
        state: String,
    },
    /// The server can't tell what changed since our state.
    Reset,
}

/// The newest emails of every mailbox, for the first sync.
async fn initial_listing(client: &Client, store: &Store, account_id: &str) -> Result<(Vec<Value>, String)> {
    let account = client.account_id();
    // Take the state first, so nothing that changes while listing is missed.
    let state = client.call(vec![("Email/get", json!({ "accountId": account, "ids": [] }))]).await?;
    let state = text(state.get(0, "Email/get")?, "state").unwrap_or_default().to_string();

    let limit = (INITIAL_WINDOW as usize).min(client.session.max_objects_in_get);
    let mut folders = store.folder_records(account_id)?;
    folders.sort_by_key(|f| f.role != Some(FolderRole::Inbox));
    let mut emails = Vec::new();
    let mut seen = HashSet::new();
    for folder in folders {
        let responses = client
            .call(vec![
                (
                    "Email/query",
                    json!({
                        "accountId": account,
                        "filter": { "inMailbox": folder.path },
                        "sort": [{ "property": "receivedAt", "isAscending": false }],
                        "limit": limit,
                    }),
                ),
                (
                    "Email/get",
                    json!({
                        "accountId": account,
                        "#ids": { "resultOf": "0", "name": "Email/query", "path": "/ids" },
                        "properties": LIGHT_PROPERTIES,
                    }),
                ),
            ])
            .await?;
        for email in list(responses.get(1, "Email/get")?) {
            if text(&email, "id").is_some_and(|id| seen.insert(id.to_string())) {
                emails.push(email);
            }
        }
    }
    Ok((emails, state))
}

async fn changes_since(client: &Client, since: &str) -> Result<Listing> {
    let account = client.account_id();
    let mut state = since.to_string();
    let mut emails = Vec::new();
    let mut destroyed = Vec::new();
    let max_changes = MAX_CHANGES.min(client.session.max_objects_in_get);
    loop {
        let get = |path: &str| {
            json!({
                "accountId": account,
                "#ids": { "resultOf": "0", "name": "Email/changes", "path": path },
                "properties": LIGHT_PROPERTIES,
            })
        };
        let responses = client
            .call(vec![
                ("Email/changes", json!({ "accountId": account, "sinceState": state, "maxChanges": max_changes })),
                ("Email/get", get("/created")),
                ("Email/get", get("/updated")),
            ])
            .await?;
        let changes = match responses.get(0, "Email/changes") {
            Ok(changes) => changes,
            Err(error) if error.kind == "cannotCalculateChanges" => return Ok(Listing::Reset),
            Err(error) => return Err(error.into()),
        };
        emails.extend(list(responses.get(1, "Email/get")?));
        emails.extend(list(responses.get(2, "Email/get")?));
        destroyed.extend(
            changes
                .get("destroyed")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(String::from),
        );
        state = text(changes, "newState").unwrap_or(&state).to_string();
        if changes.get("hasMoreChanges").and_then(Value::as_bool) != Some(true) {
            return Ok(Listing::Changes { emails, destroyed, state });
        }
    }
}

/// Which of the known emails still exist, for when the server lost track of our state.
async fn existing(client: &Client, remote_ids: Vec<String>) -> Result<(Vec<Value>, Vec<String>)> {
    let mut emails = Vec::new();
    let mut gone = Vec::new();
    for chunk in jmap::chunks(&remote_ids, client.session.max_objects_in_get) {
        let responses = client
            .call(vec![(
                "Email/get",
                json!({ "accountId": client.account_id(), "ids": chunk, "properties": LIGHT_PROPERTIES }),
            )])
            .await?;
        let answer = responses.get(0, "Email/get")?;
        emails.extend(list(answer));
        gone.extend(
            answer
                .get("notFound")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(String::from),
        );
    }
    Ok((emails, gone))
}

/// Brings the account's emails in the store up to date.
pub async fn sync_emails(client: &Client, store: &Store, account_id: &str) -> Result<EmailSync> {
    let known = store.remote_messages(account_id)?;
    let mut result = EmailSync { had_messages: !known.is_empty(), ..EmailSync::default() };

    let (emails, destroyed, state) = match store.sync_state(account_id, EMAIL_STATE)? {
        None => {
            let (emails, state) = initial_listing(client, store, account_id).await?;
            (emails, Vec::new(), state)
        }
        Some(since) => match changes_since(client, &since).await? {
            Listing::Changes { emails, destroyed, state } => (emails, destroyed, state),
            Listing::Reset => {
                let (mut emails, state) = initial_listing(client, store, account_id).await?;
                let (still_there, gone) = existing(client, known.keys().cloned().collect()).await?;
                emails.extend(still_there);
                (emails, gone, state)
            }
        },
    };

    let folders: HashMap<String, FolderRecord> =
        store.folder_records(account_id)?.into_iter().map(|f| (f.path.clone(), f)).collect();

    // The latest version of each email wins; destroyed ones are dropped.
    let destroyed: HashSet<String> = destroyed.into_iter().collect();
    let mut latest: HashMap<String, Value> = HashMap::new();
    let mut order = Vec::new();
    for email in emails {
        let Some(id) = text(&email, "id").map(String::from) else { continue };
        if destroyed.contains(&id) {
            continue;
        }
        if latest.insert(id.clone(), email).is_none() {
            order.push(id);
        }
    }

    let mut removed: Vec<String> = destroyed.iter().filter_map(|id| known.get(id)).map(|k| k.id.clone()).collect();
    let mut new_emails = Vec::new();
    for id in order {
        let email = &latest[&id];
        let folder = jmap::primary_mailbox(email.get("mailboxIds"), &folders, |f| f.role);
        let flags = jmap::flags_from_keywords(email.get("keywords"));
        match (known.get(&id), folder) {
            (Some(local), Some(folder)) => {
                result.changed |= store.update_remote_message(&local.id, &folder.id, flags)?
            }
            (Some(local), None) => removed.push(local.id.clone()),
            (None, Some(folder)) => new_emails.push((email.clone(), folder.id.clone(), flags)),
            (None, None) => {}
        }
    }
    if !removed.is_empty() {
        store.delete_messages(&removed)?;
        result.changed = true;
    }

    let size_of = |email: &Value| email.get("size").and_then(Value::as_u64).unwrap_or(0);
    let received = |email: &Value| {
        text(email, "receivedAt").and_then(mail_parser::DateTime::parse_rfc3339).map(|date| date.to_timestamp())
    };
    let (small, large): (Vec<_>, Vec<_>) =
        new_emails.into_iter().partition(|(email, _, _)| size_of(email) <= FULL_DOWNLOAD_LIMIT);

    let mut downloads = futures::stream::iter(small)
        .map(|(email, folder_id, flags)| async move {
            let blob = text(&email, "blobId").unwrap_or_default().to_string();
            let raw = client.download(&blob, "message.eml", "message/rfc822").await;
            (email, folder_id, flags, raw)
        })
        .buffered(PARALLEL_DOWNLOADS);
    while let Some((email, folder_id, flags, raw)) = downloads.next().await {
        let raw = match raw {
            Ok(raw) => raw,
            // Deleted in the meantime; the next changes will say so.
            Err(error) if error.code == ErrorCode::NotFound => continue,
            Err(error) => return Err(error),
        };
        let (Some(id), Some(blob)) = (text(&email, "id"), text(&email, "blobId")) else { continue };
        let parsed = mime::parse(&raw);
        if let Some(local) = store.insert_jmap_message(
            account_id,
            &folder_id,
            id,
            blob,
            flags,
            size_of(&email),
            received(&email),
            &parsed,
        )? {
            result.new_message_ids.push(local);
            result.changed = true;
        }
    }

    for chunk in jmap::chunks(&large, client.session.max_objects_in_get) {
        let ids: Vec<&str> = chunk.iter().filter_map(|(email, _, _)| text(email, "id")).collect();
        let responses = client
            .call(vec![(
                "Email/get",
                json!({ "accountId": client.account_id(), "ids": ids, "properties": ["id", "headers"] }),
            )])
            .await?;
        let headers: HashMap<String, Vec<Value>> = list(responses.get(0, "Email/get")?)
            .into_iter()
            .filter_map(|email| Some((text(&email, "id")?.to_string(), email.get("headers")?.as_array()?.clone())))
            .collect();
        for (email, folder_id, flags) in chunk {
            let (Some(id), Some(blob)) = (text(&email, "id"), text(&email, "blobId")) else { continue };
            let Some(header_list) = headers.get(id) else { continue };
            let parsed = mime::parse(&jmap::header_block(header_list));
            if let Some(local) = store.insert_jmap_message(
                account_id,
                &folder_id,
                id,
                blob,
                flags,
                size_of(&email),
                received(&email),
                &parsed,
            )? {
                result.new_message_ids.push(local);
                result.changed = true;
            }
        }
    }

    store.set_sync_state(account_id, EMAIL_STATE, Some(&state))?;
    Ok(result)
}

async fn update_emails(client: &Client, remote_ids: &[String], patch: Value) -> Result<()> {
    for chunk in jmap::chunks(remote_ids, 250) {
        let responses = client
            .call(vec![(
                "Email/set",
                json!({ "accountId": client.account_id(), "update": jmap::patch_all(&chunk, &patch) }),
            )])
            .await?;
        if let Some(error) = jmap::set_errors(responses.get(0, "Email/set")?) {
            return Err(error.into());
        }
    }
    Ok(())
}

/// Sets or clears keywords such as `$seen` and `$flagged`.
pub async fn set_keywords(client: &Client, remote_ids: &[String], keywords: &[(&str, bool)]) -> Result<()> {
    let patch: Map<String, Value> = keywords
        .iter()
        .map(|(keyword, on)| (format!("keywords/{keyword}"), if *on { Value::Bool(true) } else { Value::Null }))
        .collect();
    update_emails(client, remote_ids, Value::Object(patch)).await
}

/// Moves emails into exactly one mailbox.
pub async fn move_emails(client: &Client, remote_ids: &[String], mailbox_id: &str) -> Result<()> {
    update_emails(client, remote_ids, json!({ "mailboxIds": { mailbox_id: true } })).await
}

pub async fn destroy_emails(client: &Client, remote_ids: &[String]) -> Result<()> {
    for chunk in jmap::chunks(remote_ids, 250) {
        let responses =
            client.call(vec![("Email/set", json!({ "accountId": client.account_id(), "destroy": chunk }))]).await?;
        if let Some(error) = jmap::set_errors(responses.get(0, "Email/set")?).filter(|e| e.kind != "notFound") {
            return Err(error.into());
        }
    }
    Ok(())
}

/// Finds the folder for a role, adopting a same-named mailbox or creating one.
pub async fn ensure_mailbox(
    client: &Client,
    store: &Store,
    account_id: &str,
    role: FolderRole,
) -> Result<FolderRecord> {
    if let Some(folder) = store.folder_by_role(account_id, role)? {
        return Ok(folder);
    }
    let name = folder_name(role);
    let account = client.account_id();
    let responses = client
        .call(vec![(
            "Mailbox/get",
            json!({ "accountId": account, "ids": null, "properties": ["id", "name", "parentId"] }),
        )])
        .await?;
    let existing = list(responses.get(0, "Mailbox/get")?).into_iter().find(|mailbox| {
        mailbox.get("parentId").is_none_or(Value::is_null)
            && text(mailbox, "name").is_some_and(|n| n.eq_ignore_ascii_case(name))
    });
    let id = match existing.as_ref().and_then(|mailbox| text(mailbox, "id")) {
        Some(id) => id.to_string(),
        None => {
            let mut id = None;
            // Not every server lets clients assign roles; try with, then without.
            for with_role in [true, false] {
                let mut mailbox = json!({ "name": name, "parentId": null });
                if with_role {
                    mailbox["role"] = json!(role.as_str());
                }
                let responses = client
                    .call(vec![("Mailbox/set", json!({ "accountId": account, "create": { "new": mailbox } }))])
                    .await?;
                let answer = responses.get(0, "Mailbox/set")?;
                if let Some(created) = answer.pointer("/created/new/id").and_then(Value::as_str) {
                    id = Some(created.to_string());
                    break;
                }
                if !with_role {
                    return Err(jmap::set_errors(answer)
                        .map(Error::from)
                        .unwrap_or_else(|| Error::internal("The mail server didn't create the folder.")));
                }
            }
            id.ok_or_else(|| Error::internal("The mail server didn't create the folder."))?
        }
    };
    let folder_id = store.upsert_folder(
        account_id,
        &FolderInfo { path: &id, name, role: Some(role), delimiter: None, selectable: true, parent_ref: None },
    )?;
    store.folder(&folder_id)
}

/// Sends a message: stores it in Sent, then submits it for delivery. If the
/// submission fails, the stored copy is removed again.
pub async fn send(
    client: &Client,
    store: &Store,
    account_id: &str,
    raw: Vec<u8>,
    from: &str,
    recipients: &[String],
) -> Result<()> {
    let submission_account = client
        .session
        .submission_account_id
        .clone()
        .ok_or_else(|| Error::not_supported("This JMAP account can't send mail."))?;
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
    let responses = client
        .call(vec![
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
                    "create": { "submission": {
                        "identityId": identity,
                        "emailId": "#outgoing",
                        "envelope": { "mailFrom": { "email": from, "parameters": null }, "rcptTo": rcpt_to },
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
    let submitted = responses
        .get(1, "EmailSubmission/set")
        .map_err(Error::from)
        .and_then(|answer| jmap::set_errors(answer).map_or(Ok(()), |error| Err(error.into())));
    if let Err(error) = submitted {
        if let Some(email_id) = email_id {
            let _ = destroy_emails(client, &[email_id]).await;
        }
        return Err(error);
    }
    Ok(())
}
