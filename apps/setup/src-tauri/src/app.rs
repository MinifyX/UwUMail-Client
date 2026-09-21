//! The setup window and the commands its page calls.
//!
//! Started plainly it installs (or reinstalls). `--update [--relaunch]
//! [--wait-pid <pid>]` is how UwUMail hands over to a downloaded update, and
//! `--uninstall` comes from Windows' "Installed apps" list (or from the
//! setup's own page on macOS and Linux).
//!
//! `--silent` does the same without a window, for scripts and CI: it installs
//! (`--autostart`, `--default-mail-app`, `--desktop-shortcut` switch those on),
//! updates with `--update`, or removes with `--uninstall` (`--delete-data`
//! also deletes mail and settings). It prints what it did and exits with 1 on
//! failure.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::install::{self, Installed, Layout, Options, Step};
use crate::system;

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(windows)]
const PLATFORM: &str = "windows";
#[cfg(target_os = "macos")]
const PLATFORM: &str = "macos";
#[cfg(target_os = "linux")]
const PLATFORM: &str = "linux";

#[derive(Debug, Clone)]
enum Mode {
    Install,
    Update {
        relaunch: bool,
        wait_pid: Option<u32>,
    },
    Uninstall {
        dir: Option<PathBuf>,
        /// Windows only: running from the temporary copy that deletes itself at the end.
        #[cfg_attr(not(windows), allow(dead_code))]
        from_temp: bool,
    },
}

fn parse_mode(args: &[String]) -> Mode {
    let value_after = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    if args.iter().any(|a| a == "--uninstall") {
        Mode::Uninstall {
            // Only Windows moves the uninstaller to a temporary copy that needs to be told where
            // UwUMail is. Elsewhere the place is fixed and never comes from the command line.
            dir: if cfg!(windows) { value_after("--dir").map(PathBuf::from) } else { None },
            from_temp: cfg!(windows) && args.iter().any(|a| a == "--from-temp"),
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
    platform: &'static str,
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
        platform: PLATFORM,
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
/// Only on Windows: macOS and Linux have one fixed place for apps of a user.
#[tauri::command]
async fn pick_folder(app: AppHandle, current: String) -> Option<String> {
    #[cfg(windows)]
    {
        use tauri_plugin_dialog::DialogExt;
        let start = Path::new(&current).parent().map(Path::to_path_buf).unwrap_or_default();
        let picked = app.dialog().file().set_directory(start).blocking_pick_folder()?;
        let mut path = picked.into_path().ok()?;
        if !path.file_name().is_some_and(|name| name.eq_ignore_ascii_case("UwUMail")) {
            path.push("UwUMail");
        }
        Some(path.display().to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, current);
        None
    }
}

#[tauri::command]
async fn close_app(app: AppHandle) -> Result<(), String> {
    let setup = app.state::<Setup>();
    install::stop_app(&setup.layout, &current_dir(&setup))
}

/// Turns step-local progress into one smooth 0..1 value and hands it on.
fn reporter(weights: &'static [(Step, f64)], mut report: impl FnMut(Step, f64)) -> impl FnMut(Step, f64) {
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
            report(step, overall);
        }
    }
}

fn to_page(app: &AppHandle) -> impl FnMut(Step, f64) {
    let app = app.clone();
    move |step, overall| {
        let _ = app.emit("setup:progress", ProgressEvent { step, overall });
    }
}

const INSTALL_WEIGHTS: &[(Step, f64)] =
    &[(Step::Prepare, 0.08), (Step::Copy, 0.72), (Step::Shortcuts, 0.08), (Step::Register, 0.12)];
const UNINSTALL_WEIGHTS: &[(Step, f64)] =
    &[(Step::Prepare, 0.15), (Step::Shortcuts, 0.1), (Step::Register, 0.15), (Step::Copy, 0.3), (Step::Cleanup, 0.3)];

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

/// Installs, or updates when UwUMail handed over: then never to an older version.
fn run_install(setup: &Setup, options: &Options, progress: &mut dyn FnMut(Step, f64)) -> Result<(), String> {
    if let Mode::Update { wait_pid, .. } = setup.mode {
        install::check_not_older(setup.layout.installed().and_then(|i| i.version).as_deref(), VERSION)?;
        if let Some(pid) = wait_pid {
            system::wait_for_exit(pid, Duration::from_secs(15));
        }
    }
    install::install(&setup.layout, options, VERSION, progress)
}

#[tauri::command]
async fn install(app: AppHandle, options: Options) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let setup = app.state::<Setup>();
        let _busy = guard(&setup)?;
        let mut progress = reporter(INSTALL_WEIGHTS, to_page(&app));
        run_install(&setup, &options, &mut progress)
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
        let mut progress = reporter(UNINSTALL_WEIGHTS, to_page(&app));
        install::uninstall(&setup.layout, &dir, keep_data, &mut progress)
    })
    .await
    .map_err(|e| format!("Setup stopped unexpectedly: {e}"))?
}

#[tauri::command]
fn launch_app(setup: State<'_, Setup>) -> Result<(), String> {
    install::launch(&setup.layout, &current_dir(&setup))
}

#[tauri::command]
fn open_default_apps(setup: State<'_, Setup>) {
    install::open_default_apps(&setup.layout);
}

#[tauri::command]
fn finish(app: AppHandle) {
    #[cfg(windows)]
    {
        let setup = app.state::<Setup>();
        if let Mode::Uninstall { from_temp: true, .. } = setup.mode
            && let Ok(me) = std::env::current_exe()
        {
            system::delete_after_exit(&me);
        }
    }
    app.exit(0);
}

/// `--silent`: the same jobs without a window.
fn run_silent(setup: &Setup, args: &[String]) -> Result<String, String> {
    let flag = |name: &str| args.iter().any(|a| a == name);
    let mut report = |step: Step, overall: f64| println!("{:>3} % {step:?}", (overall * 100.0).round());
    if let Mode::Uninstall { .. } = setup.mode {
        let dir = current_dir(setup);
        let mut progress = reporter(UNINSTALL_WEIGHTS, &mut report);
        install::uninstall(&setup.layout, &dir, !flag("--delete-data"), &mut progress)?;
        return Ok(format!("UwUMail was removed from {}", dir.display()));
    }
    let mut options = setup.layout.remembered_options();
    options.autostart |= flag("--autostart");
    options.default_mail_app |= flag("--default-mail-app");
    options.desktop_shortcut |= flag("--desktop-shortcut");
    let mut progress = reporter(INSTALL_WEIGHTS, &mut report);
    run_install(setup, &options, &mut progress)?;
    Ok(format!("UwUMail {VERSION} is installed in {}", options.dir))
}

pub fn run() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = parse_mode(&args);
    let layout = Layout::detect();

    let uninstall_dir = match &mode {
        Mode::Uninstall { dir, .. } => {
            dir.clone().or_else(|| layout.installed().map(|installed| PathBuf::from(installed.dir))).or_else(|| {
                if cfg!(windows) {
                    std::env::current_exe().ok().and_then(|me| me.parent().map(Path::to_path_buf))
                } else {
                    Some(PathBuf::from(layout.remembered_options().dir))
                }
            })
        }
        _ => None,
    };

    if args.iter().any(|a| a == "--silent") {
        let setup = Setup { layout, mode, uninstall_dir, busy: Mutex::new(false) };
        match run_silent(&setup, &args) {
            Ok(done) => println!("{done}"),
            Err(error) => {
                eprintln!("UwUMail Setup: {error}");
                std::process::exit(1);
            }
        }
        return;
    }

    #[cfg(windows)]
    {
        if !prepare_windows(&mode, uninstall_dir.as_deref()) {
            return;
        }
    }

    let setup = Setup { layout, mode, uninstall_dir, busy: Mutex::new(false) };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(setup)
        .setup(|app| {
            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("UwUMail Setup")
                .inner_size(460.0, 640.0)
                .resizable(false)
                .maximizable(false)
                .decorations(false)
                .shadow(true)
                .center();
            // The page's own browser data stays away from UwUMail's.
            if let Some(data) = webview_data_dir() {
                window = window.data_directory(data);
            }
            window.build()?;
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

#[cfg(windows)]
fn webview_data_dir() -> Option<PathBuf> {
    Some(std::env::temp_dir().join("UwUMail-Setup-WebView"))
}

#[cfg(not(windows))]
fn webview_data_dir() -> Option<PathBuf> {
    system::webview_data_dir()
}

/// Windows can't delete a running program, so the uninstaller hands over to a
/// copy in the temp folder; and without WebView2 there's no window to show.
/// Returns false when this process is done.
#[cfg(windows)]
fn prepare_windows(mode: &Mode, uninstall_dir: Option<&Path>) -> bool {
    if let (Mode::Uninstall { from_temp: false, .. }, Some(dir)) = (mode, uninstall_dir)
        && let Ok(me) = std::env::current_exe()
    {
        let copy = std::env::temp_dir().join(format!("UwUMail-Uninstall-{}.exe", std::process::id()));
        if std::fs::copy(&me, &copy).is_ok() {
            let dir = dir.display().to_string();
            if system::spawn_detached(&copy, &["--uninstall", "--from-temp", "--dir", &dir]).is_ok() {
                return false;
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
            return false;
        }
        if let Err(error) = system::install_webview2() {
            system::alert(title, &error);
            return false;
        }
    }
    true
}

#[cfg(windows)]
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
        let uninstall = parse_mode(&args(&["--uninstall", "--from-temp", "--dir", r"C:\Apps\UwUMail"]));
        if cfg!(windows) {
            assert!(matches!(uninstall, Mode::Uninstall { from_temp: true, dir: Some(_) }));
        } else {
            assert!(
                matches!(uninstall, Mode::Uninstall { from_temp: false, dir: None }),
                "the place to remove never comes from the command line"
            );
        }
    }

    #[test]
    fn reports_smooth_progress_over_all_steps() {
        let mut seen = Vec::new();
        {
            let mut progress = reporter(INSTALL_WEIGHTS, |_, overall| seen.push(overall));
            progress(Step::Prepare, 1.0);
            progress(Step::Copy, 0.5);
            progress(Step::Copy, 0.501);
            progress(Step::Done, 1.0);
        }
        assert_eq!(seen.len(), 3, "tiny steps are skipped: {seen:?}");
        assert!((seen[1] - (0.08 + 0.36)).abs() < 1e-9);
        assert_eq!(seen.last(), Some(&1.0));
    }
}
