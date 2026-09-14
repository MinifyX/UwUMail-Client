// No console window next to the setup in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod app;
#[cfg(windows)]
mod install;
#[cfg(windows)]
mod system;

fn main() {
    #[cfg(windows)]
    {
        // Same for DLLs loaded later at runtime; must happen before anything else loads one.
        system::restrict_dll_search();
        app::run();
    }
    #[cfg(not(windows))]
    eprintln!("UwUMail Setup is the Windows installer. Other systems use their own packages.");
}
