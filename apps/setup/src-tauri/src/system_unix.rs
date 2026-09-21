//! The parts macOS and Linux share: the home folder, processes and starting
//! programs. Nothing here goes through a shell; paths are passed as arguments.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Environment an AppImage's start script sets for the program inside it. A
/// program started from here gets a clean slate, or it would look for its
/// libraries in the (by then vanished) AppImage this setup runs from.
#[cfg(target_os = "linux")]
const APPIMAGE_ENV: &[&str] = &[
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "GDK_BACKEND",
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
    "PYTHONHOME",
    "PERLLIB",
    "QT_PLUGIN_PATH",
];

/// The user's home folder from `HOME`, which must be an absolute path.
pub fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).filter(|home| home.is_absolute())
}

fn alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    // Signal 0 only asks whether the process exists (EPERM: it does, but isn't ours).
    unsafe { libc::kill(pid, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
}

/// Waits for a process to end; true if it did in time.
pub fn wait_for_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while alive(pid) {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    true
}

/// Every process of this user whose program lies inside `folder`.
pub fn processes_in(folder: &Path) -> Vec<u32> {
    let me = std::process::id();
    running_programs()
        .into_iter()
        .filter(|(pid, path)| *pid != me && path.starts_with(folder))
        .map(|(pid, _)| pid)
        .collect()
}

#[cfg(target_os = "linux")]
fn running_programs() -> Vec<(u32, PathBuf)> {
    let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|entry| {
            let pid = entry.file_name().to_str()?.parse::<u32>().ok()?;
            // Only readable for our own processes, which are the only ones we could stop anyway.
            let program = std::fs::read_link(entry.path().join("exe")).ok()?;
            Some((pid, program))
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn running_programs() -> Vec<(u32, PathBuf)> {
    use std::os::unix::ffi::OsStrExt;
    let mut pids = vec![0 as libc::c_int; 8192];
    let size = libc::c_int::try_from(pids.len() * std::mem::size_of::<libc::c_int>()).unwrap_or(libc::c_int::MAX);
    let count = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), size) };
    let count = usize::try_from(count).unwrap_or(0).min(pids.len());
    pids[..count]
        .iter()
        .filter_map(|&pid| {
            let mut buffer = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
            let length = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
            let length = usize::try_from(length).ok().filter(|length| *length > 0)?;
            let path = PathBuf::from(std::ffi::OsStr::from_bytes(&buffer[..length]));
            Some((u32::try_from(pid).ok()?, path))
        })
        .collect()
}

/// Ends every process running from `folder`: politely first, then for good.
pub fn stop_processes_in(folder: &Path) -> Result<(), String> {
    let signal_all = |signal| {
        for pid in processes_in(folder) {
            if let Ok(pid) = libc::pid_t::try_from(pid) {
                unsafe {
                    libc::kill(pid, signal);
                }
            }
        }
    };
    let wait_all = |timeout: Duration| {
        let deadline = Instant::now() + timeout;
        while !processes_in(folder).is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    if processes_in(folder).is_empty() {
        return Ok(());
    }
    signal_all(libc::SIGTERM);
    wait_all(Duration::from_secs(8));
    signal_all(libc::SIGKILL);
    wait_all(Duration::from_secs(3));
    if processes_in(folder).is_empty() {
        Ok(())
    } else {
        Err("UwUMail is still running and couldn't be closed.".into())
    }
}

/// A command that doesn't inherit this setup's terminal or AppImage surroundings.
pub fn command(program: &Path) -> Command {
    let mut command = Command::new(program);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(target_os = "linux")]
    for name in APPIMAGE_ENV {
        command.env_remove(name);
    }
    if let Some(home) = home() {
        command.current_dir(home);
    }
    command
}

/// Starts a program in its own process group, so it outlives the setup.
pub fn spawn_detached<S: AsRef<std::ffi::OsStr>>(program: &Path, args: &[S]) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    command(program)
        .args(args)
        .process_group(0)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't start {}: {e}", program.display()))
}

/// Runs a helper program to its end; false when it is missing or fails.
pub fn run_quietly(program: &str, args: &[&std::ffi::OsStr], env: &[(&str, &Path)]) -> bool {
    let mut command = command(Path::new(program));
    command.args(args);
    for (name, value) in env {
        command.env(name, value);
    }
    command.status().is_ok_and(|status| status.success())
}

/// Sets the permission bits of a file or folder.
pub fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|e| format!("Couldn't set the permissions of {}: {e}", path.display()))
}

/// Writes a small text file in one go: next to its place first, then swapped in.
pub fn write_file(path: &Path, content: &str, mode: u32) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    let temporary = path.with_extension(format!("uwumail-{}", std::process::id()));
    let _ = std::fs::remove_file(&temporary);
    std::fs::write(&temporary, content).map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
    set_mode(&temporary, mode)?;
    std::fs::rename(&temporary, path).map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        format!("Couldn't write {}: {e}", path.display())
    })
}

/// Removes a file, but only when it is one (not a folder someone put there).
pub fn remove_file(path: &Path) {
    if path.symlink_metadata().is_ok_and(|meta| !meta.is_dir()) {
        let _ = std::fs::remove_file(path);
    }
}

/// Where the setup window keeps its own browser data: a private folder of this
/// user, never the shared temp folder.
pub fn webview_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let cache = std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .or_else(|| home().map(|home| home.join(".cache")))?;
        Some(cache.join("uwumail-setup"))
    }
    #[cfg(target_os = "macos")]
    {
        // WKWebView keeps its data per app on its own; there is no folder to pick.
        None
    }
}
