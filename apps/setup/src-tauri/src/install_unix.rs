//! Installing, updating and removing UwUMail for the current macOS or Linux
//! user. Everything lives in the home folder; no administrator rights needed.
//!
//! - macOS: `~/Applications/UwUMail.app`, a LaunchAgent for starting with the
//!   Mac, and UwUMail registered for `mailto:` links.
//! - Linux: the app in `~/.local/share/uwumail/app`, a menu entry, an icon,
//!   `~/.local/bin/uwumail`, an autostart entry and `mailto:` via mimeapps.list.
//!
//! The app comes out of the setup itself (a tar packed by build.rs), is
//! unpacked next to its place and then swapped in, so a failed update leaves
//! the old version working. What the setup chose is kept in a small JSON file.
//!
//! `UWUMAIL_SETUP_SANDBOX=<folder>` treats that folder as the home folder and
//! never touches running programs or system settings, for testing.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub use crate::common::{Installed, Options, Progress, Step, check_not_older, has_payload};
use crate::common::{PAYLOAD, PAYLOAD_SIZE};
use crate::platform::{self, Paths};
use crate::system;

/// Where things go for this user.
pub struct Layout {
    pub paths: Paths,
    pub sandbox: bool,
}

/// What the last install chose, kept for the next update.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    version: Option<String>,
    #[serde(default)]
    autostart: bool,
    #[serde(default)]
    default_mail_app: bool,
}

impl Layout {
    pub fn detect() -> Self {
        match std::env::var_os("UWUMAIL_SETUP_SANDBOX").map(PathBuf::from).filter(|dir| dir.is_absolute()) {
            Some(dir) => Self::sandbox(&dir),
            None => Self {
                // Without a home folder every path is relative, and install() refuses to start.
                paths: Paths::for_user(&system::home().unwrap_or_default(), true),
                sandbox: false,
            },
        }
    }

    pub fn sandbox(home: &Path) -> Self {
        Self { paths: Paths::for_user(home, false), sandbox: true }
    }

    fn state(&self) -> State {
        std::fs::read(&self.paths.state_file).ok().and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or_default()
    }

    /// What is installed right now, if anything.
    pub fn installed(&self) -> Option<Installed> {
        platform::app_present(&self.paths).then(|| Installed {
            dir: self.paths.app.display().to_string(),
            version: self.state().version.or_else(|| platform::app_version(&self.paths)),
            legacy: false,
        })
    }

    /// Options from the last install, or the defaults.
    pub fn remembered_options(&self) -> Options {
        let state = self.state();
        Options {
            dir: self.paths.app.display().to_string(),
            desktop_shortcut: false,
            autostart: state.autostart,
            default_mail_app: state.default_mail_app,
        }
    }
}

/// Stops UwUMail if it runs. Skipped in the sandbox, which must never touch real processes.
pub fn stop_app(layout: &Layout, _dir: &Path) -> Result<(), String> {
    if layout.sandbox {
        return Ok(());
    }
    system::stop_processes_in(&layout.paths.app)
}

pub fn app_running(layout: &Layout, _dir: &Path) -> bool {
    !layout.sandbox && !system::processes_in(&layout.paths.app).is_empty()
}

/// Starts the installed UwUMail. Skipped in the sandbox.
pub fn launch(layout: &Layout, _dir: &Path) -> Result<(), String> {
    if layout.sandbox {
        return Ok(());
    }
    platform::launch(&layout.paths)
}

/// Nothing to open: macOS and Linux have no settings page the setup could hand over to.
pub fn open_default_apps(_layout: &Layout) {}

/// A name next to `path` in the same folder, so renaming it into place is one step.
fn sibling(path: &Path, label: &str) -> PathBuf {
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(format!(".{name}.{label}-{}", std::process::id()))
}

/// Removes what an interrupted earlier run left next to the app.
fn remove_leftovers(app: &Path) {
    let (Some(parent), Some(name)) = (app.parent(), app.file_name()) else { return };
    let prefix = format!(".{}.", name.to_string_lossy());
    for entry in std::fs::read_dir(parent).into_iter().flatten().flatten() {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if file_name.starts_with(&prefix) && (file_name.contains(".new-") || file_name.contains(".old-")) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Counts what the decoder hands out, for the progress bar.
struct Counting<'a, R> {
    inner: R,
    read: u64,
    total: u64,
    progress: Progress<'a>,
}

impl<R: Read> Read for Counting<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.read += read as u64;
        (self.progress)(Step::Copy, self.read as f64 / self.total as f64);
        Ok(read)
    }
}

/// Unpacks the app into `target`, which must not exist yet.
fn extract(target: &Path, progress: Progress) -> Result<(), String> {
    if PAYLOAD.is_empty() {
        return Err("This setup was built without UwUMail inside (a development build).".into());
    }
    let total: u64 = PAYLOAD_SIZE.parse().unwrap_or(1).max(1);
    let decoder = zstd::Decoder::new(PAYLOAD).map_err(|e| format!("The packed app is damaged: {e}"))?;
    let mut archive = tar::Archive::new(Counting { inner: decoder, read: 0, total, progress });
    // No setuid bits, nothing writable for others, whatever the archive says.
    archive.set_preserve_permissions(false);
    archive.set_mask(0o022);
    archive.set_overwrite(false);
    std::fs::create_dir(target).map_err(|e| format!("Couldn't create {}: {e}", target.display()))?;
    system::set_mode(target, 0o755)?;
    // `unpack` keeps every entry inside `target`, also against `..` and links.
    archive.unpack(target).map_err(|e| format!("Couldn't unpack UwUMail into {}: {e}", target.display()))
}

/// Puts `staged` where `app` is, keeping the old version until the new one is in place.
fn swap_in(staged: &Path, app: &Path) -> Result<(), String> {
    let old = sibling(app, "old");
    let had_old = app.symlink_metadata().is_ok();
    if had_old {
        std::fs::rename(app, &old).map_err(|e| format!("Couldn't move the old UwUMail aside: {e}"))?;
    }
    if let Err(e) = std::fs::rename(staged, app) {
        if had_old {
            let _ = std::fs::rename(&old, app);
        }
        return Err(format!("Couldn't put UwUMail into {}: {e}", app.display()));
    }
    if had_old {
        let _ = std::fs::remove_dir_all(&old);
    }
    Ok(())
}

fn save_state(layout: &Layout, options: &Options, version: &str) -> Result<(), String> {
    let state = State {
        version: Some(version.to_string()),
        autostart: options.autostart,
        default_mail_app: options.default_mail_app,
    };
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    system::write_file(&layout.paths.state_file, &json, 0o600)
}

pub fn install(layout: &Layout, options: &Options, version: &str, progress: Progress) -> Result<(), String> {
    let paths = &layout.paths;
    if !paths.home.is_absolute() {
        return Err("Couldn't find your home folder (HOME isn't set).".into());
    }
    progress(Step::Prepare, 0.0);
    platform::prepare(paths)?;
    stop_app(layout, &paths.app)?;
    remove_leftovers(&paths.app);
    progress(Step::Prepare, 1.0);

    let staged = sibling(&paths.app, "new");
    let result = extract(&staged, progress).and_then(|()| platform::check_unpacked(&staged));
    if let Err(error) = result.and_then(|()| swap_in(&staged, &paths.app)) {
        let _ = std::fs::remove_dir_all(&staged);
        return Err(error);
    }

    progress(Step::Shortcuts, 0.0);
    platform::add_shortcuts(paths, layout.sandbox)?;
    progress(Step::Shortcuts, 1.0);

    progress(Step::Register, 0.0);
    platform::register(paths, options, layout.sandbox)?;
    save_state(layout, options, version)?;
    progress(Step::Register, 1.0);
    progress(Step::Done, 1.0);
    Ok(())
}

pub fn uninstall(layout: &Layout, _dir: &Path, keep_data: bool, progress: Progress) -> Result<(), String> {
    let paths = &layout.paths;
    progress(Step::Prepare, 0.0);
    stop_app(layout, &paths.app)?;
    progress(Step::Prepare, 1.0);

    progress(Step::Shortcuts, 0.0);
    platform::remove_shortcuts(paths);
    progress(Step::Shortcuts, 1.0);

    progress(Step::Register, 0.0);
    platform::unregister(paths, layout.sandbox);
    progress(Step::Register, 1.0);

    progress(Step::Copy, 0.0);
    if paths.app.symlink_metadata().is_ok() {
        std::fs::remove_dir_all(&paths.app)
            .map_err(|e| format!("Couldn't remove {}. Is UwUMail still open? ({e})", paths.app.display()))?;
    }
    remove_leftovers(&paths.app);
    platform::remove_setup_files(paths);
    progress(Step::Copy, 1.0);

    if !keep_data {
        progress(Step::Cleanup, 0.0);
        for folder in platform::data_dirs(paths) {
            if folder.symlink_metadata().is_ok() {
                std::fs::remove_dir_all(&folder).map_err(|e| format!("Couldn't delete {}: {e}", folder.display()))?;
            }
        }
        if !layout.sandbox {
            platform::delete_credentials();
        }
        progress(Step::Cleanup, 1.0);
    }
    progress(Step::Done, 1.0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox() -> (tempfile::TempDir, Layout) {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::sandbox(dir.path());
        (dir, layout)
    }

    #[test]
    fn remembers_defaults_until_something_is_installed() {
        let (_dir, layout) = sandbox();
        assert!(layout.installed().is_none());
        let options = layout.remembered_options();
        assert_eq!(options.dir, layout.paths.app.display().to_string());
        assert!(!options.autostart && !options.default_mail_app);
    }

    #[test]
    fn swaps_the_new_version_in_and_keeps_the_old_one_on_failure() {
        let (dir, _layout) = sandbox();
        let app = dir.path().join("app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("version"), "old").unwrap();

        let staged = sibling(&app, "new");
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("version"), "new").unwrap();
        swap_in(&staged, &app).unwrap();
        assert_eq!(std::fs::read_to_string(app.join("version")).unwrap(), "new");
        assert!(!staged.exists());

        let missing = sibling(&app, "missing");
        assert!(swap_in(&missing, &app).is_err());
        assert_eq!(std::fs::read_to_string(app.join("version")).unwrap(), "new", "the old version stays");
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names.len(), 1, "nothing left over: {names:?}");
    }

    #[test]
    fn cleans_up_after_an_interrupted_run() {
        let (dir, _layout) = sandbox();
        let app = dir.path().join("app");
        std::fs::create_dir_all(dir.path().join(".app.new-1")).unwrap();
        std::fs::create_dir_all(dir.path().join(".app.old-2")).unwrap();
        std::fs::create_dir_all(dir.path().join(".other")).unwrap();
        remove_leftovers(&app);
        assert!(!dir.path().join(".app.new-1").exists() && !dir.path().join(".app.old-2").exists());
        assert!(dir.path().join(".other").exists());
    }

    #[test]
    fn registers_and_unregisters_everything() {
        let (_dir, layout) = sandbox();
        let paths = &layout.paths;
        platform::prepare(paths).unwrap();
        platform::fake_app(&paths.app);
        let options = Options {
            dir: paths.app.display().to_string(),
            desktop_shortcut: false,
            autostart: true,
            default_mail_app: true,
        };
        platform::add_shortcuts(paths, true).unwrap();
        platform::register(paths, &options, true).unwrap();
        save_state(&layout, &options, "0.3.0-beta.1").unwrap();

        let installed = layout.installed().unwrap();
        assert_eq!(installed.version.as_deref(), Some("0.3.0-beta.1"));
        let remembered = layout.remembered_options();
        assert!(remembered.autostart && remembered.default_mail_app);
        platform::check_registered(paths, true);

        for folder in platform::data_dirs(paths) {
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("uwumail.db"), b"mail").unwrap();
        }
        uninstall(&layout, &paths.app, true, &mut |_, _| {}).unwrap();
        assert!(!paths.app.exists());
        assert!(layout.installed().is_none());
        platform::check_registered(paths, false);
        assert!(platform::data_dirs(paths)[0].join("uwumail.db").exists(), "mail data is kept");

        platform::fake_app(&paths.app);
        uninstall(&layout, &paths.app, false, &mut |_, _| {}).unwrap();
        assert!(platform::data_dirs(paths).iter().all(|folder| !folder.exists()), "mail data is deleted on request");
    }
}
