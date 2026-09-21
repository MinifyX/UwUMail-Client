//! What the setup does the same way on every system: the packed app, the
//! options, the steps it reports and the rule that updates never go back.

use serde::{Deserialize, Serialize};

/// The app this setup installs, compressed by build.rs. On Windows it is the
/// program itself; on macOS and Linux a tar of the app's folder.
pub static PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/payload.zst"));
/// Unpacked size of [`PAYLOAD`], for the progress bar.
pub const PAYLOAD_SIZE: &str = env!("UWUMAIL_SETUP_PAYLOAD_SIZE");

pub fn has_payload() -> bool {
    !PAYLOAD.is_empty()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub dir: String,
    pub desktop_shortcut: bool,
    pub autostart: bool,
    pub default_mail_app: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub dir: String,
    pub version: Option<String>,
    /// Installed by the old standard installer (Windows only).
    pub legacy: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Step {
    Prepare,
    Copy,
    Shortcuts,
    Register,
    Cleanup,
    Done,
}

pub type Progress<'a> = &'a mut dyn FnMut(Step, f64);

/// The version in an update feed isn't signed, only the setup is. So an update may carry an
/// older (validly signed) setup; it must not replace a newer UwUMail.
pub fn check_not_older(installed: Option<&str>, update: &str) -> Result<(), String> {
    let parse = |version: &str| semver::Version::parse(version.trim()).ok();
    match (installed.and_then(parse), parse(update)) {
        (Some(installed), Some(update)) if update < installed => Err(format!(
            "UwUMail {installed} is already installed. This update is older ({update}), so it was skipped."
        )),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updates_never_go_back() {
        assert!(check_not_older(Some("0.3.0"), "0.2.0-beta.1").is_err());
        assert!(check_not_older(Some("0.2.0"), "0.2.0-beta.1").is_err());
        assert!(check_not_older(Some("0.3.0-beta.1"), "0.3.0-beta.2").is_ok());
        assert!(check_not_older(Some("0.2.0-beta.1"), "0.2.0-beta.2").is_ok());
        assert!(check_not_older(Some("0.2.0-beta.1"), "0.2.0-beta.1").is_ok(), "repairing is fine");
        assert!(check_not_older(None, "0.2.0").is_ok());
        assert!(check_not_older(Some("unknown"), "0.2.0").is_ok());
    }
}
