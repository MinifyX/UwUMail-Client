//! Windows, macOS and Linux: the engine starts with the window, the tray keeps
//! it running, updates come as a signed setup.

use std::sync::Arc;

use tauri::{App, AppHandle, Manager, RunEvent, Wry};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use uwumail_core::attachments::AttachmentFile;
use uwumail_core::mailto::MailtoDraft;
use uwumail_core::model::EngineEvent;
use uwumail_core::notify;
use uwumail_core::secrets::KeyringSecrets;
use uwumail_core::{Engine, EngineOptions, Error};

use crate::{background, updates};

pub use updates::{Channel, ReadyUpdate};

pub fn before_start() {
    #[cfg(windows)]
    restrict_dll_search();
}

/// On Windows, DLLs loaded by name at runtime resolve from System32 only, never the install folder
/// or PATH. This is the runtime counterpart to `/DEPENDENTLOADFLAG` (build.rs), which only covers
/// statically imported DLLs, and mirrors the setup (M7). Called before anything else loads a DLL.
#[cfg(windows)]
fn restrict_dll_search() {
    // SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) from kernel32.
    unsafe extern "system" {
        fn SetDefaultDllDirectories(directory_flags: u32) -> i32;
    }
    const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;
    unsafe {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
    }
}

pub fn plugins(builder: tauri::Builder<Wry>) -> tauri::Builder<Wry> {
    // Must come first, so a second start hands over before anything else runs.
    #[cfg(not(target_os = "macos"))]
    let builder =
        builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| background::on_second_instance(app, args)));
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(background::single_instance::init());
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
}

pub fn start_engine(app: &mut App) -> Result<Engine, Box<dyn std::error::Error>> {
    if updates::apply_pending_on_start(app.handle()) {
        // The downloaded setup replaces this version and starts UwUMail again.
        std::process::exit(0);
    }
    let data_dir = app.path().app_data_dir()?;
    let opener = app.handle().clone();
    // Only ever sign-in pages; anything but a web address stays unopened.
    let open_url = Arc::new(move |url: &str| match uwumail_core::links::external_url(url) {
        Ok(url) => {
            let _ = opener.opener().open_url(url, None::<&str>);
        }
        Err(_) => tracing::warn!("Refused to open an address that isn't a web address"),
    });
    let engine = tauri::async_runtime::block_on(async move {
        Engine::new(EngineOptions {
            data_dir,
            secrets: Arc::new(KeyringSecrets),
            open_url,
            recognizer: crate::ocr::recognizer(),
        })
    })?;
    engine.start()?;
    Ok(engine)
}

pub fn after_start(app: &mut App) -> tauri::Result<()> {
    background::setup(app)?;
    updates::start(app.handle());
    Ok(())
}

/// Rings for new mail while UwUMail is in the background.
pub fn on_engine_event(app: &AppHandle, engine: &Engine, event: &EngineEvent) {
    let EngineEvent::MailReceived { message_ids, .. } = event else { return };
    let focused = app.get_webview_window("main").and_then(|window| window.is_focused().ok()).unwrap_or(false);
    if focused {
        return;
    }
    if let Ok(messages) = engine.messages(message_ids) {
        let (title, body) = match messages.as_slice() {
            // Written by whoever sent the mail: plain, on one line and short (see uwumail_core::notify).
            [one] => (
                notify::notification_sender(one.from.name.as_deref(), &one.from.email),
                notify::notification_text(
                    if one.subject.is_empty() { &one.snippet } else { &one.subject },
                    notify::MAX_LINE,
                ),
            ),
            many => ("UwUMail".to_string(), format!("{} ✉︎", many.len())),
        };
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

/// macOS hands `mailto:` links over as an "open URL" event instead of on the
/// command line, and clicking the Dock icon brings a hidden window back.
pub fn on_run_event(app: &AppHandle, event: RunEvent) {
    #[cfg(target_os = "macos")]
    {
        match event {
            RunEvent::Opened { urls } => background::on_opened(app, urls.iter().map(|url| url.as_str())),
            RunEvent::Reopen { has_visible_windows: false, .. } => background::show_main_window(app),
            _ => {}
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, event);
    }
}

/// Every attachment may be opened on desktop; dangerous ones are confirmed first.
pub fn check_openable(_file: &AttachmentFile) -> Result<(), Error> {
    Ok(())
}

pub fn open_file(app: &AppHandle, file: &AttachmentFile) -> Result<(), Error> {
    app.opener()
        .open_path(file.path.to_string_lossy(), None::<&str>)
        .map_err(|e| Error::internal(format!("Couldn't open the attachment: {e}")))
}

/// A native warning dialog, answered by the person, not by the web page.
///
/// The safe answer (`cancel`) is the first button, so it is the one Enter picks, and only a click
/// on `ok` counts as yes: closing the dialog or Escape never does. This goes to rfd directly:
/// tauri-plugin-dialog reports a closed dialog as a click on the second custom button, which
/// would be `ok` once the safe answer comes first.
pub async fn confirm(app: &AppHandle, title: &str, text: String, ok: &str, cancel: &str) -> Result<bool, Error> {
    let (answer, answered) = tokio::sync::oneshot::channel();
    let (title, ok, cancel) = (title.to_owned(), ok.to_owned(), cancel.to_owned());
    // Like the plugin: the dialog is made on the main thread and waited for on another one.
    app.run_on_main_thread(move || {
        let shown = rfd::AsyncMessageDialog::new()
            .set_title(title)
            .set_description(text)
            .set_level(rfd::MessageLevel::Warning)
            .set_buttons(rfd::MessageButtons::OkCancelCustom(cancel, ok.clone()))
            .show();
        std::thread::spawn(move || {
            let result = tauri::async_runtime::block_on(shown);
            let _ = answer.send(is_yes(&result, &ok));
        });
    })
    .map_err(|e| Error::internal(format!("The dialog failed: {e}")))?;
    answered.await.map_err(|_| Error::internal("The dialog failed."))
}

/// Only the button that says yes: never `Ok`/`Cancel`, which is how a closed dialog comes back.
fn is_yes(result: &rfd::MessageDialogResult, ok: &str) -> bool {
    matches!(result, rfd::MessageDialogResult::Custom(label) if label == ok)
}

/// Asks where to save in the native save dialog and copies the attachment there.
pub async fn save_file(app: &AppHandle, file: &AttachmentFile) -> Result<bool, Error> {
    let dialog = app.dialog().file().set_file_name(uwumail_core::attachments::safe_filename(&file.filename));
    let destination = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|e| Error::internal(format!("The dialog failed: {e}")))?;
    let Some(destination) = destination.and_then(|path| path.into_path().ok()) else { return Ok(false) };
    // The file is already in the cache; the page never decides which file gets copied.
    std::fs::copy(&file.path, &destination)
        .map_err(|e| Error::invalid(format!("Couldn't save to {}: {e}", destination.display())))?;
    // A saved attachment stays marked as downloaded, whatever the copy took along.
    uwumail_core::attachments::mark_from_internet(&destination);
    Ok(true)
}

/// The engine keeps the setting while it runs; desktop starts with everything.
pub fn remember_offline_days(_days: Option<u32>) -> Result<(), Error> {
    Ok(())
}

pub fn set_run_in_background(enabled: bool) -> Result<(), Error> {
    background::set_run_in_background(enabled);
    Ok(())
}

pub fn take_mailto(app: &AppHandle) -> Option<MailtoDraft> {
    background::take_mailto(app)
}

pub fn take_launch_action() -> Option<serde_json::Value> {
    None
}

pub fn set_mobile_prefs(_language: String, _tone: String, _app_lock: bool) -> Result<(), Error> {
    Ok(())
}

pub fn set_system_bars(_dark: bool, _background: String) -> Result<(), Error> {
    Ok(())
}

pub fn mobile_action(_app: &AppHandle, _action: &str) -> Result<(), Error> {
    Ok(())
}

/// UnifiedPush is Android's; nothing to show here.
pub fn push_status() -> Result<Option<serde_json::Value>, Error> {
    Ok(None)
}

pub fn set_unified_push(_enabled: bool, _distributor: Option<String>) -> Result<Option<serde_json::Value>, Error> {
    Ok(None)
}

pub fn set_update_channel(app: &AppHandle, channel: Channel) {
    updates::set_channel(app, channel);
}

pub fn set_update_checks(app: &AppHandle, enabled: bool) {
    updates::set_automatic(app, enabled);
}

pub fn update_status(app: &AppHandle) -> Option<ReadyUpdate> {
    updates::ready(app)
}

pub async fn check_for_updates(app: &AppHandle) -> Result<Option<ReadyUpdate>, Error> {
    updates::check(app).await
}

pub async fn install_update(app: &AppHandle) -> Result<(), Error> {
    updates::install_now(app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_yes_button_counts_as_yes() {
        use rfd::MessageDialogResult as Answer;
        assert!(is_yes(&Answer::Custom("Open anyway".into()), "Open anyway"));
        assert!(!is_yes(&Answer::Custom("Don't open".into()), "Open anyway"));
        // A closed dialog or Escape.
        for closed in [Answer::Cancel, Answer::Ok, Answer::Yes, Answer::No] {
            assert!(!is_yes(&closed, "Open anyway"));
        }
    }
}
