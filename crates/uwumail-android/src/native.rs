//! The native methods of `app.uwumail.UwuNative`. The exported `Java_…`
//! symbols live in the app library and forward here.

use std::sync::atomic::{AtomicU8, Ordering};

use jni::EnvUnowned;
use jni::errors::ThrowRuntimeExAndDefault;
use jni::objects::{JClass, JObject, JString};

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

/// How far `start` got: 1 bridge, 2 certificate checks, 3 engine. For `status`.
static STARTED: AtomicU8 = AtomicU8::new(0);

pub(crate) fn started() -> u8 {
    STARTED.load(Ordering::Relaxed)
}

/// Whether HTTPS and TLS can check certificates yet; using them before panics.
pub fn certificates_ready() -> bool {
    !cfg!(target_os = "android") || started() >= 2
}

#[derive(Debug)]
pub enum NativeError {
    Jni(jni::errors::Error),
    Engine(uwumail_core::Error),
}

impl std::fmt::Display for NativeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Jni(error) => write!(f, "JNI: {error}"),
            Self::Engine(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for NativeError {}

impl From<jni::errors::Error> for NativeError {
    fn from(error: jni::errors::Error) -> Self {
        Self::Jni(error)
    }
}

impl From<uwumail_core::Error> for NativeError {
    fn from(error: uwumail_core::Error) -> Self {
        Self::Engine(error)
    }
}

/// `UwuNative.start(context, bridge, dataDir, cacheDir)`, from
/// `UwuApplication.onCreate`: connects the bridge and starts the engine for
/// this process.
pub fn start<'caller>(
    mut env: EnvUnowned<'caller>,
    context: JObject<'caller>,
    bridge: JClass<'caller>,
    data_dir: JString<'caller>,
    cache_dir: JString<'caller>,
) {
    env.with_env(|env| -> Result<(), NativeError> {
        log("native start");
        let outcome = (|| -> Result<(), NativeError> {
            crate::bridge::init(env, &context, &bridge)?;
            STARTED.store(1, Ordering::Relaxed);
            log("bridge ready");
            #[cfg(target_os = "android")]
            {
                // Certificates are checked by Android itself, including ones the user installed.
                let context = env.new_local_ref(&context)?;
                rustls_platform_verifier::android::init_with_env(env, context)?;
            }
            STARTED.store(2, Ordering::Relaxed);
            log("certificate checks ready");
            let data_dir = data_dir.try_to_string(env)?;
            let cache_dir = cache_dir.try_to_string(env)?;
            crate::host::start_engine(data_dir.into(), cache_dir.into())?;
            STARTED.store(3, Ordering::Relaxed);
            log("engine running");
            Ok(())
        })();
        if let Err(error) = &outcome {
            log(&format!("start failed: {error}"));
            if env.exception_check() {
                // The stack trace goes to logcat; Kotlin reports the failure.
                env.exception_describe();
                env.exception_clear();
            }
            *START_ERROR.lock().unwrap() = Some(error.to_string());
        }
        outcome
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

static START_ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub(crate) fn start_error() -> Option<String> {
    START_ERROR.lock().unwrap().clone()
}

/// `UwuNative.call(method, json)`: see [`crate::host::handle`].
pub fn call<'caller>(
    mut env: EnvUnowned<'caller>,
    method: JString<'caller>,
    payload: JString<'caller>,
) -> JString<'caller> {
    env.with_env(|env| -> Result<JString<'caller>, NativeError> {
        let method = method.try_to_string(env)?;
        let payload = payload.try_to_string(env)?;
        log(&format!("call {method}"));
        Ok(match crate::host::handle(&method, &payload)? {
            Some(answer) => JString::from_str(env, answer)?,
            None => JString::default(),
        })
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}
