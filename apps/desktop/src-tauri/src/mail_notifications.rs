//! Windows, macOS and Linux: one new-mail notification per account. Until UwUMail is looked at
//! again, every new mail replaces it with one about all of them ("3 new mails"), so mail that came
//! while the computer was locked doesn't pile up as one notification each. Each system gets the
//! replacing its own way: a toast tag on Windows, the delivered notification's identifier on
//! macOS, the id the notification server gave on Linux. Where that fails, the plugin shows it as
//! a new one.

use std::sync::{LazyLock, Mutex, PoisonError};

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use uwumail_core::notify::{MailLine, NotifiedMail, Unseen};

static UNSEEN: LazyLock<Mutex<Unseen>> = LazyLock::new(Mutex::default);

/// Counts `mails` (oldest first) in for `account_id`: how many are unseen, newest lines first.
pub fn add(account_id: &str, mails: &[NotifiedMail<'_>]) -> (usize, Vec<MailLine>) {
    UNSEEN.lock().unwrap_or_else(PoisonError::into_inner).add(account_id, mails)
}

/// UwUMail came on screen: the next mail starts counting anew (and, on Windows and macOS, takes
/// the place of the notification already read).
pub fn looked_at() {
    UNSEEN.lock().unwrap_or_else(PoisonError::into_inner).clear();
    #[cfg(target_os = "linux")]
    linux::forget();
}

/// Shows the notification of `account_id`, in place of the one it showed before.
pub fn show(app: &AppHandle, account_id: &str, title: String, body: String) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        match toast::show(&app.config().identifier, account_id, &title, &body) {
            Ok(()) => return,
            Err(error) => tracing::warn!("Couldn't replace the mail notification: {error}"),
        }
    }
    #[cfg(target_os = "linux")]
    {
        let account_id = account_id.to_string();
        let fallback = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = linux::show(&account_id, &title, &body) {
                tracing::warn!("Couldn't replace the mail notification: {error}");
                let _ = fallback.notification().builder().title(title).body(body).show();
            }
        });
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let (account_id, fallback) = (account_id.to_string(), app.clone());
        let (text_title, text_body) = (title.clone(), body.clone());
        let shown = app.run_on_main_thread(move || {
            if !macos::show(&account_id, &text_title, &text_body) {
                let _ = fallback.notification().builder().title(text_title).body(text_body).show();
            }
        });
        if shown.is_ok() {
            return;
        }
    }
    #[allow(unreachable_code)]
    let _ = app.notification().builder().title(title).body(body).show();
}

/// A short name for the account's notification that stays the same between starts and Rust
/// versions (FNV-1a); Windows takes at most 16 characters as a tag on older versions.
fn tag(account_id: &str) -> String {
    let hash = account_id
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3));
    format!("{hash:016x}")
}

#[cfg(windows)]
mod toast {
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    use windows::core::HSTRING;

    /// What the plugin (notify-rust) uses for a copy that wasn't installed: there is no app id
    /// of UwUMail's own then, and Windows only shows toasts of a known one.
    const POWERSHELL_APP_ID: &str = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
    const GROUP: &str = "mail";

    /// The app id as the plugin picks it: UwUMail's own when installed, else PowerShell's.
    fn app_id(identifier: &str) -> String {
        let installed = tauri::utils::platform::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
            .is_some_and(|dir| !(dir.ends_with("target\\debug") || dir.ends_with("target\\release")));
        if installed { identifier.to_string() } else { POWERSHELL_APP_ID.to_string() }
    }

    pub fn show(identifier: &str, account_id: &str, title: &str, body: &str) -> windows::core::Result<()> {
        // Title and at most two lines of text: the most a plain toast shows.
        let mut texts = format!("<text>{}</text>", escape(title));
        for line in body.lines().take(2) {
            texts.push_str(&format!("<text>{}</text>", escape(line)));
        }
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(format!(
            "<toast><visual><binding template=\"ToastGeneric\">{texts}</binding></visual></toast>"
        )))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        // A toast with the same tag and group takes the place of the earlier one, in the Action
        // Center too.
        toast.SetTag(&HSTRING::from(super::tag(account_id)))?;
        toast.SetGroup(&HSTRING::from(GROUP))?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id(identifier)))?.Show(&toast)
    }

    /// The toast is XML: a stranger's subject stays text.
    fn escape(text: &str) -> String {
        uwumail_core::notify::markup_escape(text)
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashMap;
    use std::sync::{Mutex, PoisonError};

    use zbus::zvariant::Value;

    /// The id the notification server gave each account's notification, to replace it.
    static SHOWN: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);
    /// One connection for as long as UwUMail runs: GNOME takes all of an app's notifications away
    /// once the connection that sent its first one is gone, and a connection per notification (as
    /// notify-rust, and so the plugin, opens one) is gone right after.
    static BUS: Mutex<Option<zbus::Connection>> = Mutex::new(None);

    pub fn forget() {
        *SHOWN.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    /// Blocks: call it off the async runtime.
    pub fn show(account_id: &str, title: &str, body: &str) -> zbus::Result<()> {
        let tag = super::tag(account_id);
        let earlier = SHOWN
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .and_then(|shown| shown.get(&tag).copied())
            .unwrap_or(0);
        let mut bus = BUS.lock().unwrap_or_else(PoisonError::into_inner);
        let connection = match bus.as_ref() {
            Some(connection) => connection.clone(),
            None => bus.insert(zbus::block_on(zbus::Connection::session())?).clone(),
        };
        drop(bus);
        // App name and icon as the plugin gives them, so the notifications look the same as before.
        let app = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.file_stem().map(|name| name.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "uwumail".to_string());
        let id: u32 = zbus::block_on(connection.call_method(
            Some("org.freedesktop.Notifications"),
            "/org/freedesktop/Notifications",
            Some("org.freedesktop.Notifications"),
            "Notify",
            &(&app, earlier, &app, title, body, Vec::<&str>::new(), HashMap::<&str, Value<'_>>::new(), -1_i32),
        ))?
        .body()
        .deserialize()?;
        SHOWN.lock().unwrap_or_else(PoisonError::into_inner).get_or_insert_default().insert(tag, id);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
mod macos {
    use objc2_foundation::{NSBundle, NSString, NSUserNotification, NSUserNotificationCenter};

    /// Delivers the notification with the account's identifier: macOS puts a notification in the
    /// place of a delivered one with the same identifier. Main thread only. `false` when it
    /// couldn't, as outside an app bundle.
    pub fn show(account_id: &str, title: &str, body: &str) -> bool {
        if NSBundle::mainBundle().bundleIdentifier().is_none() {
            return false;
        }
        let notification = NSUserNotification::new();
        notification.setTitle(Some(&NSString::from_str(title)));
        notification.setInformativeText(Some(&NSString::from_str(body)));
        notification.setIdentifier(Some(&NSString::from_str(&format!("mail-{}", super::tag(account_id)))));
        NSUserNotificationCenter::defaultUserNotificationCenter().deliverNotification(&notification);
        true
    }
}
