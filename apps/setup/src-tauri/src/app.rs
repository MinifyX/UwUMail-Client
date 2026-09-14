//! The setup window and the commands its page calls.
//!
//! Started plainly it installs (or reinstalls). `--update [--relaunch]
//! [--wait-pid <pid>]` is how UwUMail hands over to a downloaded update, and
//! `--uninstall` comes from Windows' "Installed apps" list.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

use crate::install::{self, APP_EXE, Installed, Layout, Options, Step};
use crate::system;

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone)]
enum Mode {
    Install,
    Update { relaunch: bool, wait_pid: Option<u32> },
    Uninstall { dir: Option<PathBuf>, from_temp: bool },
}

fn parse_mode(args: &[String]) -> Mode {
    let value_after = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    if args.iter().any(|a| a == "--uninstall") {
        Mode::Uninstall {
            dir: value_after("--dir").map(PathBuf::from),
            from_temp: args.iter().any(|a| a == "--from-temp"),
        }
    } else if args.iter().any(|a| a == "--update") {
        Mode::Update {
            relaunch: args.iter().any(|a| a == "--relaunch"),
            wait_pid: value_after("--wait-pid").and_then(|pid| pid.parse().ok()),
        }
    } else {
        Mode::Install
    }
}

struct Setup {
    layout: Layout,
    mode: Mode,
    /// Where the uninstaller removes UwUMail from.
    uninstall_dir: Option<PathBuf>,
    busy: Mutex<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Info {
    mode: &'static str,
    version: &'static str,
    installed: Option<Installed>,
    options: Options,
    app_running: bool,
    has_payload: bool,
    sandbox: bool,
    /// Update mode: start UwUMail again when done.
    relaunch: bool,
}

#[derive(Clone, Serialize)]
struct ProgressEvent {
    step: Step,
    /// 0 to 1 over the whole job.
    overall: f64,
}

fn current_dir(setup: &Setup) -> PathBuf {
    match &setup.mode {
        Mode::Uninstall { .. } => setup.uninstall_dir.clone().unwrap_or_default(),
        _ => PathBuf::from(setup.layout.remembered_options().dir),
    }
}

#[tauri::command]
fn info(setup: State<'_, Setup>) -> Info {
    let options = setup.layout.remembered_options();
    Info {
        mode: match setup.mode {
            Mode::Install => "install",
            Mode::Update { .. } => "update",
            Mode::Uninstall { .. } => "uninstall",
        },
        version: VERSION,
        installed: setup.layout.installed(),
        app_running: install::app_running(&setup.layout, &current_dir(&setup)),
        options,
        has_payload: install::has_payload(),
        sandbox: setup.layout.sandbox,
        relaunch: matches!(setup.mode, Mode::Update { relaunch: true, .. }),
    }
}

/// Lets the user pick a folder; UwUMail goes into a "UwUMail" folder inside it.
#[tauri::command]
async fn pick_folder(app: AppHandle, current: String) -> Option<String> {
    let start = Path::new(&current).parent().map(Path::to_path_buf).unwrap_or_default();
    let picked = app.dialog().file().set_directory(start).blocking_pick_folder()?;
    let mut path = picked.into_path().ok()?;
    if !path.file_name().is_some_and(|name| name.eq_ignore_ascii_case("UwUMail")) {
        path.push("UwUMail");
    }
    Some(path.display().to_string())
}

#[tauri::command]
async fn close_app(app: AppHandle) -> Result<(), String> {
    let setup = app.state::<Setup>();
    install::stop_app(&setup.layout, &current_dir(&setup))
}

/// Turns step-local progress into one smooth 0..1 value and sends it to the page.
fn reporter(app: &AppHandle, weights: &'static [(Step, f64)]) -> impl FnMut(Step, f64) {
    let app = app.clone();
    let mut last = -1.0;
    move |step, fraction| {
        let mut overall = 0.0;
        for (candidate, weight) in weights {
            if *candidate == step {
                overall += weight * fraction.clamp(0.0, 1.0);
                break;
            }
            overall += weight;
        }
        let overall = if step == Step::Done { 1.0 } else { overall.min(0.99) };
        if overall - last >= 0.01 || step == Step::Done {
            last = overall;
            let _ = app.emit("setup:progress", ProgressEvent { step, overall });
        }
    }
}

fn guard(setup: &Setup) -> Result<BusyGuard<'_>, String> {
    let mut busy = setup.busy.lock().unwrap();
    if *busy {
        return Err("Setup is already working.".into());
    }
    *busy = true;
    Ok(BusyGuard(&setup.busy))
}

struct BusyGuard<'a>(&'a Mutex<bool>);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        *self.0.lock().unwrap() = false;
    }
}

#[tauri::command]
async fn install(app: AppHandle, options: Options) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let setup = app.state::<Setup>();
        let _busy = guard(&setup)?;
        if let Mode::Update { wait_pid, .. } = setup.mode {
            install::check_not_older(setup.layout.installed().and_then(|i| i.version).as_deref(), VERSION)?;
            if let Some(pid) = wait_pid {
                system::wait_for_exit(pid, Duration::from_secs(15));
            }
        }
        const WEIGHTS: &[(Step, f64)] =
            &[(Step::Prepare, 0.08), (Step::Copy, 0.72), (Step::Shortcuts, 0.08), (Step::Register, 0.12)];
        let mut progress = reporter(&app, WEIGHTS);
        install::install(&setup.layout, &options, VERSION, &mut progress)
    })
    .await
    .map_err(|e| format!("Setup stopped unexpectedly: {e}"))?
}

#[tauri::command]
async fn uninstall(app: AppHandle, keep_data: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let setup = app.state::<Setup>();
        let _busy = guard(&setup)?;
        let dir = current_dir(&setup);
        const WEIGHTS: &[(Step, f64)] = &[
            (Step::Prepare, 0.15),
            (Step::Shortcuts, 0.1),
            (Step::Register, 0.15),
            (Step::Copy, 0.3),
            (Step::Cleanup, 0.3),
        ];
        let mut progress = reporter(&app, WEIGHTS);
        install::uninstall(&setup.layout, &dir, keep_data, &mut progress)
    })
    .await
    .map_err(|e| format!("Setup stopped unexpectedly: {e}"))?
}

#[tauri::command]
fn launch_app(setup: State<'_, Setup>) -> Result<(), String> {
    let app = current_dir(&setup).join(APP_EXE);
    if setup.layout.sandbox {
        return Ok(());
    }
    system::spawn_detached(&app, &[])
}

#[tauri::command]
fn open_default_apps(setup: State<'_, Setup>) {
    install::open_default_apps(&setup.layout);
}

#[tauri::command]
fn finish(app: AppHandle) {
    let setup = app.state::<Setup>();
    if let Mode::Uninstall { from_temp: true, .. } = setup.mode
        && let Ok(me) = std::env::current_exe()
    {
        system::delete_after_exit(&me);
    }
    app.exit(0);
}

pub fn run() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = parse_mode(&args);
    let layout = Layout::detect();

    let uninstall_dir = match &mode {
        Mode::Uninstall { dir, .. } => dir
            .clone()
            .or_else(|| layout.installed().map(|installed| PathBuf::from(installed.dir)))
            .or_else(|| std::env::current_exe().ok().and_then(|me| me.parent().map(Path::to_path_buf))),
        _ => None,
    };

    // Windows can't delete a running program, so the uninstaller works from a
    // copy in the temp folder that removes itself at the end.
    if let (Mode::Uninstall { from_temp: false, .. }, Some(dir)) = (&mode, &uninstall_dir)
        && let Ok(me) = std::env::current_exe()
    {
        let copy = std::env::temp_dir().join(format!("UwUMail-Uninstall-{}.exe", std::process::id()));
        if std::fs::copy(&me, &copy).is_ok() {
            let dir = dir.display().to_string();
            if system::spawn_detached(&copy, &["--uninstall", "--from-temp", "--dir", &dir]).is_ok() {
                return;
            }
        }
    }

    if !system::webview2_installed() {
        let (title, text) = if system_is_german() {
            (
                "UwUMail Setup",
                "UwUMail braucht Microsoft Edge WebView2. Soll es jetzt heruntergeladen und installiert werden?",
            )
        } else {
            ("UwUMail Setup", "UwUMail needs Microsoft Edge WebView2. Download and install it now?")
        };
        if !system::ask(title, text) {
            return;
        }
        if let Err(error) = system::install_webview2() {
            system::alert(title, &error);
            return;
        }
    }

    let setup = Setup { layout, mode, uninstall_dir, busy: Mutex::new(false) };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(setup)
        .setup(|app| {
            // The page's own browser data goes to the temp folder, not next to UwUMail's.
            let data = std::env::temp_dir().join("UwUMail-Setup-WebView");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("UwUMail Setup")
                .inner_size(460.0, 640.0)
                .resizable(false)
                .maximizable(false)
                .decorations(false)
                .shadow(true)
                .center()
                .data_directory(data)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            info,
            pick_folder,
            close_app,
            install,
            uninstall,
            launch_app,
            open_default_apps,
            finish
        ])
        .run(tauri::generate_context!())
        .expect("error while running UwUMail Setup");
}

fn system_is_german() -> bool {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Control Panel\International")
        .and_then(|key| key.get_value::<String, _>("LocaleName"))
        .is_ok_and(|locale| locale.to_ascii_lowercase().starts_with("de"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_modes() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(matches!(parse_mode(&args(&[])), Mode::Install));
        assert!(matches!(
            parse_mode(&args(&["--update", "--relaunch", "--wait-pid", "42"])),
            Mode::Update { relaunch: true, wait_pid: Some(42) }
        ));
        assert!(matches!(
            parse_mode(&args(&["--uninstall", "--from-temp", "--dir", r"C:\Apps\UwUMail"])),
            Mode::Uninstall { from_temp: true, dir: Some(_) }
        ));
    }
}
