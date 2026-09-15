//! Android: the engine already runs for the whole process (crates/uwumail-android),
//! the window borrows it. Notifications, files and updates go through Kotlin.

use serde_json::json;
use tauri::{App, AppHandle, Emitter, Manager, RunEvent, Runtime, Wry};
use uwumail_android::jni::JNIEnv;
use uwumail_android::jni::objects::{JClass, JObject, JString};
use uwumail_android::jni::sys::jstring;
use uwumail_core::attachments::AttachmentFile;
use uwumail_core::mailto::MailtoDraft;
use uwumail_core::model::EngineEvent;
use uwumail_core::{Engine, Error};

pub use uwumail_android::updates::{self, Channel, ReadyUpdate};

/// `UwuNative.start`, called from `UwuApplication.onCreate`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_uwumail_UwuNative_start(
    env: JNIEnv,
    _class: JClass,
    context: JObject,
    bridge: JClass,
    data_dir: JString,
    cache_dir: JString,
) {
    uwumail_android::native::start(env, context, bridge, data_dir, cache_dir);
}

/// `UwuNative.call`, from notifications, shares and the network watcher.
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_uwumail_UwuNative_call(
    env: JNIEnv,
    _class: JClass,
    method: JString,
    payload: JString,
) -> jstring {
    uwumail_android::native::call(env, method, payload)
}

pub fn before_start() {
    // Tauri joins the runtime the engine already uses.
    tauri::async_runtime::set(uwumail_android::runtime().handle().clone());
}

pub fn plugins(builder: tauri::Builder<Wry>) -> tauri::Builder<Wry> {
    builder.plugin(tauri_plugin_biometric::init()).plugin(tauri_plugin_haptics::init())
}

pub fn start_engine(app: &mut App) -> Result<Engine, Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    uwumail_android::launch::on_action(move || {
        let _ = handle.emit("launch:action", ());
    });
    let handle = app.handle().clone();
    updates::start(move |update| {
        let _ = handle.emit("update:ready", update);
    });
    let data_dir = app.path().app_data_dir()?;
    let cache_dir = app.path().app_cache_dir()?;
    Ok(uwumail_android::engine_for_window(data_dir, cache_dir)?)
}

pub fn after_start(_app: &mut App) -> tauri::Result<()> {
    Ok(())
}

/// New mail notifications come from the engine itself, also without a window.
pub fn on_engine_event(_app: &AppHandle, _engine: &Engine, _event: &EngineEvent) {}

pub fn on_run_event<R: Runtime>(_app: &AppHandle<R>, event: RunEvent) {
    // Android closes the window while the mail service keeps running; that
    // must not end the process.
    if let RunEvent::ExitRequested { api, code: None, .. } = event {
        api.prevent_exit();
    }
}

fn call(method: &str, payload: serde_json::Value) -> Result<Option<String>, Error> {
    uwumail_android::call(method, &payload)
}

/// App packages from mail never go to Android's installer, whatever the mail
/// claims the file is. Saving them to Downloads still works.
pub fn check_openable(file: &AttachmentFile) -> Result<(), Error> {
    if uwumail_core::attachments::is_app_package(&file.filename)
        || file.mime_type.eq_ignore_ascii_case("application/vnd.android.package-archive")
    {
        return Err(Error::invalid(
            "UwUMail doesn't open app packages from mails. Save the file if you expected it and trust the sender.",
        ));
    }
    Ok(())
}

pub fn open_file(_app: &AppHandle, file: &AttachmentFile) -> Result<(), Error> {
    call("openFile", json!({ "path": file.path, "filename": file.filename, "mimeType": file.mime_type }))?;
    Ok(())
}

/// An Android dialog, answered by the person, not by the web page.
pub async fn confirm(_app: &AppHandle, title: &str, text: String, ok: &str, cancel: &str) -> Result<bool, Error> {
    let payload = json!({ "title": title, "message": text, "ok": ok, "cancel": cancel });
    // Kotlin waits for the tap, so keep that off the async threads.
    let answer = tauri::async_runtime::spawn_blocking(move || call("confirm", payload))
        .await
        .map_err(|e| Error::internal(format!("The dialog failed: {e}")))??;
    Ok(answer.as_deref() == Some("true"))
}

/// Saves into Downloads/UwUMail; there is no save dialog on Android.
pub async fn save_file(
    _app: &AppHandle,
    _engine: &Engine,
    _attachment_id: &str,
    file: &AttachmentFile,
) -> Result<bool, Error> {
    call("saveToDownloads", json!({ "path": file.path, "filename": file.filename, "mimeType": file.mime_type }))?;
    Ok(true)
}

/// Kept on the Android side too, so the engine starts with it before any window.
pub fn remember_offline_days(days: Option<u32>) -> Result<(), Error> {
    call("setPrefs", json!({ "offlineDays": days.unwrap_or(0) }))?;
    Ok(())
}

pub fn set_run_in_background(enabled: bool) -> Result<(), Error> {
    call("setPrefs", json!({ "backgroundPush": enabled }))?;
    Ok(())
}

pub fn take_mailto(_app: &AppHandle) -> Option<MailtoDraft> {
    None
}

pub fn take_launch_action() -> Option<serde_json::Value> {
    uwumail_android::launch::take().and_then(|action| serde_json::to_value(action).ok())
}

pub fn set_mobile_prefs(language: String, tone: String, app_lock: bool) -> Result<(), Error> {
    call("setPrefs", json!({ "language": language, "tone": tone, "appLock": app_lock }))?;
    Ok(())
}

pub fn set_system_bars(dark: bool, background: String) -> Result<(), Error> {
    call("setSystemBars", json!({ "dark": dark, "background": background }))?;
    Ok(())
}

pub fn mobile_action(action: &str) -> Result<(), Error> {
    if !["requestNotifications", "uiReady", "watchSettings"].contains(&action) {
        return Err(Error::invalid("Unknown action"));
    }
    call(action, json!({}))?;
    Ok(())
}

pub fn set_update_channel(_app: &AppHandle, channel: Channel) {
    updates::set_channel(channel);
}

pub fn update_status(_app: &AppHandle) -> Option<ReadyUpdate> {
    updates::ready()
}

pub async fn check_for_updates(_app: &AppHandle) -> Result<Option<ReadyUpdate>, Error> {
    updates::check().await
}

pub fn install_update(_app: &AppHandle) -> Result<(), Error> {
    updates::install_now()
}
