//! Calendars and contacts of mailboxes signed in with Microsoft (Graph) or Google (Calendar and
//! People APIs): their tokens, and the calendar and contact calls of the engine for them.
//!
//! Microsoft gives one access token per resource: the mail token (outlook.office.com, see
//! `Inner::credential`) and a Graph token here, both from the same refresh token. Microsoft may
//! hand out a new refresh token with every refresh; the newest is always kept. Google's one token
//! covers mail, calendar and contacts, as far as the person allowed them at sign-in.
//!
//! Mailboxes signed in before calendars came along have no consent for them: their refresh fails
//! (Microsoft) or the token lacks the scope (Google). That shows as "sign in again" for calendar
//! and contacts; mail goes on as before.

use chrono::{DateTime, NaiveDateTime, Utc};
use chrono_tz::Tz;
use reqwest::Method;
use serde_json::{Map, Value, json};

use super::*;
use crate::calendar::jscal::{self, OccurrenceIds, OccurrenceTime};
use crate::calendar::{CalendarEntry, google_cal, graph_cal};
use crate::cloud::{self, Answer, Api, Call, TokenKind, segment, unsegment};
use crate::contacts::cloud_cards::{self, DEFAULT_BOOK};
use crate::contacts::{BookEntry, RemoteCard};

/// Masters of repeating events read at most per range (each is one request).
const MAX_MASTERS: usize = 200;
/// Masters read at the same time.
const MASTER_READS: usize = 8;

/// The calendar and contacts side of the cloud sign-ins, kept by the engine.
#[derive(Default)]
pub(super) struct CloudState {
    pub(super) endpoints: Mutex<cloud::Endpoints>,
    tokens: AsyncMutex<HashMap<(String, TokenKind), CachedToken>>,
    /// Graph's path to each account's mailbox: `me`, or `users/<address>` for a shared one.
    bases: AsyncMutex<HashMap<String, String>>,
}

#[derive(Clone)]
struct CachedToken {
    token: String,
    until: Instant,
    scope: Option<String>,
}

impl CachedToken {
    fn has_scope(&self, scope: &str) -> bool {
        self.scope.as_deref().is_none_or(|granted| granted.split_whitespace().any(|s| s.eq_ignore_ascii_case(scope)))
    }
}

fn provider_of(account: &AccountRecord) -> Result<OAuthProvider> {
    match account.auth {
        AuthKind::Microsoft => Ok(OAuthProvider::Microsoft),
        AuthKind::Google => Ok(OAuthProvider::Google),
        AuthKind::Password => Err(Error::invalid("This mailbox signs in with a password.")),
    }
}

/// An event's id at Graph or Google: its calendar and its own id, each escaped.
fn event_remote(calendar: &str, event: &str) -> String {
    format!("{}/{}", segment(calendar), segment(event))
}

fn split_event_remote(remote: &str) -> Result<(String, String)> {
    let (calendar, event) =
        remote.split_once('/').ok_or_else(|| Error::invalid("That calendar or event id makes no sense."))?;
    if calendar.is_empty() || event.is_empty() || event.contains('/') {
        return Err(Error::invalid("That calendar or event id makes no sense."));
    }
    Ok((unsegment(calendar), unsegment(event)))
}

fn utc_text(time: DateTime<Utc>) -> String {
    time.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn graph_event_select() -> &'static str {
    "id,subject,body,start,end,isAllDay,location,type,seriesMasterId,originalStartTimeZone,recurrence"
}

impl Inner {
    /// The account whose refresh token opens `account_id`'s calendars and contacts: a shared
    /// mailbox nested under its account uses that account's sign-in.
    pub(super) fn cloud_holder(&self, account_id: &str) -> String {
        self.secret_holder(account_id)
    }

    /// Whether the account signs in with a personal Microsoft account (outlook.com, hotmail.*, ...,
    /// or a token from Microsoft's consumer tenant): those were asked for no shared calendars.
    fn microsoft_personal(&self, holder_id: &str) -> bool {
        let link = self.store.account_link(holder_id).unwrap_or_default();
        let address = match link.signed_in_as() {
            Some(person) => person.to_string(),
            None => self.store.account(holder_id).map(|record| record.email).unwrap_or_default(),
        };
        crate::shared::is_personal_address(&address)
            || link.shared_state.as_deref() == Some(super::shared_ops::PERSONAL)
    }

    /// An access token for Graph or Google, from memory while it lasts. `refused` is a token the
    /// API just didn't take: that one isn't handed out again.
    async fn cloud_token(
        &self,
        account: &AccountRecord,
        kind: TokenKind,
        refused: Option<&str>,
    ) -> Result<CachedToken> {
        let holder = self.cloud_holder(&account.id);
        let key = (holder.clone(), kind);
        let cached = async || {
            self.cloud
                .tokens
                .lock()
                .await
                .get(&key)
                .filter(|cached| cached.until > Instant::now() + Duration::from_secs(60))
                .filter(|cached| Some(cached.token.as_str()) != refused)
                .cloned()
        };
        if let Some(token) = cached().await {
            return Ok(token);
        }
        let provider = provider_of(account)?;
        // The mail token's lock: both refresh with the same token, which Microsoft may replace.
        let _refreshing = self.tokens.lock().await;
        // Someone else may have refreshed while this waited.
        if let Some(token) = cached().await {
            return Ok(token);
        }
        let Secret::OAuth { refresh_token } = self.secrets.get(&holder)? else {
            return Err(Error::sign_in_again("Sign in again to see calendar and contacts."));
        };
        let endpoint = self.cloud.endpoints.lock().unwrap().token_endpoint(provider)?;
        let tokens = match kind {
            TokenKind::Graph => {
                let personal = self.microsoft_personal(&holder);
                match oauth::refresh_at(&endpoint, &refresh_token, Some(oauth::graph_scopes(personal)), true).await {
                    // A sign-in that got everything but the shared calendars and contacts (some
                    // accounts don't offer those) still has its own.
                    Err(error) if error.code == ErrorCode::SignInAgain && !personal => {
                        oauth::refresh_at(&endpoint, &refresh_token, Some(oauth::MICROSOFT_GRAPH_OWN_SCOPES), true)
                            .await
                            .map_err(|_| error)?
                    }
                    other => other?,
                }
            }
            TokenKind::Google => oauth::refresh_at(&endpoint, &refresh_token, None, true).await?,
        };
        if let Some(rotated) = &tokens.refresh_token
            && *rotated != refresh_token
        {
            self.secrets.set(&holder, &Secret::OAuth { refresh_token: rotated.clone() })?;
        }
        let cached =
            CachedToken { token: tokens.access_token, until: Instant::now() + tokens.expires_in, scope: tokens.scope };
        self.cloud.tokens.lock().await.insert(key, cached.clone());
        Ok(cached)
    }

    /// Whether the account's token covers `api`; Google's token says what the person allowed.
    async fn cloud_ready(&self, account: &AccountRecord, api: Api) -> Result<()> {
        let token = self.cloud_token(account, api.token(), None).await?;
        let scope = match api {
            Api::Graph => return Ok(()),
            Api::GoogleCalendar => oauth::GOOGLE_CALENDAR_SCOPE,
            Api::GooglePeople => oauth::GOOGLE_CONTACTS_SCOPE,
        };
        if token.has_scope(scope) {
            Ok(())
        } else {
            Err(Error::sign_in_again("Sign in again to see calendar and contacts."))
        }
    }

    /// One API call with the account's token; a token that isn't taken is renewed once.
    pub(super) async fn cloud_call(&self, account: &AccountRecord, call: &Call) -> Result<Value> {
        let mut refused: Option<String> = None;
        for _ in 0..2 {
            let token = self.cloud_token(account, call.api.token(), refused.as_deref()).await?;
            let endpoints = self.cloud.endpoints.lock().unwrap().clone();
            match cloud::send(&self.http, &endpoints, &token.token, call).await? {
                Answer::Done(value) => return Ok(value),
                Answer::Unauthorized => refused = Some(token.token),
            }
        }
        Err(Error::sign_in_again("Sign in again to see calendar and contacts."))
    }

    /// Every item of a Graph list, page after page.
    async fn graph_list(&self, account: &AccountRecord, call: Call) -> Result<Vec<Value>> {
        let mut call = call;
        let mut items = Vec::new();
        for _ in 0..cloud::MAX_PAGES {
            let page = self.cloud_call(account, &call).await?;
            items.extend(cloud::graph_items(&page).cloned());
            match cloud::graph_next(&page) {
                Some(next) => call.next = Some(next),
                None => return Ok(items),
            }
        }
        Ok(items)
    }

    /// Every item of a Google list (`key`), page after page; also the first page's `timeZone`.
    async fn google_list(&self, account: &AccountRecord, call: Call, key: &str) -> Result<(Vec<Value>, Option<Tz>)> {
        let mut items = Vec::new();
        let mut zone = None;
        let mut token: Option<String> = None;
        for _ in 0..cloud::MAX_PAGES {
            let mut page_call = call.clone();
            if let Some(token) = &token {
                page_call = page_call.query("pageToken", token.clone());
            }
            let page = self.cloud_call(account, &page_call).await?;
            if zone.is_none() {
                zone = page.get("timeZone").and_then(Value::as_str).and_then(jscal::parse_zone);
            }
            items.extend(page.get(key).and_then(Value::as_array).into_iter().flatten().cloned());
            match page.get("nextPageToken").and_then(Value::as_str) {
                Some(next) if !next.is_empty() => token = Some(next.to_string()),
                _ => return Ok((items, zone)),
            }
        }
        Ok((items, zone))
    }

    /// Graph's path to the account's mailbox: `me` for the person who signed in, `users/<address>`
    /// for a shared mailbox opened with their sign-in. Found once by comparing the address with the
    /// signed-in person's addresses; a mailbox that isn't theirs and that Graph opens is a shared one.
    pub(super) async fn graph_base(&self, account: &AccountRecord) -> Result<String> {
        if let Some(base) = self.cloud.bases.lock().await.get(&account.id) {
            return Ok(base.clone());
        }
        let me = self
            .cloud_call(account, &Call::get(Api::Graph, "me").query("$select", "mail,userPrincipalName,proxyAddresses"))
            .await?;
        let wanted = account.email.trim().to_lowercase();
        let mut own: Vec<String> = ["mail", "userPrincipalName"]
            .iter()
            .filter_map(|key| me.get(*key).and_then(Value::as_str))
            .map(str::to_lowercase)
            .collect();
        own.extend(
            me.get("proxyAddresses")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|address| address.split_once(':').map_or(address, |(_, a)| a).to_lowercase()),
        );
        let base = if own.contains(&wanted) {
            "me".to_string()
        } else {
            let shared = format!("users/{}", segment(&wanted));
            match self
                .cloud_call(account, &Call::get(Api::Graph, format!("{shared}/calendars")).query("$top", "1"))
                .await
            {
                Ok(_) => shared,
                Err(error) if matches!(error.code, ErrorCode::ConnectionFailed | ErrorCode::SignInAgain) => {
                    return Err(error);
                }
                // Another address of the person's own (an alias Graph doesn't list).
                Err(_) => "me".to_string(),
            }
        };
        self.cloud.bases.lock().await.insert(account.id.clone(), base.clone());
        Ok(base)
    }

    /// The calendar side of a cloud sign-in, checked: Graph's mailbox path, or Google with the scope.
    pub(super) async fn find_cloud_calendars(&self, account: &AccountRecord) -> Result<calendar::Source> {
        match account.auth {
            AuthKind::Microsoft => Ok(calendar::Source::Graph { base: self.graph_base(account).await? }),
            AuthKind::Google => {
                self.cloud_ready(account, Api::GoogleCalendar).await?;
                Ok(calendar::Source::Google)
            }
            AuthKind::Password => Err(Error::not_supported("No calendar server was found for this mailbox.")),
        }
    }

    pub(super) async fn find_cloud_contacts(&self, account: &AccountRecord) -> Result<contacts::Source> {
        match account.auth {
            AuthKind::Microsoft => Ok(contacts::Source::Graph { base: self.graph_base(account).await? }),
            AuthKind::Google => {
                self.cloud_ready(account, Api::GooglePeople).await?;
                Ok(contacts::Source::Google)
            }
            AuthKind::Password => Err(Error::not_supported("No address book server was found for this mailbox.")),
        }
    }

    /// Forgets everything about an account's cloud sign-in but the refresh token.
    pub(super) async fn forget_cloud(&self, account_id: &str) {
        self.cloud.tokens.lock().await.retain(|(id, _), _| id != account_id);
        self.cloud.bases.lock().await.remove(account_id);
        self.calendar_sources.lock().await.remove(account_id);
        self.contacts_sources.lock().await.remove(account_id);
        self.calendar_lists.lock().unwrap().remove(account_id);
        self.forget_contacts(account_id);
    }

    // --------------------------------------------------------------------------------------------
    // Calendars

    /// The account's calendars at Graph or Google.
    pub(super) async fn cloud_calendar_entries(
        &self,
        account_id: &str,
        source: &calendar::Source,
    ) -> Result<Vec<CalendarEntry>> {
        let account = self.store.account(account_id)?;
        let prefs = self.store.calendar_prefs(account_id)?;
        let chosen = prefs.iter().find(|(_, pref)| pref.is_default).map(|(id, _)| id.clone());
        let mut entries = Vec::new();
        match source {
            calendar::Source::Graph { base } => {
                let items = self
                    .graph_list(&account, Call::get(Api::Graph, format!("{base}/calendars")).query("$top", "200"))
                    .await?;
                for (index, found) in items.iter().filter_map(graph_cal::calendar).enumerate() {
                    let id = calendar::app_id(account_id, &found.id);
                    let pref = prefs.get(&id).copied().unwrap_or_default();
                    entries.push(CalendarEntry {
                        info: CalendarInfo {
                            is_default: chosen.as_ref().map_or(found.is_default, |chosen| *chosen == id),
                            id,
                            account_id: account_id.to_string(),
                            name: found.name,
                            color: found.color,
                            is_visible: !pref.hidden,
                            sort_order: index as i64,
                            may_write: found.can_edit,
                            may_delete: found.can_remove && !found.is_default,
                            is_birthdays: false,
                            is_local: false,
                        },
                        remote: found.id,
                    });
                }
            }
            calendar::Source::Google => {
                let call = Call::get(Api::GoogleCalendar, "users/me/calendarList").query("maxResults", "250");
                let (items, _) = self.google_list(&account, call, "items").await?;
                let mut found: Vec<_> = items.iter().filter_map(google_cal::calendar).collect();
                // The person's own calendar first, then the others by name.
                found.sort_by(|a, b| {
                    b.primary.cmp(&a.primary).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                });
                for (index, found) in found.into_iter().enumerate() {
                    let id = calendar::app_id(account_id, &found.id);
                    let pref = prefs.get(&id).copied().unwrap_or_default();
                    entries.push(CalendarEntry {
                        info: CalendarInfo {
                            is_default: chosen.as_ref().map_or(found.primary, |chosen| *chosen == id),
                            id,
                            account_id: account_id.to_string(),
                            name: found.name,
                            color: found.color,
                            is_visible: !pref.hidden,
                            sort_order: index as i64,
                            may_write: found.can_write,
                            may_delete: !found.primary,
                            is_birthdays: false,
                            is_local: false,
                        },
                        remote: found.id,
                    });
                }
            }
            _ => return Err(Error::internal("Not a cloud calendar.")),
        }
        if !entries.iter().any(|entry| entry.info.is_default)
            && let Some(first) = entries.iter_mut().find(|entry| entry.info.may_write)
        {
            first.info.is_default = true;
        }
        Ok(entries)
    }

    /// The occurrences in `[from, to)` (UTC, a day wider already) of the account's cloud calendars.
    pub(super) async fn cloud_occurrences(
        &self,
        account_id: &str,
        source: &calendar::Source,
        entries: &[CalendarEntry],
        (from, to): (DateTime<Utc>, DateTime<Utc>),
        viewer: Tz,
    ) -> Result<Vec<CalendarOccurrence>> {
        let account = self.store.account(account_id)?;
        let reads = entries.iter().map(|entry| {
            let account = &account;
            async move {
                let found = match source {
                    calendar::Source::Graph { base } => {
                        self.graph_occurrences(account, base, entry, from, to, viewer).await
                    }
                    _ => self.google_occurrences(account, entry, from, to, viewer).await,
                };
                (entry, found)
            }
        });
        let mut found = Vec::new();
        for (entry, read) in futures::future::join_all(reads).await {
            match read {
                Ok(occurrences) => found.extend(occurrences),
                Err(error) if error.code == ErrorCode::SignInAgain => return Err(error),
                Err(error) => {
                    tracing::warn!("A calendar of {account_id} couldn't be read: {error} ({})", entry.info.name)
                }
            }
        }
        Ok(found)
    }

    async fn graph_occurrences(
        &self,
        account: &AccountRecord,
        base: &str,
        entry: &CalendarEntry,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
        viewer: Tz,
    ) -> Result<Vec<CalendarOccurrence>> {
        let calendar_path = format!("{base}/calendars/{}", segment(&entry.remote));
        let call = Call::get(Api::Graph, format!("{calendar_path}/calendarView"))
            .query("startDateTime", utc_text(from))
            .query("endDateTime", utc_text(to))
            .query("$top", "500")
            .query("$select", graph_event_select())
            .prefer(graph_cal::PREFER);
        let items = self.graph_list(account, call).await?;
        let events: Vec<graph_cal::GraphEvent> = items.iter().filter_map(graph_cal::event).collect();
        // The series of repeating ones, for their rule.
        let mut master_ids: Vec<String> = events.iter().filter_map(|event| event.series_master_id.clone()).collect();
        master_ids.sort();
        master_ids.dedup();
        master_ids.truncate(MAX_MASTERS);
        let mut masters: HashMap<String, graph_cal::GraphEvent> = HashMap::new();
        for chunk in master_ids.chunks(MASTER_READS) {
            let reads = chunk.iter().map(|id| {
                let call = Call::get(Api::Graph, format!("{calendar_path}/events/{}", segment(id)))
                    .query("$select", graph_event_select())
                    .prefer(graph_cal::PREFER);
                async move { self.cloud_call(account, &call).await }
            });
            for read in futures::future::join_all(reads).await {
                if let Some(master) = read.ok().as_ref().and_then(graph_cal::event) {
                    masters.insert(master.id.clone(), master);
                }
            }
        }
        let mut found = Vec::new();
        for event in &events {
            if event.kind == "seriesMaster" {
                continue;
            }
            let series = event.series_master_id.as_ref().and_then(|id| masters.get(id));
            // An occurrence whose series couldn't be read can't be edited without losing its rule.
            let unknown_series = event.series_master_id.is_some() && series.is_none();
            let base_id = event.series_master_id.as_deref().unwrap_or(&event.id);
            let mut occurrence = jscal::occurrence(
                OccurrenceIds {
                    id: calendar::app_id(&account.id, &event_remote(&entry.remote, &event.id)),
                    event_id: calendar::app_id(&account.id, &event_remote(&entry.remote, base_id)),
                    account_id: account.id.clone(),
                    calendar_id: entry.info.id.clone(),
                    read_only: !entry.info.may_write || unknown_series,
                },
                &event.event,
                series.map(|series| &series.event),
                &OccurrenceTime { start: event.start, utc: event.utc },
                viewer,
            );
            if event.series_master_id.is_some() {
                occurrence.recurrence_id = Some(jscal::format_local(event.start));
            }
            found.push(occurrence);
        }
        Ok(found)
    }

    async fn google_occurrences(
        &self,
        account: &AccountRecord,
        entry: &CalendarEntry,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
        viewer: Tz,
    ) -> Result<Vec<CalendarOccurrence>> {
        let calendar_path = format!("calendars/{}", segment(&entry.remote));
        let call = Call::get(Api::GoogleCalendar, format!("{calendar_path}/events"))
            .query("timeMin", utc_text(from))
            .query("timeMax", utc_text(to))
            .query("singleEvents", "true")
            .query("maxResults", "2500");
        let (items, zone) = self.google_list(account, call, "items").await?;
        let events: Vec<google_cal::GoogleEvent> =
            items.iter().filter_map(|item| google_cal::event(item, zone)).collect();
        let mut master_ids: Vec<String> = events.iter().filter_map(|event| event.recurring_event_id.clone()).collect();
        master_ids.sort();
        master_ids.dedup();
        master_ids.truncate(MAX_MASTERS);
        let mut masters: HashMap<String, google_cal::GoogleEvent> = HashMap::new();
        for chunk in master_ids.chunks(MASTER_READS) {
            let reads = chunk.iter().map(|id| {
                let call = Call::get(Api::GoogleCalendar, format!("{calendar_path}/events/{}", segment(id)));
                async move { self.cloud_call(account, &call).await }
            });
            for read in futures::future::join_all(reads).await {
                if let Some(master) = read.ok().as_ref().and_then(|value| google_cal::event(value, zone)) {
                    masters.insert(master.id.clone(), master);
                }
            }
        }
        Ok(events
            .iter()
            .map(|event| {
                let series = event.recurring_event_id.as_ref().and_then(|id| masters.get(id));
                let unknown_series = event.recurring_event_id.is_some() && series.is_none();
                let base_id = event.recurring_event_id.as_deref().unwrap_or(&event.id);
                let mut occurrence = jscal::occurrence(
                    OccurrenceIds {
                        id: calendar::app_id(&account.id, &event_remote(&entry.remote, &event.id)),
                        event_id: calendar::app_id(&account.id, &event_remote(&entry.remote, base_id)),
                        account_id: account.id.clone(),
                        calendar_id: entry.info.id.clone(),
                        read_only: !entry.info.may_write || unknown_series,
                    },
                    &event.event,
                    series.map(|series| &series.event),
                    &OccurrenceTime { start: event.start, utc: event.utc },
                    viewer,
                );
                if event.recurring_event_id.is_some() {
                    occurrence.recurrence_id = Some(jscal::format_local(event.start));
                }
                occurrence
            })
            .collect())
    }

    pub(super) async fn cloud_create_calendar(
        &self,
        account_id: &str,
        source: &calendar::Source,
        name: &str,
        color: Option<&str>,
    ) -> Result<String> {
        let account = self.store.account(account_id)?;
        let created = match source {
            calendar::Source::Graph { base } => {
                let mut body = json!({ "name": name });
                if let Some(color) = color {
                    body["color"] = json!(graph_cal::color_name(color));
                }
                self.cloud_call(&account, &Call::new(Api::Graph, Method::POST, format!("{base}/calendars")).body(body))
                    .await?
            }
            _ => {
                let created = self
                    .cloud_call(
                        &account,
                        &Call::new(Api::GoogleCalendar, Method::POST, "calendars").body(json!({ "summary": name })),
                    )
                    .await?;
                if let (Some(color), Some(id)) = (color, created.get("id").and_then(Value::as_str)) {
                    self.google_calendar_color(&account, id, Some(color)).await?;
                }
                created
            }
        };
        created
            .get("id")
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| Error::internal("The new calendar didn't show up."))
    }

    async fn google_calendar_color(&self, account: &AccountRecord, id: &str, color: Option<&str>) -> Result<()> {
        let body = match color {
            Some(color) => json!({ "backgroundColor": color, "foregroundColor": "#000000" }),
            None => json!({ "colorId": "1" }),
        };
        let mut call =
            Call::new(Api::GoogleCalendar, Method::PATCH, format!("users/me/calendarList/{}", segment(id))).body(body);
        if color.is_some() {
            call = call.query("colorRgbFormat", "true");
        }
        self.cloud_call(account, &call).await.map(|_| ())
    }

    /// Renames and recolours a cloud calendar (visibility stays on this device).
    pub(super) async fn cloud_update_calendar(
        &self,
        entry: &CalendarEntry,
        source: &calendar::Source,
        name: Option<&str>,
        color: Option<Option<&str>>,
    ) -> Result<()> {
        let account = self.store.account(&entry.info.account_id)?;
        match source {
            calendar::Source::Graph { base } => {
                let mut body = Map::new();
                if let Some(name) = name {
                    body.insert("name".into(), json!(name));
                }
                if let Some(color) = color {
                    body.insert("color".into(), json!(color.map_or("auto", graph_cal::color_name)));
                }
                if !body.is_empty() {
                    let path = format!("{base}/calendars/{}", segment(&entry.remote));
                    self.cloud_call(&account, &Call::new(Api::Graph, Method::PATCH, path).body(Value::Object(body)))
                        .await?;
                }
            }
            _ => {
                if let Some(name) = name {
                    let path = format!("calendars/{}", segment(&entry.remote));
                    self.cloud_call(
                        &account,
                        &Call::new(Api::GoogleCalendar, Method::PATCH, path).body(json!({ "summary": name })),
                    )
                    .await?;
                }
                if let Some(color) = color {
                    self.google_calendar_color(&account, &entry.remote, color).await?;
                }
            }
        }
        Ok(())
    }

    pub(super) async fn cloud_delete_calendar(&self, entry: &CalendarEntry, source: &calendar::Source) -> Result<()> {
        let account = self.store.account(&entry.info.account_id)?;
        let call = match source {
            calendar::Source::Graph { base } => {
                Call::new(Api::Graph, Method::DELETE, format!("{base}/calendars/{}", segment(&entry.remote)))
            }
            _ => {
                // Owned calendars go; others are only taken off the list.
                let list = self
                    .cloud_call(
                        &account,
                        &Call::get(Api::GoogleCalendar, format!("users/me/calendarList/{}", segment(&entry.remote))),
                    )
                    .await?;
                if list.get("accessRole").and_then(Value::as_str) == Some("owner") {
                    Call::new(Api::GoogleCalendar, Method::DELETE, format!("calendars/{}", segment(&entry.remote)))
                } else {
                    Call::new(
                        Api::GoogleCalendar,
                        Method::DELETE,
                        format!("users/me/calendarList/{}", segment(&entry.remote)),
                    )
                }
            }
        };
        self.cloud_call(&account, &call).await?;
        self.store.forget_calendar(&entry.info.id)?;
        Ok(())
    }

    /// Creates an event (JSCalendar, from the editor) and returns its remote id.
    pub(super) async fn cloud_create_event(
        &self,
        entry: &CalendarEntry,
        source: &calendar::Source,
        event: &Value,
    ) -> Result<String> {
        let account = self.store.account(&entry.info.account_id)?;
        let created = match source {
            calendar::Source::Graph { base } => {
                let path = format!("{base}/calendars/{}/events", segment(&entry.remote));
                self.cloud_call(&account, &Call::new(Api::Graph, Method::POST, path).body(graph_cal::new_body(event)))
                    .await?
            }
            _ => {
                let path = format!("calendars/{}/events", segment(&entry.remote));
                self.cloud_call(
                    &account,
                    &Call::new(Api::GoogleCalendar, Method::POST, path).body(google_cal::new_body(event)),
                )
                .await?
            }
        };
        let id = created
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::internal("The new event didn't show up."))?;
        Ok(event_remote(&entry.remote, id))
    }

    /// Changes a whole event (the series of a repeating one), only where it differs; moves it to
    /// `target` when that's another calendar.
    pub(super) async fn cloud_update_event(
        &self,
        account_id: &str,
        source: &calendar::Source,
        remote: &str,
        target: &CalendarEntry,
        input: &EventInput,
        occurrence_start: Option<&str>,
    ) -> Result<()> {
        let account = self.store.account(account_id)?;
        let (calendar_id, event_id) = split_event_remote(remote)?;
        let moving = calendar_id != target.remote;
        match source {
            calendar::Source::Graph { base } => {
                let path = format!("{base}/calendars/{}/events/{}", segment(&calendar_id), segment(&event_id));
                let read = self
                    .cloud_call(
                        &account,
                        &Call::get(Api::Graph, path.clone())
                            .query("$select", graph_event_select())
                            .prefer(graph_cal::PREFER),
                    )
                    .await?;
                let current =
                    graph_cal::event(&read).ok_or_else(|| Error::not_found("This event no longer exists."))?;
                let patch = jscal::patch_for(&current.event, input, occurrence_start)?;
                let mut changed = current.event.clone();
                jscal::apply_patch(&mut changed, &patch)?;
                if moving {
                    // Graph can't move events between calendars: a copy there, then away here.
                    let new_path = format!("{base}/calendars/{}/events", segment(&target.remote));
                    self.cloud_call(
                        &account,
                        &Call::new(Api::Graph, Method::POST, new_path).body(graph_cal::new_body(&changed)),
                    )
                    .await?;
                    self.cloud_call(&account, &Call::new(Api::Graph, Method::DELETE, path)).await?;
                } else if !patch.is_empty() {
                    let body = graph_cal::patch_body(&current, &changed, &patch);
                    self.cloud_call(&account, &Call::new(Api::Graph, Method::PATCH, path).body(Value::Object(body)))
                        .await?;
                }
            }
            _ => {
                let mut path = format!("calendars/{}/events/{}", segment(&calendar_id), segment(&event_id));
                let read = self.cloud_call(&account, &Call::get(Api::GoogleCalendar, path.clone())).await?;
                let current =
                    google_cal::event(&read, None).ok_or_else(|| Error::not_found("This event no longer exists."))?;
                let patch = jscal::patch_for(&current.event, input, occurrence_start)?;
                if moving {
                    let call = Call::new(Api::GoogleCalendar, Method::POST, format!("{path}/move"))
                        .query("destination", target.remote.clone());
                    self.cloud_call(&account, &call).await?;
                    path = format!("calendars/{}/events/{}", segment(&target.remote), segment(&event_id));
                }
                if !patch.is_empty() {
                    let mut changed = current.event.clone();
                    jscal::apply_patch(&mut changed, &patch)?;
                    let body = google_cal::patch_body(&current, &changed, &patch);
                    self.cloud_call(
                        &account,
                        &Call::new(Api::GoogleCalendar, Method::PATCH, path).body(Value::Object(body)),
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }

    /// Deletes one occurrence (or a single event), or the whole series it belongs to.
    pub(super) async fn cloud_delete_event(
        &self,
        account_id: &str,
        source: &calendar::Source,
        remote: &str,
        scope: EventDeleteScope,
    ) -> Result<()> {
        let account = self.store.account(account_id)?;
        let (calendar_id, event_id) = split_event_remote(remote)?;
        let (api, events) = match source {
            calendar::Source::Graph { base } => {
                (Api::Graph, format!("{base}/calendars/{}/events", segment(&calendar_id)))
            }
            _ => (Api::GoogleCalendar, format!("calendars/{}/events", segment(&calendar_id))),
        };
        let mut target = event_id;
        if scope == EventDeleteScope::Series {
            let mut call = Call::get(api, format!("{events}/{}", segment(&target)));
            if api == Api::Graph {
                call = call.query("$select", "id,seriesMasterId");
            }
            let read = self.cloud_call(&account, &call).await?;
            let series = ["seriesMasterId", "recurringEventId"]
                .iter()
                .find_map(|key| read.get(*key).and_then(Value::as_str).filter(|id| !id.is_empty()));
            if let Some(series) = series {
                target = series.to_string();
            }
        }
        self.cloud_call(&account, &Call::new(api, Method::DELETE, format!("{events}/{}", segment(&target)))).await?;
        Ok(())
    }

    // --------------------------------------------------------------------------------------------
    // Contacts

    pub(super) async fn cloud_books(&self, account_id: &str, source: &contacts::Source) -> Result<Vec<BookEntry>> {
        let account = self.store.account(account_id)?;
        let chosen = self.store.default_address_book(account_id)?;
        let book = |remote: &str, name: &str, index: usize, may_delete: bool| {
            let id = contacts::app_id(account_id, remote);
            BookEntry {
                info: AddressBookInfo {
                    is_default: chosen.as_ref().map_or(remote == DEFAULT_BOOK, |chosen| *chosen == id),
                    id,
                    account_id: account_id.to_string(),
                    name: name.to_string(),
                    sort_order: index as i64,
                    may_write: true,
                    may_delete,
                },
                remote: remote.to_string(),
            }
        };
        let mut entries = vec![book(DEFAULT_BOOK, "Contacts", 0, false)];
        if let contacts::Source::Graph { base } = source {
            let folders = self
                .graph_list(&account, Call::get(Api::Graph, format!("{base}/contactFolders")).query("$top", "100"))
                .await?;
            for folder in &folders {
                let (Some(id), name) = (
                    folder.get("id").and_then(Value::as_str).filter(|id| !id.is_empty() && *id != DEFAULT_BOOK),
                    folder.get("displayName").and_then(Value::as_str).unwrap_or("Contacts"),
                ) else {
                    continue;
                };
                entries.push(book(id, name, entries.len(), true));
            }
        }
        if !entries.iter().any(|entry| entry.info.is_default) {
            entries[0].info.is_default = true;
        }
        Ok(entries)
    }

    pub(super) async fn cloud_cards(&self, account_id: &str, source: &contacts::Source) -> Result<Vec<RemoteCard>> {
        let account = self.store.account(account_id)?;
        let mut found = Vec::new();
        match source {
            contacts::Source::Graph { base } => {
                for book in self.cloud_books(account_id, source).await? {
                    let path = if book.remote == DEFAULT_BOOK {
                        format!("{base}/contacts")
                    } else {
                        format!("{base}/contactFolders/{}/contacts", segment(&book.remote))
                    };
                    let items = match self.graph_list(&account, Call::get(Api::Graph, path).query("$top", "500")).await
                    {
                        Ok(items) => items,
                        Err(error) if error.code == ErrorCode::SignInAgain => return Err(error),
                        Err(error) => {
                            tracing::warn!("An address book of {account_id} couldn't be read: {error}");
                            continue;
                        }
                    };
                    found.extend(items.iter().filter_map(cloud_cards::graph_card).map(|(id, _, card)| RemoteCard {
                        remote: id,
                        book_remote: book.remote.clone(),
                        card,
                    }));
                }
            }
            _ => {
                let call = Call::get(Api::GooglePeople, "people/me/connections")
                    .query("personFields", cloud_cards::GOOGLE_FIELDS)
                    .query("pageSize", "1000");
                let (people, _) = self.google_list(&account, call, "connections").await?;
                found.extend(people.iter().filter_map(cloud_cards::google_card).map(|(resource, _, card)| {
                    RemoteCard { remote: resource, book_remote: DEFAULT_BOOK.to_string(), card }
                }));
            }
        }
        Ok(found)
    }

    /// One card as the provider has it now, with its etag (Google).
    pub(super) async fn cloud_card(
        &self,
        account_id: &str,
        source: &contacts::Source,
        remote: &str,
    ) -> Result<(RemoteCard, Option<String>)> {
        let account = self.store.account(account_id)?;
        match source {
            contacts::Source::Graph { base } => {
                let read = self
                    .cloud_call(&account, &Call::get(Api::Graph, format!("{base}/contacts/{}", segment(remote))))
                    .await?;
                let (id, folder, card) =
                    cloud_cards::graph_card(&read).ok_or_else(|| Error::not_found("This contact no longer exists."))?;
                // The default folder's id is Graph's own; the app calls it `contacts`.
                let books = self.address_book_entries(account_id).await?;
                let book_remote = folder
                    .filter(|folder| books.iter().any(|book| book.remote == *folder))
                    .unwrap_or_else(|| DEFAULT_BOOK.to_string());
                Ok((RemoteCard { remote: id, book_remote, card }, None))
            }
            _ => {
                let resource = cloud_cards::google_resource(remote)
                    .ok_or_else(|| Error::invalid("That contact id makes no sense."))?;
                let read = self
                    .cloud_call(
                        &account,
                        &Call::get(Api::GooglePeople, resource).query("personFields", cloud_cards::GOOGLE_FIELDS),
                    )
                    .await?;
                let (resource, etag, card) = cloud_cards::google_card(&read)
                    .ok_or_else(|| Error::not_found("This contact no longer exists."))?;
                Ok((RemoteCard { remote: resource, book_remote: DEFAULT_BOOK.to_string(), card }, etag))
            }
        }
    }

    pub(super) async fn cloud_create_card(
        &self,
        account_id: &str,
        source: &contacts::Source,
        book: &BookEntry,
        card: &Map<String, Value>,
    ) -> Result<String> {
        let account = self.store.account(account_id)?;
        match source {
            contacts::Source::Graph { base } => {
                let path = if book.remote == DEFAULT_BOOK {
                    format!("{base}/contacts")
                } else {
                    format!("{base}/contactFolders/{}/contacts", segment(&book.remote))
                };
                let created = self
                    .cloud_call(
                        &account,
                        &Call::new(Api::Graph, Method::POST, path).body(cloud_cards::card_to_graph(card)),
                    )
                    .await?;
                created.get("id").and_then(Value::as_str).map(String::from)
            }
            _ => {
                let call = Call::new(Api::GooglePeople, Method::POST, "./people:createContact")
                    .query("personFields", "metadata")
                    .body(cloud_cards::card_to_google(card));
                let created = self.cloud_call(&account, &call).await?;
                created.get("resourceName").and_then(Value::as_str).map(String::from)
            }
        }
        .ok_or_else(|| Error::internal("The new contact didn't show up."))
    }

    /// Writes a changed card back; `target` moves it to another address book (Graph folders).
    pub(super) async fn cloud_update_card(
        &self,
        account_id: &str,
        source: &contacts::Source,
        remote: &str,
        patch: &Map<String, Value>,
        target: Option<&BookEntry>,
    ) -> Result<()> {
        let account = self.store.account(account_id)?;
        let (current, etag) = self.cloud_card(account_id, source, remote).await?;
        let mut card = Value::Object(current.card.clone());
        jscal::apply_patch(&mut card, patch)?;
        let Value::Object(card) = card else {
            return Err(Error::internal("The contact isn't an object any more."));
        };
        match source {
            contacts::Source::Graph { base } => {
                let path = format!("{base}/contacts/{}", segment(remote));
                match target.filter(|target| target.remote != current.book_remote) {
                    Some(target) => {
                        // Graph can't move contacts between folders: a copy there, then away here.
                        self.cloud_create_card(account_id, source, target, &card).await?;
                        self.cloud_call(&account, &Call::new(Api::Graph, Method::DELETE, path)).await?;
                    }
                    None => {
                        let call = Call::new(Api::Graph, Method::PATCH, path).body(cloud_cards::card_to_graph(&card));
                        self.cloud_call(&account, &call).await?;
                    }
                }
            }
            _ => {
                let mut body = cloud_cards::card_to_google(&card);
                body["etag"] = json!(etag.unwrap_or_default());
                let call = Call::new(Api::GooglePeople, Method::PATCH, format!("{}:updateContact", current.remote))
                    .query("updatePersonFields", cloud_cards::GOOGLE_UPDATE_FIELDS)
                    .query("personFields", "metadata")
                    .body(body);
                self.cloud_call(&account, &call).await?;
            }
        }
        Ok(())
    }

    pub(super) async fn cloud_delete_card(
        &self,
        account_id: &str,
        source: &contacts::Source,
        remote: &str,
    ) -> Result<()> {
        let account = self.store.account(account_id)?;
        let call = match source {
            contacts::Source::Graph { base } => {
                Call::new(Api::Graph, Method::DELETE, format!("{base}/contacts/{}", segment(remote)))
            }
            _ => {
                let resource = cloud_cards::google_resource(remote)
                    .ok_or_else(|| Error::invalid("That contact id makes no sense."))?;
                Call::new(Api::GooglePeople, Method::DELETE, format!("{resource}:deleteContact"))
            }
        };
        self.cloud_call(&account, &call).await.map(|_| ())
    }

    /// Graph folders as address books: create, rename, delete. Google has the one address book here.
    pub(super) async fn cloud_book_call(
        &self,
        account_id: &str,
        source: &contacts::Source,
        method: Method,
        folder: Option<&str>,
        name: Option<&str>,
    ) -> Result<Value> {
        let contacts::Source::Graph { base } = source else {
            return Err(Error::not_supported("Google contacts are one address book here."));
        };
        let account = self.store.account(account_id)?;
        let path = match folder {
            Some(folder) if folder != DEFAULT_BOOK => format!("{base}/contactFolders/{}", segment(folder)),
            Some(_) => return Err(Error::invalid("The Contacts folder stays as it is.")),
            None => format!("{base}/contactFolders"),
        };
        let mut call = Call::new(Api::Graph, method, path);
        if let Some(name) = name {
            call = call.body(json!({ "displayName": name }));
        }
        self.cloud_call(&account, &call).await
    }
}

impl Engine {
    /// Where Graph, Google and the token endpoints are (tests only).
    #[cfg(test)]
    pub(crate) fn set_cloud_endpoints(&self, endpoints: cloud::Endpoints) {
        *self.inner.cloud.endpoints.lock().unwrap() = endpoints;
    }

    /// For tests of everything else: Microsoft and Google refuse every refresh, as for a sign-in
    /// from before calendars came along. Keep the server while the engine is used.
    #[cfg(test)]
    pub(crate) async fn refuse_cloud_tokens(&self) -> cloud::fake::Server {
        let server = cloud::fake::Server::start(|_| {
            cloud::fake::Reply::status(400, json!({ "error": "invalid_grant", "error_description": "AADSTS65001" }))
        })
        .await;
        let token = oauth::TokenEndpoint {
            url: format!("{}/token", server.base),
            client_id: "test-app".into(),
            client_secret: None,
        };
        self.set_cloud_endpoints(cloud::Endpoints {
            graph: server.url("/graph/"),
            google_calendar: server.url("/gcal/"),
            google_people: server.url("/people/"),
            microsoft_token: Some(token.clone()),
            google_token: Some(token),
        });
        server
    }
}

/// When an occurrence's range starts and ends, a day wider for all-day events.
pub(super) fn cloud_range(from: NaiveDateTime, to: NaiveDateTime, viewer: Tz) -> (DateTime<Utc>, DateTime<Utc>) {
    let (from, to) = (jscal::to_utc(from, viewer), jscal::to_utc(to, viewer));
    (from - chrono::Duration::days(1), to + chrono::Duration::days(1))
}

#[cfg(test)]
mod tests;
