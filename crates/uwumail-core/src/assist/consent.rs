//! The person's consent before the assistant sends personal data (a mail's content, a draft, the
//! label names) anywhere (App Review Guideline 5.1.2(i)): asked once per destination in a dialog
//! that names it and says what is sent, kept here, revocable in the settings.
//!
//! A destination is a provider set up on this device (`provider:<id>`) or a UwUMail server whose
//! assistant does the AI (`server:<account id>`, for its own mail and, when chosen, the mail of
//! this device's other mailboxes). A provider that runs on this computer (loopback) needs none.
//!
//! The consent is kept in `assist_settings` under `consent/<destination>` with the host and kind it
//! was given for: once a provider's address or kind changes, or a server answers from another host,
//! it no longer counts and the person is asked again. Nothing checks it but this module; every
//! request with mail to a model goes through [`require`] first (the engine before it reads the
//! mail, and `local::Device::ask` once more right before the request).

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::provider::ProviderKind;
use crate::error::{Error, Result};
use crate::store::{ProviderRecord, Store};

const PREFIX: &str = "consent/";
/// The kind of a UwUMail server's assistant, next to the providers' kinds.
pub const SERVER_KIND: &str = "uwumailServer";

/// Where the assistant would send mail, as the dialog names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Destination {
    /// `provider:<id>` or `server:<account id>`.
    pub destination: String,
    /// The provider's kind (`openai`, `ollama`, …) or [`SERVER_KIND`].
    pub kind: String,
    /// The provider's name, or the UwUMail mailbox whose server it is.
    pub name: String,
    /// Where it goes: host (and port, when not the default).
    pub host: String,
}

/// What is kept for a consent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    kind: String,
    name: String,
    host: String,
    granted_at: i64,
}

/// The host (and a port that isn't the scheme's) of an address; empty when it has none.
pub fn host_of(url: &str) -> String {
    let Ok(parsed) = url::Url::parse(url.trim()) else { return String::new() };
    let Some(host) = parsed.host_str() else { return String::new() };
    match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

/// Whether an address is on this computer itself (localhost, 127.0.0.0/8, ::1): mail sent there
/// never leaves the device. The local network is not this device.
pub fn stays_on_device(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url.trim()) else { return false };
    match parsed.host() {
        Some(url::Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback()),
        None => false,
    }
}

/// Where a provider of this device sends mail; `None` when it runs on this computer.
pub fn for_provider(record: &ProviderRecord) -> Option<Destination> {
    let default = ProviderKind::parse(&record.kind).and_then(ProviderKind::default_base_url);
    let url = record.base_url.as_deref().or(default).unwrap_or_default();
    if stays_on_device(url) {
        return None;
    }
    Some(Destination {
        destination: format!("provider:{}", record.id),
        kind: record.kind.clone(),
        name: record.name.clone(),
        host: host_of(url),
    })
}

/// Where a UwUMail server's assistant is: the server of the mailbox `account_id` (`email`), whose
/// API is at `api_url`. Always a destination: the server hands the mail on to the provider its
/// administrator chose, wherever the server itself runs.
pub fn for_server(account_id: &str, email: &str, api_url: &str) -> Destination {
    Destination {
        destination: format!("server:{account_id}"),
        kind: SERVER_KIND.into(),
        name: email.to_string(),
        host: host_of(api_url),
    }
}

fn key(destination: &str) -> String {
    format!("{PREFIX}{destination}")
}

fn grant_of(store: &Store, destination: &str) -> Result<Option<Grant>> {
    Ok(store.assist_setting(&key(destination))?.and_then(|text| serde_json::from_str(&text).ok()))
}

/// Whether the person agreed to send mail to `destination` as it is now (same host and kind).
pub fn granted(store: &Store, destination: &Destination) -> Result<bool> {
    Ok(grant_of(store, &destination.destination)?
        .is_some_and(|grant| grant.host == destination.host && grant.kind == destination.kind))
}

/// Ok when mail may go to `destination` (`None`: it stays on this device), else
/// [`Error::consent_required`] naming it. Nothing may be sent on an error.
pub fn require(store: &Store, destination: Option<Destination>) -> Result<()> {
    match destination {
        Some(destination) if !granted(store, &destination)? => Err(Error::consent_required(destination)),
        _ => Ok(()),
    }
}

/// Keeps the person's consent to `destination` as it is now.
pub fn grant(store: &Store, destination: &Destination, now: i64) -> Result<()> {
    let grant = Grant {
        kind: destination.kind.clone(),
        name: destination.name.clone(),
        host: destination.host.clone(),
        granted_at: now,
    };
    store.set_assist_setting(&key(&destination.destination), Some(&serde_json::to_string(&grant)?))
}

/// Takes a consent back: nothing more goes there until the person agrees again.
pub fn revoke(store: &Store, destination: &str) -> Result<()> {
    store.set_assist_setting(&key(destination), None)
}

/// Every consent given, for the settings: `destination`, `kind`, `name`, `host`, `grantedAt`.
pub fn list(store: &Store) -> Result<Value> {
    let consents: Vec<Value> = store
        .assist_settings_with_prefix(PREFIX)?
        .into_iter()
        .filter_map(|(key, value)| {
            let grant: Grant = serde_json::from_str(&value).ok()?;
            Some(json!({
                "destination": key.strip_prefix(PREFIX)?,
                "kind": grant.kind,
                "name": grant.name,
                "host": grant.host,
                "grantedAt": grant.granted_at,
            }))
        })
        .collect();
    Ok(Value::Array(consents))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    fn record(kind: &str, base_url: Option<&str>) -> ProviderRecord {
        ProviderRecord {
            id: "p1".into(),
            name: "Mein KI".into(),
            kind: kind.into(),
            base_url: base_url.map(String::from),
            model: None,
            fast_model: None,
            key_hint: None,
            created_at: 0,
            input_price: None,
            output_price: None,
        }
    }

    #[test]
    fn only_this_computer_needs_no_consent() {
        for url in ["http://localhost:11434/v1", "http://127.0.0.1:8080", "http://127.8.0.1", "http://[::1]:11434"] {
            assert!(stays_on_device(url), "{url}");
            assert_eq!(for_provider(&record("ollama", Some(url))), None);
        }
        for url in ["http://192.168.1.20:11434/v1", "http://10.0.0.2", "https://ai.example.com/v1", "nonsense"] {
            assert!(!stays_on_device(url), "{url}");
        }
        let lan = for_provider(&record("ollama", Some("http://192.168.1.20:11434/v1"))).unwrap();
        assert_eq!((lan.destination.as_str(), lan.host.as_str()), ("provider:p1", "192.168.1.20:11434"));
        let cloud = for_provider(&record("openai", None)).unwrap();
        assert_eq!((cloud.kind.as_str(), cloud.host.as_str()), ("openai", "api.openai.com"));
        let server = for_server("uwu", "mini@uwu.test", "https://mail.uwu.test/jmap/api");
        assert_eq!((server.destination.as_str(), server.host.as_str()), ("server:uwu", "mail.uwu.test"));
    }

    #[test]
    fn a_consent_holds_only_for_the_host_and_kind_it_was_given_for() {
        let store = Store::open_in_memory().unwrap();
        let openai = for_provider(&record("openai", None)).unwrap();
        let refused = require(&store, Some(openai.clone())).unwrap_err();
        assert_eq!(refused.code, ErrorCode::ConsentRequired);
        assert_eq!(refused.assist_kind(), Some("consentRequired"));
        assert_eq!(refused.assist.as_ref().unwrap().consent.as_ref(), Some(&openai));
        require(&store, None).unwrap();

        grant(&store, &openai, 1_700_000_000).unwrap();
        require(&store, Some(openai.clone())).unwrap();
        let listed = list(&store).unwrap();
        assert_eq!(listed[0]["destination"], "provider:p1");
        assert_eq!(
            (listed[0]["host"].as_str(), listed[0]["grantedAt"].as_i64()),
            (Some("api.openai.com"), Some(1_700_000_000))
        );

        // Another address or kind under the same id: asked again.
        let gateway = for_provider(&record("openai", Some("https://gateway.example.com/v1"))).unwrap();
        assert!(!granted(&store, &gateway).unwrap());
        let other_kind = Destination { kind: "mistral".into(), ..openai.clone() };
        assert!(!granted(&store, &other_kind).unwrap());

        revoke(&store, "provider:p1").unwrap();
        assert!(!granted(&store, &openai).unwrap());
        assert_eq!(list(&store).unwrap(), json!([]));
    }
}
