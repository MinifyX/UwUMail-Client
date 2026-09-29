//! Birthdays across all accounts (UwUMail-Server `docs/birthdays.md`, docs/architecture.md
//! "Birthdays"):
//!
//! - A UwUMail server (`urn:uwumail:jmap:birthdays`) keeps the birthdays calendar and the
//!   reminders itself; the app reads its marks and hands the import to `Birthdays/scan` and
//!   `Birthdays/import`.
//! - Every other mailbox with contacts gets a birthdays calendar made here from its cards: one
//!   virtual, read-only calendar per account, never written to any server, its events computed for
//!   the range asked for. Its colour and visibility are kept on this device. Where the mailbox also
//!   has CalDAV calendars, the app finds birthday events in them and moves them into the contacts
//!   itself, with the server's rules: the card is written first, the event deleted afterwards.

use chrono::{Datelike, Duration as Days, NaiveDateTime, Utc};
use serde_json::{Map, Value, json};

use super::*;
use crate::birthdays::scan::{
    BirthdayFailed, BirthdayFeatures, BirthdayImportEntry, BirthdayImportResult, BirthdayImported, BirthdayScan,
    KnownCard, MAX_CANDIDATES, ScannedEvent, Scanner, adds_year, birthday_in_event, known_card, same_birthday,
};
use crate::birthdays::{self, DateKind, LOCAL_CALENDAR, OccurrenceBirthday, PartialDate};
use crate::calendar::{Source as CalendarSource, dav};
use crate::contacts::{RemoteCard, Source as ContactsSource};

/// The colour of a birthdays calendar until someone picks another, as on the server.
const COLOR: &str = "#f5a623";
/// Where the birthdays calendar sits among an account's calendars: last.
const SORT_ORDER: i64 = 1_000_000;

fn this_year() -> i32 {
    Utc::now().year()
}

/// Whether an id (of a calendar, an event or an occurrence) belongs to an app-made birthdays calendar.
pub(super) fn is_local(id: &str) -> bool {
    calendar::split_id(id).is_ok_and(|(_, remote)| {
        remote.strip_prefix(LOCAL_CALENDAR).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    })
}

pub(super) fn read_only() -> Error {
    Error::invalid("The birthdays calendar comes from your contacts; change the contact instead.")
}

/// A JSContact date for a birthday.
fn date_json(date: PartialDate) -> Value {
    let mut out = json!({ "@type": "PartialDate", "month": date.month, "day": date.day });
    if let Some(year) = date.year {
        out["year"] = json!(year);
    }
    out
}

/// The anniversary key of a card's birthday, if it has one.
fn birthday_key(card: &Value) -> Option<String> {
    card.get("anniversaries")?
        .as_object()?
        .iter()
        .find(|(_, entry)| entry.get("kind").and_then(Value::as_str).is_some_and(|k| k.eq_ignore_ascii_case("birth")))
        .map(|(key, _)| key.clone())
}

/// The patch that gives a card (JSContact) this birthday; everything else of the card stays.
fn birthday_patch(card: &Value, date: PartialDate) -> Map<String, Value> {
    let mut patch = Map::new();
    let pointer = |key: &str| format!("anniversaries/{}", key.replace('~', "~0").replace('/', "~1"));
    match birthday_key(card) {
        Some(key) => {
            patch.insert(format!("{}/date", pointer(&key)), date_json(date));
            // Apple's "no year" mark would take the new year away again.
            let converted = format!("anniversaries/{key}/date");
            if card.pointer("/vCard/convertedProperties").and_then(|c| c.get(&converted)).is_some() {
                let escaped = converted.replace('~', "~0").replace('/', "~1");
                patch.insert(format!("vCard/convertedProperties/{escaped}"), Value::Null);
            }
        }
        None => {
            let entry = json!({ "@type": "Anniversary", "kind": "birth", "date": date_json(date) });
            match card.get("anniversaries").and_then(Value::as_object) {
                Some(taken) => {
                    let key = (1..).map(|n| format!("b{n}")).find(|key| !taken.contains_key(key)).unwrap_or_default();
                    patch.insert(pointer(&key), entry);
                }
                None => {
                    patch.insert("anniversaries".into(), json!({ "b1": entry }));
                }
            }
        }
    }
    patch
}

/// A new card (JSContact) with just a name and a birthday.
fn new_card(name: &str, date: PartialDate) -> Value {
    let name: String = name.chars().filter(|c| !c.is_control()).take(200).collect();
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut words: Vec<&str> = name.split_whitespace().collect();
    let surname = if words.len() > 1 { words.pop().unwrap_or_default() } else { "" };
    let mut components = vec![json!({ "kind": "given", "value": words.join(" ") })];
    if !surname.is_empty() {
        components.push(json!({ "kind": "surname", "value": surname }));
    }
    json!({
        "@type": "Card",
        "version": "1.0",
        "kind": "individual",
        "name": { "full": name, "components": components },
        "anniversaries": { "b1": { "@type": "Anniversary", "kind": "birth", "date": date_json(date) } },
    })
}

impl Inner {
    /// Whether the account's mail server keeps birthdays itself (a UwUMail server).
    async fn server_birthdays(&self, account_id: &str) -> bool {
        match self.store.account(account_id) {
            Ok(account) if account.protocol == Protocol::Jmap => {
                self.jmap_client(account_id).await.is_ok_and(|client| client.session.birthdays_account_id.is_some())
            }
            _ => false,
        }
    }

    /// The cards the app makes a birthdays calendar of: those of a mailbox whose server doesn't
    /// keep one. With `look`, the address book server is searched for when that isn't known yet.
    async fn birthday_cards(&self, account_id: &str, look: bool) -> Option<Vec<RemoteCard>> {
        let known = if look {
            Some(self.contacts_source(account_id).await)
        } else {
            self.contacts_source_known(account_id).await
        };
        let source = known?.ok()?;
        if matches!(source, ContactsSource::Jmap) && self.server_birthdays(account_id).await {
            return None;
        }
        self.remote_cards(account_id).await.ok()
    }

    /// The app's birthdays calendar of an account, when its contacts have dates.
    pub(super) async fn local_birthdays_calendar(&self, account_id: &str, look: bool) -> Option<CalendarInfo> {
        let cards = self.birthday_cards(account_id, look).await?;
        if !cards.iter().any(|card| !birthdays::card_dates(&Value::Object(card.card.clone())).is_empty()) {
            return None;
        }
        let id = calendar::app_id(account_id, LOCAL_CALENDAR);
        let prefs = self.store.calendar_prefs(account_id).ok().and_then(|prefs| prefs.get(&id).copied());
        Some(CalendarInfo {
            account_id: account_id.to_string(),
            name: "Birthdays".into(),
            color: self.store.calendar_color(&id).ok().flatten().or_else(|| Some(COLOR.into())),
            is_default: false,
            is_visible: !prefs.is_some_and(|prefs| prefs.hidden),
            sort_order: SORT_ORDER,
            may_write: false,
            may_delete: false,
            is_birthdays: true,
            is_local: true,
            id,
        })
    }

    /// The occurrences of the app's birthdays calendar in `[from, to)`, from the cards known now.
    pub(super) async fn local_birthday_occurrences(
        &self,
        account_id: &str,
        from: NaiveDateTime,
        to: NaiveDateTime,
    ) -> Vec<CalendarOccurrence> {
        let Some(cards) = self.birthday_cards(account_id, false).await else { return Vec::new() };
        let calendar_id = calendar::app_id(account_id, LOCAL_CALENDAR);
        // All-day: every day the range touches.
        let (first, last) = (from.date(), to.date() + Days::days(1));
        let mut found = Vec::new();
        for card in &cards {
            let value = Value::Object(card.card.clone());
            let dates = birthdays::card_dates(&value);
            if dates.is_empty() {
                continue;
            }
            let name = birthdays::card_name(&value);
            if name.is_empty() {
                continue;
            }
            let contact_id = contacts::app_id(account_id, &card.remote);
            for occurrence in birthdays::occurrences(&dates, first, last) {
                let date = &dates[occurrence.index];
                let key = if date.kind == DateKind::Birth { "b".to_string() } else { format!("a{}", occurrence.index) };
                let event_id = calendar::app_id(account_id, &format!("{LOCAL_CALENDAR}/{}/{key}", card.remote));
                let start = occurrence.day.and_hms_opt(0, 0, 0).unwrap_or_default();
                let birthday = OccurrenceBirthday {
                    contact_id: contact_id.clone(),
                    kind: date.kind,
                    label: date.label.clone(),
                    name: name.clone(),
                    year: date.date.year,
                    age: occurrence.years.filter(|years| *years > 0),
                };
                let start_text = calendar::jscal::format_local(start);
                found.push(CalendarOccurrence {
                    id: format!("{event_id}#{start_text}"),
                    event_id,
                    account_id: account_id.to_string(),
                    calendar_id: calendar_id.clone(),
                    // The UI shows it in its own language (lib/birthdays.ts).
                    title: birthdays::title(&birthday, false),
                    description: String::new(),
                    location: String::new(),
                    all_day: true,
                    start: start_text.clone(),
                    end: calendar::jscal::format_local(start + Days::days(1)),
                    time_zone: None,
                    recurrence: Some(Recurrence {
                        frequency: Frequency::Yearly,
                        interval: 1,
                        by_day: None,
                        until: None,
                        count: None,
                    }),
                    recurrence_editable: false,
                    recurrence_id: Some(start_text),
                    read_only: true,
                    color: None,
                    birthday: Some(birthday),
                });
            }
        }
        found
    }

    /// The contacts a found birthday may go into: the cards of the account's writable address books.
    async fn writable_cards(&self, account_id: &str) -> Result<Vec<KnownCard>> {
        let books = self.address_book_entries(account_id).await?;
        let cards = self.remote_cards(account_id).await?;
        Ok(cards
            .iter()
            .filter_map(|card| {
                let book = books.iter().find(|book| book.remote == card.book_remote && book.info.may_write)?;
                known_card(
                    &contacts::app_id(account_id, &card.remote),
                    &book.info.id,
                    &Value::Object(card.card.clone()),
                )
            })
            .collect())
    }

    /// Birthday events of the account's CalDAV calendars, matched to its contacts.
    async fn scan_dav_birthdays(&self, account_id: &str) -> Result<BirthdayScan> {
        let CalendarSource::Dav { client, home } = self.calendar_source(account_id).await? else {
            return Err(Error::not_supported("This mailbox has no calendars to look for birthdays in."));
        };
        let cards = self.writable_cards(account_id).await?;
        let entries = self.calendar_entries(account_id).await?;
        let mut scanner = Scanner::new(&cards, this_year());
        // One calendar after the other, so only one listing is in memory at a time.
        for entry in &entries {
            if scanner.full() {
                break;
            }
            let url = calendar::dav_url(&home, &entry.remote)?;
            let objects = match dav::all_objects(&client, &url).await {
                Ok(objects) => objects,
                Err(error) => {
                    tracing::warn!("A calendar of {account_id} couldn't be read for birthdays: {error}");
                    continue;
                }
            };
            for object in objects {
                scanner.add(&ScannedEvent {
                    event_id: calendar::app_id(account_id, object.url.path()),
                    calendar_id: entry.info.id.clone(),
                    content: object.data,
                    deletable: entry.info.may_write,
                });
            }
        }
        Ok(scanner.finish())
    }

    /// Moves one found birthday into a contact of a mailbox whose server can't: reads the event
    /// again, writes the card, then deletes the event. Returns the contact, whether it's new, and
    /// whether the event went.
    async fn import_dav_birthday(
        &self,
        engine: &Engine,
        account_id: &str,
        entry: &BirthdayImportEntry,
        dav_client: &dav::DavClient,
        home: &url::Url,
        calendars: &[calendar::CalendarEntry],
    ) -> std::result::Result<BirthdayImported, String> {
        let (event_account, path) = calendar::split_id(&entry.event_id).map_err(|_| "notFound".to_string())?;
        if event_account != account_id || is_local(&entry.event_id) {
            return Err("notFound".into());
        }
        let owner = calendars
            .iter()
            .filter(|calendar| path.starts_with(&calendar.remote))
            .max_by_key(|calendar| calendar.remote.len())
            .ok_or_else(|| "notFound".to_string())?;
        let url = calendar::dav_url(home, path).map_err(|error| error.message)?;
        let object = dav::get_object(dav_client, &url).await.map_err(|error| error.message)?;
        let found = birthday_in_event(&object.data, this_year()).ok_or_else(|| "notABirthday".to_string())?;
        let (contact_id, created) = match (&entry.contact_id, &entry.new_contact_name) {
            (Some(contact_id), None) => {
                let (contact_account, _) = contacts::split_id(contact_id).map_err(|error| error.message)?;
                if contact_account != account_id {
                    return Err("notFound".into());
                }
                let card = engine.contact_card(contact_id).await.map_err(|error| error.message)?;
                let known = birthdays::card_dates(&card).into_iter().find(|date| date.kind == DateKind::Birth);
                let write = match known {
                    None => true,
                    Some(known) if same_birthday(&known.date, &found.date) => false,
                    Some(known) if adds_year(&known.date, &found.date) => true,
                    Some(_) if entry.overwrite => true,
                    Some(_) => return Err("birthdayExists".into()),
                };
                if write {
                    engine
                        .update_contact_card(contact_id, birthday_patch(&card, found.date))
                        .await
                        .map_err(|error| error.message)?;
                }
                (contact_id.clone(), false)
            }
            (None, Some(name)) if !name.trim().is_empty() => {
                let book = match &entry.address_book_id {
                    Some(book) => book.clone(),
                    None => {
                        let books = self.address_book_entries(account_id).await.map_err(|error| error.message)?;
                        books
                            .iter()
                            .find(|book| book.info.is_default && book.info.may_write)
                            .or_else(|| books.iter().find(|book| book.info.may_write))
                            .map(|book| book.info.id.clone())
                            .ok_or_else(|| "No address book of this mailbox takes contacts.".to_string())?
                    }
                };
                let id = engine
                    .create_contact_card(&book, new_card(name, found.date))
                    .await
                    .map_err(|error| error.message)?;
                (id, true)
            }
            _ => return Err("invalidProperties".into()),
        };
        // The birthday is in the contact now; only then does the event go.
        let event_deleted = entry.delete_event != Some(false)
            && owner.info.may_write
            && match dav::delete(dav_client, &url, object.etag.as_deref()).await {
                Ok(()) => true,
                Err(error) => {
                    tracing::warn!("A birthday event of {account_id} stayed after its import: {error}");
                    false
                }
            };
        Ok(BirthdayImported { event_id: entry.event_id.clone(), contact_id, created, event_deleted })
    }
}

impl Engine {
    /// For each account: whether its server keeps birthdays (calendar and reminders), and whether
    /// birthday events of its calendars can be moved into its contacts. Never starts a search for
    /// a CalDAV or CardDAV server.
    pub async fn birthday_features(&self) -> Result<Vec<BirthdayFeatures>> {
        let accounts = self.inner.store.accounts()?;
        let checks = accounts.iter().map(|account| async move {
            let server = self.inner.server_birthdays(&account.id).await;
            let import = server || {
                let calendars = self.inner.calendar_source_known(&account.id).await;
                let contacts = self.inner.contacts_source_known(&account.id).await;
                matches!(calendars, Some(Ok(CalendarSource::Dav { .. }))) && matches!(contacts, Some(Ok(_)))
            };
            BirthdayFeatures { account_id: account.id.clone(), server, import }
        });
        Ok(futures::future::join_all(checks).await)
    }

    /// The birthday events of an account's calendars, each with the contacts it may belong to.
    pub async fn scan_birthdays(&self, account_id: &str) -> Result<BirthdayScan> {
        self.inner.store.account(account_id)?;
        if self.inner.server_birthdays(account_id).await {
            let client = self.inner.jmap_client(account_id).await?;
            return birthdays::jmap::scan(&client, account_id).await;
        }
        self.inner.scan_dav_birthdays(account_id).await
    }

    /// Moves found birthdays into contacts; an event is deleted only once its birthday is in the
    /// contact. Events left out stay as they are.
    pub async fn import_birthdays(
        &self,
        account_id: &str,
        entries: Vec<BirthdayImportEntry>,
    ) -> Result<BirthdayImportResult> {
        self.inner.store.account(account_id)?;
        if entries.len() > MAX_CANDIDATES {
            return Err(Error::invalid(format!("At most {MAX_CANDIDATES} birthdays at once.")));
        }
        let result = if self.inner.server_birthdays(account_id).await {
            let client = self.inner.jmap_client(account_id).await?;
            birthdays::jmap::import(&client, account_id, &entries).await?
        } else {
            let CalendarSource::Dav { client, home } = self.inner.calendar_source(account_id).await? else {
                return Err(Error::not_supported("This mailbox has no calendars to take birthdays from."));
            };
            let calendars = self.inner.calendar_entries(account_id).await?;
            let mut result = BirthdayImportResult::default();
            for entry in &entries {
                match self.inner.import_dav_birthday(self, account_id, entry, &client, &home, &calendars).await {
                    Ok(done) => result.imported.push(done),
                    Err(reason) => result.failed.push(BirthdayFailed { event_id: entry.event_id.clone(), reason }),
                }
            }
            result
        };
        if !result.imported.is_empty() {
            self.inner.forget_contacts(account_id);
            self.inner.calendar_changed(Some(account_id));
            self.inner.emit(EngineEvent::ContactsChanged {});
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_ids_are_known_and_nothing_else() {
        assert!(is_local("a:uwu-birthdays"));
        assert!(is_local("a:uwu-birthdays//dav/ab/x.vcf/b#2026-04-12T00:00:00"));
        assert!(!is_local("a:/dav/cal/uwu-birthdays/x.ics"));
        assert!(!is_local("a:E1"));
        assert!(!is_local("nothing"));
    }

    #[test]
    fn birthdays_go_into_the_card_and_the_rest_stays() {
        let date = PartialDate { year: Some(1999), month: 4, day: 12 };
        // A card without dates gets the whole map.
        let patch = birthday_patch(&json!({ "name": { "full": "Mia" } }), date);
        assert_eq!(
            Value::Object(patch),
            json!({ "anniversaries": { "b1": { "@type": "Anniversary", "kind": "birth",
                "date": { "@type": "PartialDate", "year": 1999, "month": 4, "day": 12 } } } })
        );
        // Beside a wedding anniversary, under a free key.
        let card = json!({ "anniversaries": { "b1": { "kind": "wedding", "date": { "month": 6, "day": 1 } } } });
        let patch = birthday_patch(&card, date);
        assert!(patch.contains_key("anniversaries/b2"), "{patch:?}");
        // A birthday without a year gets the year; Apple's "no year" mark goes.
        let apple = json!({
            "anniversaries": { "k1": { "kind": "birth", "date": { "year": 1604, "month": 4, "day": 12 } } },
            "vCard": { "convertedProperties": { "anniversaries/k1/date": { "parameters": { "x-apple-omit-year": "1604" } } } }
        });
        let mut card = apple.clone();
        crate::calendar::jscal::apply_patch(&mut card, &birthday_patch(&apple, date)).unwrap();
        assert_eq!(birthdays::card_dates(&card)[0].date, date);
        assert!(card["vCard"]["convertedProperties"].get("anniversaries/k1/date").is_none(), "{card}");
    }

    #[test]
    fn new_contacts_have_a_name_and_the_birthday() {
        let card = new_card(" Oma  Hilde Muster ", PartialDate { year: None, month: 2, day: 29 });
        assert_eq!(card["name"]["full"], "Oma Hilde Muster");
        assert_eq!(birthdays::name_part(&card, "given"), "Oma Hilde");
        assert_eq!(birthdays::name_part(&card, "surname"), "Muster");
        assert_eq!(birthdays::card_dates(&card)[0].date.format(), "--02-29");
        let single = new_card("Leni", PartialDate { year: Some(2001), month: 1, day: 1 });
        assert_eq!(birthdays::name_part(&single, "given"), "Leni");
        assert!(crate::contacts::vcard::to_vcard(single.as_object().unwrap()).unwrap().contains("BDAY"));
    }
}
