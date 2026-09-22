//! Automatic updates on Windows, macOS and Linux.
//!
//! UwUMail looks for a new version shortly after starting and every six
//! hours, downloads the signed setup for this system quietly and tells the UI.
//! "Restart now" hands over to that setup in `--update` mode; otherwise the
//! update is applied the next time UwUMail starts.
//!
//! The setup is UwUMail's Windows setup (the ARM one for an ARM build, which
//! Tauri's updater looks up as `windows-aarch64`; that is fixed when UwUMail is
//! built, so an x64 UwUMail on an ARM PC keeps the x64 setup), the universal
//! setup program itself on macOS and the setup AppImage on Linux. On macOS and
//! Linux only a UwUMail the setup installed updates itself, so a copy started
//! from somewhere else (the portable folder, a build of your own) never
//! installs a second one.
//!
//! A UwUMail from the .deb or .rpm updates through its package instead: the
//! updater finds it under `linux-<arch>-deb` / `-rpm` in the feed, and "Restart
//! now" installs it with `pkexec dpkg -i` / `pkexec rpm -U`, which asks for an
//! administrator's password. Only when dpkg or rpm really owns this UwUMail: the
//! AUR package is built from the .deb's files, so it looks like a .deb inside,
//! but pacman keeps that one up to date.

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

/// How this UwUMail came onto the computer, which decides how it updates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Install {
    /// UwUMail's own setup: Windows, macOS, and the per-user install on Linux.
    Setup,
    /// The .deb, installed by dpkg.
    Deb,
    /// The .rpm, installed by rpm.
    Rpm,
}

/// The package name of the .deb and .rpm (scripts/build-setup.mjs builds them under it).
#[cfg(target_os = "linux")]
const PACKAGE: &str = "uwumail";

/// The updater's name for this processor, as in the packages' signed names.
const ARCH: &str = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" };

fn setup_file(dir: &Path, version: &str, install: Install) -> PathBuf {
    if install == Install::Deb {
        dir.join(format!("UwUMail-{version}.deb"))
    } else if install == Install::Rpm {
        dir.join(format!("UwUMail-{version}.rpm"))
    } else if cfg!(windows) {
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

/// How this UwUMail updates itself, if it does: when the setup installed it (where the setup puts
/// it), or when dpkg or rpm installed it.
fn installed_by() -> Option<Install> {
    if cfg!(debug_assertions) {
        return None;
    }
    if cfg!(windows) {
        return Some(Install::Setup);
    }
    let exe = std::env::current_exe().ok().and_then(|exe| real(&exe))?;
    #[cfg(target_os = "linux")]
    {
        use tauri::utils::{config::BundleType, platform::bundle_type};
        // Written into the program when the .deb or .rpm was made; the setup's says AppImage.
        match bundle_type() {
            Some(BundleType::Deb) => return owned_by_dpkg(&exe).then_some(Install::Deb),
            Some(BundleType::Rpm) => return owned_by_rpm(&exe).then_some(Install::Rpm),
            _ => {}
        }
    }
    installed_by_setup(&exe).then_some(Install::Setup)
}

/// Whether dpkg installed this program as part of UwUMail's package.
#[cfg(target_os = "linux")]
fn owned_by_dpkg(exe: &Path) -> bool {
    std::fs::read_to_string(format!("/var/lib/dpkg/info/{PACKAGE}.list"))
        .is_ok_and(|files| files.lines().any(|line| Path::new(line) == exe))
}

/// Whether rpm installed this program as part of UwUMail's package.
#[cfg(target_os = "linux")]
fn owned_by_rpm(exe: &Path) -> bool {
    std::process::Command::new("rpm")
        .args(["-qf", "--queryformat", "%{NAME}"])
        .arg(exe)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .is_ok_and(|out| out.status.success() && out.stdout == PACKAGE.as_bytes())
}

/// Whether this program lies where UwUMail's setup installs it on macOS and Linux.
fn installed_by_setup(exe: &Path) -> bool {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from).filter(|home| home.is_absolute()) else {
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
fn read_pending(app: &AppHandle, install: Install) -> Option<ReadyUpdate> {
    let dir = updates_dir(app)?;
    let raw = std::fs::read(dir.join(PENDING)).ok()?;
    let update = serde_json::from_slice::<ReadyUpdate>(&raw).ok()?;
    semver::Version::parse(&update.version).ok()?;
    let expected = setup_file(&dir, &update.version, install);
    if update.file != expected {
        return None;
    }
    let bytes = std::fs::read(&expected).ok()?;
    verify(app, &bytes, &update.signature, &update.version, install).then_some(update)
}

/// The name the update of `version` for this system carries in its signature, as `tauri signer
/// sign` wrote it there. The release publishes the file under a name without the version
/// (UwUMail-windows-x64-setup.exe, ...) but signs a copy under this one (scripts/release-feeds.mjs).
/// Every released UwUMail expects these, so the names of the setups must never change.
fn release_file_name(version: &str, install: Install) -> String {
    if install == Install::Deb {
        format!("UwUMail-{version}-linux-{ARCH}.deb")
    } else if install == Install::Rpm {
        format!("UwUMail-{version}-linux-{ARCH}.rpm")
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        format!("UwUMail-Setup-{version}-arm64.exe")
    } else if cfg!(windows) {
        format!("UwUMail-Setup-{version}.exe")
    } else if cfg!(target_os = "linux") {
        format!("UwUMail-Setup-{version}-x86_64.AppImage")
    } else if cfg!(target_arch = "aarch64") {
        format!("UwUMail-Update-{version}-macos-apple-silicon")
    } else {
        format!("UwUMail-Update-{version}-macos-intel")
    }
}

/// Whether a signature's trusted comment (`timestamp:…<tab>file:<name>`) names the setup of
/// `version` for this system. The feed's version number isn't signed, the comment is: without
/// this, an altered feed could hand out an older setup, still validly signed, as a newer one.
fn signed_for_version(trusted_comment: &str, version: &str, install: Install) -> bool {
    let expected = release_file_name(version, install);
    trusted_comment.split('\t').any(|part| part.strip_prefix("file:") == Some(expected.as_str()))
}

/// Checks a setup against the release key from `tauri.conf.json`, and that the signature was
/// made for this version's setup.
fn verify(app: &AppHandle, bytes: &[u8], signature: &str, version: &str, install: Install) -> bool {
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
    key.verify(bytes, &signature, false).is_ok() && signed_for_version(signature.trusted_comment(), version, install)
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
        // so FUSE isn't needed and nothing lands in the shared /tmp. The AppImage runtime also
        // reads a few variables of its own, one of which would make it run another image than
        // the one just checked; none of them may come along.
        for name in [
            "APPDIR",
            "APPIMAGE",
            "ARGV0",
            "OWD",
            "TARGET_APPIMAGE",
            "NO_CLEANUP",
            "LD_LIBRARY_PATH",
            "LD_PRELOAD",
            "GDK_PIXBUF_MODULEDIR",
            "GDK_PIXBUF_MODULE_FILE",
            "GIO_EXTRA_MODULES",
            "GIO_MODULE_DIR",
            "GSETTINGS_SCHEMA_DIR",
            "GTK_DATA_PREFIX",
            "GTK_EXE_PREFIX",
            "GTK_IM_MODULE_FILE",
            "GTK_PATH",
            "GTK_THEME",
            "GDK_BACKEND",
            "PYTHONHOME",
            "PERLLIB",
            "QT_PLUGIN_PATH",
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

/// Installs a downloaded .deb or .rpm with the package manager, as an administrator: `pkexec`
/// asks for the password in a window of the desktop's own. The same commands as
/// tauri-plugin-updater's own package install, which can't be used here: it needs the update it
/// just downloaded in memory, not one waiting from before a restart, and has rpm refuse to go
/// from a beta to the final version.
#[cfg(target_os = "linux")]
fn install_package(file: &Path, install: Install) -> Result<(), Error> {
    // `--oldpackage`: rpm orders a beta (0.3.0-beta.2) after its final version (0.3.0). That the
    // update is newer, UwUMail has checked itself.
    let (program, args): (&str, &[&str]) =
        if install == Install::Deb { ("dpkg", &["-i"]) } else { ("rpm", &["-U", "--oldpackage"]) };
    let status = std::process::Command::new("pkexec")
        .arg(program)
        .args(args)
        .arg(file)
        .stdin(std::process::Stdio::null())
        .status()
        .map_err(|e| Error::internal(format!("Couldn't ask for the administrator password (pkexec): {e}")))?;
    if status.success() {
        return Ok(());
    }
    Err(Error::internal(format!(
        "The update wasn't installed. You can also install it yourself: sudo {program} {} '{}'",
        args.join(" "),
        file.display()
    )))
}

#[cfg(not(target_os = "linux"))]
fn install_package(_file: &Path, _install: Install) -> Result<(), Error> {
    Err(Error::internal("Only Linux has UwUMail packages."))
}

/// Called first thing on start: installs a waiting update, or cleans up after one.
/// Returns true when UwUMail must quit right away because the setup takes over.
pub fn apply_pending_on_start(app: &AppHandle) -> bool {
    let Some(install) = installed_by() else {
        return false;
    };
    match read_pending(app, install) {
        // A package wants an administrator's password, so it waits for "Restart now" instead of
        // asking out of the blue while UwUMail starts.
        Some(update) if is_newer(app, &update.version) => install == Install::Setup && hand_over(&update, true).is_ok(),
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
    let Some(install) = installed_by() else {
        return Ok(None);
    };
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
    if !verify(app, &bytes, &found.signature, &found.version, install) {
        return Err(Error::internal(format!("The update to {} isn't signed for that version.", found.version)));
    }
    let dir = updates_dir(app).ok_or_else(|| Error::internal("No folder for updates"))?;
    create_private_dir(&dir).map_err(|e| Error::internal(format!("Couldn't save the update: {e}")))?;
    let file = setup_file(&dir, &found.version, install);
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
pub async fn install_now(app: &AppHandle) -> Result<(), Error> {
    ready(app).ok_or_else(|| Error::not_found("There's no update waiting."))?;
    let install = installed_by().ok_or_else(|| Error::internal("This UwUMail doesn't update itself."))?;
    // Read it back from disk, so the signature is checked on the file that runs.
    let update = read_pending(app, install).ok_or_else(|| Error::internal("The downloaded update is damaged."))?;
    if install == Install::Setup {
        hand_over(&update, true)?;
        app.exit(0);
        return Ok(());
    }
    // Off the main thread, so the window keeps drawing while the password is asked for.
    let file = update.file.clone();
    tauri::async_runtime::spawn_blocking(move || install_package(&file, install))
        .await
        .map_err(|e| Error::internal(format!("The update failed: {e}")))??;
    if let Some(dir) = updates_dir(app) {
        let _ = std::fs::remove_dir_all(dir);
    }
    app.restart()
}

/// Checks in the background for as long as UwUMail runs.
pub fn start(app: &AppHandle) {
    app.manage(Updates::default());
    let pending = installed_by().and_then(|install| read_pending(app, install));
    if let Some(update) = pending.filter(|update| is_newer(app, &update.version)) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_must_name_the_version_they_were_made_for() {
        for install in [Install::Setup, Install::Deb, Install::Rpm] {
            let comment = |version: &str| format!("timestamp:1789548634\tfile:{}", release_file_name(version, install));
            let signed = |comment: &str, version: &str| signed_for_version(comment, version, install);
            assert!(signed(&comment("0.3.0-beta.1"), "0.3.0-beta.1"));
            assert!(!signed(&comment("0.2.0"), "0.3.0"), "an older update under a newer number");
            assert!(!signed(&comment("0.3.0-beta.1"), "0.3.0"));
            assert!(!signed("timestamp:1789548634", "0.3.0"));
            assert!(!signed(&format!("timestamp:1\tfile:x{}", release_file_name("0.3.0", install)), "0.3.0"));
        }
        let setup = |comment: &str, version: &str| signed_for_version(comment, version, Install::Setup);
        if cfg!(all(windows, target_arch = "aarch64")) {
            assert!(setup("timestamp:1\tfile:UwUMail-Setup-0.4.0-arm64.exe", "0.4.0"));
            assert!(!setup("timestamp:1\tfile:UwUMail-Setup-0.4.0.exe", "0.4.0"), "the x64 setup");
        } else if cfg!(windows) {
            assert!(!setup("timestamp:1\tfile:UwUMail-Setup-0.4.0-arm64.exe", "0.4.0"), "the ARM setup");
            // As the release of 0.2.0-beta.3 signed it.
            assert!(setup("timestamp:1789548634\tfile:UwUMail-Setup-0.2.0-beta.3.exe", "0.2.0-beta.3"));
        }
        // A package only takes the package for its own processor, never the setup and vice versa.
        let deb = |comment: &str| signed_for_version(comment, "0.4.0", Install::Deb);
        assert_eq!(deb("timestamp:1\tfile:UwUMail-0.4.0-linux-x86_64.deb"), cfg!(target_arch = "x86_64"));
        assert_eq!(deb("timestamp:1\tfile:UwUMail-0.4.0-linux-aarch64.deb"), cfg!(target_arch = "aarch64"));
        assert!(!deb("timestamp:1\tfile:UwUMail-0.4.0-linux-x86_64.rpm"), "the .rpm");
        assert!(!deb("timestamp:1\tfile:UwUMail-Setup-0.4.0-x86_64.AppImage"), "the setup");
        assert!(!setup("timestamp:1\tfile:UwUMail-0.4.0-linux-x86_64.deb", "0.4.0"), "the .deb");
    }
}
