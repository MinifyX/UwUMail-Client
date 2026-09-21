// No console window next to the setup in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
mod app;
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
mod common;

#[cfg(windows)]
mod install;
#[cfg(windows)]
mod system;

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[path = "install_unix.rs"]
mod install;
#[cfg(target_os = "linux")]
#[path = "platform_linux.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "platform_macos.rs"]
mod platform;
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[path = "system_unix.rs"]
mod system;

fn main() {
    #[cfg(windows)]
    {
        // Same for DLLs loaded later at runtime; must happen before anything else loads one.
        system::restrict_dll_search();
    }
    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    {
        app::run();
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    eprintln!("UwUMail Setup runs on Windows, macOS and Linux.");
}
