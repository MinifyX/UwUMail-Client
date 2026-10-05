//! "Send later": what a chosen time has to be, when the outbox looks again, and what the list of
//! scheduled mail shows.
//!
//! A mailbox on a UwUMail server hands the mail to the server right away and the server holds it
//! (JMAP `EmailSubmission` with `sendAt`, at most the session's `maxDelayedSend` ahead), exactly
//! like the webmail does; it goes even while this device is off. Every other mailbox (IMAP/SMTP,
//! other JMAP servers, Microsoft, Google) keeps the mail in the local outbox, the table the
//! "undo send" window uses too, with its send time: it goes out when UwUMail runs at or after that
//! time (also in the tray or Android's background service), and a time missed while UwUMail was
//! closed sends on the next start.
//!
//! Everything here is plain logic over times in Unix milliseconds, so it is tested with made-up
//! clocks instead of waiting.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::model::Address;

/// A time has to be at least this far ahead. The UI asks for a few minutes; this leaves room for
/// a slow dialog.
pub const MIN_AHEAD_MS: i64 = 60 * 1000;
/// How far ahead the local outbox takes mail: a year.
pub const LOCAL_MAX_DELAY_SECS: u64 = 365 * 24 * 3600;
/// The most mail scheduled in the local outbox at once.
pub const MAX_LOCAL_SCHEDULED: usize = 500;
/// The outbox looks at the clock at least this often. A sleeping computer stops the timer but
/// not the wall clock; this way a time passed during sleep is noticed soon after waking.
pub const MAX_NAP: Duration = Duration::from_secs(30);
/// Server-held mail due this soon is still in somebody's "undo send" window rather than sent
/// later on purpose (the longest undo window is a minute); the list leaves it out.
pub const UNDO_WINDOW_MS: i64 = 60 * 1000;
/// Waits before trying a scheduled mail again that couldn't reach its server, e.g. right after
/// waking up before the network is back. After the last one it is kept as a draft.
const RETRY_MINUTES: [i64; 6] = [1, 2, 5, 10, 15, 30];

/// Where a mailbox's scheduled mail waits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScheduledKind {
    /// On the UwUMail server, which sends it even while this device is off.
    Server,
    /// In this device's outbox: it goes when UwUMail runs at or after its time.
    Local,
}

/// What "send later" can do for a mailbox.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendLaterInfo {
    pub kind: ScheduledKind,
    /// How far ahead a time may be, in seconds.
    pub max_delay_seconds: u64,
}

/// A mail waiting for its time, on the server or in this device's outbox.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledSend {
    /// The outbox entry, or the server's submission.
    pub id: String,
    pub account_id: String,
    pub kind: ScheduledKind,
    /// When it goes (ISO 8601, UTC).
    pub send_at: String,
    pub subject: String,
    pub to: Vec<Address>,
    /// Its time passed, but its server couldn't be reached yet; UwUMail tries again at `send_at`.
    #[serde(default)]
    pub retrying: bool,
    /// It waits for the person and doesn't go on its own: it couldn't be sent, or it may have
    /// gone out already. A new time or "send now" sends it again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held: Option<Held>,
    /// Why it is held, in the words of the failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held_reason: Option<String>,
}

/// Why a mail in this device's outbox waits for the person (security review 0.10 SL-3/SL-4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Held {
    /// It couldn't be sent, and Drafts couldn't take it either; this copy is the only one.
    Failed,
    /// Sending broke off when it may already have gone out (also: UwUMail stopped meanwhile).
    Unsure,
}

/// Which scheduled mail an action is about.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRef {
    pub id: String,
    pub account_id: String,
    pub kind: ScheduledKind,
}

impl ScheduledRef {
    /// Refuses ids that can't be ours: outbox ids are UUIDs, JMAP ids are short and plain.
    pub fn check(&self) -> Result<()> {
        let plain = |id: &str| {
            !id.is_empty() && id.len() <= 255 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        };
        if !plain(&self.id) || self.account_id.is_empty() || self.account_id.len() > 255 {
            return Err(Error::invalid("This scheduled mail doesn't exist."));
        }
        Ok(())
    }
}

/// What scheduling handed back.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledReceipt {
    pub id: String,
    pub kind: ScheduledKind,
    pub send_at: String,
}

/// A time from the UI (RFC 3339) in Unix milliseconds.
pub fn parse_time(text: &str) -> Result<i64> {
    let invalid = || Error::invalid("Pick a date and a time.");
    if text.len() > 64 {
        return Err(invalid());
    }
    chrono::DateTime::parse_from_rfc3339(text.trim()).map(|date| date.timestamp_millis()).map_err(|_| invalid())
}

/// A time as the UI and JMAP take it: whole seconds in UTC (a JMAP `UTCDate`).
pub fn format_time(millis: i64) -> String {
    chrono::DateTime::from_timestamp(millis.div_euclid(1000), 0)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

/// Whether `send_at` works now: far enough ahead, and not further than the mail can be held.
pub fn check_time(send_at: i64, now: i64, max_delay_seconds: u64) -> Result<()> {
    if send_at - now < MIN_AHEAD_MS {
        return Err(Error::invalid("Pick a time at least a few minutes from now."));
    }
    let max = i64::try_from(max_delay_seconds).unwrap_or(i64::MAX / 2).saturating_mul(1000);
    if send_at - now > max {
        let days = max_delay_seconds / 86_400;
        return Err(Error::invalid(format!("Mail can be held for at most {days} days.")));
    }
    Ok(())
}

/// How long the outbox may sleep before it looks again: until the next mail is due, at most
/// [`MAX_NAP`], and not at all when one is due already.
pub fn nap(next_send_at: Option<i64>, now: i64) -> Duration {
    match next_send_at {
        Some(at) if at <= now => Duration::ZERO,
        Some(at) => Duration::from_millis(u64::try_from(at - now).unwrap_or(0)).min(MAX_NAP),
        None => MAX_NAP,
    }
}

/// When to try again a scheduled mail that couldn't reach its server on its `attempts`th try;
/// `None` once it has been tried often enough.
pub fn retry_at(attempts: u32, now: i64) -> Option<i64> {
    RETRY_MINUTES.get(usize::try_from(attempts).ok()?).map(|minutes| now + minutes * 60 * 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000;

    #[test]
    fn times_come_and_go_as_whole_utc_seconds() {
        assert_eq!(parse_time("2026-10-06T08:00:00Z").unwrap(), 1_791_273_600_000);
        assert_eq!(parse_time("2026-10-06T10:00:00+02:00").unwrap(), 1_791_273_600_000);
        assert_eq!(parse_time("2026-10-06T08:00:00.000Z").unwrap(), 1_791_273_600_000);
        assert_eq!(format_time(1_791_273_600_999), "2026-10-06T08:00:00Z");
        for bad in ["", "morgen", "2026-10-06", "2026-13-06T08:00:00Z", &"9".repeat(100)] {
            assert!(parse_time(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_time_has_to_be_ahead_and_within_reach() {
        let day = 86_400;
        assert!(check_time(NOW + 5 * 60_000, NOW, day).is_ok());
        assert!(check_time(NOW + MIN_AHEAD_MS, NOW, day).is_ok());
        assert!(check_time(NOW + MIN_AHEAD_MS - 1, NOW, day).is_err(), "too soon");
        assert!(check_time(NOW - 60_000, NOW, day).is_err(), "in the past");
        assert!(check_time(NOW + day as i64 * 1000, NOW, day).is_ok());
        let far = check_time(NOW + day as i64 * 1000 + 1, NOW, day).unwrap_err();
        assert!(far.message.contains("1 days"), "{}", far.message);
        assert!(check_time(i64::MAX, NOW, u64::MAX).is_ok(), "no overflow");
    }

    #[test]
    fn the_outbox_sleeps_until_the_next_mail_but_never_long() {
        assert_eq!(nap(None, NOW), MAX_NAP);
        assert_eq!(nap(Some(NOW + 5_000), NOW), Duration::from_secs(5));
        assert_eq!(nap(Some(NOW + 3_600_000), NOW), MAX_NAP, "a computer may sleep in between");
        assert_eq!(nap(Some(NOW), NOW), Duration::ZERO);
        assert_eq!(nap(Some(NOW - 86_400_000), NOW), Duration::ZERO, "missed while closed: at once");
    }

    #[test]
    fn an_unreachable_server_is_tried_again_a_few_times() {
        assert_eq!(retry_at(0, NOW), Some(NOW + 60_000));
        assert_eq!(retry_at(5, NOW), Some(NOW + 30 * 60_000));
        assert_eq!(retry_at(6, NOW), None);
        assert_eq!(retry_at(u32::MAX, NOW), None);
    }

    #[test]
    fn only_plain_ids_are_taken() {
        let reference = |id: &str| ScheduledRef { id: id.into(), account_id: "acc".into(), kind: ScheduledKind::Local };
        assert!(reference("3f2b0c1e-8d7a-4c2b-9b1e-0a1b2c3d4e5f").check().is_ok());
        assert!(reference("S12").check().is_ok());
        for bad in ["", "a/b", "a b", "ü", &"x".repeat(256)] {
            assert!(reference(bad).check().is_err(), "{bad:?}");
        }
    }
}
