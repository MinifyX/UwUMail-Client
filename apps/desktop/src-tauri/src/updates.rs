//! Automatic updates on Windows.
//!
//! UwUMail looks for a new version shortly after starting and every six
//! hours, downloads the signed `UwUMail-Setup.exe` quietly and tells the UI.
//! "Restart now" hands over to that setup in `--update` mode; otherwise the
//! update is applied the next time UwUMail starts.

use std::path::PathBuf;
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

fn setup_file(dir: &std::path::Path, version: &str) -> PathBuf {
    dir.join(format!("UwUMail-Setup-{version}.exe"))
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
    std::process::Command::new(&update.file)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| Error::internal(format!("Couldn't start the update: {e}")))
}

/// Called first thing on start: installs a waiting update, or cleans up after one.
/// Returns true when UwUMail must quit right away because the setup takes over.
pub fn apply_pending_on_start(app: &AppHandle) -> bool {
    if !cfg!(windows) || cfg!(debug_assertions) {
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
    if !cfg!(windows) {
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
    std::fs::create_dir_all(&dir).map_err(|e| Error::internal(format!("Couldn't save the update: {e}")))?;
    let file = setup_file(&dir, &found.version);
    std::fs::write(&file, &bytes).map_err(|e| Error::internal(format!("Couldn't save the update: {e}")))?;
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
