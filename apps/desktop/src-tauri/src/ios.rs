//! iPhone and iPad: one process, the engine starts with the window.
//!
//! iOS gives no app a service that keeps running, so mail arrives while
//! UwUMail is open and whenever iOS wakes it up again. Notifications, Face ID
//! and haptics come from Tauri's own plugins. Attachments are saved into
//! UwUMail's folder in the Files app, because iOS has no "save as" of its own.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{App, AppHandle, Manager, RunEvent, Runtime, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use uwumail_core::attachments::AttachmentFile;
use uwumail_core::mailto::MailtoDraft;
use uwumail_core::model::EngineEvent;
use uwumail_core::secrets::KeyringSecrets;
use uwumail_core::{Engine, EngineOptions, Error};

/// UwUMail doesn't update itself on iOS: a new version comes from wherever the
/// app was installed from. The types stay, so the same UI code works everywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Beta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyUpdate {
    pub version: String,
    pub notes: Option<String>,
}

pub fn before_start() {}

pub fn plugins(builder: tauri::Builder<Wry>) -> tauri::Builder<Wry> {
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_biometric::init())
        .plugin(tauri_plugin_haptics::init())
}

pub fn start_engine(app: &mut App) -> Result<Engine, Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    let opener = app.handle().clone();
    let open_url = Arc::new(move |url: &str| {
        let _ = opener.opener().open_url(url, None::<&str>);
    });
    let engine = tauri::async_runtime::block_on(async move {
        Engine::new(EngineOptions { data_dir, secrets: Arc::new(KeyringSecrets), open_url })
    })?;
    engine.start()?;
    // Shows up in Xcode's console and in the simulator log the CI watches.
    println!("UwUMail: engine running");
    Ok(engine)
}

pub fn after_start(_app: &mut App) -> tauri::Result<()> {
    Ok(())
}

/// Rings for new mail that arrived while UwUMail wasn't the app in front.
/// iOS shows nothing while it is, so a banner never lands on top of the mail itself.
pub fn on_engine_event(app: &AppHandle, engine: &Engine, event: &EngineEvent) {
    let EngineEvent::MailReceived { message_ids, .. } = event else { return };
    let focused = app.get_webview_window("main").and_then(|window| window.is_focused().ok()).unwrap_or(false);
    if focused {
        return;
    }
    if let Ok(messages) = engine.messages(message_ids) {
        let (title, body) = match messages.as_slice() {
            [one] => (
                one.from.name.clone().unwrap_or_else(|| one.from.email.clone()),
                if one.subject.is_empty() { one.snippet.clone() } else { one.subject.clone() },
            ),
            many => ("UwUMail".to_string(), format!("{} ✉︎", many.len())),
        };
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

pub fn on_run_event<R: Runtime>(_app: &AppHandle<R>, _event: RunEvent) {}

/// Profiles, apps and shortcuts from a mail never reach iOS, whatever the mail
/// claims the file is. Saving them to the Files app still works.
pub fn check_openable(file: &AttachmentFile) -> Result<(), Error> {
    if uwumail_core::attachments::is_ios_installable(&file.filename)
        || file.mime_type.eq_ignore_ascii_case("application/x-apple-aspen-config")
    {
        return Err(Error::invalid(
            "UwUMail doesn't open profiles or apps from mails. Save the file if you expected it and trust the sender.",
        ));
    }
    Ok(())
}

/// Handing a file to another app needs iOS' share sheet, which UwUMail doesn't
/// have yet. Pictures, PDFs and text open in UwUMail itself; the rest is saved.
pub fn open_file(_app: &AppHandle, _file: &AttachmentFile) -> Result<(), Error> {
    Err(Error::invalid(
        "UwUMail can't hand this file to another app on the iPhone yet. Save it — it lands in the Files app under UwUMail.",
    ))
}

/// An iOS dialog, answered by the person, not by the web page.
pub async fn confirm(app: &AppHandle, title: &str, text: String, ok: &str, cancel: &str) -> Result<bool, Error> {
    let dialog = app
        .dialog()
        .message(text)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.into(), cancel.into()));
    tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
        .await
        .map_err(|e| Error::internal(format!("The dialog failed: {e}")))
}

/// Saves into UwUMail's folder in the Files app; iOS has no save dialog that
/// picks a folder for us. An existing file is never overwritten.
pub async fn save_file(app: &AppHandle, file: &AttachmentFile) -> Result<bool, Error> {
    let folder =
        app.path().document_dir().map_err(|e| Error::internal(format!("Couldn't find the Files folder: {e}")))?;
    std::fs::create_dir_all(&folder).map_err(|e| Error::internal(format!("Couldn't open the Files folder: {e}")))?;
    let destination = free_name(&folder, &uwumail_core::attachments::safe_filename(&file.filename));
    // The file is already in the cache; the page never decides which file gets copied.
    std::fs::copy(&file.path, &destination)
        .map_err(|e| Error::invalid(format!("Couldn't save {}: {e}", destination.display())))?;
    Ok(true)
}

/// `bild.png`, then `bild (2).png`, so a second mail with the same name keeps both.
fn free_name(folder: &std::path::Path, filename: &str) -> PathBuf {
    let first = folder.join(filename);
    if !first.exists() {
        return first;
    }
    let (stem, suffix) = match filename.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (filename.to_string(), String::new()),
    };
    for number in 2..1000 {
        let candidate = folder.join(format!("{stem} ({number}){suffix}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    first
}

/// The engine keeps the setting while it runs, and on iOS it only runs with the app.
pub fn remember_offline_days(_days: Option<u32>) -> Result<(), Error> {
    Ok(())
}

/// iOS decides by itself when a background app may look for mail; there is
/// nothing to switch on. The setting stays hidden on the iPhone.
pub fn set_run_in_background(_enabled: bool) -> Result<(), Error> {
    Ok(())
}

pub fn take_mailto(_app: &AppHandle) -> Option<MailtoDraft> {
    None
}

pub fn take_launch_action() -> Option<serde_json::Value> {
    None
}

/// Notifications only go out while UwUMail itself runs, so iOS needs no copy
/// of the language, the tone or the app lock.
pub fn set_mobile_prefs(_language: String, _tone: String, _app_lock: bool) -> Result<(), Error> {
    Ok(())
}

/// The status bar takes its color from the page behind it (`env(safe-area-inset-*)`).
pub fn set_system_bars(_dark: bool, _background: String) -> Result<(), Error> {
    Ok(())
}

pub fn mobile_action(app: &AppHandle, action: &str) -> Result<(), Error> {
    match action {
        // iOS asks once, the first time UwUMail has a mailbox to watch.
        "requestNotifications" => {
            app.notification()
                .request_permission()
                .map_err(|e| Error::internal(format!("Couldn't ask for notifications: {e}")))?;
            Ok(())
        }
        // The web view drew its first screen and reached the engine through IPC.
        "uiReady" => {
            println!("UwUMail: ui ready");
            Ok(())
        }
        "watchSettings" => Ok(()),
        _ => Err(Error::invalid("Unknown action")),
    }
}

pub fn set_update_channel(_app: &AppHandle, _channel: Channel) {}

pub fn update_status(_app: &AppHandle) -> Option<ReadyUpdate> {
    None
}

pub async fn check_for_updates(_app: &AppHandle) -> Result<Option<ReadyUpdate>, Error> {
    Ok(None)
}

pub fn install_update(_app: &AppHandle) -> Result<(), Error> {
    Err(Error::invalid("On the iPhone a new UwUMail comes from where you installed it."))
}
