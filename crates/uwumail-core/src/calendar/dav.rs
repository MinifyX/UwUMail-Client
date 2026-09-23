//! CalDAV (RFC 4791) for mailboxes whose server has no JMAP calendars: finding the calendar
//! home (RFC 6764), listing calendars, reading events in a time range and writing them back.
//!
//! Only HTTPS. The password goes only to the sites the mailbox already trusts with it (its mail
//! servers, an address typed in by hand); redirects are followed by hand under the same rule.
//! Other places discovery looks (the mail domain's own website, its SRV record) are asked
//! without the password, and only a redirect from there to a trusted site is followed. Answers
//! are size-limited and read with the careful XML reader in `xml`.

use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::{Method, StatusCode};
use url::Url;

use super::xml::{self, APPLE, CALDAV, DAV, Element};
use crate::error::{Error, Result};

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: usize = 5;
/// PROPFIND and REPORT answers.
pub const MAX_LISTING: usize = 16 * 1024 * 1024;
/// One calendar object.
pub const MAX_OBJECT: usize = 1024 * 1024;
/// Objects read from one calendar at most.
const MAX_OBJECTS: usize = 5000;

/// The registrable domain of a host, or the host itself (IP addresses, local names).
pub fn site(host: &str) -> String {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    psl::domain_str(&host).map_or(host.clone(), String::from)
}

pub struct DavClient {
    http: reqwest::Client,
    username: String,
    password: String,
    trusted_sites: Vec<String>,
}

#[derive(Debug)]
pub struct DavResponse {
    pub status: StatusCode,
    pub url: Url,
    pub etag: Option<String>,
    pub body: Vec<u8>,
}

fn method(name: &str) -> Method {
    Method::from_bytes(name.as_bytes()).unwrap_or(Method::GET)
}

impl DavClient {
    /// A client that sends the password only to `trusted_hosts`' sites.
    pub fn new(username: &str, password: &str, trusted_hosts: &[&str]) -> Result<Self> {
        Self::with_http(crate::tls::http_client()?, username, password, trusted_hosts)
    }

    /// Like [`DavClient::new`], with the certificate checks of `http` instead of the system's.
    /// Only for tests against a local server with a certificate of its own; the app always
    /// uses `new`. Redirects, the timeout and the rules for the password stay the same.
    #[doc(hidden)]
    pub fn with_http(
        http: reqwest::ClientBuilder,
        username: &str,
        password: &str,
        trusted_hosts: &[&str],
    ) -> Result<Self> {
        let http = http
            .user_agent(concat!("UwUMail/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::none())
            .timeout(TIMEOUT)
            .build()
            .map_err(|e| Error::internal(format!("HTTP client setup failed: {e}")))?;
        let mut trusted_sites: Vec<String> =
            trusted_hosts.iter().map(|host| host.trim()).filter(|host| !host.is_empty()).map(site).collect();
        trusted_sites.sort();
        trusted_sites.dedup();
        Ok(Self { http, username: username.to_string(), password: password.to_string(), trusted_sites })
    }

    pub fn may_send_password(&self, url: &Url) -> bool {
        url.scheme() == "https" && url.host_str().is_some_and(|host| self.trusted_sites.contains(&site(host)))
    }

    /// Where a discovery address leads before any password is sent: an address on a trusted
    /// site is used as it is; any other is asked without the password, and its redirects are
    /// followed (without it) until one reaches a trusted site. `None` when none does.
    pub async fn locate(&self, url: &Url) -> Result<Option<Url>> {
        let mut target = url.clone();
        for _ in 0..=MAX_REDIRECTS {
            if target.scheme() != "https" {
                return Ok(None);
            }
            if self.may_send_password(&target) {
                return Ok(Some(target));
            }
            let response = self
                .http
                .request(method("PROPFIND"), target.clone())
                .header("Depth", "0")
                .header(reqwest::header::CONTENT_TYPE, "application/xml; charset=utf-8")
                .body(PRINCIPAL_BODY)
                .send()
                .await?;
            let Some(location) = response
                .status()
                .is_redirection()
                .then(|| response.headers().get(reqwest::header::LOCATION))
                .flatten()
                .and_then(|location| location.to_str().ok())
            else {
                return Ok(None);
            };
            match target.join(location) {
                Ok(next) => target = next,
                Err(_) => return Ok(None),
            }
        }
        Ok(None)
    }

    /// One request, redirects followed within the trusted sites; the body is read up to `limit`.
    pub async fn send(
        &self,
        method_name: &str,
        url: &Url,
        headers: &[(&str, String)],
        body: Option<(&str, &[u8])>,
        limit: usize,
    ) -> Result<DavResponse> {
        let mut target = url.clone();
        let mut method_name = method_name.to_string();
        let mut body = body;
        for _ in 0..=MAX_REDIRECTS {
            if target.scheme() != "https" {
                return Err(Error::connection("UwUMail only talks to calendar servers over HTTPS."));
            }
            if !self.may_send_password(&target) {
                return Err(Error::auth(format!(
                    "The calendar server sent the sign-in to {}, which isn't part of your mailbox. UwUMail didn't send your password there.",
                    target.host_str().unwrap_or("another address")
                )));
            }
            let mut request = self
                .http
                .request(method(&method_name), target.clone())
                .basic_auth(&self.username, Some(&self.password));
            for (name, value) in headers {
                request = request.header(*name, value);
            }
            if let Some((content_type, bytes)) = body {
                request = request.header(reqwest::header::CONTENT_TYPE, content_type).body(bytes.to_vec());
            }
            let mut response = request.send().await?;
            let status = response.status();
            if status.is_redirection()
                && let Some(location) = response.headers().get(reqwest::header::LOCATION)
            {
                let location =
                    location.to_str().map_err(|_| Error::connection("The calendar server sent a broken redirect."))?;
                target = target
                    .join(location)
                    .map_err(|_| Error::connection("The calendar server sent a broken redirect."))?;
                if status == StatusCode::SEE_OTHER {
                    method_name = "GET".into();
                    body = None;
                }
                continue;
            }
            let etag =
                response.headers().get(reqwest::header::ETAG).and_then(|value| value.to_str().ok()).map(String::from);
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                if bytes.len() + chunk.len() > limit {
                    return Err(Error::connection("The calendar server's answer is too big."));
                }
                bytes.extend_from_slice(&chunk);
            }
            return Ok(DavResponse { status, url: target, etag, body: bytes });
        }
        Err(Error::connection("The calendar server keeps redirecting."))
    }

    /// PROPFIND or REPORT, expecting a multistatus answer.
    pub async fn multistatus(&self, method_name: &str, url: &Url, depth: &str, body: &str) -> Result<(Element, Url)> {
        let response = self
            .send(
                method_name,
                url,
                &[("Depth", depth.to_string())],
                Some(("application/xml; charset=utf-8", body.as_bytes())),
                MAX_LISTING,
            )
            .await?;
        check(response.status)?;
        if response.status != StatusCode::MULTI_STATUS {
            return Err(Error::not_supported("That address doesn't answer like a calendar server."));
        }
        Ok((xml::parse(&response.body)?, response.url))
    }
}

/// Turns an HTTP status into what went wrong, for anything that isn't a success.
pub fn check(status: StatusCode) -> Result<()> {
    match status {
        status if status.is_success() => Ok(()),
        StatusCode::UNAUTHORIZED => Err(Error::auth("The calendar server didn't accept your password.")),
        StatusCode::FORBIDDEN => Err(Error::invalid("The calendar server doesn't allow that.")),
        StatusCode::NOT_FOUND | StatusCode::GONE => Err(Error::not_found("That's no longer on the calendar server.")),
        StatusCode::PRECONDITION_FAILED => Err(Error::invalid(
            "This changed on the calendar server in the meantime. Load the calendar again and retry.",
        )),
        StatusCode::INSUFFICIENT_STORAGE => Err(Error::invalid("The calendar server has no room left.")),
        status if status.is_server_error() => Err(Error::connection(format!("The calendar server answered {status}."))),
        status => Err(Error::invalid(format!("The calendar server refused it ({status})."))),
    }
}

/// `href`s are paths (or full URLs) relative to the answer's address.
fn resolve(base: &Url, href: &str) -> Option<Url> {
    base.join(href.trim()).ok()
}

/// One `<response>` of a multistatus: its address and the properties that came with a 200.
pub fn responses<'a>(root: &'a Element, base: &Url) -> Vec<(Url, Vec<&'a Element>)> {
    root.children_named(DAV, "response")
        .filter_map(|response| {
            let url = resolve(base, response.child(DAV, "href")?.trimmed_text())?;
            let props = response
                .children_named(DAV, "propstat")
                .filter(|propstat| {
                    propstat
                        .child(DAV, "status")
                        .is_none_or(|status| status.trimmed_text().split(' ').nth(1) == Some("200"))
                })
                .filter_map(|propstat| propstat.child(DAV, "prop"))
                .flat_map(|prop| prop.children.iter())
                .collect();
            Some((url, props))
        })
        .collect()
}

fn prop<'a>(props: &[&'a Element], namespace: &str, name: &str) -> Option<&'a Element> {
    props.iter().copied().find(|element| element.is(namespace, name))
}

fn href_in(element: &Element, base: &Url) -> Option<Url> {
    resolve(base, element.child(DAV, "href")?.trimmed_text())
}

// ----------------------------------------------------------------- discovery

const PRINCIPAL_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:current-user-principal/><c:calendar-home-set/></d:prop></d:propfind>"#;

/// The calendar home set found at an address: directly, or through the current user's principal.
pub async fn home_at(client: &DavClient, url: &Url) -> Result<Option<Url>> {
    let (root, landed) = client.multistatus("PROPFIND", url, "0", PRINCIPAL_BODY).await?;
    let found = responses(&root, &landed);
    if let Some(home) = found.iter().find_map(|(_, props)| href_in(prop(props, CALDAV, "calendar-home-set")?, &landed))
    {
        return Ok(Some(home));
    }
    let Some(principal) =
        found.iter().find_map(|(_, props)| href_in(prop(props, DAV, "current-user-principal")?, &landed))
    else {
        return Ok(None);
    };
    let (root, landed) = client.multistatus("PROPFIND", &principal, "0", PRINCIPAL_BODY).await?;
    Ok(responses(&root, &landed)
        .iter()
        .find_map(|(_, props)| href_in(prop(props, CALDAV, "calendar-home-set")?, &landed)))
}

/// Where to look for a mailbox's calendars (RFC 6764): the SRV record's host, then the mail
/// domain's and the mail server's `/.well-known/caldav`.
pub async fn candidates(domain: &str, hosts: &[String]) -> Vec<Url> {
    let mut found: Vec<String> = Vec::new();
    if let Some(resolver) = crate::autoconfig::resolver().await
        && let Some((target, port)) = crate::autoconfig::srv(&resolver, &format!("_caldavs._tcp.{domain}.")).await
    {
        found.push(if port == 443 {
            format!("https://{target}/.well-known/caldav")
        } else {
            format!("https://{target}:{port}/.well-known/caldav")
        });
    }
    for host in std::iter::once(domain).chain(hosts.iter().map(String::as_str)) {
        let url = format!("https://{}/.well-known/caldav", host.trim().trim_end_matches('.'));
        if !found.contains(&url) {
            found.push(url);
        }
    }
    found.iter().filter_map(|url| Url::parse(url).ok()).collect()
}

/// The calendar home for a mailbox: at the address typed in by hand, or found by discovery.
pub async fn discover(client: &DavClient, manual: Option<&Url>, domain: &str, hosts: &[String]) -> Result<Url> {
    if let Some(manual) = manual {
        return match home_at(client, manual).await {
            Ok(Some(home)) => Ok(home),
            // The address may be the home (or a calendar's parent) itself.
            Ok(None) => Ok(manual.clone()),
            Err(error) => Err(error),
        };
    }
    discover_among(client, &candidates(domain, hosts).await).await
}

/// The calendar home at the first of `candidates` that has one. The password only goes where
/// [`DavClient::locate`] leads.
pub async fn discover_among(client: &DavClient, candidates: &[Url]) -> Result<Url> {
    let mut last_error = None;
    for candidate in candidates {
        let start = match client.locate(candidate).await {
            Ok(Some(start)) => start,
            Ok(None) => continue,
            Err(error) => {
                tracing::debug!("No calendars at {candidate}: {error}");
                last_error.get_or_insert(error);
                continue;
            }
        };
        match home_at(client, &start).await {
            Ok(Some(home)) => return Ok(home),
            Ok(None) => {}
            Err(error) => {
                tracing::debug!("No calendars at {candidate}: {error}");
                // A wrong password is worth telling; a missing server isn't.
                if error.code == crate::error::ErrorCode::AuthFailed || last_error.is_none() {
                    last_error = Some(error);
                }
            }
        }
    }
    match last_error {
        Some(error) if error.code == crate::error::ErrorCode::AuthFailed => Err(error),
        _ => Err(Error::not_supported("No calendar server was found for this mailbox.")),
    }
}

// ----------------------------------------------------------------- calendars

#[derive(Debug, Clone, PartialEq)]
pub struct DavCalendar {
    pub url: Url,
    pub name: String,
    pub color: Option<String>,
    pub order: Option<i64>,
    pub writable: bool,
}

const CALENDARS_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/" xmlns:cs="http://calendarserver.org/ns/">
<d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><a:calendar-order/><c:supported-calendar-component-set/><d:current-user-privilege-set/><cs:getctag/></d:prop></d:propfind>"#;

/// The calendars in a multistatus answer about the home: collections of type calendar that
/// hold events (or don't say what they hold).
pub fn parse_calendars(root: &Element, base: &Url) -> Vec<DavCalendar> {
    responses(root, base)
        .into_iter()
        .filter_map(|(url, props)| {
            let kind = prop(&props, DAV, "resourcetype")?;
            kind.child(CALDAV, "calendar")?;
            if let Some(components) = prop(&props, CALDAV, "supported-calendar-component-set") {
                let events = components
                    .children_named(CALDAV, "comp")
                    .any(|comp| comp.attribute("name").is_some_and(|name| name.eq_ignore_ascii_case("VEVENT")));
                if !events {
                    return None;
                }
            }
            let privileges: Vec<&str> = prop(&props, DAV, "current-user-privilege-set")
                .map(|set| {
                    set.children_named(DAV, "privilege")
                        .flat_map(|privilege| privilege.children.iter())
                        .filter(|element| element.namespace == DAV)
                        .map(|element| element.name.as_str())
                        .collect()
                })
                .unwrap_or_default();
            // Servers that don't list privileges usually let the owner write.
            let writable = prop(&props, DAV, "current-user-privilege-set").is_none()
                || privileges.iter().any(|name| matches!(*name, "all" | "write" | "write-content" | "bind"));
            let name = prop(&props, DAV, "displayname").map(|e| e.trimmed_text().to_string()).unwrap_or_default();
            let name = if name.is_empty() {
                url.path_segments()
                    .and_then(|mut segments| segments.rfind(|segment| !segment.is_empty()))
                    .map(|segment| percent_encoding::percent_decode_str(segment).decode_utf8_lossy().into_owned())
                    .unwrap_or_else(|| "Calendar".into())
            } else {
                name
            };
            Some(DavCalendar {
                color: super::jscal::clean_color(prop(&props, APPLE, "calendar-color").map(Element::trimmed_text)),
                order: prop(&props, APPLE, "calendar-order").and_then(|e| e.trimmed_text().parse().ok()),
                url,
                name,
                writable,
            })
        })
        .collect()
}

pub async fn calendars(client: &DavClient, home: &Url) -> Result<Vec<DavCalendar>> {
    let (root, landed) = client.multistatus("PROPFIND", home, "1", CALENDARS_BODY).await?;
    Ok(parse_calendars(&root, &landed))
}

/// Apple's calendar-color with full opacity.
fn apple_color(color: &str) -> String {
    format!("{}FF", color.to_ascii_uppercase())
}

pub async fn make_calendar(client: &DavClient, home: &Url, name: &str, color: Option<&str>) -> Result<Url> {
    let mut url = home.clone();
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    let url = url
        .join(&format!("{}/", uuid::Uuid::new_v4()))
        .map_err(|_| Error::internal("The calendar's address couldn't be built."))?;
    let color = color
        .map(|c| format!("<a:calendar-color>{}</a:calendar-color>", xml::escape(&apple_color(c))))
        .unwrap_or_default();
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:set><d:prop><d:displayname>{}</d:displayname>{color}<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>"#,
        xml::escape(name)
    );
    let response = client
        .send("MKCALENDAR", &url, &[], Some(("application/xml; charset=utf-8", body.as_bytes())), MAX_LISTING)
        .await?;
    check(response.status)?;
    Ok(url)
}

/// Renames or recolors a calendar. `color: Some(None)` removes the color.
pub async fn update_calendar(
    client: &DavClient,
    url: &Url,
    name: Option<&str>,
    color: Option<Option<&str>>,
) -> Result<()> {
    let mut set = String::new();
    let mut remove = String::new();
    if let Some(name) = name {
        set.push_str(&format!("<d:displayname>{}</d:displayname>", xml::escape(name)));
    }
    match color {
        Some(Some(color)) => {
            set.push_str(&format!("<a:calendar-color>{}</a:calendar-color>", xml::escape(&apple_color(color))))
        }
        Some(None) => remove.push_str("<a:calendar-color/>"),
        None => {}
    }
    if set.is_empty() && remove.is_empty() {
        return Ok(());
    }
    let set = if set.is_empty() { String::new() } else { format!("<d:set><d:prop>{set}</d:prop></d:set>") };
    let remove =
        if remove.is_empty() { String::new() } else { format!("<d:remove><d:prop>{remove}</d:prop></d:remove>") };
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/">{set}{remove}</d:propertyupdate>"#
    );
    let response = client
        .send("PROPPATCH", url, &[], Some(("application/xml; charset=utf-8", body.as_bytes())), MAX_LISTING)
        .await?;
    check(response.status)?;
    // A 207 can still say a property was refused.
    if response.status == StatusCode::MULTI_STATUS {
        let root = xml::parse(&response.body)?;
        let refused =
            root.children_named(DAV, "response").flat_map(|r| r.children_named(DAV, "propstat")).any(|propstat| {
                propstat
                    .child(DAV, "status")
                    .is_some_and(|status| status.trimmed_text().split(' ').nth(1) != Some("200"))
            });
        if refused {
            return Err(Error::invalid("The calendar server didn't take the change."));
        }
    }
    Ok(())
}

// -------------------------------------------------------------------- events

#[derive(Debug, Clone, PartialEq)]
pub struct DavObject {
    pub url: Url,
    pub etag: Option<String>,
    pub data: String,
}

fn caldav_time(time: DateTime<Utc>) -> String {
    time.format("%Y%m%dT%H%M%SZ").to_string()
}

/// The objects with events in `[from, to)` (UTC).
pub async fn objects_between(
    client: &DavClient,
    calendar: &Url,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<DavObject>> {
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>
<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="{}" end="{}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"#,
        caldav_time(from),
        caldav_time(to)
    );
    let (root, landed) = client.multistatus("REPORT", calendar, "1", &body).await?;
    Ok(parse_objects(&root, &landed))
}

pub fn parse_objects(root: &Element, base: &Url) -> Vec<DavObject> {
    responses(root, base)
        .into_iter()
        .filter_map(|(url, props)| {
            let data = prop(&props, CALDAV, "calendar-data")?.text.clone();
            (!data.trim().is_empty() && data.len() <= MAX_OBJECT).then(|| DavObject {
                etag: prop(&props, DAV, "getetag").map(|e| e.trimmed_text().to_string()).filter(|e| !e.is_empty()),
                url,
                data,
            })
        })
        .take(MAX_OBJECTS)
        .collect()
}

pub async fn get_object(client: &DavClient, url: &Url) -> Result<DavObject> {
    let response = client.send("GET", url, &[("Accept", "text/calendar".into())], None, MAX_OBJECT).await?;
    check(response.status)?;
    let data = String::from_utf8(response.body)
        .map_err(|_| Error::invalid("The calendar server sent an event that isn't text."))?;
    Ok(DavObject { url: response.url, etag: response.etag, data })
}

/// Stores an object: new (`etag` None, fails if something is there) or replacing the version
/// with that etag. Returns the new etag, if the server says.
pub async fn put_object(client: &DavClient, url: &Url, data: &str, etag: Option<&str>) -> Result<Option<String>> {
    let condition = match etag {
        Some(etag) => ("If-Match", etag.to_string()),
        None => ("If-None-Match", "*".to_string()),
    };
    let response = client
        .send("PUT", url, &[condition], Some(("text/calendar; charset=utf-8", data.as_bytes())), MAX_LISTING)
        .await?;
    check(response.status)?;
    Ok(response.etag)
}

pub async fn delete(client: &DavClient, url: &Url, etag: Option<&str>) -> Result<()> {
    let headers: Vec<(&str, String)> = etag.map(|etag| ("If-Match", etag.to_string())).into_iter().collect();
    let response = client.send("DELETE", url, &headers, None, MAX_LISTING).await?;
    match response.status {
        StatusCode::NOT_FOUND | StatusCode::GONE => Ok(()),
        status => check(status),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("https://dav.example.org/calendars/mini/").unwrap()
    }

    #[test]
    fn lists_calendars_that_hold_events() {
        let answer = br##"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
 <d:response><d:href>/calendars/mini/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/calendars/mini/work/</d:href><d:propstat><d:prop>
   <d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Work</d:displayname>
   <a:calendar-color>#FF8800FF</a:calendar-color><a:calendar-order>2</a:calendar-order>
   <c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set>
   <d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  <d:propstat><d:prop><x:unknown xmlns:x="urn:x"/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
 <d:response><d:href>/calendars/mini/tasks/</d:href><d:propstat><d:prop>
   <d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Tasks</d:displayname>
   <c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/calendars/mini/holidays%20de/</d:href><d:propstat><d:prop>
   <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
   <d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>"##;
        let root = xml::parse(answer).unwrap();
        let calendars = parse_calendars(&root, &base());
        assert_eq!(calendars.len(), 2);
        assert_eq!(calendars[0].url.as_str(), "https://dav.example.org/calendars/mini/work/");
        assert_eq!(calendars[0].name, "Work");
        assert_eq!(calendars[0].color.as_deref(), Some("#ff8800"));
        assert_eq!(calendars[0].order, Some(2));
        assert!(calendars[0].writable);
        assert_eq!(calendars[1].name, "holidays de");
        assert!(!calendars[1].writable);
    }

    #[test]
    fn reads_events_and_skips_broken_ones() {
        let answer = br#"<d:multistatus xmlns:d="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
 <d:response><d:href>/calendars/mini/work/a.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag>
  <C:calendar-data>BEGIN:VCALENDAR&#13;
BEGIN:VEVENT&#13;
UID:a&#13;
END:VEVENT&#13;
END:VCALENDAR&#13;
</C:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/calendars/mini/work/gone.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>
 <d:response><d:propstat><d:prop><d:getetag>"x"</d:getetag></d:prop></d:propstat></d:response>
</d:multistatus>"#;
        let root = xml::parse(answer).unwrap();
        let objects = parse_objects(&root, &Url::parse("https://dav.example.org/calendars/mini/work/").unwrap());
        assert_eq!(objects.len(), 1);
        assert_eq!(objects[0].etag.as_deref(), Some("\"1\""));
        assert!(objects[0].data.contains("UID:a\r\n"));
    }

    #[test]
    fn keeps_the_password_within_the_mailbox_sites() {
        let client = DavClient::new("mini", "secret", &["uwumail.test", "imap.mailhost.example"]).unwrap();
        let url = |s: &str| Url::parse(s).unwrap();
        assert!(client.may_send_password(&url("https://dav.uwumail.test/caldav/")));
        assert!(client.may_send_password(&url("https://caldav.mailhost.example/")));
        assert!(!client.may_send_password(&url("http://dav.uwumail.test/caldav/")), "never unencrypted");
        assert!(!client.may_send_password(&url("https://collector.example.net/")));
        assert!(!client.may_send_password(&url("https://uwumail.test.evil.example/")));
    }

    #[test]
    fn explains_statuses() {
        assert!(check(StatusCode::CREATED).is_ok());
        assert_eq!(check(StatusCode::UNAUTHORIZED).unwrap_err().code, crate::error::ErrorCode::AuthFailed);
        assert!(check(StatusCode::PRECONDITION_FAILED).unwrap_err().message.contains("changed"));
        assert_eq!(check(StatusCode::BAD_GATEWAY).unwrap_err().code, crate::error::ErrorCode::ConnectionFailed);
    }
}
