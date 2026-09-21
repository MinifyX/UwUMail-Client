//! macOS: where UwUMail goes and how the Mac learns about it.
//!
//! The app goes to `~/Applications/UwUMail.app`, which needs no administrator.
//! Starting with the Mac is a LaunchAgent in `~/Library/LaunchAgents`: the
//! setup can write it for another app, while `SMAppService` only lets an app
//! register itself (and wants a properly signed one). macOS shows a
//! "background item added" note the first time.
//!
//! `mailto:` links: UwUMail declares the scheme in its Info.plist; the setup
//! registers the app with Launch Services and asks for it to become the
//! default. Newer macOS versions may ask the user to confirm that, or ignore
//! it; Mail › Settings › Default email reader always works.

use std::ffi::{OsStr, c_void};
use std::path::{Path, PathBuf};

use crate::install::Options;
use crate::system;

const APP_ID: &str = "app.uwumail.desktop";
const AGENT_LABEL: &str = "app.uwumail.autostart";
const APPLE_MAIL: &str = "com.apple.mail";

pub struct Paths {
    pub home: PathBuf,
    /// `~/Applications/UwUMail.app`
    pub app: PathBuf,
    pub state_file: PathBuf,
    state_dir: PathBuf,
    launch_agent: PathBuf,
}

impl Paths {
    pub fn for_user(home: &Path, _use_env: bool) -> Self {
        let state_dir = home.join("Library/Application Support/app.uwumail.setup");
        Self {
            home: home.to_path_buf(),
            app: home.join("Applications/UwUMail.app"),
            state_file: state_dir.join("setup.json"),
            state_dir,
            launch_agent: home.join(format!("Library/LaunchAgents/{AGENT_LABEL}.plist")),
        }
    }
}

fn info_plist(app: &Path) -> PathBuf {
    app.join("Contents/Info.plist")
}

/// A string value from an XML Info.plist, which is what Tauri writes.
fn plist_string(plist: &str, key: &str) -> Option<String> {
    let after = plist.split_once(&format!("<key>{key}</key>"))?.1;
    let value = after.trim_start().strip_prefix("<string>")?;
    Some(value.split_once("</string>")?.0.trim().to_string())
}

pub fn app_present(paths: &Paths) -> bool {
    info_plist(&paths.app).exists()
}

pub fn app_version(paths: &Paths) -> Option<String> {
    let plist = std::fs::read_to_string(info_plist(&paths.app)).ok()?;
    plist_string(&plist, "CFBundleShortVersionString")
}

/// The program inside the bundle, as its Info.plist names it.
fn executable(app: &Path) -> Result<PathBuf, String> {
    let plist =
        std::fs::read_to_string(info_plist(app)).map_err(|e| format!("Couldn't read UwUMail's Info.plist: {e}"))?;
    let name = plist_string(&plist, "CFBundleExecutable")
        .filter(|name| !name.is_empty() && !name.contains('/') && name != "..")
        .ok_or("UwUMail's Info.plist names no program.")?;
    Ok(app.join("Contents/MacOS").join(name))
}

pub fn prepare(paths: &Paths) -> Result<(), String> {
    let applications = paths.app.parent().unwrap_or(&paths.home);
    if !applications.exists() {
        std::fs::create_dir_all(applications)
            .map_err(|e| format!("Couldn't create {}: {e}", applications.display()))?;
        system::set_mode(applications, 0o700)?;
    }
    Ok(())
}

pub fn check_unpacked(staged: &Path) -> Result<(), String> {
    let program = executable(staged)?;
    if program.is_file() { Ok(()) } else { Err("The packed app is incomplete (no program inside).".into()) }
}

/// Opens UwUMail the way Finder would.
pub fn launch(paths: &Paths) -> Result<(), String> {
    system::spawn_detached(Path::new("/usr/bin/open"), &[paths.app.as_os_str()])
}

/// Nothing to add: `~/Applications` is where Launchpad and Spotlight look.
pub fn add_shortcuts(_paths: &Paths, _sandbox: bool) -> Result<(), String> {
    Ok(())
}

pub fn remove_shortcuts(_paths: &Paths) {}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

fn launch_agent(program: &Path) -> Result<String, String> {
    let program = program.to_str().ok_or("The path to UwUMail isn't valid UTF-8.")?;
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>--autostart</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
"#,
        xml_escape(program)
    ))
}

/// Autostart and `mailto:`.
pub fn register(paths: &Paths, options: &Options, sandbox: bool) -> Result<(), String> {
    if options.autostart {
        // launchd skips agents others could write to.
        system::write_file(&paths.launch_agent, &launch_agent(&executable(&paths.app)?)?, 0o644)?;
    } else {
        remove_launch_agent(paths, sandbox);
    }
    if sandbox {
        return Ok(());
    }
    launch_services::register(&paths.app);
    if options.default_mail_app {
        if let Err(status) = launch_services::set_mailto_handler(APP_ID) {
            eprintln!("macOS didn't make UwUMail the mail app (status {status}).");
        }
    } else if launch_services::mailto_handler().as_deref() == Some(APP_ID) {
        let _ = launch_services::set_mailto_handler(APPLE_MAIL);
    }
    Ok(())
}

fn remove_launch_agent(paths: &Paths, sandbox: bool) {
    if !paths.launch_agent.exists() {
        return;
    }
    if !sandbox {
        // Only loaded when UwUMail started with the Mac since the last sign-in; fails quietly otherwise.
        let target = format!("gui/{}/{AGENT_LABEL}", unsafe { libc::getuid() });
        system::run_quietly("/bin/launchctl", &[OsStr::new("bootout"), OsStr::new(&target)], &[]);
    }
    system::remove_file(&paths.launch_agent);
}

pub fn unregister(paths: &Paths, sandbox: bool) {
    remove_launch_agent(paths, sandbox);
    if !sandbox && launch_services::mailto_handler().as_deref() == Some(APP_ID) {
        let _ = launch_services::set_mailto_handler(APPLE_MAIL);
    }
}

pub fn remove_setup_files(paths: &Paths) {
    system::remove_file(&paths.state_file);
    let _ = std::fs::remove_dir(&paths.state_dir);
}

/// Where UwUMail and its web view keep mail, settings and caches.
pub fn data_dirs(paths: &Paths) -> Vec<PathBuf> {
    let library = paths.home.join("Library");
    vec![
        library.join("Application Support").join(APP_ID),
        library.join("Caches").join(APP_ID),
        library.join("WebKit").join(APP_ID),
        library.join("HTTPStorages").join(APP_ID),
        library.join("Logs").join(APP_ID),
        library.join("Saved Application State").join(format!("{APP_ID}.savedState")),
    ]
}

/// Removes UwUMail's saved passwords (service "UwUMail") from the login keychain.
pub fn delete_credentials() {
    // `security` removes one match per call.
    for _ in 0..200 {
        let removed = system::run_quietly(
            "/usr/bin/security",
            &[OsStr::new("delete-generic-password"), OsStr::new("-s"), OsStr::new("UwUMail")],
            &[],
        );
        if !removed {
            break;
        }
    }
}

/// The few Launch Services calls the setup needs, straight from CoreServices.
mod launch_services {
    use super::*;

    type CFTypeRef = *const c_void;
    type OSStatus = i32;
    const UTF8: u32 = 0x0800_0100;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithBytes(
            allocator: CFTypeRef,
            bytes: *const u8,
            length: isize,
            encoding: u32,
            external: u8,
        ) -> CFTypeRef;
        fn CFStringGetCString(string: CFTypeRef, buffer: *mut u8, size: isize, encoding: u32) -> u8;
        fn CFURLCreateFromFileSystemRepresentation(
            allocator: CFTypeRef,
            path: *const u8,
            length: isize,
            directory: u8,
        ) -> CFTypeRef;
        fn CFRelease(object: CFTypeRef);
    }

    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn LSRegisterURL(url: CFTypeRef, update: u8) -> OSStatus;
        fn LSSetDefaultHandlerForURLScheme(scheme: CFTypeRef, bundle_id: CFTypeRef) -> OSStatus;
        fn LSCopyDefaultHandlerForURLScheme(scheme: CFTypeRef) -> CFTypeRef;
    }

    /// An owned CoreFoundation object, released when dropped.
    struct Owned(CFTypeRef);

    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) }
            }
        }
    }

    fn string(text: &str) -> Owned {
        Owned(unsafe { CFStringCreateWithBytes(std::ptr::null(), text.as_ptr(), text.len() as isize, UTF8, 0) })
    }

    /// Tells Launch Services about the app, so it knows its `mailto:` scheme.
    pub fn register(app: &Path) {
        use std::os::unix::ffi::OsStrExt;
        let bytes = app.as_os_str().as_bytes();
        let url = Owned(unsafe {
            CFURLCreateFromFileSystemRepresentation(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize, 1)
        });
        if !url.0.is_null() {
            unsafe { LSRegisterURL(url.0, 1) };
        }
    }

    pub fn set_mailto_handler(bundle_id: &str) -> Result<(), OSStatus> {
        let (scheme, id) = (string("mailto"), string(bundle_id));
        match unsafe { LSSetDefaultHandlerForURLScheme(scheme.0, id.0) } {
            0 => Ok(()),
            status => Err(status),
        }
    }

    pub fn mailto_handler() -> Option<String> {
        let scheme = string("mailto");
        let handler = Owned(unsafe { LSCopyDefaultHandlerForURLScheme(scheme.0) });
        if handler.0.is_null() {
            return None;
        }
        let mut buffer = [0u8; 512];
        let ok = unsafe { CFStringGetCString(handler.0, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) };
        let end = buffer.iter().position(|b| *b == 0).unwrap_or(0);
        (ok != 0).then(|| String::from_utf8_lossy(&buffer[..end]).to_ascii_lowercase())
    }
}

#[cfg(test)]
pub fn fake_app(app: &Path) {
    std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    std::fs::write(
        info_plist(app),
        "<plist><dict>\n<key>CFBundleExecutable</key>\n<string>uwumail-desktop</string>\n</dict></plist>\n",
    )
    .unwrap();
    std::fs::write(app.join("Contents/MacOS/uwumail-desktop"), b"app").unwrap();
}

#[cfg(test)]
pub fn check_registered(paths: &Paths, registered: bool) {
    assert_eq!(paths.launch_agent.exists(), registered);
    if registered {
        let agent = std::fs::read_to_string(&paths.launch_agent).unwrap();
        assert!(agent.contains("/Applications/UwUMail.app/Contents/MacOS/uwumail-desktop</string>"));
        assert!(agent.contains("<string>--autostart</string>"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_info_plist() {
        let plist = "<dict>\n\t<key>CFBundleExecutable</key>\n\t<string>UwUMail</string>\n\t<key>CFBundleShortVersionString</key>\n\t<string>0.3.0-beta.1</string>\n</dict>";
        assert_eq!(plist_string(plist, "CFBundleExecutable").as_deref(), Some("UwUMail"));
        assert_eq!(plist_string(plist, "CFBundleShortVersionString").as_deref(), Some("0.3.0-beta.1"));
        assert_eq!(plist_string(plist, "CFBundleIdentifier"), None);
    }

    #[test]
    fn escapes_the_launch_agent() {
        let agent = launch_agent(Path::new("/Users/a&b/<x>/UwUMail")).unwrap();
        assert!(agent.contains("<string>/Users/a&amp;b/&lt;x&gt;/UwUMail</string>"));
    }
}
