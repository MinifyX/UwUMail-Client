//! Running in the background: the tray icon, closing to the tray, starting
//! hidden with Windows, one instance at a time and `mailto:` links.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use uwumail_core::Engine;
use uwumail_core::mailto::{self, MailtoDraft};

/// Started by Windows at sign-in: stay in the tray until someone asks.
pub const AUTOSTART_FLAG: &str = "--autostart";

/// Whether closing the window keeps UwUMail running in the tray. The UI sets
/// this from its settings on start.
static RUN_IN_BACKGROUND: AtomicBool = AtomicBool::new(true);

/// A `mailto:` link waiting for the UI to pick it up.
#[derive(Default)]
pub struct PendingMailto(Mutex<Option<MailtoDraft>>);

pub fn set_run_in_background(enabled: bool) {
    RUN_IN_BACKGROUND.store(enabled, Ordering::Relaxed);
}

pub fn take_mailto(app: &AppHandle) -> Option<MailtoDraft> {
    app.state::<PendingMailto>().0.lock().unwrap().take()
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Hands a `mailto:` link to the UI, which opens a draft.
fn deliver_mailto(app: &AppHandle, draft: MailtoDraft) {
    *app.state::<PendingMailto>().0.lock().unwrap() = Some(draft);
    show_main_window(app);
    let _ = app.emit("compose:mailto", ());
}

/// A link macOS handed over before the window was set up, e.g. the one UwUMail was started for.
#[cfg(target_os = "macos")]
static EARLY_MAILTO: Mutex<Option<MailtoDraft>> = Mutex::new(None);

/// macOS: links opened with UwUMail, such as a clicked `mailto:` link.
#[cfg(target_os = "macos")]
pub fn on_opened<'a>(app: &AppHandle, urls: impl IntoIterator<Item = &'a str>) {
    let Some(draft) = mailto::from_args(urls) else { return };
    if app.try_state::<PendingMailto>().is_some() {
        deliver_mailto(app, draft);
    } else {
        *EARLY_MAILTO.lock().unwrap() = Some(draft);
    }
}

/// Called in the first instance when UwUMail is started again, e.g. from a
/// shortcut or by clicking a `mailto:` link.
pub fn on_second_instance(app: &AppHandle, args: Vec<String>) {
    match mailto::from_args(&args) {
        Some(draft) => deliver_mailto(app, draft),
        None if !args.iter().any(|arg| arg == AUTOSTART_FLAG) => show_main_window(app),
        None => {}
    }
}

struct Labels {
    open: &'static str,
    sync: &'static str,
    quit: &'static str,
}

fn labels() -> Labels {
    let german = sys_locale::get_locale().is_some_and(|locale| locale.to_ascii_lowercase().starts_with("de"));
    if german {
        Labels { open: "UwUMail öffnen", sync: "Nach neuen Mails sehen", quit: "UwUMail beenden" }
    } else {
        Labels { open: "Open UwUMail", sync: "Check for new mail", quit: "Quit UwUMail" }
    }
}

pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    app.manage(PendingMailto::default());
    let args: Vec<String> = std::env::args().collect();
    if let Some(draft) = mailto::from_args(&args) {
        *app.state::<PendingMailto>().0.lock().unwrap() = Some(draft);
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(draft) = EARLY_MAILTO.lock().unwrap().take() {
            *app.state::<PendingMailto>().0.lock().unwrap() = Some(draft);
        }
    }

    let labels = labels();
    let open = MenuItem::with_id(app, "open", labels.open, true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", labels.sync, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", labels.quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &sync, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("UwUMail")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "sync" => app.state::<Engine>().sync_now(None),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    if let Some(window) = app.get_webview_window("main") {
        let hidden = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && RUN_IN_BACKGROUND.load(Ordering::Relaxed)
            {
                api.prevent_close();
                let _ = hidden.hide();
            }
        });
        if !args.iter().any(|arg| arg == AUTOSTART_FLAG) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    Ok(())
}
