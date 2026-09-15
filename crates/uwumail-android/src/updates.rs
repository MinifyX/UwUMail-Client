//! Updates on Android, like on Windows: look for a new version on the `updates`
//! branch of the public repo, download the APK quietly and let the UI offer it.
//! Android itself refuses an APK that isn't signed with UwUMail's key, the
//! checksum from the feed guards against broken downloads.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use uwumail_core::{Error, Result};

use crate::bridge;

const FEED: &str = "https://raw.githubusercontent.com/MinifyX/UwUMail-Client/updates";
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(20);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// A phone often starts without network; one quick second try instead of waiting hours.
const RETRY_AFTER: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    #[default]
    Stable,
    Beta,
}

/// A downloaded update waiting to be installed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyUpdate {
    pub version: String,
    pub notes: Option<String>,
    pub file: PathBuf,
}

/// `android-stable.json` / `android-beta.json` on the `updates` branch.
#[derive(Deserialize)]
struct Feed {
    version: String,
    url: String,
    sha256: String,
    #[serde(default)]
    notes: Option<serde_json::Value>,
}

struct State {
    http: reqwest::Client,
    on_ready: Box<dyn Fn(&ReadyUpdate) + Send + Sync>,
}

static STATE: OnceLock<State> = OnceLock::new();
static CHANNEL: Mutex<Channel> = Mutex::new(Channel::Stable);
static READY: Mutex<Option<ReadyUpdate>> = Mutex::new(None);
static CHECKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn state() -> Result<&'static State> {
    STATE.get().ok_or_else(|| Error::internal("Updates aren't set up yet."))
}

fn is_newer(version: &str) -> bool {
    let current = semver::Version::parse(env!("CARGO_PKG_VERSION")).expect("the package version is semver");
    semver::Version::parse(version).is_ok_and(|found| found > current)
}

pub fn set_channel(channel: Channel) {
    *CHANNEL.lock().unwrap() = channel;
}

pub fn ready() -> Option<ReadyUpdate> {
    READY.lock().unwrap().clone()
}

/// Looks for a newer version and downloads it. Returns the waiting update, if any.
pub async fn check() -> Result<Option<ReadyUpdate>> {
    let _one_at_a_time = CHECKING.lock().await;
    if let Some(update) = ready() {
        return Ok(Some(update));
    }
    let state = state()?;
    let name = match *CHANNEL.lock().unwrap() {
        Channel::Stable => "android-stable.json",
        Channel::Beta => "android-beta.json",
    };
    let response = state.http.get(format!("{FEED}/{name}")).send().await?;
    // No Android release published yet.
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let feed: Feed = response.error_for_status()?.json().await?;
    if !is_newer(&feed.version) {
        return Ok(None);
    }

    let bytes = state.http.get(&feed.url).timeout(Duration::from_secs(600)).send().await?.error_for_status()?;
    let bytes = bytes.bytes().await?;
    let digest: String = Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect();
    if !digest.eq_ignore_ascii_case(feed.sha256.trim()) {
        return Err(Error::connection("The downloaded update is damaged. UwUMail will try again later."));
    }
    let dir = crate::host::cache_dir().join("updates");
    // Only the newest download is kept.
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("UwUMail-{}.apk", feed.version));
    std::fs::write(&file, &bytes)?;

    let update = ReadyUpdate { version: feed.version, notes: feed.notes.map(|notes| notes.to_string()), file };
    *READY.lock().unwrap() = Some(update.clone());
    (state.on_ready)(&update);
    Ok(Some(update))
}

/// "Update now": opens Android's installer for the downloaded APK.
pub fn install_now() -> Result<()> {
    let update = ready().ok_or_else(|| Error::not_found("There's no update waiting."))?;
    bridge::call("installApk", &json!({ "path": update.file }))?;
    Ok(())
}

/// Checks in the background for as long as UwUMail runs.
pub fn start(on_ready: impl Fn(&ReadyUpdate) + Send + Sync + 'static) {
    let http = match uwumail_core::tls::http_client().and_then(|builder| {
        builder
            .user_agent(concat!("UwUMail/", env!("CARGO_PKG_VERSION"), " (Android)"))
            .timeout(Duration::from_secs(60))
            // The feed and the APK only come over HTTPS, redirects included.
            .https_only(true)
            .build()
            .map_err(|e| Error::internal(format!("HTTP client setup failed: {e}")))
    }) {
        Ok(http) => http,
        Err(error) => {
            crate::native::log(&format!("updates are off: {error}"));
            return;
        }
    };
    if STATE.set(State { http, on_ready: Box::new(on_ready) }).is_err() {
        return;
    }
    crate::host::runtime().spawn(async {
        tokio::time::sleep(FIRST_CHECK_AFTER).await;
        let mut retried = false;
        loop {
            // In logcat too: the emulator test reads it to know HTTPS works.
            let wait = match check().await {
                Ok(Some(update)) => {
                    crate::native::log(&format!("update check: {} is ready", update.version));
                    CHECK_EVERY
                }
                Ok(None) => {
                    crate::native::log("update check: nothing new");
                    CHECK_EVERY
                }
                Err(error) => {
                    crate::native::log(&format!("update check failed: {error}"));
                    if retried { CHECK_EVERY } else { RETRY_AFTER }
                }
            };
            retried = wait == RETRY_AFTER;
            tokio::time::sleep(wait).await;
        }
    });
}
