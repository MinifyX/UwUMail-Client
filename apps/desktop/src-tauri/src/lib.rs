#[cfg(desktop)]
mod background;
#[cfg(desktop)]
mod updates;

/// What differs between desktop and Android, behind the same functions.
#[cfg_attr(desktop, path = "desktop.rs")]
#[cfg_attr(target_os = "android", path = "android.rs")]
mod platform;

use platform::{Channel, ReadyUpdate};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::broadcast::error::RecvError;
use uwumail_core::attachments::AttachmentFile;
use uwumail_core::mailto::MailtoDraft;
use uwumail_core::model::*;
use uwumail_core::pictures::SenderPicture;
use uwumail_core::{Engine, Error};

type CommandResult<T> = Result<T, Error>;

#[tauri::command]
fn list_accounts(engine: State<'_, Engine>) -> CommandResult<Vec<Account>> {
    engine.list_accounts()
}

#[tauri::command]
async fn discover_settings(engine: State<'_, Engine>, email: String) -> CommandResult<DiscoveredSettings> {
    engine.discover_settings(&email).await
}

#[tauri::command]
async fn add_account(engine: State<'_, Engine>, account: NewAccount) -> CommandResult<Account> {
    engine.add_account(account).await
}

#[tauri::command]
async fn remove_account(engine: State<'_, Engine>, account_id: String) -> CommandResult<()> {
    engine.remove_account(&account_id).await
}

#[tauri::command]
async fn set_account_protocol(
    engine: State<'_, Engine>,
    account_id: String,
    protocol: Protocol,
) -> CommandResult<Account> {
    engine.set_protocol(&account_id, protocol).await
}

#[tauri::command]
fn sync_now(engine: State<'_, Engine>, account_id: Option<String>) -> CommandResult<()> {
    engine.sync_now(account_id.as_deref());
    Ok(())
}

#[tauri::command]
fn list_folders(engine: State<'_, Engine>, account_id: Option<String>) -> CommandResult<Vec<Folder>> {
    engine.list_folders(account_id.as_deref())
}

#[tauri::command]
fn list_threads(engine: State<'_, Engine>, query: ThreadQuery) -> CommandResult<ThreadPage> {
    engine.list_threads(&query)
}

/// Searches on the servers too, including mail that was never downloaded.
#[tauri::command]
async fn search_server(engine: State<'_, Engine>, query: ThreadQuery) -> CommandResult<ThreadPage> {
    engine.search_server(&query).await
}

/// How many days of mail stay complete on this device; `None` keeps everything.
#[tauri::command]
fn set_offline_days(engine: State<'_, Engine>, days: Option<u32>) -> CommandResult<()> {
    engine.set_offline_days(days)?;
    platform::remember_offline_days(days)
}

#[tauri::command]
async fn get_thread(engine: State<'_, Engine>, thread_id: String, conversations: bool) -> CommandResult<ThreadDetail> {
    engine.get_thread(&thread_id, conversations).await
}

#[tauri::command]
async fn set_flags(engine: State<'_, Engine>, message_ids: Vec<String>, change: FlagChange) -> CommandResult<()> {
    engine.set_flags(&message_ids, change).await
}

#[tauri::command]
async fn archive_messages(engine: State<'_, Engine>, message_ids: Vec<String>) -> CommandResult<()> {
    engine.archive(&message_ids).await
}

#[tauri::command]
async fn trash_messages(engine: State<'_, Engine>, message_ids: Vec<String>) -> CommandResult<()> {
    engine.trash(&message_ids).await
}

#[tauri::command]
async fn send_message(engine: State<'_, Engine>, message: OutgoingMessage) -> CommandResult<()> {
    engine.send(message).await
}

#[tauri::command]
fn search_contacts(engine: State<'_, Engine>, query: String) -> CommandResult<Vec<Contact>> {
    engine.search_contacts(&query)
}

#[tauri::command]
async fn get_attachment(engine: State<'_, Engine>, attachment_id: String) -> CommandResult<AttachmentFile> {
    engine.attachment(&attachment_id).await
}

fn german() -> bool {
    sys_locale::get_locale().is_some_and(|locale| locale.to_ascii_lowercase().starts_with("de"))
}

/// Opens an attachment in its default app. Returns false when the user cancelled.
///
/// Files that can run programs are confirmed in a native dialog shown from
/// here, so nothing in the web page can skip that question.
#[tauri::command]
async fn open_attachment(app: AppHandle, engine: State<'_, Engine>, attachment_id: String) -> CommandResult<bool> {
    let file = engine.attachment(&attachment_id).await?;
    if file.dangerous {
        let (title, text, open, cancel) = if german() {
            (
                "Diese Datei kann Programme ausführen",
                format!(
                    "„{}“ kann Programme auf deinem Gerät starten. Öffne die Datei nur, wenn du sie erwartet hast und dem Absender vertraust.",
                    file.filename
                ),
                "Trotzdem öffnen",
                "Nicht öffnen",
            )
        } else {
            (
                "This file can run programs",
                format!(
                    "“{}” can start programs on your device. Only open it if you expected it and trust the sender.",
                    file.filename
                ),
                "Open anyway",
                "Don't open",
            )
        };
        if !platform::confirm(&app, title, text, open, cancel).await? {
            return Ok(false);
        }
    }
    platform::open_file(&app, &file)?;
    Ok(true)
}

/// Saves an attachment. The destination never comes from the web page: on
/// desktop from the native save dialog, on Android it's Downloads/UwUMail.
/// Returns false when the user cancelled.
#[tauri::command]
async fn save_attachment(app: AppHandle, engine: State<'_, Engine>, attachment_id: String) -> CommandResult<bool> {
    let file = engine.attachment(&attachment_id).await?;
    platform::save_file(&app, &engine, &attachment_id, &file).await
}

#[tauri::command]
async fn get_sender_picture(engine: State<'_, Engine>, email: String) -> CommandResult<Option<SenderPicture>> {
    engine.sender_picture(&email).await
}

#[tauri::command]
fn clear_sender_pictures(engine: State<'_, Engine>) -> CommandResult<()> {
    engine.clear_sender_pictures()
}

/// The main domain of a company address, or `None` for mail providers.
#[tauri::command]
fn get_company_domain(email: String) -> Option<String> {
    uwumail_core::pictures::picture_domain(&email)
}

/// Desktop: closing the window keeps UwUMail in the tray.
/// Android: stay connected in the background for instant new mail.
#[tauri::command]
fn set_run_in_background(enabled: bool) -> CommandResult<()> {
    platform::set_run_in_background(enabled)
}

/// The `mailto:` link UwUMail was opened with, once.
#[tauri::command]
fn take_mailto(app: AppHandle) -> Option<MailtoDraft> {
    platform::take_mailto(&app)
}

/// Android: a share, `mailto:` link or tapped notification waiting for the UI, once.
#[tauri::command]
fn take_launch_action() -> Option<serde_json::Value> {
    platform::take_launch_action()
}

/// Android: language and tone for notifications shown while no window is open.
#[tauri::command]
fn set_mobile_prefs(language: String, tone: String) -> CommandResult<()> {
    platform::set_mobile_prefs(language, tone)
}

/// Android: colors behind the status and navigation bars.
#[tauri::command]
fn set_system_bars(dark: bool, background: String) -> CommandResult<()> {
    platform::set_system_bars(dark, background)
}

/// Android: `requestNotifications`, `uiReady` or `watchSettings`.
#[tauri::command]
fn mobile_action(action: String) -> CommandResult<()> {
    platform::mobile_action(&action)
}

#[tauri::command]
fn set_update_channel(app: AppHandle, channel: Channel) {
    platform::set_update_channel(&app, channel);
}

/// A downloaded update waiting for a restart, if any.
#[tauri::command]
fn update_status(app: AppHandle) -> Option<ReadyUpdate> {
    platform::update_status(&app)
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> CommandResult<Option<ReadyUpdate>> {
    platform::check_for_updates(&app).await
}

#[tauri::command]
fn install_update(app: AppHandle) -> CommandResult<()> {
    platform::install_update(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    platform::before_start();

    let app = platform::plugins(tauri::Builder::default())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let engine = platform::start_engine(app)?;

            let handle = app.handle().clone();
            let forwarding = engine.clone();
            let mut events = engine.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    match events.recv().await {
                        Ok(event) => {
                            platform::on_engine_event(&handle, &forwarding, &event);
                            let _ = handle.emit(event.name(), &event);
                        }
                        Err(RecvError::Lagged(_)) => continue,
                        Err(RecvError::Closed) => break,
                    }
                }
            });

            app.manage(engine);
            platform::after_start(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_accounts,
            discover_settings,
            add_account,
            remove_account,
            set_account_protocol,
            sync_now,
            list_folders,
            list_threads,
            search_server,
            set_offline_days,
            get_thread,
            set_flags,
            archive_messages,
            trash_messages,
            send_message,
            search_contacts,
            get_attachment,
            open_attachment,
            save_attachment,
            get_sender_picture,
            clear_sender_pictures,
            get_company_domain,
            set_run_in_background,
            take_mailto,
            take_launch_action,
            set_mobile_prefs,
            set_system_bars,
            mobile_action,
            set_update_channel,
            update_status,
            check_for_updates,
            install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building UwUMail");

    app.run(platform::on_run_event);
}
