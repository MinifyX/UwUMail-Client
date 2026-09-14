//! Calls into the Kotlin side (`app.uwumail.UwuBridge.call`).
//!
//! Everything crosses as a method name plus JSON, so the JNI surface stays one
//! function in each direction. The class and the application context are
//! cached while `start` runs on a Java thread, because threads created by Rust
//! can't find app classes by name.

use std::sync::OnceLock;

use jni::objects::{Global, JClass, JObject, JString, JValue};
use jni::{Env, JavaVM, jni_sig, jni_str};
// `Reference` provides `as_raw`/`is_null` on JNI references.
use jni::refs::Reference;
use serde::Serialize;
use uwumail_core::Error;

struct Bridge {
    vm: JavaVM,
    class: Global<JClass<'static>>,
    // Kept alive for `ndk_context`, which only stores the raw pointer.
    _context: Global<JObject<'static>>,
}

static BRIDGE: OnceLock<Bridge> = OnceLock::new();

/// Remembers the VM, the bridge class and the application context.
/// Must run on a thread that Java called into.
pub(crate) fn init(env: &mut Env, context: &JObject) -> jni::errors::Result<()> {
    if BRIDGE.get().is_some() {
        return Ok(());
    }
    let class = env.find_class(jni_str!("app/uwumail/UwuBridge"))?;
    let class = env.new_global_ref(class)?;
    let context = env.new_global_ref(context)?;
    let vm = env.get_java_vm()?;
    // Libraries like the DNS resolver look up the context through ndk-context.
    // SAFETY: both pointers stay valid for the whole process: the VM never goes
    // away and the global reference lives in the static below.
    unsafe { ndk_context::initialize_android_context(vm.get_raw().cast(), context.as_raw().cast()) };
    let _ = BRIDGE.set(Bridge { vm, class, _context: context });
    Ok(())
}

/// Runs `UwuBridge.call(method, json)` and returns what it answered, if anything.
/// A Kotlin exception comes back as an error with its message.
pub fn call(method: &str, payload: &impl Serialize) -> Result<Option<String>, Error> {
    let bridge = BRIDGE.get().ok_or_else(|| Error::internal("The Android bridge isn't ready yet."))?;
    let payload = serde_json::to_string(payload)?;
    bridge
        .vm
        .attach_current_thread(|env| -> jni::errors::Result<Option<String>> {
            let name = JString::from_str(env, method)?;
            let payload = JString::from_str(env, &payload)?;
            let answer = env
                .call_static_method(
                    &bridge.class,
                    jni_str!("call"),
                    jni_sig!("(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;"),
                    &[JValue::Object(&name), JValue::Object(&payload)],
                )?
                .l()?;
            if answer.is_null() {
                return Ok(None);
            }
            let answer = env.cast_local::<JString>(answer)?;
            Ok(Some(answer.try_to_string(env)?))
        })
        .map_err(|error| Error::internal(format!("Android call {method} failed: {error}")))
}

/// Like [`call`], for calls whose answer is JSON.
pub fn call_json<T: serde::de::DeserializeOwned>(method: &str, payload: &impl Serialize) -> Result<Option<T>, Error> {
    match call(method, payload)? {
        Some(answer) => Ok(Some(serde_json::from_str(&answer)?)),
        None => Ok(None),
    }
}
