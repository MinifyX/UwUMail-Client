//! Calendars: JMAP Calendars on UwUMail servers, CalDAV for other mailboxes that sign in with a
//! password. Online only: events are read from the server for the range on screen; only each
//! account's list of calendars is kept in memory for a few minutes.
//!
//! Both paths meet in the JSCalendar shape (`jscal`): a UwUMail server sends it over JMAP, and
//! CalDAV's iCalendar is converted into it with `calcard` (`ical`).

pub mod dav;
pub mod ical;
pub mod jmap_cal;
pub mod jscal;
pub mod xml;

use std::sync::Arc;
use std::time::Instant;

use url::Url;

use crate::error::{Error, Result};
use crate::model::CalendarInfo;

/// Where an account's calendars live.
#[derive(Clone)]
pub enum Source {
    /// The account's JMAP session has calendars.
    Jmap,
    Dav {
        client: Arc<dav::DavClient>,
        home: Url,
    },
}

/// What's known about an account's calendars.
pub enum SourceState {
    Ready(Source),
    /// No calendars for this account; asked again after a while.
    Unavailable {
        problem: Error,
        since: Instant,
    },
}

/// A calendar and how the server knows it: the JMAP id, or the CalDAV collection's path.
#[derive(Debug, Clone)]
pub struct CalendarEntry {
    pub info: CalendarInfo,
    pub remote: String,
}

/// The app's id for something of an account: the account id, a colon, the server's id or path.
pub fn app_id(account_id: &str, remote: &str) -> String {
    format!("{account_id}:{remote}")
}

/// Splits an app id into the account id and the server's id or path.
pub fn split_id(id: &str) -> Result<(&str, &str)> {
    id.split_once(':')
        .filter(|(account, remote)| !account.is_empty() && !remote.is_empty())
        .ok_or_else(|| Error::invalid("That calendar or event id makes no sense."))
}

/// CalDAV occurrence ids are the object's path, `#` and the recurrence id.
pub fn split_occurrence(remote: &str) -> (&str, Option<&str>) {
    match remote.split_once('#') {
        Some((path, recurrence_id)) if !recurrence_id.is_empty() => (path, Some(recurrence_id)),
        _ => (remote.trim_end_matches('#'), None),
    }
}

/// A CalDAV path from an id as a URL on the calendar server. Only paths: an id can never make
/// UwUMail send the password to another host.
pub fn dav_url(home: &Url, path: &str) -> Result<Url> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains(['?', '#', '\\']) {
        return Err(Error::invalid("That calendar address makes no sense."));
    }
    let mut url = home.clone();
    url.set_path(path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_carry_their_account() {
        assert_eq!(app_id("a1", "/cal/work/x.ics"), "a1:/cal/work/x.ics");
        assert_eq!(split_id("a1:/cal/work/x.ics").unwrap(), ("a1", "/cal/work/x.ics"));
        assert_eq!(split_id("a1:E:5").unwrap(), ("a1", "E:5"));
        assert!(split_id("nothing").is_err());
        assert!(split_id(":x").is_err());
        assert_eq!(split_occurrence("/cal/x.ics#2026-09-24T18:00:00"), ("/cal/x.ics", Some("2026-09-24T18:00:00")));
        assert_eq!(split_occurrence("/cal/x.ics"), ("/cal/x.ics", None));
    }

    #[test]
    fn dav_ids_stay_on_the_calendar_server() {
        let home = Url::parse("https://dav.example.org/calendars/mini/").unwrap();
        assert_eq!(
            dav_url(&home, "/calendars/mini/work/").unwrap().as_str(),
            "https://dav.example.org/calendars/mini/work/"
        );
        assert!(dav_url(&home, "//evil.example/x").is_err());
        assert!(dav_url(&home, "https://evil.example/x").is_err());
        assert!(dav_url(&home, "relative/x").is_err());
        assert!(dav_url(&home, "/x?y=1").is_err());
        // Whatever the path says, the host stays.
        assert_eq!(dav_url(&home, "/../../etc").unwrap().host_str(), Some("dav.example.org"));
    }
}
