//! Linux: where UwUMail goes and how it shows up in the desktop.
//!
//! The app is Tauri's AppImage of UwUMail, unpacked, so it runs without FUSE
//! and starts quicker. `AppRun` sets up its bundled libraries and starts it.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::install::Options;
use crate::system;

const DESKTOP_FILE: &str = "uwumail.desktop";
const ICON_NAME: &str = "uwumail";
const APP_ID: &str = "app.uwumail.desktop";
const MAILTO: &str = "x-scheme-handler/mailto";

pub struct Paths {
    pub home: PathBuf,
    /// `~/.local/share/uwumail`: the app and what the setup remembers.
    pub base: PathBuf,
    /// The unpacked app.
    pub app: PathBuf,
    pub state_file: PathBuf,
    data_home: PathBuf,
    config_home: PathBuf,
    cache_home: PathBuf,
    bin_link: PathBuf,
    menu_entry: PathBuf,
    autostart_entry: PathBuf,
    icons: PathBuf,
    mimeapps: PathBuf,
}

impl Paths {
    /// The XDG folders count only when absolute, as the spec says, and only outside the sandbox.
    pub fn for_user(home: &Path, use_env: bool) -> Self {
        let xdg = |name: &str, fallback: &str| {
            use_env
                .then(|| std::env::var_os(name).map(PathBuf::from).filter(|dir| dir.is_absolute()))
                .flatten()
                .unwrap_or_else(|| home.join(fallback))
        };
        let data_home = xdg("XDG_DATA_HOME", ".local/share");
        let config_home = xdg("XDG_CONFIG_HOME", ".config");
        let cache_home = xdg("XDG_CACHE_HOME", ".cache");
        let base = data_home.join("uwumail");
        Self {
            home: home.to_path_buf(),
            app: base.join("app"),
            state_file: base.join("setup.json"),
            base,
            bin_link: home.join(".local/bin/uwumail"),
            menu_entry: data_home.join("applications").join(DESKTOP_FILE),
            autostart_entry: config_home.join("autostart").join(DESKTOP_FILE),
            icons: data_home.join("icons/hicolor"),
            mimeapps: config_home.join("mimeapps.list"),
            data_home,
            config_home,
            cache_home,
        }
    }

    fn app_run(&self) -> PathBuf {
        self.app.join("AppRun")
    }
}

pub fn app_present(paths: &Paths) -> bool {
    paths.app_run().exists()
}

/// Only the setup's own record knows the version of an unpacked AppImage.
pub fn app_version(_paths: &Paths) -> Option<String> {
    None
}

/// `~/.local/share/uwumail` belongs to this user alone.
pub fn prepare(paths: &Paths) -> Result<(), String> {
    std::fs::create_dir_all(&paths.base).map_err(|e| format!("Couldn't create {}: {e}", paths.base.display()))?;
    system::set_mode(&paths.base, 0o700)
}

pub fn check_unpacked(staged: &Path) -> Result<(), String> {
    if staged.join("AppRun").exists() { Ok(()) } else { Err("The packed app is incomplete (no AppRun).".into()) }
}

pub fn launch(paths: &Paths) -> Result<(), String> {
    system::spawn_detached::<&str>(&paths.app_run(), &[])
}

/// Quotes a path for the `Exec` key of a desktop entry, as the Desktop Entry
/// specification wants it: in double quotes with `"`, `` ` ``, `$` and `\`
/// escaped, then `\` escaped once more for the string value and `%` doubled.
fn exec_quote(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or_else(|| format!("{} isn't valid UTF-8.", path.display()))?;
    if text.chars().any(char::is_control) {
        return Err(format!("{} contains control characters.", path.display()));
    }
    let mut quoted = String::from("\"");
    for c in text.chars() {
        match c {
            '"' | '`' | '$' => {
                quoted.push_str("\\\\");
                quoted.push(c);
            }
            '\\' => quoted.push_str("\\\\\\\\"),
            '%' => quoted.push_str("%%"),
            _ => quoted.push(c),
        }
    }
    quoted.push('"');
    Ok(quoted)
}

fn desktop_entry(exec: &str, mailto: bool, autostart: bool) -> String {
    let mut entry = String::from("[Desktop Entry]\nType=Application\nName=UwUMail\n");
    entry.push_str("GenericName=Mail Client\nGenericName[de]=E-Mail-Programm\n");
    entry.push_str("Comment=A cute, modern mail client, built just for fun\n");
    entry.push_str("Comment[de]=Ein niedliches, modernes Mailprogramm, einfach zum Spaß gebaut\n");
    entry.push_str(&format!("Icon={ICON_NAME}\nTerminal=false\nCategories=Network;Email;\n"));
    if autostart {
        entry.push_str(&format!("Exec={exec} --autostart\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n"));
    } else if mailto {
        entry.push_str(&format!("Exec={exec} %u\nMimeType={MAILTO};\n"));
    } else {
        entry.push_str(&format!("Exec={exec}\n"));
    }
    entry
}

/// The icons the AppImage brings along, by size folder (`128x128`, ...).
fn bundled_icons(app: &Path) -> Vec<(String, PathBuf)> {
    let hicolor = app.join("usr/share/icons/hicolor");
    let mut icons = Vec::new();
    for size in std::fs::read_dir(&hicolor).into_iter().flatten().flatten() {
        let apps = size.path().join("apps");
        let png = std::fs::read_dir(&apps)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.extension() == Some(OsStr::new("png")));
        if let Some(png) = png {
            icons.push((size.file_name().to_string_lossy().into_owned(), png));
        }
    }
    icons
}

/// First line after the shebang of `~/.local/bin/uwumail`, to recognize our own.
const LAUNCHER_MARK: &str = "# UwUMail launcher, written by UwUMail Setup";

/// A shell script that starts `program`, quoted for sh (single quotes, `'` as `'\''`).
fn launcher_script(program: &Path) -> String {
    let quoted = program.to_string_lossy().replace('\'', r"'\''");
    format!("#!/bin/sh\n{LAUNCHER_MARK}\nexec '{quoted}' \"$@\"\n")
}

fn is_our_launcher(path: &Path) -> bool {
    path.symlink_metadata().is_ok_and(|meta| meta.is_file())
        && std::fs::read_to_string(path).is_ok_and(|text| text.lines().nth(1) == Some(LAUNCHER_MARK))
}

/// The menu entry, its icon and `~/.local/bin/uwumail`.
pub fn add_shortcuts(paths: &Paths, sandbox: bool) -> Result<(), String> {
    for (size, png) in bundled_icons(&paths.app) {
        let target = paths.icons.join(&size).join("apps").join(format!("{ICON_NAME}.png"));
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
        }
        std::fs::copy(&png, &target).map_err(|e| format!("Couldn't copy the icon: {e}"))?;
    }

    // A small launcher, not a link: AppRun finds its libraries next to the path it was started
    // by. It only replaces an earlier launcher of ours, never someone else's program of that name.
    let launcher = &paths.bin_link;
    if launcher.symlink_metadata().is_err() || is_our_launcher(launcher) {
        system::write_file(launcher, &launcher_script(&paths.app_run()), 0o755)?;
    }

    if !sandbox {
        system::run_quietly(
            "gtk-update-icon-cache",
            &[OsStr::new("--quiet"), OsStr::new("--ignore-theme-index"), paths.icons.as_os_str()],
            &[],
        );
    }
    Ok(())
}

pub fn remove_shortcuts(paths: &Paths) {
    system::remove_file(&paths.menu_entry);
    for size in std::fs::read_dir(&paths.icons).into_iter().flatten().flatten() {
        system::remove_file(&size.path().join("apps").join(format!("{ICON_NAME}.png")));
    }
    if is_our_launcher(&paths.bin_link) {
        let _ = std::fs::remove_file(&paths.bin_link);
    }
}

/// Sets or clears UwUMail as the `mailto:` handler in mimeapps.list, leaving every other line alone.
fn set_mailto_default(mimeapps: &Path, ours: bool) -> Result<(), String> {
    let text = std::fs::read_to_string(mimeapps).unwrap_or_default();
    let mut lines: Vec<String> = Vec::new();
    let mut in_defaults = false;
    let mut placed = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            if in_defaults && ours && !placed {
                lines.push(format!("{MAILTO}={DESKTOP_FILE};"));
                placed = true;
            }
            in_defaults = trimmed == "[Default Applications]";
        } else if in_defaults && trimmed.split('=').next().map(str::trim) == Some(MAILTO) {
            // Ours goes in once; someone else's default stays unless UwUMail should take over.
            let value = trimmed.split_once('=').map(|(_, value)| value.trim()).unwrap_or_default();
            if ours || value.split(';').next() == Some(DESKTOP_FILE) {
                continue;
            }
        }
        lines.push(line.to_string());
    }
    if ours && !placed {
        if !in_defaults {
            if lines.last().is_some_and(|line| !line.trim().is_empty()) {
                lines.push(String::new());
            }
            lines.push("[Default Applications]".into());
        }
        lines.push(format!("{MAILTO}={DESKTOP_FILE};"));
    }
    let mut result = lines.join("\n");
    result.push('\n');
    if result.trim().is_empty() && !mimeapps.exists() {
        return Ok(());
    }
    system::write_file(mimeapps, &result, 0o644)
}

/// Menu entry, autostart and `mailto:`.
pub fn register(paths: &Paths, options: &Options, sandbox: bool) -> Result<(), String> {
    let exec = exec_quote(&paths.app_run())?;
    system::write_file(&paths.menu_entry, &desktop_entry(&exec, options.default_mail_app, false), 0o644)?;
    if options.autostart {
        system::write_file(&paths.autostart_entry, &desktop_entry(&exec, false, true), 0o644)?;
    } else {
        system::remove_file(&paths.autostart_entry);
    }
    set_mailto_default(&paths.mimeapps, options.default_mail_app)?;
    if sandbox {
        return Ok(());
    }
    let applications = paths.menu_entry.parent().unwrap_or(&paths.data_home);
    system::run_quietly("update-desktop-database", &[applications.as_os_str()], &[]);
    if options.default_mail_app {
        // Desktops with their own place for defaults learn it from xdg-mime; if it is missing,
        // mimeapps.list above is what the others read.
        let env = [
            ("HOME", paths.home.as_path()),
            ("XDG_CONFIG_HOME", &paths.config_home),
            ("XDG_DATA_HOME", &paths.data_home),
        ];
        system::run_quietly("xdg-mime", &[OsStr::new("default"), OsStr::new(DESKTOP_FILE), OsStr::new(MAILTO)], &env);
    }
    Ok(())
}

pub fn unregister(paths: &Paths, _sandbox: bool) {
    system::remove_file(&paths.autostart_entry);
    system::remove_file(&paths.menu_entry);
    let _ = set_mailto_default(&paths.mimeapps, false);
}

/// The setup's own record and the folder around the app.
pub fn remove_setup_files(paths: &Paths) {
    system::remove_file(&paths.state_file);
    let _ = std::fs::remove_dir(&paths.base);
}

/// Where UwUMail keeps mail, settings and caches (Tauri's folders for its app id).
pub fn data_dirs(paths: &Paths) -> Vec<PathBuf> {
    vec![paths.data_home.join(APP_ID), paths.config_home.join(APP_ID), paths.cache_home.join(APP_ID)]
}

/// Removes the saved passwords (service "UwUMail") from the Secret Service, if
/// `secret-tool` is there. Best effort: without it they stay in the keyring.
pub fn delete_credentials() {
    system::run_quietly("secret-tool", &[OsStr::new("clear"), OsStr::new("service"), OsStr::new("UwUMail")], &[]);
}

#[cfg(test)]
pub fn fake_app(app: &Path) {
    std::fs::create_dir_all(app.join("usr/share/icons/hicolor/128x128/apps")).unwrap();
    std::fs::write(app.join("usr/share/icons/hicolor/128x128/apps/uwumail-desktop.png"), b"png").unwrap();
    std::fs::write(app.join("AppRun"), b"#!/bin/sh\n").unwrap();
}

#[cfg(test)]
pub fn check_registered(paths: &Paths, registered: bool) {
    let menu = std::fs::read_to_string(&paths.menu_entry).unwrap_or_default();
    assert_eq!(menu.contains("MimeType=x-scheme-handler/mailto;"), registered);
    assert_eq!(paths.autostart_entry.exists(), registered);
    assert_eq!(paths.icons.join("128x128/apps/uwumail.png").exists(), registered);
    assert_eq!(is_our_launcher(&paths.bin_link), registered);
    let mimeapps = std::fs::read_to_string(&paths.mimeapps).unwrap_or_default();
    assert_eq!(mimeapps.contains("x-scheme-handler/mailto=uwumail.desktop;"), registered);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_paths_for_desktop_entries() {
        assert_eq!(
            exec_quote(Path::new("/home/mia/.local/share/uwumail/app/AppRun")).unwrap(),
            "\"/home/mia/.local/share/uwumail/app/AppRun\""
        );
        assert_eq!(exec_quote(Path::new("/home/a b/$x`y\"z%/AppRun")).unwrap(), r#""/home/a b/\\$x\\`y\\"z%%/AppRun""#);
        assert_eq!(exec_quote(Path::new(r"/home/back\slash")).unwrap(), r#""/home/back\\\\slash""#);
        assert!(exec_quote(Path::new("/home/new\nline")).is_err());
    }

    #[test]
    fn writes_a_launcher_and_leaves_other_programs_alone() {
        let script = launcher_script(Path::new("/home/it's me/.local/share/uwumail/app/AppRun"));
        assert_eq!(
            script,
            format!("#!/bin/sh\n{LAUNCHER_MARK}\nexec '/home/it'\\''s me/.local/share/uwumail/app/AppRun' \"$@\"\n")
        );
        let dir = tempfile::tempdir().unwrap();
        let ours = dir.path().join("ours");
        std::fs::write(&ours, &script).unwrap();
        assert!(is_our_launcher(&ours));
        let theirs = dir.path().join("theirs");
        std::fs::write(&theirs, "#!/bin/sh\nexec something-else\n").unwrap();
        assert!(!is_our_launcher(&theirs));
    }

    #[test]
    fn edits_only_the_mailto_line_of_mimeapps() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mimeapps.list");
        std::fs::write(&file, "[Added Associations]\ntext/plain=gedit.desktop;\n\n[Default Applications]\nx-scheme-handler/mailto=thunderbird.desktop;\ntext/html=firefox.desktop;\n").unwrap();
        set_mailto_default(&file, true).unwrap();
        let set = std::fs::read_to_string(&file).unwrap();
        assert!(set.contains("x-scheme-handler/mailto=uwumail.desktop;"));
        assert!(!set.contains("thunderbird"));
        assert!(set.contains("text/html=firefox.desktop;") && set.contains("text/plain=gedit.desktop;"));
        assert_eq!(set.matches("[Default Applications]").count(), 1);

        set_mailto_default(&file, false).unwrap();
        let cleared = std::fs::read_to_string(&file).unwrap();
        assert!(!cleared.contains("mailto") && cleared.contains("text/html=firefox.desktop;"));

        // Someone else's default stays when UwUMail doesn't want to be it.
        std::fs::write(&file, "[Default Applications]\nx-scheme-handler/mailto=thunderbird.desktop;\n").unwrap();
        set_mailto_default(&file, false).unwrap();
        assert!(std::fs::read_to_string(&file).unwrap().contains("thunderbird"));

        let fresh = dir.path().join("new/mimeapps.list");
        set_mailto_default(&fresh, true).unwrap();
        assert_eq!(
            std::fs::read_to_string(&fresh).unwrap(),
            "[Default Applications]\nx-scheme-handler/mailto=uwumail.desktop;\n"
        );
    }
}
