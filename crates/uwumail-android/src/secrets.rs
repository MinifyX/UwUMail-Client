//! Passwords and refresh tokens on Android. Kotlin encrypts them with a key
//! that lives in the Android Keystore and never leaves it; only the encrypted
//! form is stored in the app's private preferences.

use serde_json::json;
use uwumail_core::Result;
use uwumail_core::secrets::{Secret, SecretStore};

use crate::bridge;

pub struct KeystoreSecrets;

impl SecretStore for KeystoreSecrets {
    fn set(&self, account_id: &str, secret: &Secret) -> Result<()> {
        let value = serde_json::to_string(secret)?;
        bridge::call("secretSet", &json!({ "account": account_id, "value": value }))?;
        Ok(())
    }

    fn get(&self, account_id: &str) -> Result<Secret> {
        match bridge::call("secretGet", &json!({ "account": account_id }))? {
            Some(value) => Ok(serde_json::from_str(&value)?),
            None => Err(uwumail_core::Error::auth("No saved password for this mailbox.")),
        }
    }

    fn delete(&self, account_id: &str) -> Result<()> {
        bridge::call("secretDelete", &json!({ "account": account_id }))?;
        Ok(())
    }
}
