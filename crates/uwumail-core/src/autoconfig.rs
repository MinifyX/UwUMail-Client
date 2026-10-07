//! Finds IMAP/SMTP settings from nothing but an email address.
//!
//! Order: the domain's own autoconfig file, a Microsoft 365 tenant, the
//! Thunderbird ISPDB, the provider behind the MX record, RFC 6186 SRV
//! records, the autoconfig file of the MX host itself, and finally probing
//! the usual host names. Everything that needs no earlier answer is asked at
//! once, so one place that hangs or fails (a split-horizon DNS without the
//! records, a proxy that answers 502) costs no more than its own timeout.

use std::time::Duration;

use serde::Deserialize;
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::error::{Error, Result};
use crate::model::{DiscoveredSettings, DiscoverySource, OAuthProvider, Security, ServerSettings};

const HTTP_TIMEOUT: Duration = Duration::from_secs(6);
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// An autoconfig file is a few kilobytes; a bigger answer isn't one.
const MAX_CONFIG: usize = 256 * 1024;

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

/// Domains the providers own, under which their mail servers live.
const GOOGLE_DOMAINS: &[&str] = &["gmail.com", "googlemail.com", "google.com"];
const MICROSOFT_DOMAINS: &[&str] =
    &["outlook.com", "hotmail.com", "live.com", "msn.com", "office365.com", "office.com"];

/// The provider a server belongs to: only a name under a domain the provider owns. A name like
/// `outlook.example.org` is anybody's, and a server that looks like the provider's would receive
/// the provider's sign-in token.
pub fn oauth_provider_of_host(host: &str) -> Option<OAuthProvider> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let under = |domains: &[&str]| domains.iter().any(|d| host == *d || host.ends_with(&format!(".{d}")));
    if under(GOOGLE_DOMAINS) {
        Some(OAuthProvider::Google)
    } else if under(MICROSOFT_DOMAINS) {
        Some(OAuthProvider::Microsoft)
    } else {
        None
    }
}

/// Known providers that only allow OAuth for IMAP, by the domain of a mail address. Microsoft's
/// national domains (`outlook.de`, `hotmail.co.uk`) count too: they get Microsoft's own servers
/// ([`microsoft_settings`]), never servers named after them.
pub fn oauth_provider_for(domain: &str) -> Option<OAuthProvider> {
    let value = domain.to_ascii_lowercase();
    oauth_provider_of_host(&value).or_else(|| {
        (value.starts_with("hotmail.") || value.starts_with("live.") || value.starts_with("outlook."))
            .then_some(OAuthProvider::Microsoft)
    })
}

/// An OAuth sign-in only ever goes to the provider's own servers, and only encrypted. Whoever
/// answers discovery (the domain's website, its DNS, or the network in between) could otherwise
/// name a server of theirs and receive a token that opens the mailbox at the provider.
pub(crate) fn check_oauth_servers(provider: OAuthProvider, servers: &[&ServerSettings]) -> Result<()> {
    for server in servers {
        if oauth_provider_of_host(&server.host) != Some(provider) {
            return Err(Error::invalid(format!(
                "{} isn't a server of the provider you sign in with, so UwUMail won't send your sign-in there.",
                server.host
            )));
        }
        if server.security == Security::None {
            return Err(Error::invalid(format!("The connection to {} would not be encrypted.", server.host)));
        }
    }
    Ok(())
}

/// Exchange Online's IMAP and SMTP hosts. Every mailbox in Microsoft 365 uses
/// these two, no matter what the company's domain is called.
const MICROSOFT_IMAP: &str = "outlook.office365.com";
const MICROSOFT_SMTP: &str = "smtp.office365.com";

/// Settings for a mailbox that Microsoft hosts, personal or company.
pub(crate) fn microsoft_settings(email: &str, source: DiscoverySource) -> DiscoveredSettings {
    DiscoveredSettings {
        email: email.to_string(),
        provider_name: Some("Microsoft 365".into()),
        oauth: Some(OAuthProvider::Microsoft),
        imap: ServerSettings { host: MICROSOFT_IMAP.into(), port: 993, security: Security::Tls },
        // Exchange Online only submits on 587 with STARTTLS; it has no implicit-TLS port.
        smtp: ServerSettings { host: MICROSOFT_SMTP.into(), port: 587, security: Security::Starttls },
        username: email.to_string(),
        source,
        jmap: None,
        via_mx: None,
        uwumail_login: false,
    }
}

/// Whether a domain belongs to a Microsoft 365 tenant.
///
/// Autodiscover v2 stopped answering for IMAP and SMTP, so we ask Entra ID
/// instead: every domain a tenant has verified serves an OpenID configuration,
/// and every other domain answers with an error. This is what finds companies
/// whose mail sits behind a spam filter, where the MX record gives Microsoft
/// away nowhere.
async fn microsoft_tenant(http: &reqwest::Client, domain: &str) -> bool {
    // split_email already made sure this is a bare host name, but it goes into
    // a URL path, so encode it anyway.
    let encoded: String = url::form_urlencoded::byte_serialize(domain.as_bytes()).collect();
    let url = format!("https://login.microsoftonline.com/{encoded}/v2.0/.well-known/openid-configuration");
    let Ok(Ok(response)) = timeout(HTTP_TIMEOUT, http.get(&url).send()).await else { return false };
    response.status().is_success()
}

pub(crate) fn parse_client_config(xml: &str, email: &str, source: DiscoverySource) -> Option<DiscoveredSettings> {
    let config: ClientConfig = quick_xml::de::from_str(xml).ok()?;
    let provider = config.email_provider;
    // The most secure of each kind: a file that lists a plain connection first doesn't get it used.
    let rank = |s: &&ServerXml| match security(&s.socket_type) {
        Security::Tls => 0,
        Security::Starttls => 1,
        Security::None => 2,
    };
    let imap = provider.incoming.iter().filter(|s| s.kind.eq_ignore_ascii_case("imap")).min_by_key(rank)?;
    let smtp = provider.outgoing.iter().filter(|s| s.kind.eq_ignore_ascii_case("smtp")).min_by_key(rank)?;
    let wants_oauth = imap.authentication.iter().any(|a| a.eq_ignore_ascii_case("OAuth2"));
    let domain = email.split_once('@').map(|(_, d)| d).unwrap_or_default();
    // Only when the server really is the provider's: the file comes from whoever runs the domain's
    // website, and a sign-in with Google or Microsoft must not end up at a server of theirs.
    let oauth = oauth_provider_of_host(&imap.hostname)
        .filter(|provider| wants_oauth || oauth_provider_for(domain) == Some(*provider));
    // The domain's own file may call itself anything ("Microsoft 365") while it names a server of its
    // own: its name only counts for servers on the domain's site. Otherwise setup shows the server
    // that gets the password (audit CC-5). ISPDB entries are curated and keep theirs.
    // The same goes for the file of the MX host, which plain DNS chose.
    let named = !matches!(source, DiscoverySource::Autoconfig | DiscoverySource::MailServer)
        || same_site(&imap.hostname, &domain.to_ascii_lowercase());
    Some(DiscoveredSettings {
        email: email.to_string(),
        provider_name: provider
            .display_name
            .filter(|n| !n.is_empty())
            .or((!provider.id.is_empty()).then_some(provider.id))
            .filter(|_| named),
        oauth,
        imap: ServerSettings { host: imap.hostname.clone(), port: imap.port, security: security(&imap.socket_type) },
        smtp: ServerSettings { host: smtp.hostname.clone(), port: smtp.port, security: security(&smtp.socket_type) },
        username: fill_placeholders(if imap.username.is_empty() { "%EMAILADDRESS%" } else { &imap.username }, email),
        source,
        jmap: None,
        via_mx: None,
        uwumail_login: false,
    })
}

/// Server settings decide where the password goes: a redirect is followed only to HTTPS, never
/// through plain HTTP on the way (audit CC-6), and at most five times.
fn https_redirects_only(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder.redirect(reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            attempt.error("too many redirects")
        } else if attempt.url().scheme() != "https" {
            attempt.stop()
        } else {
            attempt.follow()
        }
    }))
}

fn config_client() -> Option<reqwest::Client> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Some(client.clone());
    }
    let builder = crate::tls::http_client().ok()?.user_agent(concat!("UwUMail/", env!("CARGO_PKG_VERSION")));
    let client = https_redirects_only(builder).timeout(HTTP_TIMEOUT).build().ok()?;
    Some(CLIENT.get_or_init(|| client).clone())
}

/// The body of an answer, `None` beyond `limit` bytes or when it isn't text.
async fn read_text(mut response: reqwest::Response, limit: usize) -> Option<String> {
    if response.content_length().is_some_and(|length| length > limit as u64) {
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if body.len() + chunk.len() > limit {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).ok()
}

async fn fetch_config(
    _http: &reqwest::Client,
    url: &str,
    email: &str,
    source: DiscoverySource,
) -> Option<DiscoveredSettings> {
    let http = config_client()?;
    let response = timeout(HTTP_TIMEOUT, http.get(url).send()).await.ok()?.ok()?;
    if !response.status().is_success() || response.url().scheme() != "https" {
        return None;
    }
    let body = timeout(HTTP_TIMEOUT, read_text(response, MAX_CONFIG)).await.ok()??;
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

/// The mail host a domain points at, i.e. its most preferred MX record.
async fn mx_host(domain: &str) -> Option<String> {
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
    let host = records.first()?.exchange.to_utf8().trim_end_matches('.').to_ascii_lowercase();
    // A null MX (RFC 7505, ".") receives no mail at all.
    matches!(url::Host::parse(&host), Ok(url::Host::Domain(_))).then_some(host)
}

/// Whether Microsoft hosts the mail for a domain.
///
/// The MX record is the sure sign, but a spam filter in front of Microsoft 365
/// hides it, so an Entra tenant counts as well — except when the MX names a
/// provider we know to be someone else, which is what a company looks like
/// that uses Entra for sign-in but keeps its mail elsewhere.
fn hosted_by_microsoft(tenant: bool, mx: Option<&str>) -> bool {
    match mx.and_then(oauth_provider_of_host) {
        Some(OAuthProvider::Microsoft) => true,
        Some(_) => false,
        None => tenant,
    }
}

/// The address of the MX host's own autoconfig file. A UwUMail server (and many others) serves it
/// on its host name: the one place that still answers when the domain's own website and SRV
/// records don't, e.g. inside a network whose DNS knows only part of the domain.
fn mail_server_config_url(host: &str, email: &str) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(email.as_bytes()).collect();
    format!("https://{host}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress={encoded}")
}

async fn from_mail_server(http: &reqwest::Client, email: &str, host: &str) -> Option<DiscoveredSettings> {
    fetch_config(http, &mail_server_config_url(host, email), email, DiscoverySource::MailServer).await
}

async fn from_mx(http: &reqwest::Client, email: &str, domain: &str, host: &str) -> Option<DiscoveredSettings> {
    let provider_domain = base_domain(host);
    if provider_domain.eq_ignore_ascii_case(domain) {
        return None;
    }
    let url = format!("https://autoconfig.thunderbird.net/v1.1/{provider_domain}");
    let mut settings = fetch_config(http, &url, email, DiscoverySource::Mx).await?;
    // Only for the provider's own servers, as in `parse_client_config`.
    let imap_provider = oauth_provider_of_host(&settings.imap.host);
    settings.oauth = settings.oauth.or_else(|| oauth_provider_of_host(host).filter(|p| imap_provider == Some(*p)));
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

/// Whether `host` lies under the same registrable domain as the mail domain (`mail.example.org`
/// for `example.org`, `imap.example.co.uk` for `shop.example.co.uk`).
fn same_site(host: &str, domain: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let site = |name: &str| psl::domain(name.as_bytes()).map(|d| d.as_bytes().to_vec());
    site(&host).is_some_and(|site_of_host| Some(site_of_host) == site(domain))
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
    // SRV answers are plain DNS, which anyone on the network in between can forge, and a server's
    // certificate only proves its own name. So a server on another site than the address's own is
    // not taken unseen (RFC 6186, section 6): setup then guesses and shows the servers it uses.
    if !same_site(&imap_host, domain) || !same_site(&smtp.host, domain) {
        return None;
    }
    Some(DiscoveredSettings {
        email: email.to_string(),
        provider_name: None,
        oauth: oauth_provider_of_host(&imap_host),
        imap: ServerSettings { host: imap_host, port: imap_port, security: Security::Tls },
        smtp,
        username: email.to_string(),
        source: DiscoverySource::Srv,
        jmap: None,
        via_mx: None,
        uwumail_login: false,
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
        via_mx: None,
        uwumail_login: false,
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

/// IMAP and SMTP settings for an address, plus the JMAP session URL if the server offers JMAP, and
/// whether that server signs in with UwUMail.
pub async fn discover(http: &reqwest::Client, email: &str) -> Result<DiscoveredSettings> {
    let email = email.trim();
    let (_, domain) = split_email(email)?;
    let (mut settings, mx) = discover_imap(http, email, &domain).await;
    // OAuth providers (Google, Microsoft) don't offer JMAP.
    if settings.oauth.is_none() {
        let mut mail_hosts = vec![settings.imap.host.clone(), settings.smtp.host.clone()];
        // The MX host is asked for JMAP as well; when only it answers, setup shows it (`via_mx`).
        if let Some(mx) = mx.as_ref().filter(|mx| !mail_hosts.contains(mx)) {
            mail_hosts.push(mx.clone());
        }
        let hosts: Vec<&str> = mail_hosts.iter().map(String::as_str).collect();
        settings.jmap = crate::jmap::discover(http, &domain, &hosts).await;
        settings.via_mx = shown_server(&settings, &domain, mx.as_deref());
        if let Some(session) = &settings.jmap
            && let Ok(client) = crate::uwumail_login::http_client()
        {
            settings.uwumail_login = crate::uwumail_login::metadata(&client, session).await.is_some();
        }
    }
    Ok(settings)
}

/// The server that gets the password, when only the MX record led to it and it isn't on the
/// address's own site. The MX record is plain DNS, which anyone on the network in between can
/// forge, so setup shows this server instead of taking it unseen (RFC 6186 section 6, audit CC-7).
fn shown_server(settings: &DiscoveredSettings, domain: &str, mx: Option<&str>) -> Option<String> {
    let mx = mx?;
    let jmap_host =
        settings.jmap.as_deref().and_then(|u| url::Url::parse(u).ok()).and_then(|u| u.host_str().map(String::from));
    let server = jmap_host.clone().unwrap_or_else(|| settings.imap.host.clone());
    if same_site(&server, domain) {
        return None;
    }
    let from_mx = settings.source == DiscoverySource::MailServer
        || (jmap_host.is_some()
            && same_site(&server, mx)
            && !same_site(&server, &settings.imap.host)
            && !same_site(&server, &settings.smtp.host));
    from_mx.then_some(server)
}

/// Everything found at once, picked in order of trust.
struct Answers {
    autoconfig: Option<DiscoveredSettings>,
    microsoft: bool,
    mx_provider: Option<DiscoveredSettings>,
    srv: Option<DiscoveredSettings>,
    mail_server: Option<DiscoveredSettings>,
}

fn pick(email: &str, answers: Answers) -> Option<DiscoveredSettings> {
    if let Some(found) = answers.autoconfig {
        // A file the domain publishes itself wins: whoever wrote it knows where the
        // mail really lives, hybrid setups included. A shared ISPDB entry loses
        // against a tenant, because the password login it describes cannot work there.
        if found.source == DiscoverySource::Autoconfig || !answers.microsoft {
            return Some(found);
        }
    }
    if answers.microsoft {
        return Some(microsoft_settings(email, DiscoverySource::Microsoft));
    }
    answers.mx_provider.or(answers.srv).or(answers.mail_server)
}

async fn discover_imap(http: &reqwest::Client, email: &str, domain: &str) -> (DiscoveredSettings, Option<String>) {
    // Microsoft's own domains are known and need no lookup.
    if oauth_provider_for(domain) == Some(OAuthProvider::Microsoft) {
        return (microsoft_settings(email, DiscoverySource::Microsoft), None);
    }
    let behind_mx = async {
        let Some(host) = mx_host(domain).await else { return (None, None, None) };
        let (provider, server) =
            tokio::join!(from_mx(http, email, domain, &host), from_mail_server(http, email, &host));
        (Some(host), provider, server)
    };
    let (autoconfig, tenant, (mx, mx_provider, mail_server), srv) = tokio::join!(
        from_autoconfig(http, email, domain),
        microsoft_tenant(http, domain),
        behind_mx,
        from_srv(email, domain),
    );
    let microsoft = hosted_by_microsoft(tenant, mx.as_deref());
    let answers = Answers { autoconfig, microsoft, mx_provider, srv, mail_server };
    let settings = match pick(email, answers) {
        Some(found) => found,
        None => guess(email, domain).await,
    };
    (settings, mx)
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
    fn a_domains_own_file_names_itself_only_for_its_own_servers() {
        // The domain's website calls its file "Google Mail", but the servers are somebody else's.
        let foreign = GMAIL
            .replace("imap.gmail.com", "imap.collector.example")
            .replace("smtp.gmail.com", "smtp.collector.example");
        let settings = parse_client_config(&foreign, "mini@example.org", DiscoverySource::Autoconfig).unwrap();
        assert_eq!(settings.provider_name, None, "setup shows the server instead");
        assert_eq!(settings.imap.host, "imap.collector.example");
        let own = GMAIL.replace("imap.gmail.com", "imap.example.org").replace("smtp.gmail.com", "smtp.example.org");
        let settings = parse_client_config(&own, "mini@example.org", DiscoverySource::Autoconfig).unwrap();
        assert_eq!(settings.provider_name.as_deref(), Some("Google Mail"));
        // A curated ISPDB entry keeps its name.
        let settings = parse_client_config(&foreign, "mini@example.org", DiscoverySource::Ispdb).unwrap();
        assert_eq!(settings.provider_name.as_deref(), Some("Google Mail"));
    }

    /// Answers `/hop` with a redirect to plain HTTP, `/big` with more than an autoconfig file, and
    /// anything else with a small text.
    async fn stub() -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = [0u8; 4096];
                let n = socket.read(&mut buffer).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buffer[..n]).into_owned();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let answer = match path.as_str() {
                    "/hop" => format!(
                        "HTTP/1.1 301 Moved\r\nLocation: http://127.0.0.1:{port}/end\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    ),
                    "/big" => format!("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}", "x".repeat(MAX_CONFIG + 1)),
                    _ => "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_string(),
                };
                let _ = socket.write_all(answer.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        port
    }

    #[tokio::test]
    async fn autoconfig_answers_stay_on_https_and_small() {
        let port = stub().await;
        let http = https_redirects_only(reqwest::Client::builder().no_proxy()).build().unwrap();
        let hop = http.get(format!("http://127.0.0.1:{port}/hop")).send().await.unwrap();
        assert_eq!(hop.status(), reqwest::StatusCode::MOVED_PERMANENTLY, "a hop to plain http isn't followed");
        let big = http.get(format!("http://127.0.0.1:{port}/big")).send().await.unwrap();
        assert_eq!(read_text(big, MAX_CONFIG).await, None);
        let small = http.get(format!("http://127.0.0.1:{port}/small")).send().await.unwrap();
        assert_eq!(read_text(small, MAX_CONFIG).await.as_deref(), Some("ok"));
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
    fn only_the_providers_own_servers_get_a_sign_in() {
        // Named like the provider, but anybody's.
        for host in ["outlook.example.org", "hotmail.example.org", "live.example.org", "imap.gmail.com.example.org"] {
            assert_eq!(oauth_provider_of_host(host), None, "{host}");
        }
        assert_eq!(oauth_provider_of_host("outlook.office365.com."), Some(OAuthProvider::Microsoft));
        assert_eq!(oauth_provider_of_host("IMAP.gmail.com"), Some(OAuthProvider::Google));
        // As a mail address's domain, Microsoft's national domains still count: they get Microsoft's servers.
        assert_eq!(oauth_provider_for("hotmail.co.uk"), Some(OAuthProvider::Microsoft));

        // A domain's own file that names a look-alike server for a Microsoft sign-in.
        let lookalike =
            GMAIL.replace("imap.gmail.com", "outlook.example.org").replace("smtp.gmail.com", "smtp.example.org");
        let settings = parse_client_config(&lookalike, "alex@example.org", DiscoverySource::Autoconfig).unwrap();
        assert_eq!(settings.oauth, None, "no OAuth sign-in for a server that isn't the provider's");

        let microsoft = microsoft_settings("alex@example.org", DiscoverySource::Microsoft);
        assert!(check_oauth_servers(OAuthProvider::Microsoft, &[&microsoft.imap, &microsoft.smtp]).is_ok());
        let foreign = ServerSettings { host: "outlook.example.org".into(), port: 993, security: Security::Tls };
        assert!(check_oauth_servers(OAuthProvider::Microsoft, &[&foreign, &microsoft.smtp]).is_err());
        assert!(check_oauth_servers(OAuthProvider::Google, &[&microsoft.imap]).is_err(), "another provider's");
        let plain = ServerSettings { security: Security::None, ..microsoft.imap.clone() };
        assert!(check_oauth_servers(OAuthProvider::Microsoft, &[&plain]).is_err(), "never unencrypted");
    }

    #[test]
    fn a_plain_connection_listed_first_is_not_taken() {
        let xml = GMAIL.replace(
            "<incomingServer type=\"imap\">",
            "<incomingServer type=\"imap\"><hostname>imap.gmail.com</hostname><port>143</port><socketType>plain</socketType></incomingServer>\n    <incomingServer type=\"imap\">",
        );
        let settings = parse_client_config(&xml, "mini@gmail.com", DiscoverySource::Ispdb).unwrap();
        assert_eq!(settings.imap, ServerSettings { host: "imap.gmail.com".into(), port: 993, security: Security::Tls });
    }

    #[test]
    fn srv_answers_only_count_on_the_addresses_own_site() {
        assert!(same_site("mail.example.org", "example.org"));
        assert!(same_site("imap.example.org.", "shop.example.org"));
        assert!(same_site("imap.example.co.uk", "example.co.uk"));
        assert!(!same_site("imap.example.net", "example.org"));
        assert!(!same_site("example.co.uk", "other.co.uk"));
        assert!(!same_site("co.uk", "example.co.uk"));
    }

    #[test]
    fn microsoft_mailboxes_get_exchange_onlines_fixed_hosts() {
        let settings = microsoft_settings("alex@example-company.de", DiscoverySource::Microsoft);
        assert_eq!(
            settings.imap,
            ServerSettings { host: "outlook.office365.com".into(), port: 993, security: Security::Tls }
        );
        // Exchange Online submits on 587 only; 465 would fail to connect.
        assert_eq!(
            settings.smtp,
            ServerSettings { host: "smtp.office365.com".into(), port: 587, security: Security::Starttls }
        );
        assert_eq!(settings.oauth, Some(OAuthProvider::Microsoft));
        assert_eq!(settings.username, "alex@example-company.de");
        assert!(settings.jmap.is_none(), "Microsoft offers no JMAP");
    }

    fn found(source: DiscoverySource, host: &str) -> DiscoveredSettings {
        let server = |port| ServerSettings { host: host.into(), port, security: Security::Tls };
        DiscoveredSettings {
            email: "lorin@example.org".into(),
            provider_name: None,
            oauth: None,
            imap: server(993),
            smtp: server(465),
            username: "lorin@example.org".into(),
            source,
            jmap: None,
            via_mx: None,
            uwumail_login: false,
        }
    }

    fn none() -> Answers {
        Answers { autoconfig: None, microsoft: false, mx_provider: None, srv: None, mail_server: None }
    }

    #[test]
    fn the_mail_servers_own_file_is_the_last_answer_before_guessing() {
        let email = "lorin@example.org";
        // Inside a network whose DNS has no SRV records and whose proxy answers 502 for the
        // domain's autoconfig: only the MX host's own file is left.
        let only_mx = Answers { mail_server: Some(found(DiscoverySource::MailServer, "mail.example.net")), ..none() };
        let picked = pick(email, only_mx).unwrap();
        assert_eq!((picked.source, picked.imap.host.as_str()), (DiscoverySource::MailServer, "mail.example.net"));

        // Everything that is the domain's own comes first.
        let all = || Answers {
            autoconfig: Some(found(DiscoverySource::Autoconfig, "imap.example.org")),
            microsoft: false,
            mx_provider: Some(found(DiscoverySource::Mx, "imap.provider.example")),
            srv: Some(found(DiscoverySource::Srv, "mail.example.org")),
            mail_server: Some(found(DiscoverySource::MailServer, "mail.example.net")),
        };
        assert_eq!(pick(email, all()).unwrap().source, DiscoverySource::Autoconfig);
        assert_eq!(pick(email, Answers { autoconfig: None, ..all() }).unwrap().source, DiscoverySource::Mx);
        assert_eq!(
            pick(email, Answers { autoconfig: None, mx_provider: None, ..all() }).unwrap().source,
            DiscoverySource::Srv
        );
        let microsoft = Answers { autoconfig: None, microsoft: true, ..all() };
        assert_eq!(pick(email, microsoft).unwrap().source, DiscoverySource::Microsoft);
        assert!(pick(email, none()).is_none(), "then it guesses");
    }

    #[test]
    fn a_server_only_the_mx_record_named_is_shown() {
        let domain = "example.org";
        let mx = Some("mail.example.net");
        // The MX host's file named its own servers: shown.
        let from_mail_server = found(DiscoverySource::MailServer, "mail.example.net");
        assert_eq!(shown_server(&from_mail_server, domain, mx).as_deref(), Some("mail.example.net"));
        // A guess with JMAP only on the MX host: the JMAP host is shown.
        let mut guessed = found(DiscoverySource::Guess, "imap.example.org");
        guessed.jmap = Some("https://mail.example.net/.well-known/jmap".into());
        assert_eq!(shown_server(&guessed, domain, mx).as_deref(), Some("mail.example.net"));
        // The domain's own file named the MX host: that file is the domain's word, not DNS.
        let mut own = found(DiscoverySource::Autoconfig, "mail.example.net");
        own.jmap = Some("https://mail.example.net/.well-known/jmap".into());
        assert_eq!(shown_server(&own, domain, mx), None);
        // Servers on the address's own site, or no MX at all.
        let home = found(DiscoverySource::MailServer, "mail.example.org");
        assert_eq!(shown_server(&home, domain, Some("mx.example.org")), None);
        assert_eq!(shown_server(&from_mail_server, domain, None), None);
    }

    #[test]
    fn the_mail_servers_file_is_asked_on_its_host_name_and_names_nothing() {
        assert_eq!(
            mail_server_config_url("mail.example.net", "lorin+x@example.org"),
            "https://mail.example.net/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=lorin%2Bx%40example.org"
        );
        // Like the domain's own file, the MX host's may call itself anything; setup shows the server.
        let foreign = GMAIL
            .replace("imap.gmail.com", "imap.collector.example")
            .replace("smtp.gmail.com", "smtp.collector.example");
        let settings = parse_client_config(&foreign, "mini@example.org", DiscoverySource::MailServer).unwrap();
        assert_eq!(settings.provider_name, None);
        assert_eq!(settings.source, DiscoverySource::MailServer);
    }

    #[test]
    fn microsoft_is_told_by_the_mx_record_before_the_tenant() {
        assert!(hosted_by_microsoft(false, Some("example-org.mail.protection.outlook.com")));
        assert!(!hosted_by_microsoft(true, Some("aspmx.l.google.com")), "Entra sign-in, mail at Google");
        assert!(hosted_by_microsoft(true, Some("mx.filter.example")), "a spam filter in front");
        assert!(!hosted_by_microsoft(false, None));
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
