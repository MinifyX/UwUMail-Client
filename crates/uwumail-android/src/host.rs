//! The mail engine as a process-wide service.
//!
//! On Android the window can go away while UwUMail keeps running for new mail
//! in a foreground service. The engine therefore starts with the process (from
//! `UwuApplication.onCreate`) instead of with the Tauri window, and the window
//! borrows it while it's open.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;
use uwumail_core::model::{EngineEvent, FlagChange, Message};
use uwumail_core::{Engine, EngineOptions, Error, Result};

use crate::{bridge, launch, secrets::KeystoreSecrets};

/// Android gives a broadcast about ten seconds.
const NOTIFICATION_ACTION_TIMEOUT: Duration = Duration::from_secs(8);

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static ENGINE: OnceLock<Engine> = OnceLock::new();
static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// The Tokio runtime shared with Tauri (see `tauri::async_runtime::set`).
pub fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("uwumail")
            .build()
            .expect("the Tokio runtime starts")
    })
}

/// The running engine. Blocks until the process has started it, which happens
/// before any window exists.
pub fn engine() -> Engine {
    ENGINE.wait().clone()
}

/// The app's cache folder (shared files, updates, files opened in other apps).
pub fn cache_dir() -> &'static PathBuf {
    CACHE_DIR.wait()
}

pub(crate) fn start_engine(data_dir: PathBuf, cache_dir: PathBuf) -> Result<()> {
    if ENGINE.get().is_some() {
        return Ok(());
    }
    let _ = CACHE_DIR.set(cache_dir);
    let open_url = Arc::new(|url: &str| {
        if let Err(error) = bridge::call("openUrl", &json!({ "url": url })) {
            tracing::warn!("{error}");
        }
    });
    let _entered = runtime().enter();
    let engine = Engine::new(EngineOptions { data_dir, secrets: Arc::new(KeystoreSecrets), open_url })?;
    // Phones keep the last 90 days complete unless Settings say otherwise.
    let days = bridge::call("offlineDays", &json!({}))?.and_then(|days| days.parse::<u32>().ok()).unwrap_or(90);
    engine.set_offline_days((days > 0).then_some(days))?;
    engine.start()?;

    let mut events = engine.subscribe();
    let notifier = engine.clone();
    runtime().spawn(async move {
        loop {
            match events.recv().await {
                Ok(EngineEvent::MailReceived { account_id, message_ids }) => {
                    if let Err(error) = notify(&notifier, &account_id, &message_ids) {
                        tracing::warn!("Couldn't show the notification: {error}");
                    }
                }
                Ok(_) | Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
    let _ = ENGINE.set(engine);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NotifiedMessage<'a> {
    id: &'a str,
    thread_id: &'a str,
    from: &'a str,
    subject: &'a str,
    snippet: &'a str,
}

/// Hands new mail to Kotlin, which shows it unless UwUMail is on screen.
fn notify(engine: &Engine, account_id: &str, message_ids: &[String]) -> Result<()> {
    let messages: Vec<Message> =
        engine.messages(message_ids)?.into_iter().filter(|message| !message.flags.seen).collect();
    if messages.is_empty() {
        return Ok(());
    }
    let account = engine.list_accounts()?.into_iter().find(|account| account.id == account_id);
    let notified: Vec<NotifiedMessage> = messages
        .iter()
        .map(|message| NotifiedMessage {
            id: &message.id,
            thread_id: &message.thread_id,
            from: message.from.name.as_deref().filter(|name| !name.is_empty()).unwrap_or(&message.from.email),
            subject: &message.subject,
            snippet: &message.snippet,
        })
        .collect();
    bridge::call(
        "notifyMail",
        &json!({
            "accountId": account_id,
            "accountEmail": account.as_ref().map(|account| account.email.as_str()),
            "messages": notified,
        }),
    )?;
    Ok(())
}

/// Calls from Kotlin (`UwuNative.call`).
pub(crate) fn handle(method: &str, payload: &str) -> Result<Option<String>> {
    let payload: serde_json::Value = if payload.is_empty() { json!({}) } else { serde_json::from_str(payload)? };
    match method {
        // "Mark as read" / "Archive" on a notification.
        // Runs on a Java thread that keeps the broadcast alive until the server knows.
        "notificationAction" => {
            let ids: Vec<String> = serde_json::from_value(payload["messageIds"].clone())?;
            let engine = engine();
            let work = async {
                match payload["action"].as_str() {
                    Some("read") => engine.set_flags(&ids, FlagChange { seen: Some(true), flagged: None }).await,
                    Some("archive") => engine.archive(&ids).await,
                    other => Err(Error::invalid(format!("Unknown notification action {other:?}"))),
                }
            };
            match runtime().block_on(tokio::time::timeout(NOTIFICATION_ACTION_TIMEOUT, work)) {
                Ok(result) => result?,
                Err(_) => tracing::warn!("The server took too long for a notification action"),
            }
            Ok(None)
        }
        // A share, a mailto: link or a tapped notification.
        "launch" => {
            launch::deliver(payload)?;
            Ok(None)
        }
        // How far the start got, for the log.
        "status" => Ok(Some(
            json!({
                "started": crate::native::started(),
                "certificates": crate::native::certificates_ready(),
                "engine": ENGINE.get().is_some(),
                "error": crate::native::start_error(),
            })
            .to_string(),
        )),
        // The phone got (back) online: reconnect right away instead of waiting.
        "networkAvailable" => {
            if let Some(engine) = ENGINE.get() {
                engine.sync_now(None);
            }
            Ok(None)
        }
        other => Err(Error::invalid(format!("Unknown call {other}"))),
    }
}
