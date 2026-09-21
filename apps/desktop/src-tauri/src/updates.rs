//! Automatic updates on Windows, macOS and Linux.
//!
//! UwUMail looks for a new version shortly after starting and every six
//! hours, downloads the signed setup for this system quietly and tells the UI.
//! "Restart now" hands over to that setup in `--update` mode; otherwise the
//! update is applied the next time UwUMail starts.
//!
//! The setup is `UwUMail-Setup-<version>.exe` on Windows, the setup program
//! itself on macOS and the setup AppImage on Linux. On macOS and Linux only a
//! UwUMail the setup installed updates itself, so a copy started from
//! somewhere else never installs a second one.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
use uwumail_core::Error;

/// The `updates` branch of the public repo, written by the release workflow.
const FEED: &str = "https://raw.githubusercontent.com/MinifyX/UwUMail-Client/updates";
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(20);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
const PENDING: &str = "pending.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Beta,
}

/// Until the page says otherwise: a beta build stays on Beta, everything else on Stable.
impl Default for Channel {
    fn default() -> Self {
        if env!("CARGO_PKG_VERSION").contains('-') { Channel::Beta } else { Channel::Stable }
    }
}

/// A downloaded update waiting to be installed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyUpdate {
    pub version: String,
    /// Release notes; JSON with `de` and `en` when written for UwUMail.
    pub notes: Option<String>,
    /// The downloaded setup. Also kept in `pending.json` for the next start.
    pub file: PathBuf,
    /// The release signature, checked again right before the setup runs.
    #[serde(default)]
    pub signature: String,
}

#[derive(Default)]
pub struct Updates {
    channel: Mutex<Channel>,
    ready: Mutex<Option<ReadyUpdate>>,
    checking: tokio::sync::Mutex<()>,
}

fn updates_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|dir| dir.join("updates"))
}

fn current_version(app: &AppHandle) -> semver::Version {
    app.package_info().version.clone()
}

fn is_newer(app: &AppHandle, version: &str) -> bool {
    semver::Version::parse(version).is_ok_and(|v| v > current_version(app))
}

fn setup_file(dir: &Path, version: &str) -> PathBuf {
    if cfg!(windows) {
        dir.join(format!("UwUMail-Setup-{version}.exe"))
    } else if cfg!(target_os = "linux") {
        dir.join(format!("UwUMail-Setup-{version}.AppImage"))
    } else {
        dir.join(format!("UwUMail-Setup-{version}"))
    }
}

/// A path with its links resolved.
fn real(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// Whether this UwUMail is the one the setup installed and may replace.
fn updates_itself() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    if cfg!(windows) {
        return true;
    }
    let (Some(exe), Some(home)) = (
        std::env::current_exe().ok().and_then(|exe| real(&exe)),
        std::env::var_os("HOME").map(PathBuf::from).filter(|home| home.is_absolute()),
    ) else {
        return false;
    };
    let installed = if cfg!(target_os = "macos") {
        home.join("Applications/UwUMail.app")
    } else {
        let data = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .unwrap_or_else(|| home.join(".local/share"));
        data.join("uwumail/app")
    };
    real(&installed).is_some_and(|installed| exe.starts_with(installed))
}

/// Creates the updates folder for this user alone.
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Writes the downloaded setup, runnable only by this user where that matters.
fn write_setup(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let _ = std::fs::remove_file(file);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o700);
    }
    let mut out = options.open(file)?;
    std::io::Write::write_all(&mut out, bytes)?;
    out.sync_all()
}

/// A waiting update, if it is where UwUMail put it and still carries a valid
/// release signature. `pending.json` lives in a folder any program of the
/// user can write to, so neither its path nor the file is trusted blindly.
fn read_pending(app: &AppHandle) -> Option<ReadyUpdate> {
    let dir = updates_dir(app)?;
    let raw = std::fs::read(dir.join(PENDING)).ok()?;
    let update = serde_json::from_slice::<ReadyUpdate>(&raw).ok()?;
    semver::Version::parse(&update.version).ok()?;
    let expected = setup_file(&dir, &update.version);
    if update.file != expected {
        return None;
    }
    let bytes = std::fs::read(&expected).ok()?;
    verify(app, &bytes, &update.signature).then_some(update)
}

/// Checks a setup against the release key from `tauri.conf.json`.
fn verify(app: &AppHandle, bytes: &[u8], signature: &str) -> bool {
    use base64::Engine as _;
    let decode = |text: &str| {
        base64::engine::general_purpose::STANDARD.decode(text.trim()).ok().and_then(|raw| String::from_utf8(raw).ok())
    };
    let Some(pubkey) = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .and_then(decode)
    else {
        return false;
    };
    let (Ok(key), Some(Ok(signature))) = (
        minisign_verify::PublicKey::decode(&pubkey),
        decode(signature).map(|s| minisign_verify::Signature::decode(&s)),
    ) else {
        return false;
    };
    key.verify(bytes, &signature, false).is_ok()
}

/// Starts the downloaded setup to replace this UwUMail, which then quits.
fn hand_over(update: &ReadyUpdate, relaunch: bool) -> Result<(), Error> {
    // Each download gets one attempt. If the setup refuses (e.g. an older version), the next
    // start must not hand over again and again.
    if let Some(dir) = update.file.parent() {
        let _ = std::fs::remove_file(dir.join(PENDING));
    }
    let pid = std::process::id().to_string();
    let mut args = vec!["--update", "--wait-pid", pid.as_str()];
    if relaunch {
        args.push("--relaunch");
    }
    let mut command = std::process::Command::new(&update.file);
    command.args(&args);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, so the setup outlives this UwUMail.
        command.process_group(0).stdin(std::process::Stdio::null());
        if let Some(dir) = update.file.parent() {
            command.current_dir(dir);
        }
    }
    #[cfg(target_os = "linux")]
    {
        // UwUMail runs from its unpacked AppImage; the setup must not inherit where that one keeps
        // its libraries. It unpacks itself into the private updates folder instead of mounting,
        // so FUSE isn't needed and nothing lands in the shared /tmp.
        for name in [
            "APPDIR",
            "APPIMAGE",
            "ARGV0",
            "OWD",
            "LD_LIBRARY_PATH",
            "GDK_PIXBUF_MODULEDIR",
            "GDK_PIXBUF_MODULE_FILE",
            "GIO_EXTRA_MODULES",
            "GIO_MODULE_DIR",
            "GSETTINGS_SCHEMA_DIR",
            "GTK_DATA_PREFIX",
            "GTK_EXE_PREFIX",
            "GTK_IM_MODULE_FILE",
            "GTK_PATH",
        ] {
            command.env_remove(name);
        }
        command.env("APPIMAGE_EXTRACT_AND_RUN", "1");
        if let Some(dir) = update.file.parent() {
            command.env("TMPDIR", dir);
        }
    }
    command.spawn().map(|_| ()).map_err(|e| Error::internal(format!("Couldn't start the update: {e}")))
}

/// Called first thing on start: installs a waiting update, or cleans up after one.
/// Returns true when UwUMail must quit right away because the setup takes over.
pub fn apply_pending_on_start(app: &AppHandle) -> bool {
    if !updates_itself() {
        return false;
    }
    match read_pending(app) {
        Some(update) if is_newer(app, &update.version) => hand_over(&update, true).is_ok(),
        _ => {
            if let Some(dir) = updates_dir(app) {
                let _ = std::fs::remove_dir_all(dir);
            }
            false
        }
    }
}

pub fn set_channel(app: &AppHandle, channel: Channel) {
    *app.state::<Updates>().channel.lock().unwrap() = channel;
}

pub fn ready(app: &AppHandle) -> Option<ReadyUpdate> {
    app.state::<Updates>().ready.lock().unwrap().clone()
}

/// Looks for a newer version and downloads it. Returns the waiting update, if any.
pub async fn check(app: &AppHandle) -> Result<Option<ReadyUpdate>, Error> {
    let state = app.state::<Updates>();
    let _one_at_a_time = state.checking.lock().await;
    if let Some(update) = ready(app) {
        return Ok(Some(update));
    }
    if !updates_itself() {
        return Ok(None);
    }
    let channel = *state.channel.lock().unwrap();
    let feed = match channel {
        Channel::Stable => format!("{FEED}/stable.json"),
        Channel::Beta => format!("{FEED}/beta.json"),
    };
    let fail = |e: tauri_plugin_updater::Error| Error::connection(format!("Update check failed: {e}"));
    let updater = app
        .updater_builder()
        .endpoints(vec![feed.parse().map_err(|_| Error::internal("Bad update address"))?])
        .map_err(fail)?
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(fail)?;
    let Some(found) = updater.check().await.map_err(fail)? else { return Ok(None) };

    // The plugin checks the signature against the public key before handing out the bytes.
    let bytes = found.download(|_, _| {}, || {}).await.map_err(fail)?;
    let dir = updates_dir(app).ok_or_else(|| Error::internal("No folder for updates"))?;
    create_private_dir(&dir).map_err(|e| Error::internal(format!("Couldn't save the update: {e}")))?;
    let file = setup_file(&dir, &found.version);
    write_setup(&file, &bytes).map_err(|e| Error::internal(format!("Couldn't save the update: {e}")))?;
    let update = ReadyUpdate {
        version: found.version.clone(),
        notes: found.body.clone(),
        file,
        signature: found.signature.clone(),
    };
    std::fs::write(dir.join(PENDING), serde_json::to_vec(&update)?)
        .map_err(|e| Error::internal(format!("Couldn't save the update: {e}")))?;

    *state.ready.lock().unwrap() = Some(update.clone());
    let _ = app.emit("update:ready", &update);
    Ok(Some(update))
}

/// "Restart now".
pub fn install_now(app: &AppHandle) -> Result<(), Error> {
    ready(app).ok_or_else(|| Error::not_found("There's no update waiting."))?;
    // Read it back from disk, so the signature is checked on the file that runs.
    let update = read_pending(app).ok_or_else(|| Error::internal("The downloaded update is damaged."))?;
    hand_over(&update, true)?;
    app.exit(0);
    Ok(())
}

/// Checks in the background for as long as UwUMail runs.
pub fn start(app: &AppHandle) {
    app.manage(Updates::default());
    if let Some(update) = read_pending(app).filter(|update| is_newer(app, &update.version)) {
        *app.state::<Updates>().ready.lock().unwrap() = Some(update);
    }
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_AFTER).await;
        loop {
            if let Err(error) = check(&app).await {
                tracing::info!("{error}");
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}
