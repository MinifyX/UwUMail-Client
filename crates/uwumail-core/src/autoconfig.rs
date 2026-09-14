//! Finds IMAP/SMTP settings from nothing but an email address.
//!
//! Order: the domain's own autoconfig file, the Thunderbird ISPDB, the
//! provider behind the MX record, RFC 6186 SRV records, and finally probing
//! the usual host names.

use std::time::Duration;

use serde::Deserialize;
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::error::{Error, Result};
use crate::model::{DiscoveredSettings, DiscoverySource, OAuthProvider, Security, ServerSettings};

const HTTP_TIMEOUT: Duration = Duration::from_secs(6);
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Deserialize)]
struct ClientConfig {
    #[serde(rename = "emailProvider")]
    email_provider: EmailProvider,
}

#[derive(Debug, Deserialize)]
struct EmailProvider {
    #[serde(rename = "@id", default)]
    id: String,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(rename = "incomingServer", default)]
    incoming: Vec<ServerXml>,
    #[serde(rename = "outgoingServer", default)]
    outgoing: Vec<ServerXml>,
}

#[derive(Debug, Deserialize)]
struct ServerXml {
    #[serde(rename = "@type")]
    kind: String,
    hostname: String,
    port: u16,
    #[serde(rename = "socketType")]
    socket_type: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    authentication: Vec<String>,
}

fn security(socket_type: &str) -> Security {
    match socket_type.to_ascii_uppercase().as_str() {
        "SSL" | "TLS" => Security::Tls,
        "STARTTLS" => Security::Starttls,
        _ => Security::None,
    }
}

fn fill_placeholders(template: &str, email: &str) -> String {
    let (local, domain) = email.split_once('@').unwrap_or((email, ""));
    template.replace("%EMAILADDRESS%", email).replace("%EMAILLOCALPART%", local).replace("%EMAILDOMAIN%", domain)
}

/// Known providers that only allow OAuth for IMAP.
pub fn oauth_provider_for(host_or_domain: &str) -> Option<OAuthProvider> {
    let value = host_or_domain.to_ascii_lowercase();
    let google = ["gmail.com", "googlemail.com", "google.com"];
    let microsoft = [
        "outlook.com",
        "hotmail.com",
        "live.com",
        "msn.com",
        "office365.com",
        "outlook.office365.com",
        "protection.outlook.com",
    ];
    let matches = |suffixes: &[&str]| suffixes.iter().any(|s| value == *s || value.ends_with(&format!(".{s}")));
    if matches(&google) {
        Some(OAuthProvider::Google)
    } else if matches(&microsoft)
        || value.starts_with("hotmail.")
        || value.starts_with("live.")
        || value.starts_with("outlook.")
    {
        Some(OAuthProvider::Microsoft)
    } else {
        None
    }
}

pub(crate) fn parse_client_config(xml: &str, email: &str, source: DiscoverySource) -> Option<DiscoveredSettings> {
    let config: ClientConfig = quick_xml::de::from_str(xml).ok()?;
    let provider = config.email_provider;
    let imap = provider.incoming.iter().find(|s| s.kind.eq_ignore_ascii_case("imap"))?;
    let smtp =
        provider.outgoing.iter().filter(|s| s.kind.eq_ignore_ascii_case("smtp")).min_by_key(|s| {
            match security(&s.socket_type) {
                Security::Tls => 0,
                Security::Starttls => 1,
                Security::None => 2,
            }
        })?;
    let wants_oauth = imap.authentication.iter().any(|a| a.eq_ignore_ascii_case("OAuth2"));
    let domain = email.split_once('@').map(|(_, d)| d).unwrap_or_default();
    let oauth = oauth_provider_for(domain)
        .or_else(|| oauth_provider_for(&imap.hostname))
        .filter(|_| wants_oauth || oauth_provider_for(domain).is_some());
    Some(DiscoveredSettings {
        email: email.to_string(),
        provider_name: provider
            .display_name
            .filter(|n| !n.is_empty())
            .or((!provider.id.is_empty()).then_some(provider.id)),
        oauth,
        imap: ServerSettings { host: imap.hostname.clone(), port: imap.port, security: security(&imap.socket_type) },
        smtp: ServerSettings { host: smtp.hostname.clone(), port: smtp.port, security: security(&smtp.socket_type) },
        username: fill_placeholders(if imap.username.is_empty() { "%EMAILADDRESS%" } else { &imap.username }, email),
        source,
        jmap: None,
    })
}

async fn fetch_config(
    http: &reqwest::Client,
    url: &str,
    email: &str,
    source: DiscoverySource,
) -> Option<DiscoveredSettings> {
    let response = timeout(HTTP_TIMEOUT, http.get(url).send()).await.ok()?.ok()?;
    // Server settings decide where the password goes: never take them from a redirect to plain http.
    if !response.status().is_success() || response.url().scheme() != "https" {
        return None;
    }
    let body = timeout(HTTP_TIMEOUT, response.text()).await.ok()?.ok()?;
    parse_client_config(&body, email, source)
}

async fn from_autoconfig(http: &reqwest::Client, email: &str, domain: &str) -> Option<DiscoveredSettings> {
    let encoded: String = url::form_urlencoded::byte_serialize(email.as_bytes()).collect();
    let own = format!("https://autoconfig.{domain}/mail/config-v1.1.xml?emailaddress={encoded}");
    let well_known = format!("https://{domain}/.well-known/autoconfig/mail/config-v1.1.xml");
    let ispdb = format!("https://autoconfig.thunderbird.net/v1.1/{domain}");
    let (a, b, c) = tokio::join!(
        fetch_config(http, &own, email, DiscoverySource::Autoconfig),
        fetch_config(http, &well_known, email, DiscoverySource::Autoconfig),
        fetch_config(http, &ispdb, email, DiscoverySource::Ispdb),
    );
    a.or(b).or(c)
}

/// The domain whose ISPDB entry describes a mail host, e.g.
/// `aspmx.l.google.com` → `google.com`.
fn base_domain(host: &str) -> String {
    let labels: Vec<&str> = host.trim_end_matches('.').split('.').collect();
    let keep = if labels.len() >= 3 && labels[labels.len() - 2].len() <= 3 { 3 } else { 2 };
    labels[labels.len().saturating_sub(keep)..].join(".")
}

pub(crate) async fn resolver() -> Option<hickory_resolver::TokioResolver> {
    hickory_resolver::Resolver::builder_tokio().ok()?.build().ok()
}

async fn from_mx(http: &reqwest::Client, email: &str, domain: &str) -> Option<DiscoveredSettings> {
    let resolver = resolver().await?;
    let lookup = timeout(HTTP_TIMEOUT, resolver.mx_lookup(domain)).await.ok()?.ok()?;
    let mut records: Vec<_> = lookup
        .answers()
        .iter()
        .filter_map(|record| match &record.data {
            hickory_resolver::proto::rr::RData::MX(mx) => Some(mx.clone()),
            _ => None,
        })
        .collect();
    records.sort_by_key(|mx| mx.preference);
    let host = records.first()?.exchange.to_utf8();
    let provider_domain = base_domain(&host);
    if provider_domain.eq_ignore_ascii_case(domain) {
        return None;
    }
    let url = format!("https://autoconfig.thunderbird.net/v1.1/{provider_domain}");
    let mut settings = fetch_config(http, &url, email, DiscoverySource::Mx).await?;
    settings.oauth = settings.oauth.or_else(|| oauth_provider_for(&host));
    Some(settings)
}

pub(crate) async fn srv(resolver: &hickory_resolver::TokioResolver, name: &str) -> Option<(String, u16)> {
    let lookup = timeout(HTTP_TIMEOUT, resolver.srv_lookup(name)).await.ok()?.ok()?;
    let record = lookup
        .answers()
        .iter()
        .filter_map(|record| match &record.data {
            hickory_resolver::proto::rr::RData::SRV(srv) => Some(srv.clone()),
            _ => None,
        })
        .min_by_key(|srv| srv.priority)?;
    let target = record.target.to_utf8();
    let target = target.trim_end_matches('.');
    (!target.is_empty()).then(|| (target.to_string(), record.port))
}

async fn from_srv(email: &str, domain: &str) -> Option<DiscoveredSettings> {
    let resolver = resolver().await?;
    let (imaps_name, submissions_name, submission_name) = (
        format!("_imaps._tcp.{domain}."),
        format!("_submissions._tcp.{domain}."),
        format!("_submission._tcp.{domain}."),
    );
    let (imaps, submissions, submission) =
        tokio::join!(srv(&resolver, &imaps_name), srv(&resolver, &submissions_name), srv(&resolver, &submission_name),);
    let (imap_host, imap_port) = imaps?;
    let smtp = match (submissions, submission) {
        (Some((host, port)), _) => ServerSettings { host, port, security: Security::Tls },
        (None, Some((host, port))) => ServerSettings { host, port, security: Security::Starttls },
        _ => return None,
    };
    Some(DiscoveredSettings {
        email: email.to_string(),
        provider_name: None,
        oauth: oauth_provider_for(&imap_host),
        imap: ServerSettings { host: imap_host, port: imap_port, security: Security::Tls },
        smtp,
        username: email.to_string(),
        source: DiscoverySource::Srv,
        jmap: None,
    })
}

async fn reachable(host: &str, port: u16) -> bool {
    matches!(timeout(PROBE_TIMEOUT, TcpStream::connect((host, port))).await, Ok(Ok(_)))
}

async fn guess(email: &str, domain: &str) -> DiscoveredSettings {
    let mut imap = ServerSettings { host: format!("imap.{domain}"), port: 993, security: Security::Tls };
    for host in [format!("imap.{domain}"), format!("mail.{domain}"), domain.to_string()] {
        if reachable(&host, 993).await {
            imap.host = host;
            break;
        }
    }
    let mut smtp = ServerSettings { host: format!("smtp.{domain}"), port: 465, security: Security::Tls };
    'outer: for host in [format!("smtp.{domain}"), format!("mail.{domain}"), domain.to_string()] {
        for (port, security) in [(465, Security::Tls), (587, Security::Starttls)] {
            if reachable(&host, port).await {
                smtp = ServerSettings { host, port, security };
                break 'outer;
            }
        }
    }
    DiscoveredSettings {
        email: email.to_string(),
        provider_name: None,
        oauth: None,
        imap,
        smtp,
        username: email.to_string(),
        source: DiscoverySource::Guess,
        jmap: None,
    }
}

pub fn split_email(email: &str) -> Result<(&str, String)> {
    let email = email.trim();
    match email.rsplit_once('@') {
        // The domain goes into lookup URLs, so it has to be a plain host name (no "/", "?", ports…).
        Some((local, domain))
            if !local.is_empty()
                && domain.contains('.')
                && matches!(url::Host::parse(domain), Ok(url::Host::Domain(_)))
                && !domain.contains(|c: char| c.is_whitespace() || "/?#:@[]\\%".contains(c)) =>
        {
            Ok((local, domain.to_ascii_lowercase()))
        }
        _ => Err(Error::invalid("That doesn't look like an email address.")),
    }
}

/// IMAP and SMTP settings for an address, plus the JMAP session URL if the server offers JMAP.
pub async fn discover(http: &reqwest::Client, email: &str) -> Result<DiscoveredSettings> {
    let email = email.trim();
    let (_, domain) = split_email(email)?;
    let mut settings = discover_imap(http, email, &domain).await;
    // OAuth providers (Google, Microsoft) don't offer JMAP.
    if settings.oauth.is_none() {
        settings.jmap = crate::jmap::discover(http, &domain, Some(&settings.imap.host)).await;
    }
    Ok(settings)
}

async fn discover_imap(http: &reqwest::Client, email: &str, domain: &str) -> DiscoveredSettings {
    if let Some(found) = from_autoconfig(http, email, domain).await {
        return found;
    }
    if let Some(found) = from_mx(http, email, domain).await {
        return found;
    }
    if let Some(found) = from_srv(email, domain).await {
        return found;
    }
    guess(email, domain).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const GMAIL: &str = r#"<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="googlemail.com">
    <domain>gmail.com</domain>
    <displayName>Google Mail</displayName>
    <displayShortName>GMail</displayShortName>
    <incomingServer type="pop3">
      <hostname>pop.gmail.com</hostname><port>995</port><socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username><authentication>OAuth2</authentication>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.gmail.com</hostname><port>993</port><socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>OAuth2</authentication>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.gmail.com</hostname><port>587</port><socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username><authentication>OAuth2</authentication>
    </outgoingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.gmail.com</hostname><port>465</port><socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username><authentication>OAuth2</authentication>
    </outgoingServer>
    <documentation url="http://mail.google.com/support/bin/answer.py?answer=13273"><descr>How to enable IMAP</descr></documentation>
  </emailProvider>
</clientConfig>"#;

    #[test]
    fn parses_ispdb_entries_and_prefers_imap_and_implicit_tls() {
        let settings = parse_client_config(GMAIL, "mini@gmail.com", DiscoverySource::Ispdb).unwrap();
        assert_eq!(settings.imap, ServerSettings { host: "imap.gmail.com".into(), port: 993, security: Security::Tls });
        assert_eq!(settings.smtp.port, 465);
        assert_eq!(settings.oauth, Some(OAuthProvider::Google));
        assert_eq!(settings.provider_name.as_deref(), Some("Google Mail"));
        assert_eq!(settings.username, "mini@gmail.com");
    }

    #[test]
    fn replaces_username_placeholders() {
        let xml = GMAIL.replace("<username>%EMAILADDRESS%</username>\n      <authentication>OAuth2</authentication>\n      <authentication>password-cleartext</authentication>", "<username>%EMAILLOCALPART%</username><authentication>password-cleartext</authentication>");
        let settings = parse_client_config(&xml, "mini@example.org", DiscoverySource::Autoconfig).unwrap();
        assert_eq!(settings.username, "mini");
        assert_eq!(settings.oauth, None);
    }

    #[test]
    fn recognizes_oauth_only_providers() {
        assert_eq!(oauth_provider_for("outlook.de"), Some(OAuthProvider::Microsoft));
        assert_eq!(oauth_provider_for("example-com.mail.protection.outlook.com"), Some(OAuthProvider::Microsoft));
        assert_eq!(oauth_provider_for("aspmx.l.google.com"), Some(OAuthProvider::Google));
        assert_eq!(oauth_provider_for("posteo.de"), None);
    }

    #[test]
    fn finds_the_provider_domain_of_mail_hosts() {
        assert_eq!(base_domain("aspmx.l.google.com."), "google.com");
        assert_eq!(base_domain("mx01.mail.example.co.uk"), "example.co.uk");
    }

    #[test]
    fn rejects_invalid_addresses() {
        assert!(split_email("nope").is_err());
        assert!(split_email("a@localhost").is_err());
        assert_eq!(split_email(" Mini@Example.ORG ").unwrap().1, "example.org");
        assert_eq!(split_email("leni@müller.de").unwrap().1, "müller.de");
        assert!(split_email("a@evil.example/path").is_err());
        assert!(split_email("a@evil.example:8080").is_err());
        assert!(split_email("a@evil.example?x=1").is_err());
    }
}
