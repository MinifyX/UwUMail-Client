//! Calls into the Kotlin side (`app.uwumail.UwuBridge.call`).
//!
//! Everything crosses as a method name plus JSON, so the JNI surface stays one
//! function in each direction. The class and the application context are
//! cached while `start` runs on a Java thread, because threads created by Rust
//! can't find app classes by name.
//!
//! This uses jni 0.21 like tao and wry in the same process: jni 0.22 failed its
//! own class lookups on Android.

use std::sync::OnceLock;

use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
use jni::{JNIEnv, JavaVM};
use serde::Serialize;
use uwumail_core::Error;

struct Bridge {
    vm: JavaVM,
    class: GlobalRef,
    // Kept alive for `ndk_context`, which only stores the raw pointer.
    _context: GlobalRef,
}

static BRIDGE: OnceLock<Bridge> = OnceLock::new();

/// Remembers the VM, the bridge class and the application context. Kotlin
/// hands over the class itself: looking it up by name from native code isn't
/// reliable on every device.
pub(crate) fn init(env: &mut JNIEnv, context: &JObject, class: &JClass) -> jni::errors::Result<()> {
    if BRIDGE.get().is_some() {
        return Ok(());
    }
    let class = env.new_global_ref(class)?;
    let context = env.new_global_ref(context)?;
    let vm = env.get_java_vm()?;
    // Libraries like the DNS resolver look up the context through ndk-context.
    // SAFETY: both pointers stay valid for the whole process: the VM never goes
    // away and the global reference lives in the static below.
    unsafe {
        ndk_context::initialize_android_context(vm.get_java_vm_pointer().cast(), context.as_obj().as_raw().cast())
    };
    let _ = BRIDGE.set(Bridge { vm, class, _context: context });
    Ok(())
}

/// Runs `UwuBridge.call(method, json)` and returns what it answered, if anything.
/// A Kotlin exception comes back as an error.
pub fn call(method: &str, payload: &impl Serialize) -> Result<Option<String>, Error> {
    let bridge = BRIDGE.get().ok_or_else(|| Error::internal("The Android bridge isn't ready yet."))?;
    let payload = serde_json::to_string(payload)?;
    let fail = |error: jni::errors::Error| Error::internal(format!("Android call {method} failed: {error}"));
    // Nested on Java threads, attached for the call on Rust threads.
    let mut env = bridge.vm.attach_current_thread().map_err(fail)?;
    let result = (|| -> jni::errors::Result<Option<String>> {
        let name = env.new_string(method)?;
        let payload = env.new_string(&payload)?;
        let answer = env
            .call_static_method(
                &bridge.class,
                "call",
                "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&name), JValue::Object(&payload)],
            )?
            .l()?;
        if answer.is_null() {
            return Ok(None);
        }
        let answer = JString::from(answer);
        let text: String = env.get_string(&answer)?.into();
        Ok(Some(text))
    })();
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    result.map_err(fail)
}

/// Like [`call`], for calls whose answer is JSON.
pub fn call_json<T: serde::de::DeserializeOwned>(method: &str, payload: &impl Serialize) -> Result<Option<T>, Error> {
    match call(method, payload)? {
        Some(answer) => Ok(Some(serde_json::from_str(&answer)?)),
        None => Ok(None),
    }
}
