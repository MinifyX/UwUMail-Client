//! Calendar invitations in mail: what the reader shows of one, and answering it — in every kind
//! of mailbox, each the way its calendar works:
//!
//! - a UwUMail server (JMAP Calendars) has already put the invitation into the calendar; the
//!   answer goes into that event, and the server tells the organizer, as in the webmail;
//! - Microsoft (Graph) and Google (Calendar API) have done the same; the answer goes through
//!   their own "accept"/"decline", which tells the organizer;
//! - everywhere else (IMAP or JMAP without a calendar that took it in) the app keeps the
//!   attendee's copy itself — in the mailbox's CalDAV calendar, or on this device in a calendar
//!   "Invitations" — and sends the organizer an iTIP REPLY by mail (RFC 6047).
//!
//! Nothing is answered, stored or removed but on a click; what the page sends is only the mail's id
//! and the answer. The mail is read again here each time, and only an invitation that comes from
//! its organizer (and names one of the mailbox's addresses) can be answered (security-audit-0.16.0
//! WEBMAIL-2, as on the server).

use std::sync::Arc;

use chrono::{NaiveDateTime, TimeDelta, Utc};
use chrono_tz::Tz;
use reqwest::Method as HttpMethod;
use serde_json::{Value, json};
use url::Url;

use super::*;
use crate::calendar::invite::{
    self, Invite, InvitePlace, Language, MailScheduling, Method, Moment, Partstat, Person, Revision,
};
use crate::calendar::itip::{self, Component};
use crate::calendar::jscal::{self, OccurrenceIds};
use crate::calendar::{CalendarEntry, Source, dav, ical, jmap_cal};
use crate::cloud::{self, Api, Call, segment, unsegment};

/// The remote id of the calendar the app keeps invitations in on this device.
pub(super) const LOCAL_INVITES: &str = "uwu-invites";
/// Where that calendar sits among an account's calendars: last, before the birthdays.
const SORT_ORDER: i64 = 999_999;
const COLOR: &str = "#e85d9f";

/// Whether an id (of a calendar, an event or an occurrence) belongs to the invitations kept here.
pub(super) fn is_local(id: &str) -> bool {
    calendar::split_id(id).is_ok_and(|(_, remote)| {
        remote.strip_prefix(LOCAL_INVITES).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    })
}

pub(super) fn read_only() -> Error {
    Error::invalid("Invitations kept on this device are answered from their mail; they can only be deleted.")
}

/// The event an invitation names, where it was found.
enum Found {
    /// On a JMAP server; `scheduling` when the server keeps it as somebody else's event
    /// (`isOrigin: false`) and tells the organizer itself.
    Jmap {
        id: String,
        participant: String,
        event: Value,
        scheduling: bool,
    },
    Graph {
        base: String,
        id: String,
        event: Value,
    },
    Google {
        id: String,
        event: Value,
    },
    Dav {
        client: Arc<dav::DavClient>,
        url: Url,
        etag: Option<String>,
        copy: Component,
    },
    Device {
        copy: Component,
    },
}

/// A mail's invitation with everything known about it.
struct Context {
    account: AccountRecord,
    invite: Invite,
    /// The mailbox's addresses, lower case.
    own: Vec<String>,
    from: String,
    sender_confirmed: bool,
    /// The mailbox's address the event invites (or, for answers, organizes with).
    me: String,
    source: Option<Source>,
    found: Option<Found>,
}

fn text<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

/// A JSCalendar participant's mail address, lower case.
fn participant_address(participant: &Value) -> Option<String> {
    [text(participant, "/sendTo/imip"), text(participant, "/calendarAddress"), text(participant, "/email")]
        .into_iter()
        .flatten()
        .find_map(invite::plain_address)
}

fn jmap_status(value: Option<&str>) -> Partstat {
    match value {
        Some("accepted") => Partstat::Accepted,
        Some("tentative") => Partstat::Tentative,
        Some("declined") => Partstat::Declined,
        _ => Partstat::NeedsAction,
    }
}

fn jmap_status_text(status: Partstat) -> &'static str {
    match status {
        Partstat::NeedsAction => "needs-action",
        Partstat::Accepted => "accepted",
        Partstat::Tentative => "tentative",
        Partstat::Declined => "declined",
    }
}

fn graph_status(event: &Value) -> Partstat {
    match text(event, "/responseStatus/response") {
        Some("accepted" | "organizer") => Partstat::Accepted,
        Some("tentativelyAccepted") => Partstat::Tentative,
        Some("declined") => Partstat::Declined,
        _ => Partstat::NeedsAction,
    }
}

fn google_status(value: Option<&str>) -> Partstat {
    match value {
        Some("accepted") => Partstat::Accepted,
        Some("tentative") => Partstat::Tentative,
        Some("declined") => Partstat::Declined,
        _ => Partstat::NeedsAction,
    }
}

fn google_status_text(status: Partstat) -> &'static str {
    match status {
        Partstat::NeedsAction => "needsAction",
        Partstat::Accepted => "accepted",
        Partstat::Tentative => "tentative",
        Partstat::Declined => "declined",
    }
}

/// An instant in an API's answer (`2026-09-27T07:00:00Z`, Graph's `…0000000` without zone in UTC).
fn api_instant(value: Option<&str>) -> Option<chrono::DateTime<Utc>> {
    let value = value?.trim();
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc))
        .ok()
        .or_else(|| jscal::parse_local(value).map(|time| time.and_utc()))
}

/// Whether an occurrence of a provider's event is the date the mail names.
fn is_occurrence(original: Option<&Value>, wanted: Moment) -> bool {
    let Some(original) = original else { return false };
    match wanted {
        Moment::Date(date) => text(original, "/date").is_some_and(|value| value == date.format("%Y-%m-%d").to_string()),
        Moment::Utc(time) => {
            api_instant(original.as_str().or_else(|| text(original, "/dateTime"))).is_some_and(|found| found == time)
        }
        Moment::Floating(_) => false,
    }
}

impl Inner {
    /// The mailbox's own addresses, lower case: its own, then its aliases.
    fn own_addresses(&self, account: &AccountRecord) -> Vec<String> {
        let mut own = vec![account.email.trim().to_lowercase()];
        if let Ok(identities) = self.store.identities() {
            own.extend(
                identities
                    .into_iter()
                    .filter(|identity| identity.account_id == account.id)
                    .map(|identity| identity.email.trim().to_lowercase()),
            );
        }
        own
    }

    /// The text of a mail's iCalendar part, at most [`invite::MAX_ICS_BYTES`].
    async fn invitation_text(&self, engine: &Engine, message: &Message) -> Result<Option<String>> {
        let calendar_part = |attachment: &Attachment| {
            let mime = attachment.mime_type.to_ascii_lowercase();
            mime.starts_with("text/calendar") || mime.starts_with("application/ics")
        };
        let index = message
            .attachments
            .iter()
            .position(calendar_part)
            .or_else(|| message.attachments.iter().position(|a| a.filename.to_ascii_lowercase().ends_with(".ics")));
        let Some(index) = index else { return Ok(None) };
        if message.attachments[index].size > invite::MAX_ICS_BYTES as u64 {
            return Ok(None);
        }
        let file = engine.attachment(&message.attachments[index].id).await?;
        let bytes = tokio::fs::read(&file.path)
            .await
            .map_err(|e| Error::internal(format!("The invitation couldn't be read: {e}")))?;
        if bytes.len() > invite::MAX_ICS_BYTES {
            return Ok(None);
        }
        // Odd encodings are read as far as they are UTF-8; the rest becomes replacement characters.
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// The event on a JMAP server, if it has it.
    async fn find_jmap(&self, account_id: &str, invite: &Invite, own: &[String]) -> Result<Option<Found>> {
        let client = self.jmap_client(account_id).await?;
        let events = jmap_cal::events_with_uid(&client, &invite.uid).await?;
        let Some(event) = events.into_iter().next() else { return Ok(None) };
        let participants = event.get("participants").and_then(Value::as_object);
        let participant = participants.and_then(|all| {
            all.iter()
                .find(|(_, participant)| participant_address(participant).is_some_and(|address| own.contains(&address)))
                .map(|(key, _)| key.clone())
        });
        let id = text(&event, "/baseEventId").or_else(|| text(&event, "/id")).unwrap_or_default().to_string();
        if id.is_empty() {
            return Ok(None);
        }
        let scheduling = event.get("isOrigin").and_then(Value::as_bool) == Some(false);
        Ok(Some(Found::Jmap { id, participant: participant.unwrap_or_default(), event, scheduling }))
    }

    /// The event at Microsoft: by its iCalendar UID, the date the mail names if it names one.
    async fn find_graph(&self, account: &AccountRecord, base: &str, invite: &Invite) -> Result<Option<Found>> {
        const SELECT: &str = "id,type,seriesMasterId,responseStatus,isCancelled,organizer,originalStart";
        let filter = format!("iCalUId eq '{}'", invite.uid.replace('\'', "''"));
        let call = Call::get(Api::Graph, format!("{base}/events")).query("$filter", filter).query("$select", SELECT);
        let answer = self.cloud_call(account, &call).await?;
        let items: Vec<Value> = cloud::graph_items(&answer).cloned().collect();
        let mut event = items
            .iter()
            .find(|e| matches!(text(e, "/type"), Some("seriesMaster" | "singleInstance")))
            .or_else(|| items.first())
            .cloned();
        if let (Some(series), Some(wanted)) = (&event, invite.occurrence)
            && text(series, "/type") == Some("seriesMaster")
            && let (Some(id), Some(at)) = (text(series, "/id"), wanted.utc())
        {
            let window = |hours: i64| (at + TimeDelta::hours(hours)).format("%Y-%m-%dT%H:%M:%SZ").to_string();
            let call = Call::get(Api::Graph, format!("{base}/events/{}/instances", segment(id)))
                .query("startDateTime", window(-36))
                .query("endDateTime", window(36))
                .query("$select", SELECT);
            let instances = self.cloud_call(account, &call).await?;
            if let Some(instance) =
                cloud::graph_items(&instances).find(|instance| is_occurrence(instance.get("originalStart"), wanted))
            {
                event = Some(instance.clone());
            }
        }
        Ok(event.and_then(|event| {
            let id = text(&event, "/id")?.to_string();
            Some(Found::Graph { base: base.to_string(), id, event })
        }))
    }

    /// The event in the Google calendar: by its iCalendar UID, the date the mail names if it names one.
    async fn find_google(&self, account: &AccountRecord, invite: &Invite) -> Result<Option<Found>> {
        let call = Call::get(Api::GoogleCalendar, "calendars/primary/events")
            .query("iCalUID", invite.uid.clone())
            .query("showDeleted", "true")
            .query("maxResults", "50");
        let answer = self.cloud_call(account, &call).await?;
        let items: Vec<Value> = answer.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        let series = items.iter().find(|e| e.get("recurringEventId").is_none()).or_else(|| items.first()).cloned();
        let mut event = series.clone();
        if let Some(wanted) = invite.occurrence {
            if let Some(exception) = items.iter().find(|e| is_occurrence(e.get("originalStartTime"), wanted)) {
                event = Some(exception.clone());
            } else if let (Some(series), Some(at)) = (&series, wanted.utc())
                && let Some(id) = text(series, "/id")
            {
                let call =
                    Call::get(Api::GoogleCalendar, format!("calendars/primary/events/{}/instances", segment(id)))
                        .query("originalStart", at.format("%Y-%m-%dT%H:%M:%SZ").to_string())
                        .query("showDeleted", "true");
                let instances = self.cloud_call(account, &call).await?;
                if let Some(instance) = instances.get("items").and_then(Value::as_array).and_then(|list| list.first()) {
                    event = Some(instance.clone());
                }
            }
        }
        Ok(event.and_then(|event| Some(Found::Google { id: text(&event, "/id")?.to_string(), event })))
    }

    /// The attendee's copy in one of the mailbox's CalDAV calendars.
    async fn find_dav(
        &self,
        account_id: &str,
        client: &Arc<dav::DavClient>,
        home: &Url,
        invite: &Invite,
    ) -> Result<Option<Found>> {
        let entries = self.calendar_entries(account_id).await?;
        for entry in entries.iter().filter(|entry| !entry.info.is_birthdays) {
            let Ok(url) = calendar::dav_url(home, &entry.remote) else { continue };
            let objects = match dav::objects_with_uid(client, &url, &invite.uid).await {
                Ok(objects) => objects,
                Err(error) => {
                    tracing::debug!("A calendar couldn't be searched for an invitation: {error}");
                    continue;
                }
            };
            for object in objects {
                let Some(copy) = Component::parse(&object.data) else { continue };
                if itip::uid(&copy).as_deref() == Some(invite.uid.as_str()) && url.origin() == object.url.origin() {
                    return Ok(Some(Found::Dav {
                        client: Arc::clone(client),
                        url: object.url,
                        etag: object.etag,
                        copy,
                    }));
                }
            }
        }
        Ok(None)
    }

    /// Where the invited event is: the mailbox's calendar first, then this device.
    async fn find_invited(
        &self,
        account: &AccountRecord,
        source: Option<&Source>,
        ctx: &Invite,
        own: &[String],
    ) -> Option<Found> {
        let found = match source {
            Some(Source::Jmap) => self.find_jmap(&account.id, ctx, own).await,
            Some(Source::Graph { base }) => self.find_graph(account, base, ctx).await,
            Some(Source::Google) => self.find_google(account, ctx).await,
            Some(Source::Dav { client, home }) => self.find_dav(&account.id, client, home, ctx).await,
            None => Ok(None),
        };
        match found {
            Ok(Some(found)) => return Some(found),
            Ok(None) => {}
            Err(error) => tracing::warn!("The calendar couldn't be searched for an invitation: {error}"),
        }
        let stored = self.store.local_invite(&account.id, &ctx.uid).ok().flatten()?;
        Some(Found::Device { copy: Component::parse(&stored)? })
    }

    /// The calendar the mailbox keeps invitations in when it has to store one itself: its
    /// default CalDAV calendar that takes events.
    async fn dav_target(&self, account_id: &str, home: &Url) -> Option<Url> {
        let entries = self.calendar_entries(account_id).await.ok()?;
        let writable: Vec<&CalendarEntry> =
            entries.iter().filter(|entry| entry.info.may_write && !entry.info.is_birthdays).collect();
        let entry = writable.iter().find(|entry| entry.info.is_default).or_else(|| writable.first())?;
        calendar::dav_url(home, &entry.remote).ok()
    }
}

impl Engine {
    /// A mail's invitation with where its event is; `None` when the mail has none the mailbox is part of.
    async fn invitation_context(&self, message_id: &str) -> Result<Option<Context>> {
        let message = self
            .inner
            .store
            .messages_by_ids(&[message_id.to_string()])?
            .pop()
            .ok_or_else(|| Error::not_found("This message no longer exists."))?;
        let Some(text) = self.inner.invitation_text(self, &message).await? else { return Ok(None) };
        let Some(invite) = invite::read(&text) else { return Ok(None) };
        let account = self.inner.store.account(&message.account_id)?;
        let own = self.inner.own_addresses(&account);
        let Some(from) = invite::plain_address(&message.from.email) else { return Ok(None) };
        let me = match invite.method {
            // An answer only matters for the mailbox's own event.
            Method::Reply => match invite.organizer_email() {
                Some(organizer) if own.iter().any(|address| address == organizer) => organizer.to_string(),
                _ => return Ok(None),
            },
            _ => match invite.own_attendee(&own) {
                Some(person) => person.email.clone(),
                None => return Ok(None),
            },
        };
        let sender_confirmed = self.inner.store.label_headers(&message.id).map(|h| h.from_trusted).unwrap_or(false);
        let source = match self.inner.calendar_source(&account.id).await {
            Ok(source) => Some(source),
            Err(error) => {
                tracing::debug!("No calendar for an invitation of {}: {error}", account.id);
                None
            }
        };
        let found = if invite.method == Method::Reply {
            // What the calendar says of an answer only counts where a server applied it.
            match source {
                Some(Source::Jmap) => self.inner.find_jmap(&account.id, &invite, &own).await.ok().flatten(),
                _ => None,
            }
        } else {
            self.inner.find_invited(&account, source.as_ref(), &invite, &own).await
        };
        Ok(Some(Context { account, invite, own, from, sender_confirmed, me, source, found }))
    }

    /// What the reader shows of a mail's invitation, cancellation or answer, with the event as
    /// the mailbox's calendar has it. `None` for mail without one, or one the mailbox isn't part of.
    pub async fn mail_invitation(&self, message_id: &str) -> Result<Option<MailScheduling>> {
        Ok(self.invitation_context(message_id).await?.map(|ctx| summary(&ctx)))
    }

    /// Answers a mail's invitation: accept, maybe or decline, with a comment where the way the
    /// organizer is told carries one. Only on a click in the reader.
    pub async fn respond_to_invitation(
        &self,
        message_id: &str,
        status: Partstat,
        comment: Option<&str>,
        language: Option<&str>,
    ) -> Result<()> {
        if status == Partstat::NeedsAction {
            return Err(Error::invalid("Accept, maybe or decline."));
        }
        let ctx = self
            .invitation_context(message_id)
            .await?
            .ok_or_else(|| Error::not_found("This mail holds no invitation for you."))?;
        let shown = summary(&ctx);
        if !shown.can_answer {
            return Err(Error::invalid(if !shown.verified {
                "This invitation doesn't come from the event's organizer, so it can't be answered from here."
            } else {
                "This invitation can't be answered any more."
            }));
        }
        let comment = invite::clean_comment(comment).filter(|_| shown.can_comment);
        let inner = &self.inner;
        let account = &ctx.account;
        let now = Utc::now().timestamp();
        // Where the provider tells the organizer, that is all; otherwise the copy is kept and
        // the app sends the REPLY.
        match &ctx.found {
            Some(Found::Jmap { id, participant, scheduling: true, .. }) if !participant.is_empty() => {
                let client = inner.jmap_client(&account.id).await?;
                jmap_cal::set_participation(&client, id, participant, jmap_status_text(status), true).await?;
                inner.calendar_changed(Some(&account.id));
                return Ok(());
            }
            Some(Found::Graph { base, id, .. }) => {
                let action = match status {
                    Partstat::Accepted => "accept",
                    Partstat::Tentative => "tentativelyAccept",
                    _ => "decline",
                };
                let mut body = json!({ "sendResponse": true });
                if let Some(comment) = &comment {
                    body["comment"] = json!(comment);
                }
                let path = format!("{base}/events/{}/{action}", segment(id));
                inner.cloud_call(account, &Call::new(Api::Graph, HttpMethod::POST, path).body(body)).await?;
                inner.calendar_changed(Some(&account.id));
                return Ok(());
            }
            Some(Found::Google { id, event }) => {
                let mut attendees = event.get("attendees").and_then(Value::as_array).cloned().unwrap_or_default();
                let mine = attendees.iter_mut().find(|attendee| {
                    attendee.get("self").and_then(Value::as_bool) == Some(true)
                        || text(attendee, "/email").and_then(invite::plain_address).as_deref() == Some(ctx.me.as_str())
                });
                let Some(mine) = mine else {
                    return Err(Error::not_found("Google's calendar doesn't list you for this event."));
                };
                mine["responseStatus"] = json!(google_status_text(status));
                if let Some(comment) = &comment {
                    mine["comment"] = json!(comment);
                }
                let call = Call::new(
                    Api::GoogleCalendar,
                    HttpMethod::PATCH,
                    format!("calendars/primary/events/{}", segment(id)),
                )
                .query("sendUpdates", "all")
                .body(json!({ "attendees": attendees }));
                inner.cloud_call(account, &call).await?;
                inner.calendar_changed(Some(&account.id));
                return Ok(());
            }
            _ => {}
        }

        // Kept by the app: the copy first, so the calendar says what the organizer is told.
        match &ctx.found {
            Some(Found::Jmap { id, participant, .. }) if !participant.is_empty() => {
                let client = inner.jmap_client(&account.id).await?;
                jmap_cal::set_participation(&client, id, participant, jmap_status_text(status), false).await?;
            }
            Some(Found::Dav { client, url, etag, copy }) => {
                let updated = invite::attendee_copy(&ctx.invite, Some(copy), &ctx.own, &ctx.me, Some(status));
                dav::put_object(client, url, &updated.to_ics(), etag.as_deref()).await?;
            }
            Some(Found::Device { copy }) => {
                let updated = invite::attendee_copy(&ctx.invite, Some(copy), &ctx.own, &ctx.me, Some(status));
                inner.store.set_local_invite(&account.id, &ctx.invite.uid, &updated.to_ics(), now)?;
            }
            _ => {
                let copy = invite::attendee_copy(&ctx.invite, None, &ctx.own, &ctx.me, Some(status)).to_ics();
                let target = match &ctx.source {
                    Some(Source::Dav { client, home }) => {
                        inner.dav_target(&account.id, home).await.map(|calendar| (Arc::clone(client), calendar))
                    }
                    _ => None,
                };
                let stored_remote = match target {
                    Some((client, calendar)) => {
                        let url = calendar
                            .join(&format!("{}.ics", uuid::Uuid::new_v4()))
                            .map_err(|_| Error::internal("The event's address couldn't be built."))?;
                        match dav::put_object(&client, &url, &copy, None).await {
                            Ok(_) => true,
                            Err(error) => {
                                tracing::warn!("The invitation couldn't go into the CalDAV calendar: {error}");
                                false
                            }
                        }
                    }
                    None => false,
                };
                if !stored_remote {
                    inner.store.set_local_invite(&account.id, &ctx.invite.uid, &copy, now)?;
                }
            }
        }
        inner.calendar_changed(Some(&account.id));
        self.send_invitation_reply(&ctx, status, comment.as_deref(), Language::of(language), now).await
    }

    /// Sends the REPLY to the organizer by mail, from the address the event invites.
    async fn send_invitation_reply(
        &self,
        ctx: &Context,
        status: Partstat,
        comment: Option<&str>,
        language: Language,
        now: i64,
    ) -> Result<()> {
        let account = &ctx.account;
        let organizer =
            ctx.invite.organizer.as_ref().ok_or_else(|| Error::invalid("The invitation names no organizer."))?;
        let reply = invite::reply(&ctx.invite, &ctx.me, status, comment, now);
        if reply.events().next().is_none() {
            return Err(Error::invalid("The invitation doesn't name you."));
        }
        let from = if ctx.me.eq_ignore_ascii_case(&account.email) {
            sender(account)
        } else {
            self.sender_for(account, Some(&ctx.me))?
        };
        let to = Address { name: organizer.name.clone(), email: organizer.email.clone() };
        let mail = invite::reply_mail(&from, &to, &reply, status, comment, language)?;
        if account.protocol == Protocol::Jmap {
            let client = self.inner.jmap_client(&account.id).await?;
            jmap_sync::send(
                &client,
                &self.inner.store,
                &account.id,
                mail.formatted(),
                &from.email,
                std::slice::from_ref(&to.email),
            )
            .await
        } else {
            let auth = match self.inner.credential(account).await? {
                Credential::Password(password) => SmtpAuth::Password(password),
                Credential::Token(token) => SmtpAuth::OAuth(token),
            };
            let username = match &auth {
                SmtpAuth::Password(_) => account.username.clone(),
                SmtpAuth::OAuth(_) => oauth_mailbox(&account.username, &account.email).to_string(),
            };
            smtp::send(&account.smtp, &username, auth, &mail).await
        }
    }

    /// Whether this device keeps invitations for any mailbox: then there is a calendar to show,
    /// even where no mailbox has one of its own.
    pub fn has_local_invitations(&self) -> Result<bool> {
        for account in self.inner.store.accounts()? {
            if self.inner.store.has_local_invites(&account.id)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Takes a cancelled event (or the cancelled dates of one) out of the mailbox's calendar,
    /// on a click in the reader of the organizer's cancellation.
    pub async fn remove_cancelled_event(&self, message_id: &str) -> Result<()> {
        let ctx = self
            .invitation_context(message_id)
            .await?
            .ok_or_else(|| Error::not_found("This mail holds no invitation for you."))?;
        if !summary(&ctx).can_remove {
            return Err(Error::invalid("Only an event its organizer cancelled can be removed from here."));
        }
        let inner = &self.inner;
        let account = &ctx.account;
        match &ctx.found {
            Some(Found::Jmap { id, .. }) => {
                let client = inner.jmap_client(&account.id).await?;
                jmap_cal::destroy_event(&client, id).await?;
            }
            Some(Found::Graph { base, id, .. }) => {
                let path = format!("{base}/events/{}", segment(id));
                inner.cloud_call(account, &Call::new(Api::Graph, HttpMethod::DELETE, path)).await?;
            }
            Some(Found::Google { id, .. }) => {
                let call = Call::new(
                    Api::GoogleCalendar,
                    HttpMethod::DELETE,
                    format!("calendars/primary/events/{}", segment(id)),
                )
                .query("sendUpdates", "none");
                inner.cloud_call(account, &call).await?;
            }
            Some(Found::Dav { client, url, etag, copy }) => match invite::without_cancelled(copy, &ctx.invite) {
                Some(left) => {
                    dav::put_object(client, url, &left.to_ics(), etag.as_deref()).await?;
                }
                None => dav::delete(client, url, etag.as_deref()).await?,
            },
            Some(Found::Device { copy }) => match invite::without_cancelled(copy, &ctx.invite) {
                Some(left) => inner.store.set_local_invite(
                    &account.id,
                    &ctx.invite.uid,
                    &left.to_ics(),
                    Utc::now().timestamp(),
                )?,
                None => {
                    inner.store.delete_local_invite(&account.id, &ctx.invite.uid)?;
                }
            },
            None => return Err(Error::not_found("This event isn't in your calendar.")),
        }
        inner.calendar_changed(Some(&account.id));
        Ok(())
    }
}

/// What the reader shows, from a mail's invitation and where its event is.
fn summary(ctx: &Context) -> MailScheduling {
    let invite = &ctx.invite;
    let mut verified = invite::from_may_say(invite, &ctx.from);
    let (mut status, mut cancelled, mut revision, place, mut participant_known) =
        (Partstat::NeedsAction, invite.cancelled, Revision::New, InvitePlace::Device, true);
    let organizer_of = |value: Option<&str>| value.and_then(invite::plain_address);
    // Anyone can name someone else's event UID: what the calendar has must have the same organizer.
    let mut same_organizer = |stored: Option<String>| {
        if let (Some(stored), Some(mail)) = (stored, invite.organizer_email())
            && stored != mail
        {
            verified = false;
        }
    };
    let place = match &ctx.found {
        Some(Found::Jmap { participant, event, scheduling, .. }) => {
            same_organizer(organizer_of(text(event, "/organizerCalendarAddress")));
            participant_known = !participant.is_empty();
            if invite.method != Method::Reply {
                status = jmap_status(
                    event
                        .pointer(&format!("/participants/{}/participationStatus", jscal::pointer_segment(participant)))
                        .and_then(Value::as_str),
                );
            }
            let stored_sequence = event.get("sequence").and_then(Value::as_i64).unwrap_or(0);
            revision = invite::revision(Some(stored_sequence), invite.sequence);
            if *scheduling {
                // The server cancels only on a cancellation it believes (W-33): its word counts.
                cancelled = text(event, "/status") == Some("cancelled");
                InvitePlace::Server
            } else {
                cancelled |= text(event, "/status") == Some("cancelled");
                InvitePlace::Calendar
            }
        }
        Some(Found::Graph { event, .. }) => {
            same_organizer(organizer_of(text(event, "/organizer/emailAddress/address")));
            status = graph_status(event);
            cancelled = event.get("isCancelled").and_then(Value::as_bool) == Some(true);
            revision = Revision::Same;
            InvitePlace::Microsoft
        }
        Some(Found::Google { event, .. }) => {
            same_organizer(organizer_of(text(event, "/organizer/email")));
            let mine = event.get("attendees").and_then(Value::as_array).and_then(|list| {
                list.iter().find(|attendee| {
                    attendee.get("self").and_then(Value::as_bool) == Some(true)
                        || text(attendee, "/email").and_then(invite::plain_address).as_deref() == Some(ctx.me.as_str())
                })
            });
            participant_known = mine.is_some();
            status = google_status(mine.and_then(|attendee| text(attendee, "/responseStatus")));
            cancelled = text(event, "/status") == Some("cancelled");
            revision = Revision::Same;
            InvitePlace::Google
        }
        Some(Found::Dav { copy, .. }) | Some(Found::Device { copy }) => {
            same_organizer(itip::organizer(copy));
            status = invite::answer_in(copy, invite, &ctx.me);
            revision = invite::revision(Some(itip::sequence(copy)), invite.sequence);
            if matches!(ctx.found, Some(Found::Dav { .. })) { InvitePlace::Calendar } else { InvitePlace::Device }
        }
        None => match &ctx.source {
            Some(Source::Dav { .. }) => InvitePlace::Calendar,
            _ => place,
        },
    };
    let in_calendar = ctx.found.is_some();
    let provider_tells = matches!(place, InvitePlace::Server | InvitePlace::Microsoft | InvitePlace::Google);
    let (kind, attendee, attendee_email) = if invite.method == Method::Reply {
        let answered =
            invite.attendees.iter().find(|person| person.email == ctx.from).or_else(|| invite.attendees.first());
        status = match (&ctx.found, answered) {
            (Some(Found::Jmap { event, .. }), Some(person)) => event
                .get("participants")
                .and_then(Value::as_object)
                .and_then(|all| all.values().find(|p| participant_address(p).as_deref() == Some(person.email.as_str())))
                .map_or(person.status, |p| jmap_status(text(p, "/participationStatus"))),
            (_, Some(person)) => person.status,
            _ => Partstat::NeedsAction,
        };
        (
            "reply",
            answered.map(|person| person.name.clone().unwrap_or_else(|| person.email.clone())),
            answered.map(|person| person.email.clone()),
        )
    } else {
        ("invitation", None, None)
    };
    let request = invite.method == Method::Request;
    let can_answer = kind == "invitation"
        && verified
        && request
        && !cancelled
        && revision != Revision::Outdated
        && invite.organizer.is_some()
        && (!provider_tells || participant_known);
    // The mail's word on a cancellation counts where the app keeps the copy; a provider's calendar
    // only once it cancelled the event itself.
    let can_remove = kind == "invitation"
        && verified
        && in_calendar
        && cancelled
        && (invite.method == Method::Cancel || provider_tells);
    let mut attendees: Vec<Person> = Vec::new();
    if let Some(organizer) = &invite.organizer {
        attendees.push(organizer.clone());
    }
    attendees.extend(
        invite.attendees.iter().filter(|person| Some(person.email.as_str()) != invite.organizer_email()).cloned(),
    );
    let total = attendees.len();
    attendees.truncate(invite::MAX_ATTENDEES);
    MailScheduling {
        kind,
        method: invite.method,
        title: invite.title.clone(),
        start: invite.start.map(Moment::text),
        end: invite.end.map(Moment::text),
        all_day: invite.all_day(),
        location: invite.location.clone(),
        organizer: invite.organizer.as_ref().map(|person| person.name.clone().unwrap_or_else(|| person.email.clone())),
        organizer_email: invite.organizer_email().map(String::from),
        more_attendees: total - attendees.len(),
        attendees,
        repeats: invite.repeats,
        occurrence: invite.occurrence.map(Moment::text),
        verified,
        sender: ctx.from.clone(),
        sender_confirmed: ctx.sender_confirmed,
        status,
        attendee,
        attendee_email,
        cancelled,
        revision,
        in_calendar,
        place,
        can_answer,
        can_comment: !matches!(place, InvitePlace::Server),
        can_remove,
    }
}

// ------------------------------------------------------------------------------------------------
// The calendar "Invitations" on this device.

impl Inner {
    /// An account's calendar of invitations kept here, while it keeps any.
    pub(super) fn local_invites_calendar(&self, account_id: &str) -> Option<CalendarInfo> {
        if !self.store.has_local_invites(account_id).ok()? {
            return None;
        }
        let id = calendar::app_id(account_id, LOCAL_INVITES);
        let prefs = self.store.calendar_prefs(account_id).ok().and_then(|prefs| prefs.get(&id).copied());
        Some(CalendarInfo {
            account_id: account_id.to_string(),
            name: "Invitations".into(),
            color: self.store.calendar_color(&id).ok().flatten().or_else(|| Some(COLOR.into())),
            is_default: false,
            is_visible: !prefs.is_some_and(|prefs| prefs.hidden),
            sort_order: SORT_ORDER,
            may_write: false,
            may_delete: false,
            is_birthdays: false,
            is_local: true,
            sharing: Default::default(),
            id,
        })
    }

    /// The occurrences of the invitations kept here in `[from, to)`.
    pub(super) fn local_invite_occurrences(
        &self,
        account_id: &str,
        from: NaiveDateTime,
        to: NaiveDateTime,
        viewer: Tz,
    ) -> Vec<CalendarOccurrence> {
        let Ok(objects) = self.store.local_invites(account_id) else { return Vec::new() };
        let calendar_id = calendar::app_id(account_id, LOCAL_INVITES);
        let (utc_from, utc_to) = cloud_ops::cloud_range(from, to, viewer);
        let mut budget = ical::Budget::default();
        let mut found = Vec::new();
        for (uid, text) in objects {
            if budget.exhausted() {
                break;
            }
            let Ok(parsed) = ical::parse(&text) else { continue };
            let Ok(group) = ical::to_jscalendar(&parsed) else { continue };
            let event_id = calendar::app_id(account_id, &format!("{LOCAL_INVITES}/{}", segment(&uid)));
            for instance in ical::instances(&parsed, &group, utc_from, utc_to, viewer, &mut budget) {
                let id = match &instance.recurrence_id {
                    Some(rid) => format!("{event_id}#{rid}"),
                    None => event_id.clone(),
                };
                found.push(jscal::occurrence(
                    OccurrenceIds {
                        id,
                        event_id: event_id.clone(),
                        account_id: account_id.to_string(),
                        calendar_id: calendar_id.clone(),
                        read_only: true,
                    },
                    &instance.event,
                    Some(instance.series.as_ref()),
                    &instance.time,
                    viewer,
                ));
            }
        }
        found
    }

    /// Deletes an invitation kept here (all of it: its dates are the organizer's to change).
    pub(super) fn delete_local_invite(&self, occurrence_id: &str) -> Result<()> {
        let (account_id, remote) = calendar::split_id(occurrence_id)?;
        let (path, _) = calendar::split_occurrence(remote);
        let uid = path
            .strip_prefix(LOCAL_INVITES)
            .and_then(|rest| rest.strip_prefix('/'))
            .filter(|uid| !uid.is_empty())
            .ok_or_else(|| Error::invalid("That event id makes no sense."))?;
        self.store.delete_local_invite(account_id, &unsegment(uid))?;
        self.calendar_changed(Some(account_id));
        Ok(())
    }
}

#[cfg(test)]
mod tests;
