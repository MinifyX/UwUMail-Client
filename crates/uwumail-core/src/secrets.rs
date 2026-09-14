//! Passwords and OAuth refresh tokens. They live in the operating system's
//! keychain and never in the database or logs.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::Result;

const SERVICE: &str = "UwUMail";

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Secret {
    Password { password: String },
    OAuth { refresh_token: String },
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Password { .. } => f.write_str("Secret::Password(***)"),
            Self::OAuth { .. } => f.write_str("Secret::OAuth(***)"),
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
        keyring::Entry::new(SERVICE, account_id)?.set_password(&serde_json::to_string(secret)?)?;
        Ok(())
    }

    fn get(&self, account_id: &str) -> Result<Secret> {
        let raw = keyring::Entry::new(SERVICE, account_id)?.get_password()?;
        Ok(serde_json::from_str(&raw)?)
    }

    fn delete(&self, account_id: &str) -> Result<()> {
        match keyring::Entry::new(SERVICE, account_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(other) => Err(other.into()),
        }
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
    }
}
