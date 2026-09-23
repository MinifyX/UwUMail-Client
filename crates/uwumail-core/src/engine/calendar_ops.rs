//! Calendars across all accounts, behind one set of calls: JMAP Calendars where the UwUMail
//! server has them, CalDAV for other password accounts, nothing for Microsoft and Google
//! sign-ins (their calendars need other APIs).

use chrono::{NaiveDateTime, Utc};
use chrono_tz::Tz;
use serde_json::{Map, Value, json};
use url::Url;

use super::*;
use crate::calendar::jscal::{self, OccurrenceIds, OccurrenceTime};
use crate::calendar::{self, CalendarEntry, Source, SourceState, dav, ical, jmap_cal};

/// How long an account's list of calendars is used before it's asked for again.
const LIST_FRESH: Duration = Duration::from_secs(5 * 60);
/// How long "no calendar here" holds before discovery runs again.
const RETRY_UNAVAILABLE: Duration = Duration::from_secs(10 * 60);
/// The longest range of events asked for at once (the UwUMail server's limit too).
const MAX_RANGE_DAYS: i64 = 400;
const PRODUCT_ID: &str = "-//UwUMail//Calendar//EN";

fn now_utc_text() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn parse_range(from: &str, to: &str, zone: &str) -> Result<(NaiveDateTime, NaiveDateTime, Tz)> {
    let viewer =
        jscal::parse_zone(zone).ok_or_else(|| Error::invalid(format!("\"{zone}\" isn't a known time zone.")))?;
    let from = jscal::parse_local(from).ok_or_else(|| Error::invalid("The start of the range isn't a date."))?;
    let to = jscal::parse_local(to).ok_or_else(|| Error::invalid("The end of the range isn't a date."))?;
    if to <= from {
        return Err(Error::invalid("The range ends before it starts."));
    }
    if (to - from).num_days() > MAX_RANGE_DAYS {
        return Err(Error::invalid(format!("At most {MAX_RANGE_DAYS} days of events at once.")));
    }
    Ok((from, to, viewer))
}

impl Inner {
    /// Where an account's calendars live, found once and remembered.
    async fn calendar_source(&self, account_id: &str) -> Result<Source> {
        {
            let sources = self.calendar_sources.lock().await;
            match sources.get(account_id) {
                Some(SourceState::Ready(source)) => return Ok(source.clone()),
                Some(SourceState::Unavailable { problem, since }) if since.elapsed() < RETRY_UNAVAILABLE => {
                    return Err(problem.clone());
                }
                _ => {}
            }
        }
        let account = self.store.account(account_id)?;
        match self.find_calendar_source(&account).await {
            Ok(source) => {
                self.calendar_sources.lock().await.insert(account_id.to_string(), SourceState::Ready(source.clone()));
                Ok(source)
            }
            Err(problem) => {
                // Only a definite "none here" is remembered; a network hiccup is asked again next time.
                if problem.code == ErrorCode::NotSupported {
                    self.calendar_sources.lock().await.insert(
                        account_id.to_string(),
                        SourceState::Unavailable { problem: problem.clone(), since: Instant::now() },
                    );
                }
                Err(problem)
            }
        }
    }

    async fn find_calendar_source(&self, account: &AccountRecord) -> Result<Source> {
        if account.protocol == Protocol::Jmap {
            let client = self.jmap_client(&account.id).await?;
            if client.session.calendar_account_id.is_some() {
                return Ok(Source::Jmap);
            }
        }
        let Secret::Password { password } = self.secrets.get(&account.id)? else {
            return Err(Error::not_supported(
                "Calendars aren't available for mailboxes signed in with Microsoft or Google.",
            ));
        };
        let (_, domain) = autoconfig::split_email(&account.email)?;
        let manual = match self.store.caldav_url(&account.id)? {
            Some(url) => Some(Url::parse(&url).map_err(|_| Error::invalid("The CalDAV address isn't a web address."))?),
            None => None,
        };
        let jmap_host = account
            .jmap_url
            .as_deref()
            .and_then(|url| Url::parse(url).ok())
            .and_then(|url| url.host_str().map(String::from));
        let manual_host = manual.as_ref().and_then(|url| url.host_str().map(String::from));
        let mut trusted: Vec<&str> = vec![&domain, &account.imap.host, &account.smtp.host];
        trusted.extend(jmap_host.as_deref());
        trusted.extend(manual_host.as_deref());
        let client = dav::DavClient::new(&account.username, &password, &trusted)?;
        let hosts: Vec<String> =
            [&account.imap.host].into_iter().filter(|host| !host.trim().is_empty()).cloned().collect();
        let home = dav::discover(&client, manual.as_ref(), &domain, &hosts).await?;
        Ok(Source::Dav { client: Arc::new(client), home })
    }

    fn forget_calendars(&self, account_id: &str) {
        self.calendar_lists.lock().unwrap().remove(account_id);
    }

    /// An account's calendars, from memory while fresh.
    async fn calendar_entries(&self, account_id: &str) -> Result<Vec<CalendarEntry>> {
        if let Some((at, entries)) = self.calendar_lists.lock().unwrap().get(account_id)
            && at.elapsed() < LIST_FRESH
        {
            return Ok(entries.clone());
        }
        let entries = match self.calendar_source(account_id).await? {
            Source::Jmap => {
                let client = self.jmap_client(account_id).await?;
                jmap_cal::calendars(&client)
                    .await?
                    .into_iter()
                    .map(|calendar| CalendarEntry {
                        info: CalendarInfo {
                            id: calendar::app_id(account_id, &calendar.id),
                            account_id: account_id.to_string(),
                            name: calendar.name,
                            color: calendar.color,
                            is_default: calendar.is_default,
                            is_visible: calendar.is_visible,
                            sort_order: calendar.sort_order,
                            may_write: calendar.may_write,
                            may_delete: calendar.may_delete,
                        },
                        remote: calendar.id,
                    })
                    .collect::<Vec<_>>()
            }
            Source::Dav { client, home } => {
                let prefs = self.store.calendar_prefs(account_id)?;
                let found = dav::calendars(&client, &home).await?;
                let home_origin = home.origin();
                let mut entries: Vec<CalendarEntry> = found
                    .into_iter()
                    .filter(|calendar| calendar.url.origin() == home_origin)
                    .enumerate()
                    .map(|(index, calendar)| {
                        let path = calendar.url.path().to_string();
                        let id = calendar::app_id(account_id, &path);
                        let pref = prefs.get(&id).copied().unwrap_or_default();
                        CalendarEntry {
                            info: CalendarInfo {
                                id,
                                account_id: account_id.to_string(),
                                name: calendar.name,
                                color: calendar.color,
                                is_default: pref.is_default,
                                is_visible: !pref.hidden,
                                sort_order: calendar.order.unwrap_or(index as i64),
                                may_write: calendar.writable,
                                may_delete: calendar.writable,
                            },
                            remote: path,
                        }
                    })
                    .collect();
                // Without a choice made here, the first calendar that takes events is the default.
                if !entries.iter().any(|entry| entry.info.is_default)
                    && let Some(first) = entries.iter_mut().find(|entry| entry.info.may_write)
                {
                    first.info.is_default = true;
                }
                entries
            }
        };
        self.calendar_lists.lock().unwrap().insert(account_id.to_string(), (Instant::now(), entries.clone()));
        Ok(entries)
    }

    async fn calendar_entry(&self, calendar_id: &str) -> Result<(Source, CalendarEntry)> {
        let (account_id, _) = calendar::split_id(calendar_id)?;
        let source = self.calendar_source(account_id).await?;
        let mut entry = self.calendar_entries(account_id).await?.into_iter().find(|entry| entry.info.id == calendar_id);
        if entry.is_none() {
            self.forget_calendars(account_id);
            entry = self.calendar_entries(account_id).await?.into_iter().find(|entry| entry.info.id == calendar_id);
        }
        let entry = entry.ok_or_else(|| Error::not_found("This calendar no longer exists."))?;
        Ok((source, entry))
    }

    fn calendar_changed(&self, account_id: Option<&str>) {
        if let Some(account_id) = account_id {
            self.forget_calendars(account_id);
        }
        self.emit(EngineEvent::CalendarChanged {});
    }

    async fn account_occurrences(
        &self,
        account_id: &str,
        from: NaiveDateTime,
        to: NaiveDateTime,
        viewer: Tz,
    ) -> Result<Vec<CalendarOccurrence>> {
        let entries = self.calendar_entries(account_id).await?;
        match self.calendar_source(account_id).await? {
            Source::Jmap => {
                let client = self.jmap_client(account_id).await?;
                let instances =
                    jmap_cal::occurrences(&client, &jscal::format_local(from), &jscal::format_local(to), viewer.name())
                        .await?;
                Ok(instances
                    .into_iter()
                    .filter_map(|instance| {
                        let text = |key: &str| instance.event.get(key).and_then(Value::as_str);
                        let id = text("id")?.to_string();
                        let base = text("baseEventId").unwrap_or(&id).to_string();
                        let remote_calendar =
                            instance.event.get("calendarIds").and_then(Value::as_object).and_then(|ids| {
                                ids.iter().find(|(_, on)| on.as_bool() == Some(true)).map(|(id, _)| id.clone())
                            })?;
                        let entry = entries.iter().find(|entry| entry.remote == remote_calendar);
                        let origin = instance.event.get("isOrigin").and_then(Value::as_bool).unwrap_or(true);
                        let start = text("start").and_then(jscal::parse_local)?;
                        Some(jscal::occurrence(
                            OccurrenceIds {
                                id: calendar::app_id(account_id, &id),
                                event_id: calendar::app_id(account_id, &base),
                                account_id: account_id.to_string(),
                                calendar_id: calendar::app_id(account_id, &remote_calendar),
                                read_only: !origin || !entry.is_some_and(|entry| entry.info.may_write),
                            },
                            &instance.event,
                            instance.base.as_ref(),
                            &OccurrenceTime { start, utc: instance.utc },
                            viewer,
                        ))
                    })
                    .collect())
            }
            Source::Dav { client, home } => {
                let (utc_from, utc_to) = (jscal::to_utc(from, viewer), jscal::to_utc(to, viewer));
                // Floating and all-day events sit at the same wall time everywhere: ask a day wider.
                let (ask_from, ask_to) = (utc_from - chrono::Duration::days(1), utc_to + chrono::Duration::days(1));
                let reads = entries.iter().map(|entry| {
                    let client = Arc::clone(&client);
                    let home = home.clone();
                    async move {
                        let url = calendar::dav_url(&home, &entry.remote)?;
                        let objects = dav::objects_between(&client, &url, ask_from, ask_to).await?;
                        Ok::<_, Error>((entry, objects))
                    }
                });
                let mut found = Vec::new();
                // One budget for the whole account, so its objects together can't fill the memory.
                let mut budget = ical::Budget::default();
                for read in futures::future::join_all(reads).await {
                    let (entry, objects) = match read {
                        Ok(read) => read,
                        Err(error) => {
                            tracing::warn!("A calendar of {account_id} couldn't be read: {error}");
                            continue;
                        }
                    };
                    for object in objects {
                        if budget.exhausted() {
                            break;
                        }
                        let Ok(parsed) = ical::parse(&object.data) else { continue };
                        let Ok(group) = ical::to_jscalendar(&parsed) else { continue };
                        let event_id = calendar::app_id(account_id, object.url.path());
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
                                    calendar_id: entry.info.id.clone(),
                                    read_only: !entry.info.may_write,
                                },
                                &instance.event,
                                Some(instance.series.as_ref()),
                                &instance.time,
                                viewer,
                            ));
                        }
                    }
                }
                Ok(found)
            }
        }
    }
}

/// One CalDAV object with the event in it, ready to change and write back.
struct DavEvent {
    url: Url,
    etag: Option<String>,
    group: Value,
}

async fn read_dav_event(client: &dav::DavClient, home: &Url, path: &str) -> Result<DavEvent> {
    let url = calendar::dav_url(home, path)?;
    let object = dav::get_object(client, &url).await?;
    let parsed = ical::parse(&object.data)?;
    let group = ical::to_jscalendar(&parsed)?;
    if ical::events(&group).next().is_none() {
        return Err(Error::not_found("There's no event in this calendar entry."));
    }
    Ok(DavEvent { url, etag: object.etag, group })
}

/// The series event of an object: the one with a rule, else the first.
fn main_event(group: &mut Value) -> Option<&mut Value> {
    let index = ical::events(group)
        .position(|event| event.get("recurrenceRule").is_some_and(|rule| !rule.is_null()))
        .unwrap_or(0);
    ical::events_mut(group).nth(index)
}

fn touch(event: &mut Value) {
    if let Some(object) = event.as_object_mut() {
        let sequence = object.get("sequence").and_then(Value::as_u64).unwrap_or(0) + 1;
        object.insert("sequence".into(), json!(sequence));
        object.insert("updated".into(), json!(now_utc_text()));
    }
}

/// Applies the editor's input to the series event of a CalDAV object. False when nothing changed.
fn edit_dav_group(group: &mut Value, input: &EventInput, occurrence_start: Option<&str>) -> Result<bool> {
    let event = main_event(group).ok_or_else(|| Error::not_found("This event no longer exists."))?;
    let patch = jscal::patch_for(event, input, occurrence_start)?;
    if patch.is_empty() {
        return Ok(false);
    }
    jscal::apply_patch(event, &patch)?;
    touch(event);
    Ok(true)
}

impl Engine {
    /// Every calendar of every account that has some. Accounts that can't be reached are left out.
    pub async fn calendars(&self) -> Result<Vec<CalendarInfo>> {
        let accounts = self.inner.store.accounts()?;
        let lists = accounts.iter().map(|account| self.inner.calendar_entries(&account.id));
        let mut calendars = Vec::new();
        for (account, list) in accounts.iter().zip(futures::future::join_all(lists).await) {
            match list {
                Ok(entries) => {
                    let mut infos: Vec<CalendarInfo> = entries.into_iter().map(|entry| entry.info).collect();
                    infos.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then_with(|| a.name.cmp(&b.name)));
                    calendars.extend(infos);
                }
                Err(error) => tracing::debug!("No calendars for {}: {error}", account.id),
            }
        }
        Ok(calendars)
    }

    /// For each account: whether it has calendars, from where, and why not.
    pub async fn calendar_accounts(&self) -> Result<Vec<CalendarAccount>> {
        let accounts = self.inner.store.accounts()?;
        let sources = accounts.iter().map(|account| self.inner.calendar_source(&account.id));
        let mut found = Vec::new();
        for (account, source) in accounts.iter().zip(futures::future::join_all(sources).await) {
            let (source, problem) = match source {
                Ok(Source::Jmap) => (Some(CalendarSource::Jmap), None),
                Ok(Source::Dav { .. }) => (Some(CalendarSource::Caldav), None),
                Err(error) => (None, Some(error.message)),
            };
            found.push(CalendarAccount {
                account_id: account.id.clone(),
                source,
                caldav_url: self.inner.store.caldav_url(&account.id)?,
                problem,
            });
        }
        Ok(found)
    }

    /// Uses a CalDAV address typed in by hand for an account (`None` goes back to discovery).
    pub async fn set_caldav_url(&self, account_id: &str, url: Option<&str>) -> Result<()> {
        self.inner.store.account(account_id)?;
        let url = url.map(str::trim).filter(|url| !url.is_empty());
        if let Some(url) = url {
            let parsed = Url::parse(url).map_err(|_| Error::invalid("That isn't a web address."))?;
            if parsed.scheme() != "https" || parsed.host_str().is_none() {
                return Err(Error::invalid("The CalDAV address must start with https://."));
            }
        }
        self.inner.store.set_caldav_url(account_id, url)?;
        self.inner.calendar_sources.lock().await.remove(account_id);
        self.inner.calendar_changed(Some(account_id));
        Ok(())
    }

    pub async fn create_calendar(&self, new: NewCalendar) -> Result<CalendarInfo> {
        let name = new.name.trim();
        if name.is_empty() || name.chars().count() > 200 || name.chars().any(char::is_control) {
            return Err(Error::invalid("Give the calendar a name of up to 200 characters."));
        }
        let color = match new.color.as_deref() {
            Some(color) => {
                Some(jscal::clean_color(Some(color)).ok_or_else(|| Error::invalid("That color isn't #rrggbb."))?)
            }
            None => None,
        };
        let account_id = match new.account_id {
            Some(id) => id,
            None => {
                let mut found = None;
                for account in self.inner.store.accounts()? {
                    if self.inner.calendar_source(&account.id).await.is_ok() {
                        found = Some(account.id);
                        break;
                    }
                }
                found.ok_or_else(|| Error::not_supported("None of your mailboxes has a calendar."))?
            }
        };
        let remote = match self.inner.calendar_source(&account_id).await? {
            Source::Jmap => {
                let client = self.inner.jmap_client(&account_id).await?;
                jmap_cal::create_calendar(&client, name, color.as_deref()).await?
            }
            Source::Dav { client, home } => {
                dav::make_calendar(&client, &home, name, color.as_deref()).await?.path().to_string()
            }
        };
        self.inner.calendar_changed(Some(&account_id));
        let id = calendar::app_id(&account_id, &remote);
        self.inner
            .calendar_entries(&account_id)
            .await?
            .into_iter()
            .find(|entry| entry.info.id == id)
            .map(|entry| entry.info)
            .ok_or_else(|| Error::internal("The new calendar didn't show up."))
    }

    pub async fn update_calendar(&self, calendar_id: &str, patch: CalendarPatch) -> Result<()> {
        let (source, entry) = self.inner.calendar_entry(calendar_id).await?;
        let account_id = entry.info.account_id.clone();
        let name = patch.name.as_deref().map(str::trim);
        if name.is_some_and(|name| name.is_empty() || name.chars().count() > 200 || name.chars().any(char::is_control))
        {
            return Err(Error::invalid("Give the calendar a name of up to 200 characters."));
        }
        let color = match &patch.color {
            Some(Some(color)) => {
                Some(Some(jscal::clean_color(Some(color)).ok_or_else(|| Error::invalid("That color isn't #rrggbb."))?))
            }
            Some(None) => Some(None),
            None => None,
        };
        match source {
            Source::Jmap => {
                let mut changes = Map::new();
                if let Some(name) = name {
                    changes.insert("name".into(), json!(name));
                }
                if let Some(color) = &color {
                    changes.insert("color".into(), color.as_ref().map_or(Value::Null, |c| json!(c)));
                }
                if let Some(visible) = patch.is_visible {
                    changes.insert("isVisible".into(), json!(visible));
                }
                let client = self.inner.jmap_client(&account_id).await?;
                jmap_cal::update_calendar(&client, &entry.remote, changes).await?;
            }
            Source::Dav { client, home } => {
                if name.is_some() || color.is_some() {
                    let url = calendar::dav_url(&home, &entry.remote)?;
                    let color = color.as_ref().map(|color| color.as_deref());
                    dav::update_calendar(&client, &url, name, color).await?;
                }
                if let Some(visible) = patch.is_visible {
                    self.inner.store.set_calendar_hidden(&account_id, calendar_id, !visible)?;
                }
            }
        }
        self.inner.calendar_changed(Some(&account_id));
        Ok(())
    }

    /// Deletes a calendar with its events.
    pub async fn delete_calendar(&self, calendar_id: &str) -> Result<()> {
        let (source, entry) = self.inner.calendar_entry(calendar_id).await?;
        if !entry.info.may_delete {
            return Err(Error::invalid("This calendar can't be deleted."));
        }
        match source {
            Source::Jmap => {
                let client = self.inner.jmap_client(&entry.info.account_id).await?;
                jmap_cal::delete_calendar(&client, &entry.remote).await?;
            }
            Source::Dav { client, home } => {
                dav::delete(&client, &calendar::dav_url(&home, &entry.remote)?, None).await?;
                self.inner.store.forget_calendar(calendar_id)?;
            }
        }
        self.inner.calendar_changed(Some(&entry.info.account_id));
        Ok(())
    }

    pub async fn set_default_calendar(&self, calendar_id: &str) -> Result<()> {
        let (source, entry) = self.inner.calendar_entry(calendar_id).await?;
        match source {
            Source::Jmap => {
                let client = self.inner.jmap_client(&entry.info.account_id).await?;
                jmap_cal::set_default(&client, &entry.remote).await?;
            }
            Source::Dav { .. } => self.inner.store.set_default_calendar(&entry.info.account_id, calendar_id)?,
        }
        self.inner.calendar_changed(Some(&entry.info.account_id));
        Ok(())
    }

    /// Every occurrence in `[from, to)` (wall times in `zone`) in every account's calendars.
    /// Accounts that can't be reached are left out.
    pub async fn calendar_events(&self, from: &str, to: &str, zone: &str) -> Result<Vec<CalendarOccurrence>> {
        let (from, to, viewer) = parse_range(from, to, zone)?;
        let accounts = self.inner.store.accounts()?;
        let reads = accounts.iter().map(|account| self.inner.account_occurrences(&account.id, from, to, viewer));
        let mut found = Vec::new();
        for (account, read) in accounts.iter().zip(futures::future::join_all(reads).await) {
            match read {
                Ok(occurrences) => found.extend(occurrences),
                Err(error) if error.code == ErrorCode::NotSupported => {}
                Err(error) => tracing::warn!("Events of {} couldn't be read: {error}", account.id),
            }
        }
        let (from, to) = (jscal::format_local(from), jscal::format_local(to));
        // What overlaps the range; an event of no length right at its start counts too.
        found.retain(|occurrence| (occurrence.end > from && occurrence.start < to) || occurrence.start == from);
        found.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| a.end.cmp(&b.end)).then_with(|| a.id.cmp(&b.id)));
        Ok(found)
    }

    /// Creates an event and returns its id.
    pub async fn create_event(&self, input: EventInput) -> Result<String> {
        let (source, entry) = self.inner.calendar_entry(&input.calendar_id).await?;
        if !entry.info.may_write {
            return Err(Error::invalid("This calendar is read-only."));
        }
        let account_id = entry.info.account_id.clone();
        let mut event = jscal::new_event(&input)?;
        let remote = match source {
            Source::Jmap => {
                let client = self.inner.jmap_client(&account_id).await?;
                jmap_cal::create_event(&client, &entry.remote, event).await?
            }
            Source::Dav { client, home } => {
                let uid = uuid::Uuid::new_v4().to_string();
                event.insert("uid".into(), json!(uid));
                event.insert("created".into(), json!(now_utc_text()));
                event.insert("updated".into(), json!(now_utc_text()));
                let group = json!({ "@type": "Group", "prodId": PRODUCT_ID, "entries": [event] });
                let text = ical::from_jscalendar(&group)?;
                let calendar_url = calendar::dav_url(&home, &entry.remote)?;
                let url = calendar_url
                    .join(&format!("{uid}.ics"))
                    .map_err(|_| Error::internal("The event's address couldn't be built."))?;
                dav::put_object(&client, &url, &text, None).await?;
                url.path().to_string()
            }
        };
        self.inner.calendar_changed(None);
        Ok(calendar::app_id(&account_id, &remote))
    }

    /// Changes a whole event (the series for repeating ones); only what differs is written.
    /// `occurrence_start` is where the occurrence the edit began from was shown: a series then
    /// moves by as much as that occurrence was moved, instead of jumping to its date.
    pub async fn update_event(&self, event_id: &str, input: EventInput, occurrence_start: Option<&str>) -> Result<()> {
        let (account_id, remote) = calendar::split_id(event_id)?;
        let (target_account, _) = calendar::split_id(&input.calendar_id)?;
        if target_account != account_id {
            return Err(Error::invalid("Events can't move to a calendar of another mailbox."));
        }
        let (source, target) = self.inner.calendar_entry(&input.calendar_id).await?;
        if !target.info.may_write {
            return Err(Error::invalid("This calendar is read-only."));
        }
        match source {
            Source::Jmap => {
                let client = self.inner.jmap_client(account_id).await?;
                let current = jmap_cal::event(&client, remote).await?;
                let mut patch = jscal::patch_for(&current, &input, occurrence_start)?;
                let in_target =
                    current.get("calendarIds").and_then(|ids| ids.get(&target.remote)).and_then(Value::as_bool);
                if in_target != Some(true) {
                    patch.insert("calendarIds".into(), json!({ target.remote.clone(): true }));
                }
                jmap_cal::update_event(&client, remote, patch).await?;
            }
            Source::Dav { client, home } => {
                let (path, _) = calendar::split_occurrence(remote);
                let mut object = read_dav_event(&client, &home, path).await?;
                let changed = edit_dav_group(&mut object.group, &input, occurrence_start)?;
                let target_url = calendar::dav_url(&home, &target.remote)?;
                let same_calendar = object.url.path().starts_with(target_url.path());
                if !changed {
                    if same_calendar {
                        return Ok(());
                    }
                    // Only moving: still a new version of the event.
                    if let Some(event) = main_event(&mut object.group) {
                        touch(event);
                    }
                }
                let text = ical::from_jscalendar(&object.group)?;
                if same_calendar {
                    dav::put_object(&client, &object.url, &text, object.etag.as_deref()).await?;
                } else {
                    // Moving between calendars: write it there, then take it away here.
                    let name =
                        object.url.path_segments().and_then(|mut s| s.next_back()).unwrap_or("event.ics").to_string();
                    let moved = target_url
                        .join(&name)
                        .map_err(|_| Error::internal("The event's address couldn't be built."))?;
                    dav::put_object(&client, &moved, &text, None).await?;
                    dav::delete(&client, &object.url, object.etag.as_deref()).await?;
                }
            }
        }
        self.inner.calendar_changed(None);
        Ok(())
    }

    /// Deletes one occurrence of a series (or a single event), or the whole series.
    pub async fn delete_event(&self, occurrence_id: &str, scope: EventDeleteScope) -> Result<()> {
        let (account_id, remote) = calendar::split_id(occurrence_id)?;
        match self.inner.calendar_source(account_id).await? {
            Source::Jmap => {
                let client = self.inner.jmap_client(account_id).await?;
                let target = match scope {
                    EventDeleteScope::Occurrence => remote.to_string(),
                    EventDeleteScope::Series => jmap_cal::base_of(&client, remote).await?,
                };
                jmap_cal::destroy_event(&client, &target).await?;
            }
            Source::Dav { client, home } => {
                let (path, recurrence_id) = calendar::split_occurrence(remote);
                let mut object = read_dav_event(&client, &home, path).await?;
                match (scope, recurrence_id) {
                    (EventDeleteScope::Occurrence, Some(recurrence_id)) => {
                        let event = main_event(&mut object.group)
                            .ok_or_else(|| Error::not_found("This event no longer exists."))?;
                        let mut patch = Map::new();
                        patch.insert(
                            format!("recurrenceOverrides/{}", jscal::pointer_segment(recurrence_id)),
                            json!({ "excluded": true }),
                        );
                        jscal::apply_patch(event, &patch)?;
                        touch(event);
                        let text = ical::from_jscalendar(&object.group)?;
                        dav::put_object(&client, &object.url, &text, object.etag.as_deref()).await?;
                    }
                    _ => dav::delete(&client, &object.url, object.etag.as_deref()).await?,
                }
            }
        }
        self.inner.calendar_changed(None);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_are_checked() {
        assert!(parse_range("2026-09-01T00:00:00", "2026-10-01T00:00:00", "Europe/Berlin").is_ok());
        assert!(parse_range("2026-09-01T00:00:00", "2026-08-01T00:00:00", "Europe/Berlin").is_err());
        assert!(parse_range("2026-01-01T00:00:00", "2027-06-01T00:00:00", "Europe/Berlin").is_err());
        assert!(parse_range("2026-09-01T00:00:00", "2026-10-01T00:00:00", "Nowhere/Land").is_err());
        assert!(parse_range("soon", "2026-10-01T00:00:00", "UTC").is_err());
    }

    #[test]
    fn caldav_series_move_by_as_much_as_the_edited_occurrence() {
        let weekly = "BEGIN:VCALENDAR
PRODID:-//Example//EN
VERSION:2.0
BEGIN:VEVENT
UID:yoga-1
DTSTAMP:20260901T100000Z
DTSTART;TZID=Europe/Berlin:20260903T180000
DURATION:PT1H
RRULE:FREQ=WEEKLY
SUMMARY:Yoga
END:VEVENT
END:VCALENDAR
";
        let mut group = ical::to_jscalendar(&ical::parse(weekly).unwrap()).unwrap();
        let input = EventInput {
            calendar_id: "a:/cal/".into(),
            title: "Yoga".into(),
            description: String::new(),
            location: String::new(),
            all_day: false,
            // The occurrence of 24 September, moved from 18:00 to 19:15.
            start: "2026-09-24T19:15:00".into(),
            end: "2026-09-24T20:15:00".into(),
            time_zone: Some("Europe/Berlin".into()),
            recurrence: Some(Recurrence {
                frequency: Frequency::Weekly,
                interval: 1,
                by_day: None,
                until: None,
                count: None,
            }),
        };
        let mut untouched = group.clone();
        let mut shown = input.clone();
        shown.start = "2026-09-24T18:00:00".into();
        shown.end = "2026-09-24T19:00:00".into();
        assert!(!edit_dav_group(&mut untouched, &shown, Some("2026-09-24T18:00:00")).unwrap());

        assert!(edit_dav_group(&mut group, &input, Some("2026-09-24T18:00:00")).unwrap());
        let text = ical::from_jscalendar(&group).unwrap();
        assert!(text.contains("DTSTART;TZID=Europe/Berlin:20260903T191500"), "{text}");
        assert!(text.contains("RRULE:FREQ=WEEKLY"), "{text}");
        assert!(text.contains("SEQUENCE:1"), "{text}");
    }

    #[tokio::test]
    async fn microsoft_and_google_mailboxes_have_no_calendar() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(crate::secrets::MemorySecrets::default());
        let engine = Engine::new(EngineOptions {
            data_dir: dir.path().to_path_buf(),
            secrets: secrets.clone(),
            open_url: Arc::new(|_| {}),
        })
        .unwrap();
        engine
            .inner
            .store
            .insert_account(&AccountRecord {
                id: "m".into(),
                name: "Work".into(),
                email: "alex@example-company.de".into(),
                display_name: "Alex".into(),
                color: AccountColor::Sky,
                auth: AuthKind::Microsoft,
                username: "alex@example-company.de".into(),
                imap: ServerSettings { host: "outlook.office365.com".into(), port: 993, security: Security::Tls },
                smtp: ServerSettings { host: "smtp.office365.com".into(), port: 587, security: Security::Starttls },
                protocol: Protocol::Imap,
                jmap_url: None,
            })
            .unwrap();
        secrets.set("m", &Secret::OAuth { refresh_token: "r".into() }).unwrap();

        let accounts = engine.calendar_accounts().await.unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].source, None);
        assert!(accounts[0].problem.as_deref().unwrap().contains("Microsoft"));
        // Leaving it out is not an error for the calendar as a whole.
        assert!(engine.calendars().await.unwrap().is_empty());
        assert!(engine.calendar_events("2026-09-01T00:00:00", "2026-10-01T00:00:00", "UTC").await.unwrap().is_empty());
        let refused =
            engine.create_calendar(NewCalendar { account_id: Some("m".into()), name: "X".into(), color: None }).await;
        assert_eq!(refused.unwrap_err().code, ErrorCode::NotSupported);
        // Only HTTPS addresses can be typed in.
        assert!(engine.set_caldav_url("m", Some("http://dav.example-company.de/")).await.is_err());
        assert!(engine.set_caldav_url("m", Some("https://dav.example-company.de/")).await.is_ok());
    }
}
