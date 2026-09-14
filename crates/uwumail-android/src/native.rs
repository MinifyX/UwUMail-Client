//! The native methods of `app.uwumail.UwuNative`. The exported `Java_…`
//! symbols live in the app library and forward here.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU8, Ordering};

use jni::JNIEnv;
use jni::objects::{JClass, JObject, JString};
use jni::sys::jstring;

/// Writes to the Android log (tag UwUMail), also before Rust's stdout is piped there.
#[cfg(target_os = "android")]
pub fn log(message: &str) {
    #[link(name = "log")]
    unsafe extern "C" {
        fn __android_log_write(priority: i32, tag: *const std::ffi::c_char, text: *const std::ffi::c_char) -> i32;
    }
    let text = std::ffi::CString::new(message.replace('\0', " ")).unwrap_or_default();
    // SAFETY: both strings are NUL-terminated and outlive the call.
    unsafe {
        __android_log_write(4, c"UwUMail".as_ptr(), text.as_ptr());
    }
}

#[cfg(not(target_os = "android"))]
pub fn log(message: &str) {
    eprintln!("UwUMail: {message}");
}

/// How far `start` got: 1 bridge, 2 engine. For `status`.
static STARTED: AtomicU8 = AtomicU8::new(0);
static START_ERROR: Mutex<Option<String>> = Mutex::new(None);

pub(crate) fn started() -> u8 {
    STARTED.load(Ordering::Relaxed)
}

pub(crate) fn start_error() -> Option<String> {
    START_ERROR.lock().unwrap().clone()
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    panic
        .downcast_ref::<&str>()
        .map(|text| text.to_string())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into())
}

/// Clears a Java exception a failed JNI call left behind, with its stack trace in logcat.
fn clear_exception(env: &JNIEnv) {
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
}

/// `UwuNative.start(context, bridge, dataDir, cacheDir)`, from
/// `UwuApplication.onCreate`: connects the bridge and starts the engine for
/// this process. Failures are logged and kept for `status`; the window then
/// starts the engine itself.
pub fn start(mut env: JNIEnv, context: JObject, bridge: JClass, data_dir: JString, cache_dir: JString) {
    log("native start");
    let outcome = catch_unwind(AssertUnwindSafe(|| -> Result<(), String> {
        crate::bridge::init(&mut env, &context, &bridge).map_err(|e| format!("bridge: {e}"))?;
        STARTED.store(1, Ordering::Relaxed);
        log("bridge ready");
        let data_dir: String = env.get_string(&data_dir).map_err(|e| format!("data folder: {e}"))?.into();
        let cache_dir: String = env.get_string(&cache_dir).map_err(|e| format!("cache folder: {e}"))?.into();
        crate::host::start_engine(data_dir.into(), cache_dir.into()).map_err(|e| e.to_string())?;
        STARTED.store(2, Ordering::Relaxed);
        log("engine running");
        Ok(())
    }))
    .unwrap_or_else(|panic| Err(format!("panic: {}", panic_message(panic.as_ref()))));
    if let Err(error) = outcome {
        log(&format!("start failed: {error}"));
        clear_exception(&env);
        *START_ERROR.lock().unwrap() = Some(error);
    }
}

/// `UwuNative.call(method, json)`: see [`crate::host::handle`]. Errors reach
/// Kotlin as a `RuntimeException`.
pub fn call(mut env: JNIEnv, method: JString, payload: JString) -> jstring {
    let outcome = catch_unwind(AssertUnwindSafe(|| -> Result<Option<String>, String> {
        let method: String = env.get_string(&method).map_err(|e| e.to_string())?.into();
        let payload: String = env.get_string(&payload).map_err(|e| e.to_string())?.into();
        log(&format!("call {method}"));
        crate::host::handle(&method, &payload).map_err(|e| e.to_string())
    }))
    .unwrap_or_else(|panic| Err(format!("panic: {}", panic_message(panic.as_ref()))));
    match outcome {
        Ok(Some(answer)) => match env.new_string(answer) {
            Ok(answer) => answer.into_raw(),
            Err(error) => {
                clear_exception(&env);
                let _ = env.throw_new("java/lang/RuntimeException", error.to_string());
                std::ptr::null_mut()
            }
        },
        Ok(None) => std::ptr::null_mut(),
        Err(error) => {
            log(&format!("call failed: {error}"));
            clear_exception(&env);
            let _ = env.throw_new("java/lang/RuntimeException", error);
            std::ptr::null_mut()
        }
    }
}
