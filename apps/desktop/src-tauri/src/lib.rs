#[cfg(desktop)]
mod background;
#[cfg(desktop)]
mod updates;

/// What differs between desktop, Android and iOS, behind the same functions.
#[cfg_attr(desktop, path = "desktop.rs")]
#[cfg_attr(target_os = "android", path = "android.rs")]
#[cfg_attr(target_os = "ios", path = "ios.rs")]
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
fn list_signatures(engine: State<'_, Engine>) -> CommandResult<Vec<Signature>> {
    engine.list_signatures()
}

#[tauri::command]
fn save_signature(engine: State<'_, Engine>, signature: Signature) -> CommandResult<Signature> {
    engine.save_signature(signature)
}

#[tauri::command]
fn delete_signature(engine: State<'_, Engine>, signature_id: String) -> CommandResult<()> {
    engine.delete_signature(&signature_id)
}

#[tauri::command]
fn list_identities(engine: State<'_, Engine>) -> CommandResult<Vec<Identity>> {
    engine.list_identities()
}

#[tauri::command]
fn add_identity(engine: State<'_, Engine>, account_id: String, email: String, name: String) -> CommandResult<Identity> {
    engine.add_identity(&account_id, &email, &name)
}

#[tauri::command]
fn rename_identity(engine: State<'_, Engine>, identity_id: String, name: String) -> CommandResult<()> {
    engine.rename_identity(&identity_id, &name)
}

#[tauri::command]
fn remove_identity(engine: State<'_, Engine>, identity_id: String) -> CommandResult<()> {
    engine.remove_identity(&identity_id)
}

#[tauri::command]
async fn discover_settings(engine: State<'_, Engine>, email: String) -> CommandResult<DiscoveredSettings> {
    engine.discover_settings(&email).await
}

#[tauri::command]
fn microsoft_admin_consent_url(engine: State<'_, Engine>, email: String) -> CommandResult<String> {
    engine.microsoft_admin_consent_url(&email)
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
async fn archive_messages(engine: State<'_, Engine>, message_ids: Vec<String>) -> CommandResult<Vec<MovedMessage>> {
    engine.archive(&message_ids).await
}

#[tauri::command]
async fn trash_messages(engine: State<'_, Engine>, message_ids: Vec<String>) -> CommandResult<Vec<MovedMessage>> {
    engine.trash(&message_ids).await
}

#[tauri::command]
async fn delete_messages_forever(engine: State<'_, Engine>, message_ids: Vec<String>) -> CommandResult<usize> {
    engine.delete_forever(&message_ids).await
}

#[tauri::command]
async fn move_messages(
    engine: State<'_, Engine>,
    message_ids: Vec<String>,
    folder_id: String,
) -> CommandResult<Vec<MovedMessage>> {
    engine.move_messages(&message_ids, &folder_id).await
}

#[tauri::command]
async fn mark_spam(
    engine: State<'_, Engine>,
    message_ids: Vec<String>,
    spam: bool,
) -> CommandResult<Vec<MovedMessage>> {
    engine.mark_spam(&message_ids, spam).await
}

#[tauri::command]
async fn unsubscribe(engine: State<'_, Engine>, message_id: String) -> CommandResult<UnsubscribeOutcome> {
    engine.unsubscribe(&message_id).await
}

#[tauri::command]
fn inbox_messages_from(engine: State<'_, Engine>, email: String) -> CommandResult<Vec<String>> {
    engine.inbox_messages_from(&email)
}

#[tauri::command]
async fn blocked_senders(engine: State<'_, Engine>) -> CommandResult<Vec<BlockedSender>> {
    engine.blocked_senders().await
}

#[tauri::command]
async fn block_sender(
    engine: State<'_, Engine>,
    entry: String,
    account_id: Option<String>,
) -> CommandResult<BlockedSender> {
    engine.block_sender(&entry, account_id.as_deref()).await
}

#[tauri::command]
async fn unblock_sender(engine: State<'_, Engine>, sender: BlockedSender) -> CommandResult<()> {
    engine.unblock_sender(&sender).await
}

#[tauri::command]
async fn send_message(engine: State<'_, Engine>, message: OutgoingMessage) -> CommandResult<()> {
    engine.send(message).await
}

#[tauri::command]
fn queue_send(engine: State<'_, Engine>, message: OutgoingMessage, delay_seconds: u64) -> CommandResult<QueuedSend> {
    engine.queue_send(message, delay_seconds)
}

#[tauri::command]
fn cancel_send(engine: State<'_, Engine>, send_id: String) -> CommandResult<OutgoingMessage> {
    engine.cancel_send(&send_id)
}

#[tauri::command]
async fn save_draft(engine: State<'_, Engine>, draft: OutgoingMessage) -> CommandResult<SavedDraft> {
    engine.save_draft(draft).await
}

#[tauri::command]
async fn delete_draft(engine: State<'_, Engine>, account_id: String, draft_key: String) -> CommandResult<()> {
    engine.delete_draft(&account_id, &draft_key).await
}

#[tauri::command]
async fn open_draft(engine: State<'_, Engine>, message_id: String) -> CommandResult<DraftContent> {
    engine.open_draft(&message_id).await
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
    platform::check_openable(&file)?;
    if file.dangerous {
        // Names saved by older versions may still carry line breaks that could reword the dialog.
        let name = uwumail_core::attachments::clean_display_name(&file.filename);
        let (title, text, open, cancel) = if german() {
            (
                "Diese Datei kann Programme ausführen",
                format!(
                    "„{}“ kann Programme auf deinem Gerät starten. Öffne die Datei nur, wenn du sie erwartet hast und dem Absender vertraust.",
                    name
                ),
                "Trotzdem öffnen",
                "Nicht öffnen",
            )
        } else {
            (
                "This file can run programs",
                format!(
                    "“{}” can start programs on your device. Only open it if you expected it and trust the sender.",
                    name
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
    platform::save_file(&app, &file).await
}

/// Saves a whole mail as an .eml file where the user picks (Downloads on Android).
/// Returns false when the user cancelled.
#[tauri::command]
async fn save_message(app: AppHandle, engine: State<'_, Engine>, message_id: String) -> CommandResult<bool> {
    let file = engine.message_file(&message_id).await?;
    platform::save_file(&app, &file).await
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

/// Android: language and tone for notifications shown while no window is open,
/// and whether the app lock is on (notifications without content, no Recents preview).
#[tauri::command]
fn set_mobile_prefs(language: String, tone: String, app_lock: bool) -> CommandResult<()> {
    platform::set_mobile_prefs(language, tone, app_lock)
}

/// Android: colors behind the status and navigation bars.
#[tauri::command]
fn set_system_bars(dark: bool, background: String) -> CommandResult<()> {
    platform::set_system_bars(dark, background)
}

/// Phones: `requestNotifications`, `uiReady` or `watchSettings`.
#[tauri::command]
fn mobile_action(app: AppHandle, action: String) -> CommandResult<()> {
    platform::mobile_action(&app, &action)
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
            list_identities,
            list_signatures,
            save_signature,
            delete_signature,
            add_identity,
            rename_identity,
            remove_identity,
            discover_settings,
            microsoft_admin_consent_url,
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
            delete_messages_forever,
            move_messages,
            mark_spam,
            blocked_senders,
            unsubscribe,
            inbox_messages_from,
            block_sender,
            unblock_sender,
            send_message,
            queue_send,
            cancel_send,
            save_draft,
            delete_draft,
            open_draft,
            search_contacts,
            get_attachment,
            open_attachment,
            save_attachment,
            save_message,
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
