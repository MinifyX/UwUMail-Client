//! The UwUMail server's birthdays extension (`urn:uwumail:jmap:birthdays`, UwUMail-Server
//! `docs/birthdays.md`): birthday events of other calendars, found and matched to contacts by the
//! server, and moved into the contacts with the event deleted in the same transaction there.
//!
//! The server's ids become the app's (`account:remote`) on the way in and back on the way out;
//! whatever the server sends is checked and bounded like everything else from it.

use serde_json::{Map, Value, json};

use super::PartialDate;
use super::scan::{
    BirthdayCandidate, BirthdayChoice, BirthdayFailed, BirthdayImportEntry, BirthdayImportResult, BirthdayImported,
    BirthdayMatch, BirthdayScan, MAX_CANDIDATES, MAX_OPTIONS,
};
use crate::contacts::{app_id, split_id};
use crate::error::{Error, Result};
use crate::jmap::Client;

/// Entries one `Birthdays/import` carries; the server takes up to its `maxImport` (500).
const PER_IMPORT: usize = 200;
/// The longest id, title and name read from the server, in characters.
const MAX_ID_CHARS: usize = 255;
const MAX_TEXT_CHARS: usize = 300;

fn account(client: &Client) -> Result<&str> {
    client
        .session
        .birthdays_account_id
        .as_deref()
        .ok_or_else(|| Error::not_supported("This mail server doesn't move birthdays into contacts."))
}

fn short(value: Option<&Value>, max: usize) -> String {
    value
        .and_then(Value::as_str)
        .map(|text| text.chars().filter(|c| !c.is_control()).take(max).collect())
        .unwrap_or_default()
}

fn id(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|id| !id.is_empty() && id.chars().count() <= MAX_ID_CHARS)
}

/// `{month, day, year}` as "YYYY-MM-DD" or "--MM-DD"; none when it's no day.
fn day_of(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let number = |key: &str| value.get(key).and_then(Value::as_i64);
    let year = number("year").and_then(|year| i32::try_from(year).ok());
    let date = PartialDate::new(year, u32::try_from(number("month")?).ok()?, u32::try_from(number("day")?).ok()?)?;
    Some(date.format())
}

fn candidate_of(value: &Value, app_account: &str) -> Option<BirthdayCandidate> {
    let event = id(value.get("eventId"))?;
    let birthday = day_of(value.get("birthday"))?;
    let contacts: Vec<BirthdayChoice> = value
        .get("contacts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|contact| {
            Some(BirthdayChoice {
                contact_id: app_id(app_account, id(contact.get("contactId"))?),
                address_book_id: id(contact.get("addressBookId")).map(|book| app_id(app_account, book)),
                name: short(contact.get("name"), MAX_TEXT_CHARS),
                birthday: day_of(contact.get("birthday")),
            })
        })
        .take(MAX_OPTIONS)
        .collect();
    let state = match value.get("match").and_then(Value::as_str) {
        Some("matched") => BirthdayMatch::Matched,
        Some("known") => BirthdayMatch::Known,
        Some("conflict") => BirthdayMatch::Conflict,
        Some("ambiguous") => BirthdayMatch::Ambiguous,
        _ => BirthdayMatch::Unmatched,
    };
    // A match without its contact is none.
    let state = match state {
        BirthdayMatch::Matched | BirthdayMatch::Known | BirthdayMatch::Conflict if contacts.is_empty() => {
            BirthdayMatch::Unmatched
        }
        state => state,
    };
    Some(BirthdayCandidate {
        event_id: app_id(app_account, event),
        calendar_id: id(value.get("calendarId")).map(|calendar| app_id(app_account, calendar)).unwrap_or_default(),
        title: short(value.get("title"), MAX_TEXT_CHARS),
        name: short(value.get("name"), MAX_TEXT_CHARS),
        birthday,
        marked: value.get("marked").and_then(Value::as_bool).unwrap_or(false),
        may_delete_event: value.get("mayDeleteEvent").and_then(Value::as_bool).unwrap_or(false),
        state,
        contacts,
    })
}

/// `Birthdays/scan`'s answer, with the app's ids.
pub fn scan_from(response: &Value, app_account: &str) -> BirthdayScan {
    let listed = response.get("candidates").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let candidates: Vec<BirthdayCandidate> =
        listed.iter().filter_map(|value| candidate_of(value, app_account)).take(MAX_CANDIDATES).collect();
    let truncated =
        response.get("truncated").and_then(Value::as_bool).unwrap_or(false) || listed.len() > MAX_CANDIDATES;
    BirthdayScan { candidates, truncated }
}

/// The server's id of an app id of this account.
fn remote<'a>(app: &'a str, app_account: &str) -> Result<&'a str> {
    match split_id(app)? {
        (account, remote) if account == app_account => Ok(remote),
        _ => Err(Error::invalid("A birthday can only go into a contact of the same mailbox.")),
    }
}

/// The `entries` of `Birthdays/import`, keyed by the server's event ids.
pub fn import_entries(entries: &[BirthdayImportEntry], app_account: &str) -> Result<Map<String, Value>> {
    let mut out = Map::new();
    for entry in entries {
        let mut value = Map::new();
        match (&entry.contact_id, &entry.new_contact_name) {
            (Some(contact), None) => {
                value.insert("contactId".into(), json!(remote(contact, app_account)?));
                if entry.overwrite {
                    value.insert("overwrite".into(), json!(true));
                }
            }
            (None, Some(name)) if !name.trim().is_empty() => {
                let book = match &entry.address_book_id {
                    Some(book) => json!(remote(book, app_account)?),
                    None => Value::Null,
                };
                let name: String = name.chars().filter(|c| !c.is_control()).take(200).collect();
                let name = name.trim();
                value.insert("newContact".into(), json!({ "name": name, "addressBookId": book }));
            }
            _ => return Err(Error::invalid("Each birthday goes into one contact, or into a new one with a name.")),
        }
        if entry.delete_event == Some(false) {
            value.insert("deleteEvent".into(), json!(false));
        }
        out.insert(remote(&entry.event_id, app_account)?.to_owned(), Value::Object(value));
    }
    Ok(out)
}

/// `Birthdays/import`'s answer, with the app's ids.
pub fn import_result_from(response: &Value, app_account: &str) -> BirthdayImportResult {
    let imported = response
        .get("imported")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(event, _)| event.chars().count() <= MAX_ID_CHARS)
        .map(|(event, done)| BirthdayImported {
            event_id: app_id(app_account, event),
            contact_id: id(done.get("contactId")).map(|contact| app_id(app_account, contact)).unwrap_or_default(),
            created: done.get("created").and_then(Value::as_bool).unwrap_or(false),
            event_deleted: done.get("eventDeleted").and_then(Value::as_bool).unwrap_or(false),
        })
        .collect();
    let failed = response
        .get("notImported")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(event, _)| event.chars().count() <= MAX_ID_CHARS)
        .map(|(event, error)| {
            let description = short(error.get("description"), MAX_TEXT_CHARS);
            BirthdayFailed {
                event_id: app_id(app_account, event),
                reason: if description.is_empty() { short(error.get("type"), 64) } else { description },
            }
        })
        .collect();
    BirthdayImportResult { imported, failed }
}

/// The birthday events of the account's calendars, as the server finds them.
pub async fn scan(client: &Client, app_account: &str) -> Result<BirthdayScan> {
    let responses = client.call(vec![("Birthdays/scan", json!({ "accountId": account(client)? }))]).await?;
    Ok(scan_from(responses.get(0, "Birthdays/scan")?, app_account))
}

/// Moves found birthdays into contacts, a few hundred per call.
pub async fn import(
    client: &Client,
    app_account: &str,
    entries: &[BirthdayImportEntry],
) -> Result<BirthdayImportResult> {
    let account = account(client)?;
    let mut result = BirthdayImportResult::default();
    for part in entries.chunks(PER_IMPORT) {
        let arguments = json!({ "accountId": account, "entries": import_entries(part, app_account)? });
        let responses = client.call(vec![("Birthdays/import", arguments)]).await?;
        let done = import_result_from(responses.get(0, "Birthdays/import")?, app_account);
        result.imported.extend(done.imported);
        result.failed.extend(done.failed);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_get_the_apps_ids_and_are_checked() {
        let response = json!({ "accountId": "u1", "truncated": false, "candidates": [
            { "eventId": "v17", "calendarId": "c2", "title": "Geburtstag von Mia", "name": "Mia",
              "birthday": { "month": 4, "day": 12, "year": 1999 }, "marked": false, "mayDeleteEvent": true,
              "match": "matched", "contacts": [{ "contactId": "k12", "addressBookId": "b1", "name": "Mia Mood", "birthday": null }] },
            { "eventId": "v18", "calendarId": "c2", "title": "🎂 Oma", "name": "Oma",
              "birthday": { "month": 2, "day": 29, "year": null }, "mayDeleteEvent": false, "match": "known", "contacts": [] },
            { "eventId": "v19", "birthday": { "month": 2, "day": 30 }, "match": "matched" },
            { "birthday": { "month": 1, "day": 1 } },
            { "eventId": "v20", "title": "x\u{0}".repeat(400), "birthday": { "month": 1, "day": 1 }, "match": "surprise" }
        ] });
        let scan = scan_from(&response, "acc");
        assert_eq!(scan.candidates.len(), 3);
        let mia = &scan.candidates[0];
        assert_eq!((mia.event_id.as_str(), mia.calendar_id.as_str()), ("acc:v17", "acc:c2"));
        assert_eq!((mia.birthday.as_str(), mia.state), ("1999-04-12", BirthdayMatch::Matched));
        assert_eq!(mia.contacts[0].contact_id, "acc:k12");
        assert_eq!(mia.contacts[0].address_book_id.as_deref(), Some("acc:b1"));
        // A match without its contact is none; an unknown state is no match.
        assert_eq!(
            (scan.candidates[1].birthday.as_str(), scan.candidates[1].state),
            ("--02-29", BirthdayMatch::Unmatched)
        );
        assert_eq!(scan.candidates[2].state, BirthdayMatch::Unmatched);
        assert_eq!(scan.candidates[2].title.chars().count(), MAX_TEXT_CHARS);
        assert!(!scan.candidates[2].title.contains('\u{0}'));
    }

    #[test]
    fn import_entries_carry_the_servers_ids() {
        let entries = [
            BirthdayImportEntry {
                event_id: "acc:v17".into(),
                contact_id: Some("acc:k12".into()),
                overwrite: false,
                new_contact_name: None,
                address_book_id: None,
                delete_event: None,
            },
            BirthdayImportEntry {
                event_id: "acc:v18".into(),
                contact_id: None,
                overwrite: false,
                new_contact_name: Some(" Leni Muster ".into()),
                address_book_id: None,
                delete_event: Some(false),
            },
            BirthdayImportEntry {
                event_id: "acc:v19".into(),
                contact_id: Some("acc:k40".into()),
                overwrite: true,
                new_contact_name: None,
                address_book_id: None,
                delete_event: None,
            },
        ];
        let out = import_entries(&entries, "acc").unwrap();
        assert_eq!(
            Value::Object(out),
            json!({
                "v17": { "contactId": "k12" },
                "v18": { "newContact": { "name": "Leni Muster", "addressBookId": null }, "deleteEvent": false },
                "v19": { "contactId": "k40", "overwrite": true }
            })
        );
        // Another mailbox's contact, or neither target, is refused.
        let mut other = entries[0].clone();
        other.contact_id = Some("other:k1".into());
        assert!(import_entries(&[other], "acc").is_err());
        let mut neither = entries[0].clone();
        neither.contact_id = None;
        assert!(import_entries(&[neither], "acc").is_err());
    }

    #[test]
    fn import_results_get_the_apps_ids() {
        let result = import_result_from(
            &json!({
                "imported": { "v17": { "contactId": "k12", "created": false, "eventDeleted": true } },
                "notImported": { "v19": { "type": "birthdayExists" }, "v20": { "type": "notFound", "description": "gone" } }
            }),
            "acc",
        );
        assert_eq!(
            result.imported,
            [BirthdayImported {
                event_id: "acc:v17".into(),
                contact_id: "acc:k12".into(),
                created: false,
                event_deleted: true
            }]
        );
        let reasons: Vec<(&str, &str)> =
            result.failed.iter().map(|f| (f.event_id.as_str(), f.reason.as_str())).collect();
        assert_eq!(reasons, [("acc:v19", "birthdayExists"), ("acc:v20", "gone")]);
    }
}
