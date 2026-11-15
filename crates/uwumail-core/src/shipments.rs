//! Shipments: parcels the mail tells of. A UwUMail server keeps them itself (`jmap_shipments`);
//! for every other mailbox this device finds them in new mail with the labels crate's
//! `shipment()` and keeps them in its own store, merged by the server's rules
//! (UwUMail-Server crates/uwumail-store/src/shipments.rs, `record_mail`). Tracking pages are
//! never fetched: only what the mails say.

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, SecondsFormat, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use uwumail_labels::{Carrier, Day, Pickup as FoundPickup, ShipmentFacts, ShipmentStatus};

use crate::error::{Error, Result};

/// Only what the labels crate is this sure of becomes a shipment (as on the server).
pub const MIN_CONFIDENCE: f32 = 0.8;
/// Delivered, returned or cancelled shipments go this long after their last status.
const DONE_SECS: i64 = 30 * 86_400;
/// Any shipment goes this long after its last event.
const STALE_SECS: i64 = 60 * 86_400;
pub const MAX_EVENTS: usize = 200;
pub const MAX_PER_ACCOUNT: usize = 2000;
const TEXT_MAX_CHARS: usize = 500;
pub const TITLE_MAX_CHARS: usize = 200;
const NUMBER_MAX_CHARS: usize = 40;
/// Statuses that notify.
pub const NOTIFIED: [&str; 3] = ["outForDelivery", "delivered", "readyForPickup"];

/// When a shipment is expected: RFC 3339 with the offset of the place it was read in. A day
/// without a time window runs from its midnight to the next (`all_day`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expected {
    pub from: Option<String>,
    pub to: Option<String>,
    pub all_day: bool,
}

/// Where it waits to be picked up; `until` is a day like `2026-11-22`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pickup {
    pub kind: String,
    pub name: Option<String>,
    pub address: Option<String>,
    pub until: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShipmentEvent {
    pub at: String,
    pub status: String,
    pub text: Option<String>,
    pub location: Option<String>,
    /// `mail`, `ai` or `client`.
    pub source: String,
    /// The mail it was found in (this device's message id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
}

/// One shipment as the page shows it, from the server (docs/jmap-shipments.md) or this device.
/// `id` is unique within its account only.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Shipment {
    pub account_id: String,
    pub id: String,
    pub carrier: String,
    pub number: Option<String>,
    pub tracking_url: Option<String>,
    pub title: Option<String>,
    pub merchant: Option<String>,
    pub order_ref: Option<String>,
    pub status: String,
    pub status_at: String,
    pub expected: Option<Expected>,
    pub delivered_at: Option<String>,
    pub pickup: Option<Pickup>,
    pub hidden: bool,
    /// The mails it was found in, oldest first (this device's message ids).
    pub email_ids: Vec<String>,
    /// Oldest first.
    pub events: Vec<ShipmentEvent>,
    pub created: String,
    pub updated: String,
}

/// Whether an account has parcels (`on`), and whether the person may switch them on and off on
/// its UwUMail server (`switchable`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipmentAccount {
    pub account_id: String,
    pub on: bool,
    pub switchable: bool,
}

/// A status worth a notification that a shipment reached (see [`NOTIFIED`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipmentNotice {
    pub account_id: String,
    pub shipment_id: String,
    pub status: String,
    /// [`Shipment::display_name`].
    pub name: String,
}

pub fn format_time(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Unix seconds of an RFC 3339 time; 0 for anything else.
pub fn seconds(at: &str) -> i64 {
    DateTime::parse_from_rfc3339(at).map(|at| at.timestamp()).unwrap_or(0)
}

/// Cut to `max` characters, for what comes from mail and must not refuse the mail.
fn clipped(value: &str, max: usize) -> Option<String> {
    let value: String = value.chars().filter(|c| !c.is_control()).take(max).collect();
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn status_of(id: &str) -> ShipmentStatus {
    ShipmentStatus::from_id(id).unwrap_or(ShipmentStatus::Shipped)
}

/// The local day a mail meant, from the day it came (as the server reads it).
fn resolve<Tz: TimeZone>(day: Day, received_at: DateTime<Utc>, tz: &Tz) -> Option<NaiveDate> {
    let base = received_at.with_timezone(tz).date_naive();
    match day {
        Day::InDays(days) if days <= 60 => base.checked_add_signed(Duration::days(days.into())),
        Day::InDays(_) => None,
        Day::On { year: Some(year), month, day } => NaiveDate::from_ymd_opt(year, month, day),
        Day::On { year: None, month, day } => {
            let date = NaiveDate::from_ymd_opt(base.year(), month, day)?;
            // "am 3. Januar" in a mail from late December is next year.
            if date < base - Duration::days(60) {
                NaiveDate::from_ymd_opt(base.year() + 1, month, day)
            } else {
                Some(date)
            }
        }
    }
}

fn local<Tz: TimeZone>(day: NaiveDate, time: (u32, u32), tz: &Tz) -> Option<String> {
    let at = tz.from_local_datetime(&day.and_time(NaiveTime::from_hms_opt(time.0, time.1, 0)?)).earliest()?;
    Some(at.fixed_offset().to_rfc3339_opts(SecondsFormat::Secs, false))
}

fn expected_of<Tz: TimeZone>(facts: &ShipmentFacts, received_at: DateTime<Utc>, tz: &Tz) -> Option<Expected> {
    let window = facts.expected?;
    let day = resolve(window.day, received_at, tz)?;
    Some(match (window.from, window.to) {
        (None, None) => Expected {
            from: local(day, (0, 0), tz),
            to: day.succ_opt().and_then(|next| local(next, (0, 0), tz)),
            all_day: true,
        },
        (from, to) => Expected {
            from: local(day, from.unwrap_or((0, 0)), tz),
            to: to.and_then(|to| local(day, to, tz)),
            all_day: false,
        },
    })
}

fn pickup_of<Tz: TimeZone>(pickup: &FoundPickup, received_at: DateTime<Utc>, tz: &Tz) -> Pickup {
    Pickup {
        kind: pickup.kind.id().to_owned(),
        name: pickup.name.as_deref().and_then(|name| clipped(name, TITLE_MAX_CHARS)),
        address: pickup.address.as_deref().and_then(|address| clipped(address, TITLE_MAX_CHARS)),
        until: pickup.until.and_then(|day| resolve(day, received_at, tz)).map(|date| date.to_string()),
    }
}

/// The link to follow a shipment: the one in the mail when it names one shipment, else the carrier's.
fn carrier_tracking(facts: &ShipmentFacts, number: &str, numbers: usize) -> Option<String> {
    let own = facts.carrier.as_ref().and_then(|carrier| carrier.tracking_url(number));
    if numbers > 1 { own } else { facts.tracking_url.clone().or(own) }
}

impl Shipment {
    fn new(id: String, carrier: &str, number: Option<&str>, status: ShipmentStatus, at: DateTime<Utc>) -> Self {
        let at = format_time(at);
        Self {
            account_id: String::new(),
            id,
            carrier: carrier.to_owned(),
            number: number.map(str::to_owned),
            tracking_url: None,
            title: None,
            merchant: None,
            order_ref: None,
            status: status.id().to_owned(),
            status_at: at.clone(),
            expected: None,
            delivered_at: None,
            pickup: None,
            hidden: false,
            email_ids: Vec::new(),
            events: Vec::new(),
            created: at.clone(),
            updated: at,
        }
    }

    /// Adds an event and moves the status on if it may: only forward and never by an event older
    /// than the current status. The same event twice, or one past [`MAX_EVENTS`], is dropped.
    fn add_event(&mut self, event: ShipmentEvent, now: DateTime<Utc>) -> bool {
        let known = self.events.iter().any(|old| {
            (event.email_id.is_some() && old.email_id == event.email_id)
                || (old.at == event.at && old.status == event.status && old.source == event.source)
        });
        if known || self.events.len() >= MAX_EVENTS {
            return false;
        }
        let next = status_of(&event.status);
        if seconds(&event.at) >= seconds(&self.status_at) && status_of(&self.status).moves_to(next) {
            self.status = next.id().to_owned();
            self.status_at = event.at.clone();
            if next == ShipmentStatus::Delivered {
                self.delivered_at = Some(event.at.clone());
            }
        }
        if let Some(email) = &event.email_id
            && !self.email_ids.contains(email)
        {
            self.email_ids.push(email.clone());
        }
        self.events.push(event);
        self.updated = format_time(now);
        true
    }

    /// The person marks it `status` at `at` by hand (source `client`), or takes such a mark back
    /// (`undo`): then the status is worked out again from the events left, as on the server.
    pub fn mark(&mut self, at: &str, status: ShipmentStatus, undo: bool, now: DateTime<Utc>) -> bool {
        if !undo {
            let event = ShipmentEvent {
                at: at.to_owned(),
                status: status.id().to_owned(),
                source: "client".into(),
                ..Default::default()
            };
            return self.add_event(event, now);
        }
        let before = self.events.len();
        self.events.retain(|event| !(event.source == "client" && event.at == at && event.status == status.id()));
        if self.events.len() == before {
            return false;
        }
        let mut events = self.events.iter();
        if let Some(first) = events.next() {
            self.status = status_of(&first.status).id().to_owned();
            self.status_at = first.at.clone();
            self.delivered_at = (self.status == ShipmentStatus::Delivered.id()).then(|| first.at.clone());
            for event in events {
                let next = status_of(&event.status);
                if seconds(&event.at) >= seconds(&self.status_at) && status_of(&self.status).moves_to(next) {
                    self.status = next.id().to_owned();
                    self.status_at = event.at.clone();
                    if next == ShipmentStatus::Delivered {
                        self.delivered_at = Some(event.at.clone());
                    }
                }
            }
        }
        self.updated = format_time(now);
        true
    }

    /// What a notification calls it: its title, the shop, else the carrier and number.
    pub fn display_name(&self) -> String {
        if let Some(name) = self.title.as_deref().or(self.merchant.as_deref()).filter(|name| !name.trim().is_empty()) {
            return name.to_owned();
        }
        let carrier = match self.carrier.as_str() {
            "dhl" => "DHL",
            "deutschePost" => "Deutsche Post",
            "dpd" => "DPD",
            "hermes" => "Hermes",
            "gls" => "GLS",
            "ups" => "UPS",
            "amazonLogistics" => "Amazon",
            "fedex" => "FedEx",
            _ => "",
        };
        [carrier, self.number.as_deref().unwrap_or_default()]
            .iter()
            .filter(|part| !part.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Puts what one mail tells into an account's shipments (all of them, in `list`). Returns the
/// indices of the shipments it made or changed. `new_id` names a new one.
#[allow(clippy::too_many_arguments)]
pub fn record<Tz: TimeZone>(
    list: &mut Vec<Shipment>,
    facts: &ShipmentFacts,
    email_id: &str,
    received_at: DateTime<Utc>,
    subject: &str,
    tz: &Tz,
    now: DateTime<Utc>,
    mut new_id: impl FnMut() -> String,
) -> Vec<usize> {
    let carrier = facts.carrier.as_ref().map(Carrier::id);
    let merchant = facts.merchant.as_deref().and_then(|merchant| clipped(merchant, TITLE_MAX_CHARS));
    let order_ref = facts.order_ref.as_deref().and_then(|order| clipped(order, NUMBER_MAX_CHARS));
    let numbers: Vec<&str> =
        facts.numbers.iter().map(String::as_str).filter(|number| number.chars().count() <= NUMBER_MAX_CHARS).collect();
    if numbers.is_empty() && order_ref.is_none() {
        return Vec::new();
    }
    let status =
        facts.status.unwrap_or(if numbers.is_empty() { ShipmentStatus::Ordered } else { ShipmentStatus::Shipped });
    let event = ShipmentEvent {
        at: format_time(received_at),
        status: status.id().to_owned(),
        text: clipped(subject, TEXT_MAX_CHARS),
        location: None,
        source: "mail".into(),
        email_id: Some(email_id.to_owned()),
        client_name: None,
    };
    let order_of = |list: &[Shipment], number_is_null: bool| -> Vec<usize> {
        let Some(order_ref) = &order_ref else { return Vec::new() };
        (0..list.len())
            .filter(|&i| {
                let s = &list[i];
                s.order_ref.as_ref() == Some(order_ref)
                    && (merchant.is_none() || s.merchant.is_none() || s.merchant == merchant)
                    && (!number_is_null || s.number.is_none())
            })
            .collect()
    };

    // Which shipments the mail is about, and whether each is new.
    let mut targets: Vec<(usize, bool)> = Vec::new();
    if numbers.is_empty() {
        targets.extend(order_of(list, false).into_iter().map(|i| (i, false)));
    }
    for number in &numbers {
        // Rule 1: the same number of the same carrier, or of any carrier when the mail names none.
        if let Some(i) =
            list.iter().position(|s| s.number.as_deref() == Some(number) && carrier.is_none_or(|c| s.carrier == c))
        {
            targets.push((i, false));
            continue;
        }
        // Rules 2 and 3: the order confirmation becomes the shipment once its number comes.
        if let Some(i) = order_of(list, true).into_iter().next() {
            list[i].number = Some((*number).to_owned());
            if let Some(carrier) = carrier {
                list[i].carrier = carrier.to_owned();
            }
            targets.push((i, false));
            continue;
        }
        if list.len() >= MAX_PER_ACCOUNT {
            break;
        }
        let mut shipment = Shipment::new(new_id(), carrier.unwrap_or("other"), Some(number), status, received_at);
        shipment.tracking_url = carrier_tracking(facts, number, numbers.len());
        shipment.merchant = merchant.clone();
        shipment.order_ref = order_ref.clone();
        list.push(shipment);
        targets.push((list.len() - 1, true));
    }
    if numbers.is_empty() && targets.is_empty() && list.len() < MAX_PER_ACCOUNT {
        let mut shipment = Shipment::new(new_id(), carrier.unwrap_or("other"), None, status, received_at);
        shipment.merchant = merchant.clone();
        shipment.order_ref = order_ref.clone();
        list.push(shipment);
        targets.push((list.len() - 1, true));
    }

    let expected = expected_of(facts, received_at, tz);
    let pickup = facts.pickup.as_ref().map(|pickup| pickup_of(pickup, received_at, tz));
    let mut changed = Vec::new();
    for (i, created) in targets {
        let shipment = &mut list[i];
        if !shipment.add_event(event.clone(), now) && !created {
            continue;
        }
        let tracking = shipment.number.as_deref().and_then(|number| carrier_tracking(facts, number, numbers.len()));
        // What the newest mail says wins; an older one only fills in what is missing.
        let newest = seconds(&shipment.status_at) <= received_at.timestamp();
        if shipment.carrier == "other"
            && let Some(carrier) = carrier
        {
            shipment.carrier = carrier.to_owned();
        }
        shipment.tracking_url = shipment.tracking_url.take().or(tracking);
        shipment.merchant = shipment.merchant.take().or_else(|| merchant.clone());
        shipment.order_ref = shipment.order_ref.take().or_else(|| order_ref.clone());
        if expected.is_some() && (newest || shipment.expected.is_none()) {
            shipment.expected = expected.clone();
        }
        if pickup.is_some() && (newest || shipment.pickup.is_none()) {
            shipment.pickup = pickup.clone();
        }
        changed.push(i);
    }
    changed
}

/// A number as typed: without spaces, in capitals, 1–40 letters, digits or dashes.
pub fn normalize_number(number: &str) -> Result<String> {
    let number: String = number.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_uppercase();
    if number.is_empty()
        || number.chars().count() > NUMBER_MAX_CHARS
        || !number.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(Error::invalid("A tracking number has 1 to 40 letters, digits or dashes."));
    }
    Ok(number)
}

/// A title as typed: trimmed, at most [`TITLE_MAX_CHARS`], no control characters; empty is none.
pub fn normalize_title(title: Option<&str>) -> Result<Option<String>> {
    let Some(title) = title.map(str::trim).filter(|title| !title.is_empty()) else { return Ok(None) };
    if title.chars().count() > TITLE_MAX_CHARS || title.chars().any(char::is_control) {
        return Err(Error::invalid("A title has at most 200 characters on one line."));
    }
    Ok(Some(title.to_owned()))
}

/// A shipment added by hand to `list`: shipped, by the carrier named (`other` for one not known).
pub fn create(
    list: &[Shipment],
    carrier: &str,
    number: &str,
    title: Option<&str>,
    id: String,
    now: DateTime<Utc>,
) -> Result<Shipment> {
    let number = normalize_number(number)?;
    let title = normalize_title(title)?;
    let known = Carrier::from_id(carrier).map(|known| known.id()).unwrap_or("other");
    if list.iter().any(|s| s.carrier == known && s.number.as_deref() == Some(number.as_str())) {
        return Err(Error::invalid("This shipment is already being followed."));
    }
    if list.len() >= MAX_PER_ACCOUNT {
        return Err(Error::new(crate::error::ErrorCode::Forbidden, "There are too many shipments."));
    }
    let mut shipment = Shipment::new(id, known, Some(&number), ShipmentStatus::Shipped, now);
    shipment.title = title;
    shipment.tracking_url = Carrier::from_id(known).and_then(|carrier| carrier.tracking_url(&number));
    shipment.events.push(ShipmentEvent {
        at: format_time(now),
        status: ShipmentStatus::Shipped.id().to_owned(),
        text: None,
        location: None,
        source: "client".into(),
        email_id: None,
        client_name: None,
    });
    Ok(shipment)
}

/// Drops what is done for 30 days or quiet for 60. Returns whether any went.
pub fn prune(list: &mut Vec<Shipment>, now: DateTime<Utc>) -> bool {
    let now = now.timestamp();
    let before = list.len();
    list.retain(|s| {
        let done = status_of(&s.status).is_done() && seconds(&s.status_at) < now - DONE_SECS;
        let last = s.events.last().map(|event| seconds(&event.at)).unwrap_or_else(|| seconds(&s.updated));
        !done && last >= now - STALE_SECS
    });
    list.len() != before
}

#[cfg(test)]
mod tests {
    use super::*;
    use uwumail_labels::{DateWindow, PickupKind};

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text).unwrap().with_timezone(&Utc)
    }

    fn facts(numbers: &[&str], status: Option<ShipmentStatus>, order: Option<&str>) -> ShipmentFacts {
        ShipmentFacts {
            carrier: Some(Carrier::Dhl),
            numbers: numbers.iter().map(|n| n.to_string()).collect(),
            tracking_url: None,
            status,
            expected: None,
            merchant: Some("Shop".into()),
            order_ref: order.map(String::from),
            pickup: None,
            confidence: 0.9,
        }
    }

    fn ids() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("l{n}")
        }
    }

    #[test]
    fn mails_make_one_shipment_that_only_moves_forward() {
        let tz = chrono_tz::Europe::Berlin;
        let now = at("2026-11-15T12:00:00Z");
        let mut list = Vec::new();
        let mut new_id = ids();
        // The order confirmation, then the shipping mail with its number: one shipment.
        let changed = record(
            &mut list,
            &facts(&[], None, Some("A-1")),
            "m1",
            at("2026-11-10T08:00:00Z"),
            "Bestellt",
            &tz,
            now,
            &mut new_id,
        );
        assert_eq!(changed, vec![0]);
        assert_eq!(list[0].status, "ordered");
        let mut shipped = facts(&["00340434161094042557"], Some(ShipmentStatus::Shipped), Some("A-1"));
        shipped.expected = Some(DateWindow { day: Day::InDays(1), from: Some((10, 0)), to: Some((12, 30)) });
        record(&mut list, &shipped, "m2", at("2026-11-11T08:00:00Z"), "Versandt", &tz, now, &mut new_id);
        assert_eq!(list.len(), 1);
        let s = &list[0];
        assert_eq!(s.number.as_deref(), Some("00340434161094042557"));
        assert_eq!(s.status, "shipped");
        assert_eq!(s.email_ids, vec!["m1", "m2"]);
        let expected = s.expected.as_ref().unwrap();
        assert_eq!(expected.from.as_deref(), Some("2026-11-12T10:00:00+01:00"));
        assert_eq!(expected.to.as_deref(), Some("2026-11-12T12:30:00+01:00"));
        assert!(!expected.all_day);
        assert!(s.tracking_url.as_deref().is_some_and(|url| url.contains("00340434161094042557")));

        // Delivered, then an older mail saying "in transit": the status stays.
        let mut delivered = facts(&["00340434161094042557"], Some(ShipmentStatus::Delivered), None);
        delivered.pickup = Some(FoundPickup {
            kind: PickupKind::Packstation,
            name: Some("Packstation 101".into()),
            address: None,
            until: None,
        });
        record(&mut list, &delivered, "m3", at("2026-11-12T11:00:00Z"), "Zugestellt", &tz, now, &mut new_id);
        record(
            &mut list,
            &facts(&["00340434161094042557"], Some(ShipmentStatus::InTransit), None),
            "m4",
            at("2026-11-11T20:00:00Z"),
            "Unterwegs",
            &tz,
            now,
            &mut new_id,
        );
        let s = &list[0];
        assert_eq!(s.status, "delivered");
        assert_eq!(s.delivered_at.as_deref(), Some("2026-11-12T11:00:00Z"));
        assert_eq!(s.events.len(), 4);
        assert_eq!(s.pickup.as_ref().unwrap().kind, "packstation");
        // The same mail again changes nothing.
        assert!(
            record(&mut list, &delivered, "m3", at("2026-11-12T11:00:00Z"), "Zugestellt", &tz, now, &mut new_id)
                .is_empty()
        );
        assert_eq!(list[0].events.len(), 4);
        assert_eq!(list[0].display_name(), "Shop");
    }

    #[test]
    fn several_numbers_make_several_shipments_and_days_without_year_roll_over() {
        let tz = chrono_tz::Europe::Berlin;
        let now = at("2026-12-28T12:00:00Z");
        let mut list = Vec::new();
        let mut two = facts(&["1Z999AA10123456784", "1Z999AA10123456785"], None, None);
        two.carrier = None;
        two.expected = Some(DateWindow { day: Day::On { year: None, month: 1, day: 3 }, from: None, to: None });
        let changed = record(&mut list, &two, "m1", at("2026-12-28T08:00:00Z"), "", &tz, now, ids());
        assert_eq!(changed.len(), 2);
        assert_eq!(list[0].carrier, "other");
        let expected = list[0].expected.as_ref().unwrap();
        assert!(expected.all_day);
        assert_eq!(expected.from.as_deref(), Some("2027-01-03T00:00:00+01:00"));
        assert_eq!(expected.to.as_deref(), Some("2027-01-04T00:00:00+01:00"));
        assert_eq!(list[0].display_name(), "Shop");
        // Nothing to go by: nothing recorded.
        assert!(record(&mut list, &facts(&[], None, None), "m2", now, "", &tz, now, ids()).is_empty());
    }

    #[test]
    fn hand_made_shipments_are_checked_and_old_ones_go() {
        let now = at("2026-11-15T12:00:00Z");
        let made = create(&[], "dhl", " 0034 0434 161094042557 ", Some(" Schuhe "), "l1".into(), now).unwrap();
        assert_eq!(made.number.as_deref(), Some("00340434161094042557"));
        assert_eq!(made.title.as_deref(), Some("Schuhe"));
        assert_eq!(made.status, "shipped");
        assert_eq!(made.events[0].source, "client");
        assert!(create(std::slice::from_ref(&made), "dhl", "00340434161094042557", None, "l2".into(), now).is_err());
        assert!(create(&[], "dhl", "nö", None, "l2".into(), now).is_err());
        assert!(create(&[], "dhl", "1", Some("a\nb"), "l2".into(), now).is_err());
        assert_eq!(create(&[], "unknown", "1", None, "l2".into(), now).unwrap().carrier, "other");

        let mut done = made.clone();
        done.status = "delivered".into();
        done.status_at = "2026-10-01T00:00:00Z".into();
        let mut quiet = made.clone();
        quiet.events[0].at = "2026-09-01T00:00:00Z".into();
        let mut list = vec![made, done, quiet];
        assert!(prune(&mut list, now));
        assert_eq!(list.len(), 1);
        assert!(!prune(&mut list, now));
    }

    #[test]
    fn marked_by_hand_and_taken_back() {
        let now = at("2026-11-15T12:00:00Z");
        let mut shipment = create(&[], "dhl", "00340434161094042557", None, "1".into(), now).unwrap();
        assert!(shipment.mark("2026-11-15T13:00:00Z", ShipmentStatus::Delivered, false, now));
        assert_eq!(
            (shipment.status.as_str(), shipment.delivered_at.as_deref()),
            ("delivered", Some("2026-11-15T13:00:00Z"))
        );
        assert!(!shipment.mark("2026-11-15T13:00:00Z", ShipmentStatus::Delivered, false, now), "the same mark twice");
        assert!(shipment.mark("2026-11-15T13:00:00Z", ShipmentStatus::Delivered, true, now));
        assert_eq!((shipment.status.as_str(), shipment.delivered_at.as_deref()), ("shipped", None));
        assert_eq!(shipment.events.len(), 1);
        assert!(
            !shipment.mark("2026-11-15T13:00:00Z", ShipmentStatus::Delivered, true, now),
            "nothing left to take back"
        );
    }
}
