mod background;
mod updates;

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::broadcast::error::RecvError;
use uwumail_core::attachments::AttachmentFile;
use uwumail_core::mailto::MailtoDraft;
use uwumail_core::model::*;
use uwumail_core::pictures::SenderPicture;
use uwumail_core::secrets::KeyringSecrets;
use uwumail_core::{Engine, EngineOptions, Error};

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
                    "„{}“ kann Programme auf deinem Rechner starten. Öffne die Datei nur, wenn du sie erwartet hast und dem Absender vertraust.",
                    file.filename
                ),
                "Trotzdem öffnen",
                "Nicht öffnen",
            )
        } else {
            (
                "This file can run programs",
                format!(
                    "“{}” can start programs on your computer. Only open it if you expected it and trust the sender.",
                    file.filename
                ),
                "Open anyway",
                "Don't open",
            )
        };
        let dialog = app
            .dialog()
            .message(text)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(open.into(), cancel.into()));
        let confirmed = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
            .await
            .map_err(|e| Error::internal(format!("The dialog failed: {e}")))?;
        if !confirmed {
            return Ok(false);
        }
    }
    app.opener()
        .open_path(file.path.to_string_lossy(), None::<&str>)
        .map_err(|e| Error::internal(format!("Couldn't open the attachment: {e}")))?;
    Ok(true)
}

/// Asks where to save an attachment and copies it there. The destination only
/// ever comes from the native save dialog, never from the web page.
#[tauri::command]
async fn save_attachment(app: AppHandle, engine: State<'_, Engine>, attachment_id: String) -> CommandResult<bool> {
    let file = engine.attachment(&attachment_id).await?;
    let dialog = app.dialog().file().set_file_name(uwumail_core::attachments::safe_filename(&file.filename));
    let destination = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|e| Error::internal(format!("The dialog failed: {e}")))?;
    let Some(destination) = destination.and_then(|path| path.into_path().ok()) else { return Ok(false) };
    engine.save_attachment(&attachment_id, &destination).await?;
    Ok(true)
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

#[tauri::command]
fn set_run_in_background(enabled: bool) {
    background::set_run_in_background(enabled);
}

/// The `mailto:` link UwUMail was opened with, once.
#[tauri::command]
fn take_mailto(app: AppHandle) -> Option<MailtoDraft> {
    background::take_mailto(&app)
}

#[tauri::command]
fn set_update_channel(app: AppHandle, channel: updates::Channel) {
    updates::set_channel(&app, channel);
}

/// A downloaded update waiting for a restart, if any.
#[tauri::command]
fn update_status(app: AppHandle) -> Option<updates::ReadyUpdate> {
    updates::ready(&app)
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> CommandResult<Option<updates::ReadyUpdate>> {
    updates::check(&app).await
}

#[tauri::command]
fn install_update(app: AppHandle) -> CommandResult<()> {
    updates::install_now(&app)
}

/// Sends engine events to the UI and rings for new mail while UwUMail is in the background.
fn forward(app: &AppHandle, engine: &Engine, event: EngineEvent) {
    if let EngineEvent::MailReceived { message_ids, .. } = &event {
        let focused = app.get_webview_window("main").and_then(|window| window.is_focused().ok()).unwrap_or(false);
        if !focused && let Ok(messages) = engine.messages(message_ids) {
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
    let _ = app.emit(event.name(), &event);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must come first, so a second start hands over before anything else runs.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| background::on_second_instance(app, args)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if updates::apply_pending_on_start(app.handle()) {
                // The downloaded setup replaces this version and starts UwUMail again.
                std::process::exit(0);
            }
            let data_dir = app.path().app_data_dir()?;
            let opener = app.handle().clone();
            let open_url = Arc::new(move |url: &str| {
                let _ = opener.opener().open_url(url, None::<&str>);
            });
            let engine = tauri::async_runtime::block_on(async move {
                Engine::new(EngineOptions { data_dir, secrets: Arc::new(KeyringSecrets), open_url })
            })?;
            engine.start()?;

            let handle = app.handle().clone();
            let forwarding = engine.clone();
            let mut events = engine.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    match events.recv().await {
                        Ok(event) => forward(&handle, &forwarding, event),
                        Err(RecvError::Lagged(_)) => continue,
                        Err(RecvError::Closed) => break,
                    }
                }
            });

            app.manage(engine);
            background::setup(app)?;
            updates::start(app.handle());
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
            set_update_channel,
            update_status,
            check_for_updates,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running UwUMail");
}
