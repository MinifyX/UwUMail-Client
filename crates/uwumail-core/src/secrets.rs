//! Passwords and OAuth refresh tokens. They live in the operating system's
//! keychain and never in the database or logs.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::oauth::MicrosoftApp;

const SERVICE: &str = "UwUMail";

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Secret {
    Password {
        password: String,
    },
    OAuth {
        refresh_token: String,
        /// Microsoft: the app the refresh token was issued to, which is the only one that can
        /// redeem it. Missing in secrets saved before there were two apps: those are all `Personal`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        microsoft_app: Option<MicrosoftApp>,
    },
    /// The key of an AI provider set up on this device (entry `assist-provider:<id>`).
    #[serde(rename = "apikey")]
    ApiKey {
        api_key: String,
    },
}

impl Secret {
    /// An OAuth refresh token, with the Microsoft app it was issued to (`None` for Google).
    pub fn oauth(refresh_token: impl Into<String>, microsoft_app: Option<MicrosoftApp>) -> Self {
        Self::OAuth { refresh_token: refresh_token.into(), microsoft_app }
    }

    /// The Microsoft app an OAuth secret's refresh token belongs to; secrets from before there
    /// were two apps belong to the personal one.
    pub fn microsoft_app(&self) -> MicrosoftApp {
        match self {
            Self::OAuth { microsoft_app, .. } => microsoft_app.unwrap_or_default(),
            _ => MicrosoftApp::Personal,
        }
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Password { .. } => f.write_str("Secret::Password(***)"),
            Self::OAuth { .. } => f.write_str("Secret::OAuth(***)"),
            Self::ApiKey { .. } => f.write_str("Secret::ApiKey(***)"),
        }
    }
}

pub trait SecretStore: Send + Sync {
    fn set(&self, account_id: &str, secret: &Secret) -> Result<()>;
    fn get(&self, account_id: &str) -> Result<Secret>;
    fn delete(&self, account_id: &str) -> Result<()>;
}

/// The OS keychain: Windows Credential Manager, macOS Keychain, Secret Service on Linux.
pub struct KeyringSecrets;

impl SecretStore for KeyringSecrets {
    fn set(&self, account_id: &str, secret: &Secret) -> Result<()> {
        chunked::set(&OsKeychain, account_id, &serde_json::to_string(secret)?)
    }

    fn get(&self, account_id: &str) -> Result<Secret> {
        Ok(serde_json::from_str(&chunked::get(&OsKeychain, account_id)?)?)
    }

    fn delete(&self, account_id: &str) -> Result<()> {
        chunked::delete(&OsKeychain, account_id)
    }
}

/// One keychain entry per name, without any splitting.
trait RawKeychain {
    fn set(&self, name: &str, value: &str) -> Result<()>;
    /// `None` when there is no entry.
    fn get(&self, name: &str) -> Result<Option<String>>;
    fn delete(&self, name: &str) -> Result<()>;
}

struct OsKeychain;

impl RawKeychain for OsKeychain {
    fn set(&self, name: &str, value: &str) -> Result<()> {
        keyring::Entry::new(SERVICE, name)?.set_password(value)?;
        Ok(())
    }

    fn get(&self, name: &str) -> Result<Option<String>> {
        match keyring::Entry::new(SERVICE, name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(other) => Err(other.into()),
        }
    }

    fn delete(&self, name: &str) -> Result<()> {
        match keyring::Entry::new(SERVICE, name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(other) => Err(other.into()),
        }
    }
}

/// Windows keeps at most 2560 bytes per credential, stored as UTF-16, and Microsoft's refresh tokens
/// are longer than that. Long secrets are therefore split: the entry itself only says how many parts
/// there are, and the parts live in `<name>#part<n>`. Short ones stay a single entry as before.
mod chunked {
    use super::RawKeychain;
    use crate::error::Result;

    /// Characters per entry. The secret is JSON, so ASCII almost always: 1000 UTF-16 characters are
    /// 2000 bytes, safely below Windows' limit. Other keychains don't mind.
    pub(super) const PART_CHARS: usize = 1000;
    const MARKER: &str = "uwumail-parts:";

    fn part_name(name: &str, index: usize) -> String {
        format!("{name}#part{index}")
    }

    fn parts_of(value: Option<&str>) -> usize {
        value.and_then(|v| v.strip_prefix(MARKER)).and_then(|n| n.parse().ok()).unwrap_or(0)
    }

    pub(super) fn set(keychain: &dyn RawKeychain, name: &str, value: &str) -> Result<()> {
        let old_parts = parts_of(keychain.get(name)?.as_deref());
        let chars: Vec<char> = value.chars().collect();
        let new_parts = if chars.len() <= PART_CHARS && !value.starts_with(MARKER) {
            keychain.set(name, value)?;
            0
        } else {
            let pieces: Vec<String> = chars.chunks(PART_CHARS).map(|c| c.iter().collect()).collect();
            // Parts first, the entry pointing at them last: a failed write never leaves an entry that
            // points at missing parts.
            for (index, piece) in pieces.iter().enumerate() {
                keychain.set(&part_name(name, index + 1), piece)?;
            }
            keychain.set(name, &format!("{MARKER}{}", pieces.len()))?;
            pieces.len()
        };
        for index in new_parts + 1..=old_parts {
            keychain.delete(&part_name(name, index))?;
        }
        Ok(())
    }

    pub(super) fn get(keychain: &dyn RawKeychain, name: &str) -> Result<String> {
        let Some(value) = keychain.get(name)? else {
            return Err(crate::Error::auth("No saved password for this mailbox."));
        };
        let parts = parts_of(Some(&value));
        if parts == 0 {
            return Ok(value);
        }
        let mut whole = String::new();
        for index in 1..=parts {
            match keychain.get(&part_name(name, index))? {
                Some(piece) => whole.push_str(&piece),
                None => return Err(crate::Error::auth("The saved sign-in of this mailbox is incomplete.")),
            }
        }
        Ok(whole)
    }

    pub(super) fn delete(keychain: &dyn RawKeychain, name: &str) -> Result<()> {
        let parts = parts_of(keychain.get(name)?.as_deref());
        keychain.delete(name)?;
        for index in 1..=parts {
            keychain.delete(&part_name(name, index))?;
        }
        Ok(())
    }
}

/// For tests and the CLI.
#[derive(Default)]
pub struct MemorySecrets(Mutex<HashMap<String, Secret>>);

impl SecretStore for MemorySecrets {
    fn set(&self, account_id: &str, secret: &Secret) -> Result<()> {
        self.0.lock().unwrap().insert(account_id.to_string(), secret.clone());
        Ok(())
    }

    fn get(&self, account_id: &str) -> Result<Secret> {
        self.0
            .lock()
            .unwrap()
            .get(account_id)
            .cloned()
            .ok_or_else(|| crate::Error::auth("No saved password for this mailbox."))
    }

    fn delete(&self, account_id: &str) -> Result<()> {
        self.0.lock().unwrap().remove(account_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_output_never_contains_the_secret() {
        let secret = Secret::Password { password: "hunter2".into() };
        assert!(!format!("{secret:?}").contains("hunter2"));
        let key = Secret::ApiKey { api_key: "sk-geheim".into() };
        assert!(!format!("{key:?}").contains("geheim"));
        // What the keychain (and Android's Keystore bridge) keeps: a JSON string that reads back.
        let stored = serde_json::to_string(&key).unwrap();
        assert_eq!(serde_json::from_str::<Secret>(&stored).unwrap(), key);
    }

    #[test]
    fn oauth_secrets_from_before_two_microsoft_apps_belong_to_the_personal_one() {
        // Exactly what 0.8.0-beta.1 and older wrote.
        let legacy: Secret = serde_json::from_str("{\"kind\":\"oauth\",\"refresh_token\":\"r\"}").unwrap();
        assert_eq!(legacy, Secret::oauth("r", None));
        assert_eq!(legacy.microsoft_app(), MicrosoftApp::Personal);
        // Written back unchanged, so an older version still reads it.
        assert_eq!(serde_json::to_string(&legacy).unwrap(), "{\"kind\":\"oauth\",\"refresh_token\":\"r\"}");

        let business = Secret::oauth("r", Some(MicrosoftApp::Business));
        let stored = serde_json::to_string(&business).unwrap();
        assert!(stored.contains("\"microsoft_app\":\"business\""), "{stored}");
        let read: Secret = serde_json::from_str(&stored).unwrap();
        assert_eq!(read.microsoft_app(), MicrosoftApp::Business);
    }

    /// Like Windows: refuses entries longer than 2560 bytes of UTF-16.
    #[derive(Default)]
    struct SmallKeychain(Mutex<HashMap<String, String>>);

    impl RawKeychain for SmallKeychain {
        fn set(&self, name: &str, value: &str) -> Result<()> {
            if value.encode_utf16().count() * 2 > 2560 {
                return Err(crate::Error::auth("longer than platform limit"));
            }
            self.0.lock().unwrap().insert(name.to_string(), value.to_string());
            Ok(())
        }

        fn get(&self, name: &str) -> Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(name).cloned())
        }

        fn delete(&self, name: &str) -> Result<()> {
            self.0.lock().unwrap().remove(name);
            Ok(())
        }
    }

    fn entries(keychain: &SmallKeychain) -> usize {
        keychain.0.lock().unwrap().len()
    }

    #[test]
    fn a_long_microsoft_refresh_token_fits_in_small_keychain_entries() {
        let keychain = SmallKeychain::default();
        let token = Secret::oauth("0.AXkA".repeat(700), Some(MicrosoftApp::Business));
        let json = serde_json::to_string(&token).unwrap();
        chunked::set(&keychain, "acc", &json).unwrap();
        assert_eq!(chunked::get(&keychain, "acc").unwrap(), json);
        assert_eq!(entries(&keychain), 1 + json.len().div_ceil(chunked::PART_CHARS));

        // Replaced by a short secret: the old parts go away.
        chunked::set(&keychain, "acc", "{\"kind\":\"password\",\"password\":\"x\"}").unwrap();
        assert_eq!(entries(&keychain), 1);
        assert!(chunked::get(&keychain, "acc").unwrap().contains("password"));

        chunked::set(&keychain, "acc", &json).unwrap();
        chunked::delete(&keychain, "acc").unwrap();
        assert_eq!(entries(&keychain), 0);
        assert!(chunked::get(&keychain, "acc").is_err());
    }

    #[test]
    fn short_secrets_stay_one_plain_entry_as_before() {
        let keychain = SmallKeychain::default();
        chunked::set(&keychain, "acc", "{\"kind\":\"password\",\"password\":\"hunter2\"}").unwrap();
        assert_eq!(entries(&keychain), 1);
        // An entry written by an older version reads back unchanged.
        assert!(chunked::get(&keychain, "acc").unwrap().contains("hunter2"));
    }

    #[test]
    fn a_missing_part_is_an_error_not_a_broken_token() {
        let keychain = SmallKeychain::default();
        chunked::set(&keychain, "acc", &"a".repeat(2500)).unwrap();
        keychain.delete("acc#part2").unwrap();
        assert!(chunked::get(&keychain, "acc").is_err());
    }
}
