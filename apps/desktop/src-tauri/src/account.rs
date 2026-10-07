//! What a mailbox's UwUMail server keeps for the person (masked addresses, the own profile
//! picture, sharing calendars), and contact photos at Microsoft and Google. The engine does the
//! work with the login it holds; these commands only hand it on.

use tauri::State;
use uwumail_core::engine::ServerAccountFeatures;
use uwumail_core::jmap_masked::{MaskedAddress, MaskedInput, MaskedPatch};
use uwumail_core::jmap_profile::{ProfilePatch, ProfilePicture};
use uwumail_core::model::Person;
use uwumail_core::{Engine, Error};

type CommandResult<T> = Result<T, Error>;

/// Per mailbox on a UwUMail server: masked addresses and profile picture, where it has them.
#[tauri::command]
pub async fn server_account_features(engine: State<'_, Engine>) -> CommandResult<Vec<ServerAccountFeatures>> {
    engine.server_account_features().await
}

#[tauri::command]
pub async fn masked_addresses(engine: State<'_, Engine>, account_id: String) -> CommandResult<Vec<MaskedAddress>> {
    engine.masked_addresses(&account_id).await
}

#[tauri::command]
pub async fn create_masked_address(
    engine: State<'_, Engine>,
    account_id: String,
    input: MaskedInput,
) -> CommandResult<MaskedAddress> {
    engine.create_masked_address(&account_id, &input).await
}

#[tauri::command]
pub async fn update_masked_address(
    engine: State<'_, Engine>,
    account_id: String,
    id: String,
    patch: MaskedPatch,
) -> CommandResult<()> {
    engine.update_masked_address(&account_id, &id, &patch).await
}

#[tauri::command]
pub async fn profile_picture(engine: State<'_, Engine>, account_id: String) -> CommandResult<ProfilePicture> {
    engine.profile_picture(&account_id).await
}

/// A new picture as a `data:` URI the page cropped, or `None` to remove it.
#[tauri::command]
pub async fn set_profile_picture(
    engine: State<'_, Engine>,
    account_id: String,
    picture: Option<String>,
) -> CommandResult<ProfilePicture> {
    engine.set_profile_picture(&account_id, picture.as_deref()).await
}

#[tauri::command]
pub async fn update_profile_picture(
    engine: State<'_, Engine>,
    account_id: String,
    patch: ProfilePatch,
) -> CommandResult<()> {
    engine.update_profile_picture(&account_id, &patch).await
}

#[tauri::command]
pub async fn calendar_people(engine: State<'_, Engine>, account_id: String) -> CommandResult<Vec<Person>> {
    engine.calendar_people(&account_id).await
}

/// `level` is `read`, `write` or `all`; `None` stops sharing with the person.
#[tauri::command]
pub async fn share_calendar(
    engine: State<'_, Engine>,
    calendar_id: String,
    person_id: String,
    level: Option<String>,
) -> CommandResult<()> {
    engine.share_calendar(&calendar_id, &person_id, level.as_deref()).await
}

/// The photo Microsoft or Google keeps for a contact, as a `data:` URI.
#[tauri::command]
pub async fn contact_photo(engine: State<'_, Engine>, card_id: String) -> CommandResult<Option<String>> {
    engine.contact_photo(&card_id).await
}

/// Renames a mailbox; an empty name calls it by its address again.
#[tauri::command]
pub fn rename_account(engine: State<'_, Engine>, account_id: String, name: String) -> CommandResult<()> {
    engine.rename_account(&account_id, &name)
}

/// Whether a password mailbox's server signs in with UwUMail (for signing in again that way).
#[tauri::command]
pub async fn uwumail_login_available(engine: State<'_, Engine>, account_id: String) -> CommandResult<bool> {
    engine.uwumail_login_available(&account_id).await
}

/// Signs a mailbox in again with UwUMail: a new app password named `name` replaces its password.
#[tauri::command]
pub async fn uwumail_sign_in_again(
    engine: State<'_, Engine>,
    account_id: String,
    name: String,
) -> CommandResult<uwumail_core::model::Account> {
    engine.uwumail_sign_in_again(&account_id, &name).await
}

/// What this computer is called, for naming its app password. `None` on phones, whose page knows
/// better ("iPhone", the Android model), and wherever the system doesn't say.
#[tauri::command]
pub fn device_name() -> Option<String> {
    computer_name().map(|name| name.trim().to_string()).filter(|name| !name.is_empty())
}

/// "Lorin's MacBook Pro", as in System Settings › General › Sharing; the host name otherwise.
#[cfg(target_os = "macos")]
fn computer_name() -> Option<String> {
    use std::ffi::{CStr, c_char, c_void};
    #[link(name = "SystemConfiguration", kind = "framework")]
    unsafe extern "C" {
        fn SCDynamicStoreCopyComputerName(store: *const c_void, encoding: *mut u32) -> *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringGetCString(string: *const c_void, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
        fn CFRelease(object: *const c_void);
    }
    const UTF8: u32 = 0x0800_0100;
    // SAFETY: a null store asks the system's own; the copied string is released once, after reading.
    let named = unsafe {
        let name = SCDynamicStoreCopyComputerName(std::ptr::null(), std::ptr::null_mut());
        if name.is_null() {
            None
        } else {
            let mut buffer = [0 as c_char; 256];
            let read = CFStringGetCString(name, buffer.as_mut_ptr(), buffer.len() as isize, UTF8);
            CFRelease(name);
            (read != 0).then(|| CStr::from_ptr(buffer.as_ptr()).to_string_lossy().into_owned())
        }
    };
    named.or_else(|| {
        let mut buffer = [0 as c_char; 256];
        // SAFETY: the buffer is as long as said, and gethostname ends the name with a zero there.
        let ok = unsafe { libc::gethostname(buffer.as_mut_ptr(), buffer.len()) } == 0;
        // SAFETY: gethostname wrote a zero-terminated name into the buffer.
        let host = ok.then(|| unsafe { CStr::from_ptr(buffer.as_ptr()) }.to_string_lossy().into_owned())?;
        Some(readable_host_name(&host))
    })
}

#[cfg(target_os = "windows")]
fn computer_name() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

#[cfg(target_os = "linux")]
fn computer_name() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .or_else(|_| std::fs::read_to_string("/etc/hostname"))
        .ok()
        .map(|host| readable_host_name(&host))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn computer_name() -> Option<String> {
    None
}

/// `lorins-laptop.local` → `lorins laptop`.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn readable_host_name(host: &str) -> String {
    let host = host.trim();
    let host = host.strip_suffix(".local").or_else(|| host.strip_suffix(".lan")).unwrap_or(host);
    host.split('.').next().unwrap_or(host).replace(['-', '_'], " ")
}

#[cfg(test)]
mod tests {
    use super::readable_host_name;

    #[test]
    fn host_names_read_like_names() {
        assert_eq!(readable_host_name("Lorins-MacBook-Pro.local\n"), "Lorins MacBook Pro");
        assert_eq!(readable_host_name("nyop-desktop"), "nyop desktop");
        assert_eq!(readable_host_name("box.example.com"), "box");
    }
}
