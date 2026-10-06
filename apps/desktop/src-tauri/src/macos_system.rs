//! macOS: what the DMG's setup does for UwUMail, from inside the app — for the Mac App Store
//! build, which has no setup (docs/app-store.md).
//!
//! - The default mail app: Launch Services' handler for `mailto:`, set for this app's own bundle
//!   ID (`app.uwumail` from the store, `app.uwumail.desktop` from the DMG). Works in the sandbox.
//! - Opening at login: the app as a login item of the system (`SMAppService.mainAppService`,
//!   macOS 13 and later), listed under System Settings → General → Login Items. Only the store
//!   build manages it: the DMG's setup has its LaunchAgent (`--autostart`, hidden in the tray),
//!   and two would start UwUMail twice.

use std::ffi::c_void;

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2_foundation::NSString;
use serde_json::json;
use uwumail_core::Error;

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
    fn CFBundleGetMainBundle() -> CFTypeRef;
    fn CFBundleGetIdentifier(bundle: CFTypeRef) -> CFTypeRef;
    fn CFRelease(object: CFTypeRef);
}

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn LSSetDefaultHandlerForURLScheme(scheme: CFTypeRef, bundle_id: CFTypeRef) -> OSStatus;
    fn LSCopyDefaultHandlerForURLScheme(scheme: CFTypeRef) -> CFTypeRef;
}

// SMAppService lives here; linked so the class can be looked up at run time (absent before 13).
#[link(name = "ServiceManagement", kind = "framework")]
unsafe extern "C" {}

/// An owned CoreFoundation object, released when dropped.
struct Owned(CFTypeRef);

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}

fn cf_string(text: &str) -> Owned {
    Owned(unsafe { CFStringCreateWithBytes(std::ptr::null(), text.as_ptr(), text.len() as isize, UTF8, 0) })
}

fn rust_string(string: CFTypeRef) -> Option<String> {
    if string.is_null() {
        return None;
    }
    let mut buffer = [0u8; 512];
    let ok = unsafe { CFStringGetCString(string, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) };
    let end = buffer.iter().position(|b| *b == 0).unwrap_or(0);
    (ok != 0).then(|| String::from_utf8_lossy(&buffer[..end]).into_owned())
}

/// This app's bundle ID; `None` when started outside a bundle (`cargo run`).
fn own_bundle_id() -> Option<String> {
    // Both are "Get" functions: nothing to release.
    let bundle = unsafe { CFBundleGetMainBundle() };
    if bundle.is_null() {
        return None;
    }
    rust_string(unsafe { CFBundleGetIdentifier(bundle) })
}

fn is_default_mail() -> bool {
    let scheme = cf_string("mailto");
    let handler = Owned(unsafe { LSCopyDefaultHandlerForURLScheme(scheme.0) });
    match (rust_string(handler.0), own_bundle_id()) {
        (Some(handler), Some(own)) => handler.eq_ignore_ascii_case(&own),
        _ => false,
    }
}

pub fn make_default_mail() -> Result<(), Error> {
    let own = own_bundle_id().ok_or_else(|| Error::invalid("UwUMail isn't running as an app."))?;
    let (scheme, id) = (cf_string("mailto"), cf_string(&own));
    match unsafe { LSSetDefaultHandlerForURLScheme(scheme.0, id.0) } {
        0 => Ok(()),
        status => Err(Error::internal(format!("macOS didn't make UwUMail the default mail app ({status})."))),
    }
}

/// `SMAppService.mainAppService`, on macOS 13 and later, in the store build only.
fn main_app_service() -> Option<Retained<AnyObject>> {
    if !cfg!(feature = "store") {
        return None;
    }
    let class = AnyClass::get(c"SMAppService")?;
    unsafe { msg_send![class, mainAppService] }
}

/// SMAppServiceStatus: 0 not registered, 1 enabled, 2 waiting for approval, 3 not found.
fn login_item() -> Option<&'static str> {
    let service = main_app_service()?;
    let status: isize = unsafe { msg_send![&*service, status] };
    Some(match status {
        1 => "on",
        2 => "approval",
        _ => "off",
    })
}

pub fn set_login_item(enabled: bool) -> Result<(), Error> {
    let service = main_app_service().ok_or_else(|| Error::invalid("Opening at login needs macOS 13 or later."))?;
    let result: Result<(), Retained<AnyObject>> = unsafe {
        if enabled {
            msg_send![&*service, registerAndReturnError: _]
        } else {
            msg_send![&*service, unregisterAndReturnError: _]
        }
    };
    let Err(error) = result else { return Ok(()) };
    let description: Option<Retained<NSString>> = unsafe { msg_send![&*error, localizedDescription] };
    let reason = description.map(|text| text.to_string()).unwrap_or_default();
    Err(Error::internal(format!("macOS didn't change the login item: {reason}")))
}

/// What the settings show: `{ defaultMail, loginItem }`, `loginItem` null where UwUMail doesn't
/// manage it.
pub fn status() -> serde_json::Value {
    json!({ "defaultMail": is_default_mail(), "loginItem": login_item() })
}
