//! The mail engine as a process-wide service.
//!
//! On Android the window can go away while UwUMail keeps running for new mail
//! in a foreground service. The engine therefore starts with the process (from
//! `UwuApplication.onCreate`) instead of with the Tauri window, and the window
//! borrows it while it's open.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;
use uwumail_core::jmap_push::Endpoint;
use uwumail_core::model::{EngineEvent, FlagChange, Message};
use uwumail_core::{Engine, EngineOptions, Error, Result};

use crate::{bridge, launch, secrets::KeystoreSecrets};

/// Android gives a broadcast about ten seconds.
const NOTIFICATION_ACTION_TIMEOUT: Duration = Duration::from_secs(8);
/// A push message keeps UwUMail awake this long at most for its sync.
const PUSH_MESSAGE_TIMEOUT: Duration = Duration::from_secs(25);
/// Asking every JMAP server whether it takes push subscriptions.
const PUSH_TARGETS_TIMEOUT: Duration = Duration::from_secs(30);
/// Making, renewing or ending one push subscription.
const PUSH_SUBSCRIPTION_TIMEOUT: Duration = Duration::from_secs(30);
/// Renewing every subscription from the background job; Android gives a job about ten minutes.
const PUSH_MAINTAIN_TIMEOUT: Duration = Duration::from_secs(120);

/// Where the provider sends the browser after signing in. Registered in the OAuth apps too (docs/oauth.md).
const OAUTH_REDIRECT: &str = uwumail_core::oauth::APP_LINK;

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

/// The engine for the window. Normally the process started it already; if
/// that failed, the window starts it so the app still opens (without the
/// Android bridge, passwords then can't be saved and the log says why).
pub fn engine_for_window(data_dir: PathBuf, cache_dir: PathBuf) -> Result<Engine> {
    for _ in 0..100 {
        if let Some(engine) = ENGINE.get() {
            return Ok(engine.clone());
        }
        if crate::native::start_error().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    crate::native::log("the process didn't start the engine, the window starts it");
    start_engine(data_dir, cache_dir)?;
    Ok(engine())
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
    // Only ever sign-in pages; anything but a web address stays unopened (Files.openUrl checks too).
    let open_url = Arc::new(|url: &str| {
        let Ok(url) = uwumail_core::links::external_url(url) else {
            tracing::warn!("Refused to open an address that isn't a web address");
            return;
        };
        if let Err(error) = bridge::call("openUrl", &json!({ "url": url })) {
            tracing::warn!("{error}");
        }
    });
    let _entered = runtime().enter();
    let engine = Engine::new(EngineOptions {
        data_dir,
        secrets: Arc::new(KeystoreSecrets),
        open_url,
        recognizer: Some(Arc::new(crate::ocr::MlKit)),
    })?;
    // Signing in with Microsoft comes back through this link (see AndroidManifest.xml): the app may
    // be paused while the browser is in front. Google only takes the loopback (oauth::takes_app_link).
    engine.use_oauth_app_link(OAUTH_REDIRECT);
    // Phones keep the last 90 days complete unless Settings say otherwise.
    let days =
        bridge::call("offlineDays", &json!({})).ok().flatten().and_then(|days| days.parse::<u32>().ok()).unwrap_or(90);
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
                // Kotlin registers with the push service again, or decides whether the mail
                // service still has to stay connected. It only queues that and returns.
                Ok(EngineEvent::PushChanged { reregister }) => {
                    if let Err(error) = bridge::call("pushChanged", &json!({ "reregister": reregister })) {
                        tracing::warn!("Couldn't pass on the push change: {error}");
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

/// The running engine for calls that must not wait for it (see [`engine`]).
fn running() -> Result<Engine> {
    ENGINE.get().cloned().ok_or_else(|| Error::internal("The mail engine isn't running."))
}

/// Runs push work on a Java thread and waits for it, at most `limit`.
fn push_work<T>(limit: Duration, work: impl Future<Output = Result<T>>) -> Result<T> {
    runtime()
        .block_on(tokio::time::timeout(limit, work))
        .map_err(|_| Error::connection("The mail server took too long."))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushEndpoint {
    account_id: String,
    install_id: String,
    #[serde(flatten)]
    endpoint: Endpoint,
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
                    Some("archive") => engine.archive(&ids).await.map(|_| ()),
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
        // The browser came back from signing in. Only the waiting sign-in can use the link: it
        // checks `state` and needs its PKCE verifier, so a link from anywhere else changes nothing.
        "oauthRedirect" => {
            let url = payload["url"].as_str().unwrap_or_default();
            let accepted = ENGINE.get().is_some_and(|engine| engine.finish_sign_in(url));
            // Never the link itself: it carries the authorization code.
            crate::native::log(if accepted { "sign-in link handed over" } else { "sign-in link ignored" });
            Ok(Some(accepted.to_string()))
        }
        // How far the start got, for the log.
        "status" => Ok(Some(
            json!({
                "started": crate::native::started(),
                "engine": ENGINE.get().is_some(),
                "error": crate::native::start_error(),
            })
            .to_string(),
        )),
        // UnifiedPush: the JMAP accounts whose servers take push subscriptions, with their keys.
        // Called on a Java thread; asks the servers.
        "pushTargets" => {
            let engine = running()?;
            let (targets, unreachable) = push_work(PUSH_TARGETS_TIMEOUT, engine.push_targets())?;
            Ok(Some(json!({ "targets": targets, "unreachable": unreachable }).to_string()))
        }
        // The push service gave an account an endpoint: subscribe the server to it.
        "pushEndpoint" => {
            let request: PushEndpoint = serde_json::from_value(payload)?;
            let engine = running()?;
            push_work(
                PUSH_SUBSCRIPTION_TIMEOUT,
                engine.push_subscribe(&request.account_id, &request.install_id, request.endpoint),
            )?;
            Ok(None)
        }
        // A decrypted push message. Returns once its sync is done, so Kotlin keeps UwUMail awake meanwhile.
        "pushMessage" => {
            let account_id = payload["accountId"].as_str().unwrap_or_default();
            let body = payload["body"].as_str().unwrap_or_default();
            let engine = running()?;
            push_work(PUSH_MESSAGE_TIMEOUT, engine.push_received(account_id, body.as_bytes()))?;
            Ok(None)
        }
        // The account left the push service, or UnifiedPush was switched off.
        "pushUnsubscribe" => {
            let account_id = payload["accountId"].as_str().unwrap_or_default();
            let engine = running()?;
            push_work(PUSH_SUBSCRIPTION_TIMEOUT, engine.push_unsubscribe(account_id))?;
            Ok(None)
        }
        // Now and then from a background job: renews the subscriptions before they end.
        "pushMaintain" => {
            let engine = running()?;
            push_work(PUSH_MAINTAIN_TIMEOUT, engine.push_maintain())?;
            Ok(None)
        }
        // How many accounts get new mail through the push service. Only reads the store.
        "pushOverview" => {
            let overview = running()?.push_overview()?;
            Ok(Some(json!({ "overview": overview, "coversAll": overview.covers_all() }).to_string()))
        }
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
