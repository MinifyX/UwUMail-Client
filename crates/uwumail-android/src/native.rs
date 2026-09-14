//! The native methods of `app.uwumail.UwuNative`. The exported `Java_…`
//! symbols live in the app library and forward here.

use jni::EnvUnowned;
use jni::errors::ThrowRuntimeExAndDefault;
use jni::objects::{JObject, JString};

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

/// `UwuNative.start(context, dataDir)`, from `UwuApplication.onCreate`:
/// connects the bridge and starts the engine for this process.
pub fn start<'caller>(
    mut env: EnvUnowned<'caller>,
    context: JObject<'caller>,
    data_dir: JString<'caller>,
    cache_dir: JString<'caller>,
) {
    env.with_env(|env| -> Result<(), NativeError> {
        crate::bridge::init(env, &context)?;
        #[cfg(target_os = "android")]
        {
            // Certificates are checked by Android itself, including ones the user installed.
            let context = env.new_local_ref(&context)?;
            rustls_platform_verifier::android::init_with_env(env, context)?;
        }
        let data_dir = data_dir.try_to_string(env)?;
        let cache_dir = cache_dir.try_to_string(env)?;
        crate::host::start_engine(data_dir.into(), cache_dir.into())?;
        Ok(())
    })
    .resolve::<ThrowRuntimeExAndDefault>()
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
        Ok(match crate::host::handle(&method, &payload)? {
            Some(answer) => JString::from_str(env, answer)?,
            None => JString::default(),
        })
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}
