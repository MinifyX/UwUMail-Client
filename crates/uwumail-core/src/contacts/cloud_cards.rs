//! Contacts of Microsoft Graph and Google People as JSContact cards (the shape the app works
//! with), and back. Only what the app shows and edits is mapped: names, emails, phones, postal
//! addresses, company, job title, note, birthday (and Google's wedding anniversary). Writing
//! back changes only those fields at the provider; everything else of a contact stays there.

use serde_json::{Map, Value, json};

/// The address book of contacts without a folder (Graph's default contacts folder, Google's
/// contacts).
pub const DEFAULT_BOOK: &str = "contacts";
/// The fields of a person Google is asked for and written to.
pub const GOOGLE_FIELDS: &str =
    "names,nicknames,emailAddresses,phoneNumbers,addresses,organizations,biographies,birthdays,events,metadata";
pub const GOOGLE_UPDATE_FIELDS: &str =
    "names,nicknames,emailAddresses,phoneNumbers,addresses,organizations,biographies,birthdays,events";
/// Graph keeps at most this many email addresses per contact.
const GRAPH_EMAILS: usize = 3;

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty())
}

fn strings<'a>(value: &'a Value, key: &str) -> impl Iterator<Item = &'a str> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| !s.trim().is_empty())
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Home,
    Work,
    Other,
    Mobile,
}

fn contexts(kind: Kind) -> Option<Value> {
    match kind {
        Kind::Home => Some(json!({ "private": true })),
        Kind::Work => Some(json!({ "work": true })),
        Kind::Other | Kind::Mobile => None,
    }
}

fn kind_of(entry: &Value) -> Kind {
    if entry.get("features").and_then(|f| f.get("mobile")).and_then(Value::as_bool) == Some(true) {
        return Kind::Mobile;
    }
    let contexts = entry.get("contexts");
    let on = |key: &str| contexts.and_then(|c| c.get(key)).and_then(Value::as_bool) == Some(true);
    if on("work") {
        Kind::Work
    } else if on("private") {
        Kind::Home
    } else {
        Kind::Other
    }
}

/// A JSContact entry map (`emails`, `phones`, ...) in key order.
fn entries<'a>(card: &'a Map<String, Value>, key: &str) -> Vec<&'a Value> {
    card.get(key).and_then(Value::as_object).map(|map| map.values().collect()).unwrap_or_default()
}

fn email(address: &str, kind: Kind) -> Value {
    let mut entry = json!({ "@type": "EmailAddress", "address": address });
    if let Some(contexts) = contexts(kind) {
        entry["contexts"] = contexts;
    }
    entry
}

fn phone(number: &str, kind: Kind) -> Value {
    let mut entry = json!({ "@type": "Phone", "number": number });
    match kind {
        Kind::Mobile => entry["features"] = json!({ "mobile": true }),
        _ => {
            if let Some(contexts) = contexts(kind) {
                entry["contexts"] = contexts;
            }
        }
    }
    entry
}

/// A postal address as JSContact components; `None` when every part is empty.
fn address(
    street: Option<&str>,
    locality: Option<&str>,
    region: Option<&str>,
    postcode: Option<&str>,
    country: Option<&str>,
    kind: Kind,
) -> Option<Value> {
    let parts: Vec<Value> =
        [("name", street), ("locality", locality), ("region", region), ("postcode", postcode), ("country", country)]
            .into_iter()
            .filter_map(|(kind, value)| Some(json!({ "kind": kind, "value": value? })))
            .collect();
    if parts.is_empty() {
        return None;
    }
    let mut entry = json!({ "@type": "Address", "components": parts });
    if let Some(contexts) = contexts(kind) {
        entry["contexts"] = contexts;
    }
    Some(entry)
}

/// The parts of a JSContact address: street, locality, region, postcode, country.
struct Postal {
    street: String,
    locality: String,
    region: String,
    postcode: String,
    country: String,
}

fn postal(entry: &Value) -> Postal {
    let parts: Vec<(&str, &str)> = entry
        .get("components")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| Some((part.get("kind")?.as_str()?, part.get("value")?.as_str()?)))
        .filter(|(kind, _)| *kind != "separator")
        .collect();
    let of = |wanted: &[&str]| -> String {
        parts
            .iter()
            .filter(|(kind, _)| wanted.contains(kind))
            .map(|(_, value)| value.trim())
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut street = of(&[
        "name",
        "number",
        "block",
        "building",
        "floor",
        "apartment",
        "room",
        "extension",
        "direction",
        "subdistrict",
        "district",
        "postOfficeBox",
    ]);
    if parts.is_empty() {
        street = text(entry, "full").unwrap_or_default().to_string();
    }
    Postal {
        street,
        locality: of(&["locality"]),
        region: of(&["region"]),
        postcode: of(&["postcode"]),
        country: of(&["country"]),
    }
}

/// Given name, surname and the full name of a card.
fn names(card: &Map<String, Value>) -> (String, String, String, String) {
    let name = card.get("name").cloned().unwrap_or(Value::Null);
    let of = |wanted: &str| -> String {
        name.get("components")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|part| part.get("kind").and_then(Value::as_str) == Some(wanted))
            .filter_map(|part| part.get("value").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" ")
    };
    (of("given"), of("given2"), of("surname"), text(&name, "full").unwrap_or_default().to_string())
}

fn name_value(given: &str, middle: &str, surname: &str, full: &str) -> Option<Value> {
    let mut components = Vec::new();
    for (kind, value) in [("given", given), ("given2", middle), ("surname", surname)] {
        if !value.trim().is_empty() {
            components.push(json!({ "kind": kind, "value": value.trim() }));
        }
    }
    let full = if full.trim().is_empty() {
        [given, middle, surname].iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
    } else {
        full.trim().to_string()
    };
    if full.is_empty() && components.is_empty() {
        return None;
    }
    let mut name = json!({ "full": full });
    if !components.is_empty() {
        name["components"] = json!(components);
    }
    Some(name)
}

/// The first value of a single-entry map (`organizations`, `titles`, `notes`, `nicknames`).
fn single<'a>(card: &'a Map<String, Value>, key: &str, field: &str) -> Option<&'a str> {
    card.get(key)?.as_object()?.values().find_map(|entry| text(entry, field))
}

/// (year, month, day) of the card's date of a kind; year `None` when it isn't known.
fn card_date(card: &Map<String, Value>, kind: &str) -> Option<(Option<i64>, i64, i64)> {
    for entry in card.get("anniversaries")?.as_object()?.values() {
        if entry.get("kind").and_then(Value::as_str) != Some(kind) {
            continue;
        }
        let date = entry.get("date")?;
        if let Some(utc) = text(date, "utc") {
            let (y, rest) = utc.split_once('-')?;
            let (m, rest) = rest.split_once('-')?;
            return Some((y.parse().ok(), m.parse().ok()?, rest.get(..2)?.parse().ok()?));
        }
        let year = date.get("year").and_then(Value::as_i64).filter(|y| *y != 0 && *y != 1604);
        return Some((year, date.get("month")?.as_i64()?, date.get("day")?.as_i64()?));
    }
    None
}

fn partial_date(year: Option<i64>, month: i64, day: i64) -> Value {
    let mut date = json!({ "@type": "PartialDate", "month": month, "day": day });
    if let Some(year) = year {
        date["year"] = json!(year);
    }
    date
}

fn new_card() -> Map<String, Value> {
    let mut card = Map::new();
    card.insert("@type".into(), json!("Card"));
    card.insert("version".into(), json!("1.0"));
    card.insert("kind".into(), json!("individual"));
    card
}

fn put_map(card: &mut Map<String, Value>, key: &str, entries: Vec<(String, Value)>) {
    if !entries.is_empty() {
        card.insert(key.into(), Value::Object(entries.into_iter().collect()));
    }
}

// ------------------------------------------------------------------------------------------------
// Microsoft Graph

/// A Graph contact as a card, with its id and folder.
pub fn graph_card(value: &Value) -> Option<(String, Option<String>, Map<String, Value>)> {
    let id = text(value, "id")?.to_string();
    let mut card = new_card();
    card.insert("uid".into(), json!(format!("urn:uwumail:graph:{id}")));
    let given = text(value, "givenName").unwrap_or_default();
    let middle = text(value, "middleName").unwrap_or_default();
    let surname = text(value, "surname").unwrap_or_default();
    if let Some(name) = name_value(given, middle, surname, text(value, "displayName").unwrap_or_default()) {
        card.insert("name".into(), name);
    }
    if let Some(nick) = text(value, "nickName") {
        card.insert("nicknames".into(), json!({ "k": { "@type": "Nickname", "name": nick } }));
    }
    let emails = value
        .get("emailAddresses")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|e| text(e, "address"))
        .enumerate()
        .map(|(i, address)| (format!("e{}", i + 1), email(address, Kind::Other)))
        .collect();
    put_map(&mut card, "emails", emails);
    let mut phones = Vec::new();
    for (key, kind) in [("businessPhones", Kind::Work), ("homePhones", Kind::Home)] {
        for number in strings(value, key) {
            phones.push((format!("p{}", phones.len() + 1), phone(number.trim(), kind)));
        }
    }
    if let Some(mobile) = text(value, "mobilePhone") {
        phones.push((format!("p{}", phones.len() + 1), phone(mobile, Kind::Mobile)));
    }
    put_map(&mut card, "phones", phones);
    let mut addresses = Vec::new();
    for (key, kind) in [("homeAddress", Kind::Home), ("businessAddress", Kind::Work), ("otherAddress", Kind::Other)] {
        let Some(place) = value.get(key) else { continue };
        if let Some(entry) = address(
            text(place, "street"),
            text(place, "city"),
            text(place, "state"),
            text(place, "postalCode"),
            text(place, "countryOrRegion"),
            kind,
        ) {
            addresses.push((format!("a{}", addresses.len() + 1), entry));
        }
    }
    put_map(&mut card, "addresses", addresses);
    if let Some(company) = text(value, "companyName") {
        card.insert("organizations".into(), json!({ "o": { "@type": "Organization", "name": company } }));
    }
    if let Some(job) = text(value, "jobTitle") {
        card.insert("titles".into(), json!({ "t": { "@type": "Title", "name": job } }));
    }
    if let Some(note) = text(value, "personalNotes") {
        card.insert("notes".into(), json!({ "n": { "@type": "Note", "note": note } }));
    }
    // "1990-05-01T11:59:00Z"; Outlook writes year 1604 for "no year".
    if let Some(birthday) = text(value, "birthday") {
        let date = birthday.get(..10).unwrap_or_default();
        let mut parts = date.split('-').map(|p| p.parse::<i64>().ok());
        if let (Some(Some(year)), Some(Some(month)), Some(Some(day))) = (parts.next(), parts.next(), parts.next()) {
            let year = (year != 1604 && year > 0).then_some(year);
            card.insert(
                "anniversaries".into(),
                json!({ "b1": { "@type": "Anniversary", "kind": "birth", "date": partial_date(year, month, day) } }),
            );
        }
    }
    let folder = text(value, "parentFolderId").map(String::from);
    Some((id, folder, card))
}

/// The Graph fields of a card. Every mapped field is there, empty ones too, so a change can clear it.
pub fn card_to_graph(card: &Map<String, Value>) -> Value {
    let (given, middle, surname, full) = names(card);
    let emails: Vec<&str> = entries(card, "emails").into_iter().filter_map(|e| text(e, "address")).collect();
    let display = if !full.trim().is_empty() {
        full.trim().to_string()
    } else {
        let joined =
            [given.as_str(), surname.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" ");
        if joined.is_empty() {
            single(card, "organizations", "name").or(emails.first().copied()).unwrap_or_default().to_string()
        } else {
            joined
        }
    };
    let mut business = Vec::new();
    let mut home = Vec::new();
    let mut mobile: Option<&str> = None;
    for entry in entries(card, "phones") {
        let Some(number) = text(entry, "number") else { continue };
        match kind_of(entry) {
            Kind::Mobile if mobile.is_none() => mobile = Some(number),
            Kind::Work => business.push(number),
            _ => home.push(number),
        }
    }
    let mut places: [Option<Value>; 3] = [None, None, None];
    for entry in entries(card, "addresses") {
        let slot = match kind_of(entry) {
            Kind::Home => 0,
            Kind::Work => 1,
            _ => 2,
        };
        if places[slot].is_some() {
            continue;
        }
        let p = postal(entry);
        places[slot] = Some(json!({
            "street": p.street, "city": p.locality, "state": p.region, "postalCode": p.postcode, "countryOrRegion": p.country
        }));
    }
    let [home_address, business_address, other_address] = places;
    let birthday = card_date(card, "birth")
        .map(|(year, month, day)| format!("{:04}-{month:02}-{day:02}T11:59:00Z", year.unwrap_or(1604)));
    json!({
        "givenName": given,
        "middleName": middle,
        "surname": surname,
        "displayName": display,
        "nickName": single(card, "nicknames", "name").unwrap_or_default(),
        "emailAddresses": emails.iter().take(GRAPH_EMAILS).map(|address| json!({ "address": address, "name": address })).collect::<Vec<_>>(),
        "businessPhones": business,
        "homePhones": home,
        "mobilePhone": mobile.unwrap_or_default(),
        "homeAddress": home_address.unwrap_or_else(|| json!({})),
        "businessAddress": business_address.unwrap_or_else(|| json!({})),
        "otherAddress": other_address.unwrap_or_else(|| json!({})),
        "companyName": single(card, "organizations", "name").unwrap_or_default(),
        "jobTitle": single(card, "titles", "name").unwrap_or_default(),
        "personalNotes": single(card, "notes", "note").unwrap_or_default(),
        "birthday": birthday,
    })
}

// ------------------------------------------------------------------------------------------------
// Google People

/// A Google person as a card, with its resource name and etag.
pub fn google_card(person: &Value) -> Option<(String, Option<String>, Map<String, Value>)> {
    let resource = text(person, "resourceName")?.to_string();
    let list = |key: &str| person.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    let mut card = new_card();
    card.insert("uid".into(), json!(format!("urn:uwumail:google:{resource}")));
    if let Some(name) = list("names").first() {
        let full = text(name, "unstructuredName").or_else(|| text(name, "displayName")).unwrap_or_default();
        if let Some(name) = name_value(
            text(name, "givenName").unwrap_or_default(),
            text(name, "middleName").unwrap_or_default(),
            text(name, "familyName").unwrap_or_default(),
            full,
        ) {
            card.insert("name".into(), name);
        }
    }
    if let Some(nick) = list("nicknames").first().and_then(|n| text(n, "value")) {
        card.insert("nicknames".into(), json!({ "k": { "@type": "Nickname", "name": nick } }));
    }
    let google_kind = |entry: &Value| match text(entry, "type").map(str::to_ascii_lowercase).as_deref() {
        Some("home") => Kind::Home,
        Some("work") => Kind::Work,
        Some("mobile") => Kind::Mobile,
        _ => Kind::Other,
    };
    let emails = list("emailAddresses")
        .iter()
        .filter_map(|entry| Some((text(entry, "value")?, google_kind(entry))))
        .enumerate()
        .map(|(i, (address, kind))| {
            (format!("e{}", i + 1), email(address, if kind == Kind::Mobile { Kind::Other } else { kind }))
        })
        .collect();
    put_map(&mut card, "emails", emails);
    let phones = list("phoneNumbers")
        .iter()
        .filter_map(|entry| Some((text(entry, "value")?, google_kind(entry))))
        .enumerate()
        .map(|(i, (number, kind))| (format!("p{}", i + 1), phone(number, kind)))
        .collect();
    put_map(&mut card, "phones", phones);
    let addresses = list("addresses")
        .iter()
        .filter_map(|entry| {
            let kind = google_kind(entry);
            let street = text(entry, "streetAddress");
            let parsed = address(
                street,
                text(entry, "city"),
                text(entry, "region"),
                text(entry, "postalCode"),
                text(entry, "country"),
                kind,
            );
            parsed.or_else(|| {
                let full = text(entry, "formattedValue")?;
                let mut entry = json!({ "@type": "Address", "full": full });
                if let Some(contexts) = contexts(kind) {
                    entry["contexts"] = contexts;
                }
                Some(entry)
            })
        })
        .enumerate()
        .map(|(i, entry)| (format!("a{}", i + 1), entry))
        .collect();
    put_map(&mut card, "addresses", addresses);
    if let Some(org) = list("organizations").first() {
        if let Some(company) = text(org, "name") {
            card.insert("organizations".into(), json!({ "o": { "@type": "Organization", "name": company } }));
        }
        if let Some(title) = text(org, "title") {
            card.insert("titles".into(), json!({ "t": { "@type": "Title", "name": title } }));
        }
    }
    if let Some(note) = list("biographies").first().and_then(|b| text(b, "value")) {
        card.insert("notes".into(), json!({ "n": { "@type": "Note", "note": note } }));
    }
    let mut anniversaries = Map::new();
    let date_of = |entry: &Value| -> Option<Value> {
        let date = entry.get("date")?;
        let year = date.get("year").and_then(Value::as_i64).filter(|y| *y > 0);
        Some(partial_date(year, date.get("month")?.as_i64()?, date.get("day")?.as_i64()?))
    };
    if let Some(date) = list("birthdays").iter().find_map(date_of) {
        anniversaries.insert("b1".into(), json!({ "@type": "Anniversary", "kind": "birth", "date": date }));
    }
    if let Some(date) = list("events")
        .iter()
        .filter(|e| text(e, "type").is_some_and(|t| t.eq_ignore_ascii_case("anniversary")))
        .find_map(date_of)
    {
        anniversaries.insert("w1".into(), json!({ "@type": "Anniversary", "kind": "wedding", "date": date }));
    }
    if !anniversaries.is_empty() {
        card.insert("anniversaries".into(), Value::Object(anniversaries));
    }
    Some((resource, text(person, "etag").map(String::from), card))
}

/// The Google person fields of a card (those in [`GOOGLE_UPDATE_FIELDS`]).
pub fn card_to_google(card: &Map<String, Value>) -> Value {
    let (given, middle, surname, full) = names(card);
    let google_type = |entry: &Value| match kind_of(entry) {
        Kind::Home => "home",
        Kind::Work => "work",
        Kind::Mobile => "mobile",
        Kind::Other => "other",
    };
    let names = if given.is_empty() && surname.is_empty() && middle.is_empty() && full.is_empty() {
        Vec::new()
    } else if given.is_empty() && surname.is_empty() && middle.is_empty() {
        vec![json!({ "unstructuredName": full })]
    } else {
        vec![json!({ "givenName": given, "middleName": middle, "familyName": surname })]
    };
    let date = |(year, month, day): (Option<i64>, i64, i64)| {
        let mut date = json!({ "month": month, "day": day });
        if let Some(year) = year {
            date["year"] = json!(year);
        }
        date
    };
    let mut organization = Map::new();
    if let Some(company) = single(card, "organizations", "name") {
        organization.insert("name".into(), json!(company));
    }
    if let Some(title) = single(card, "titles", "name") {
        organization.insert("title".into(), json!(title));
    }
    json!({
        "names": names,
        "nicknames": single(card, "nicknames", "name").map(|n| vec![json!({ "value": n })]).unwrap_or_default(),
        "emailAddresses": entries(card, "emails").into_iter().filter_map(|e| {
            let kind = match google_type(e) { "mobile" => "other", other => other };
            Some(json!({ "value": text(e, "address")?, "type": kind }))
        }).collect::<Vec<_>>(),
        "phoneNumbers": entries(card, "phones").into_iter().filter_map(|e| Some(json!({ "value": text(e, "number")?, "type": google_type(e) }))).collect::<Vec<_>>(),
        "addresses": entries(card, "addresses").into_iter().map(|e| {
            let p = postal(e);
            json!({ "streetAddress": p.street, "city": p.locality, "region": p.region, "postalCode": p.postcode, "country": p.country, "type": google_type(e) })
        }).collect::<Vec<_>>(),
        "organizations": if organization.is_empty() { Vec::new() } else { vec![Value::Object(organization)] },
        "biographies": single(card, "notes", "note").map(|n| vec![json!({ "value": n, "contentType": "TEXT_PLAIN" })]).unwrap_or_default(),
        "birthdays": card_date(card, "birth").map(|d| vec![json!({ "date": date(d) })]).unwrap_or_default(),
        "events": card_date(card, "wedding").map(|d| vec![json!({ "date": date(d), "type": "anniversary" })]).unwrap_or_default(),
    })
}

// ------------------------------------------------------------------------------------------------
// Changes: only what was changed goes back, and what the app doesn't map stays as it was.

/// A provider's entry without what it adds by itself (`metadata`, formatted values).
fn plain_entry(entry: &Value) -> Value {
    let mut entry = entry.clone();
    if let Some(map) = entry.as_object_mut() {
        for key in ["metadata", "formattedType", "formattedValue", "displayNameLastFirst"] {
            map.remove(key);
        }
    }
    entry
}

fn list_of<'a>(raw: &'a Value, key: &str) -> Vec<&'a Value> {
    raw.get(key).and_then(Value::as_array).map(|list| list.iter().collect()).unwrap_or_default()
}

fn same_text(a: Option<&str>, b: Option<&str>) -> bool {
    a.map(str::trim).unwrap_or_default().eq_ignore_ascii_case(b.map(str::trim).unwrap_or_default())
}

/// The Graph fields of a contact that differ between `before` (as read) and `after`. Email
/// addresses that stay keep the name Outlook shows for them.
pub fn graph_changes(raw: &Value, before: &Map<String, Value>, after: &Map<String, Value>) -> Map<String, Value> {
    let (Value::Object(old), Value::Object(new)) = (card_to_graph(before), card_to_graph(after)) else {
        return Map::new();
    };
    let mut changes: Map<String, Value> = new.into_iter().filter(|(key, value)| old.get(key) != Some(value)).collect();
    if let Some(Value::Array(emails)) = changes.get_mut("emailAddresses") {
        let known = list_of(raw, "emailAddresses");
        for email in emails.iter_mut() {
            let address = text(email, "address");
            if let Some(name) =
                known.iter().find(|k| same_text(text(k, "address"), address)).and_then(|k| text(k, "name"))
            {
                email["name"] = json!(name);
            }
        }
    }
    changes
}

/// A Graph contact as it is created elsewhere (Graph can't move contacts between folders): every
/// field it had, with the changes of `after` on top.
pub fn graph_copy(raw: &Value, before: &Map<String, Value>, after: &Map<String, Value>) -> Value {
    let mut copy = match raw {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    copy.retain(|key, value| {
        !key.starts_with('@')
            && !matches!(
                key.as_str(),
                "id" | "changeKey" | "createdDateTime" | "lastModifiedDateTime" | "parentFolderId"
            )
            && !value.is_null()
    });
    copy.extend(graph_changes(raw, before, after));
    Value::Object(copy)
}

/// The Google update of a person from `before` (as read) to `after`: the body, and the fields it
/// replaces (`updatePersonFields`). Only fields that changed go; within them, what the app doesn't
/// map stays: further organizations, other events, name prefixes and suffixes, custom labels.
pub fn google_changes(
    raw: &Value,
    before: &Map<String, Value>,
    after: &Map<String, Value>,
) -> (Map<String, Value>, Vec<&'static str>) {
    let (Value::Object(old), Value::Object(new)) = (card_to_google(before), card_to_google(after)) else {
        return (Map::new(), Vec::new());
    };
    let mut body = Map::new();
    let mut fields = Vec::new();
    for field in GOOGLE_UPDATE_FIELDS.split(',') {
        let wanted = new.get(field).cloned().unwrap_or(Value::Array(Vec::new()));
        if old.get(field) == Some(&wanted) {
            continue;
        }
        let wanted: Vec<Value> = wanted.as_array().cloned().unwrap_or_default();
        let known = list_of(raw, field);
        let merged: Vec<Value> = match field {
            "names" => wanted
                .into_iter()
                .map(|name| {
                    let mut kept = known.first().map(|k| plain_entry(k)).unwrap_or_else(|| json!({}));
                    if let Some(map) = kept.as_object_mut() {
                        for key in ["displayName", "unstructuredName", "givenName", "middleName", "familyName"] {
                            map.remove(key);
                        }
                        map.extend(name.as_object().cloned().unwrap_or_default());
                    }
                    kept
                })
                .collect(),
            "nicknames" | "biographies" => {
                wanted.into_iter().chain(known.iter().skip(1).map(|k| plain_entry(k))).collect()
            }
            "organizations" => {
                let mut first = known.first().map(|k| plain_entry(k)).unwrap_or_else(|| json!({}));
                let given = wanted.first().cloned().unwrap_or_else(|| json!({}));
                if let Some(map) = first.as_object_mut() {
                    for key in ["name", "title"] {
                        match given.get(key) {
                            Some(value) => map.insert(key.into(), value.clone()),
                            None => map.remove(key),
                        };
                    }
                }
                let empty = first.as_object().is_none_or(|map| map.keys().all(|key| key == "type"));
                (!empty).then_some(first).into_iter().chain(known.iter().skip(1).map(|k| plain_entry(k))).collect()
            }
            "events" => known
                .iter()
                .filter(|e| !text(e, "type").is_some_and(|t| t.eq_ignore_ascii_case("anniversary")))
                .map(|e| plain_entry(e))
                .chain(wanted)
                .collect(),
            "emailAddresses" | "phoneNumbers" => wanted
                .into_iter()
                .map(|entry| {
                    // The same value of the same kind keeps its own label (and display name).
                    let same = known.iter().find(|k| {
                        same_text(text(k, "value"), text(&entry, "value"))
                            && google_type_of(k, field) == text(&entry, "type").unwrap_or("other")
                    });
                    match same {
                        Some(k) => {
                            let mut kept = plain_entry(k);
                            kept["value"] = entry["value"].clone();
                            kept
                        }
                        None => entry,
                    }
                })
                .collect(),
            "addresses" => wanted
                .into_iter()
                .map(|entry| {
                    let parts = ["streetAddress", "city", "region", "postalCode", "country"];
                    let same = known.iter().find(|k| {
                        let street = text(k, "streetAddress").or_else(|| text(k, "formattedValue"));
                        same_text(street, text(&entry, "streetAddress"))
                            && parts[1..].iter().all(|part| same_text(text(k, part), text(&entry, part)))
                            && google_type_of(k, field) == text(&entry, "type").unwrap_or("other")
                    });
                    // Unchanged: as it was, with its unstructured value, PO box, extended address.
                    match same {
                        Some(k) => {
                            let mut kept = (*k).clone();
                            if let Some(map) = kept.as_object_mut() {
                                map.remove("metadata");
                                map.remove("formattedType");
                            }
                            kept
                        }
                        None => entry,
                    }
                })
                .collect(),
            _ => wanted,
        };
        body.insert(field.to_string(), Value::Array(merged));
        fields.push(field);
    }
    (body, fields)
}

/// The type an entry of a Google list is written back with by [`card_to_google`].
fn google_type_of(entry: &Value, field: &str) -> &'static str {
    match text(entry, "type").map(str::to_ascii_lowercase).as_deref() {
        Some("home") => "home",
        Some("work") => "work",
        Some("mobile") if field == "phoneNumbers" => "mobile",
        _ => "other",
    }
}

/// A Google resource name as the app takes it: `people/` and letters, digits, `-` and `_` only.
pub fn google_resource(remote: &str) -> Option<&str> {
    let id = remote.strip_prefix("people/")?;
    (!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).then_some(remote)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        let Value::Object(map) = value else { unreachable!() };
        map
    }

    #[test]
    fn graph_contacts_round_trip() {
        let (id, folder, card) = graph_card(&json!({
            "id": "C1", "parentFolderId": "F1", "displayName": "Mina Sommer", "givenName": "Mina", "surname": "Sommer",
            "emailAddresses": [{ "name": "Mina", "address": "mina@example.org" }],
            "businessPhones": ["+49 30 1234"], "homePhones": [], "mobilePhone": "+49 170 1",
            "homeAddress": { "street": "Gartenweg 1", "city": "Berlin", "postalCode": "10115", "countryOrRegion": "Germany" },
            "businessAddress": {}, "companyName": "Nyu & Co", "jobTitle": "Cat herder",
            "personalNotes": "Likes tea", "birthday": "1604-05-01T11:59:00Z"
        }))
        .unwrap();
        assert_eq!((id.as_str(), folder.as_deref()), ("C1", Some("F1")));
        let value = Value::Object(card.clone());
        assert_eq!(value["name"]["full"], "Mina Sommer");
        assert_eq!(value["emails"]["e1"]["address"], "mina@example.org");
        assert_eq!(value["phones"]["p1"]["contexts"]["work"], true);
        assert_eq!(value["phones"]["p2"]["features"]["mobile"], true);
        assert_eq!(value["addresses"]["a1"]["contexts"]["private"], true);
        assert_eq!(value["anniversaries"]["b1"]["date"], json!({ "@type": "PartialDate", "month": 5, "day": 1 }));
        assert_eq!(crate::birthdays::card_dates(&value).len(), 1);

        let back = card_to_graph(&card);
        assert_eq!(back["givenName"], "Mina");
        assert_eq!(back["mobilePhone"], "+49 170 1");
        assert_eq!(back["businessPhones"], json!(["+49 30 1234"]));
        assert_eq!(back["homeAddress"]["city"], "Berlin");
        assert_eq!(back["businessAddress"], json!({}));
        assert_eq!(back["birthday"], "1604-05-01T11:59:00Z");
        assert_eq!(back["companyName"], "Nyu & Co");
    }

    #[test]
    fn google_people_round_trip() {
        let (resource, etag, card) = google_card(&json!({
            "resourceName": "people/c42", "etag": "%Eg0",
            "names": [{ "givenName": "Otto", "familyName": "Katz", "displayName": "Otto Katz" }],
            "emailAddresses": [{ "value": "otto@example.net", "type": "work" }],
            "phoneNumbers": [{ "value": "+43 1 2", "type": "mobile" }],
            "addresses": [{ "formattedValue": "Somewhere 1, Wien", "type": "home" }],
            "birthdays": [{ "date": { "month": 2, "day": 29 } }, { "text": "29.2." }],
            "events": [{ "type": "anniversary", "date": { "year": 2020, "month": 6, "day": 1 } }],
            "biographies": [{ "value": "Meow" }]
        }))
        .unwrap();
        assert_eq!((resource.as_str(), etag.as_deref()), ("people/c42", Some("%Eg0")));
        let value = Value::Object(card.clone());
        assert_eq!(value["emails"]["e1"]["contexts"]["work"], true);
        assert_eq!(value["addresses"]["a1"]["full"], "Somewhere 1, Wien");
        assert_eq!(value["anniversaries"]["w1"]["kind"], "wedding");
        let back = card_to_google(&card);
        assert_eq!(back["names"], json!([{ "givenName": "Otto", "middleName": "", "familyName": "Katz" }]));
        assert_eq!(back["phoneNumbers"], json!([{ "value": "+43 1 2", "type": "mobile" }]));
        assert_eq!(back["birthdays"], json!([{ "date": { "month": 2, "day": 29 } }]));
        assert_eq!(back["events"][0]["type"], "anniversary");
        assert_eq!(back["biographies"][0]["value"], "Meow");

        let only_company = card_to_google(&object(json!({ "organizations": { "o": { "name": "Nyu & Co" } } })));
        assert_eq!(only_company["names"], json!([]));
        assert_eq!(only_company["organizations"], json!([{ "name": "Nyu & Co" }]));
    }

    #[test]
    fn google_changes_keep_what_the_app_does_not_map() {
        let person = json!({
            "resourceName": "people/c7", "etag": "e7",
            "names": [{ "metadata": { "primary": true }, "honorificPrefix": "Dr.", "givenName": "Otto", "familyName": "Katz",
                "displayName": "Dr. Otto Katz", "unstructuredName": "Dr. Otto Katz" }],
            "phoneNumbers": [{ "value": "+43 1 2", "type": "school", "formattedType": "School" }],
            "emailAddresses": [{ "value": "otto@example.net", "type": "work", "displayName": "Otto (work)" }],
            "addresses": [{ "formattedValue": "Somewhere 1, Wien", "poBox": "12", "type": "home" }],
            "organizations": [
                { "name": "Nyu & Co", "title": "Cat herder", "department": "Paws" },
                { "name": "Second job" }
            ],
            "events": [
                { "type": "anniversary", "date": { "year": 2020, "month": 6, "day": 1 } },
                { "type": "graduation", "date": { "year": 2010, "month": 7, "day": 2 } }
            ]
        });
        let (_, _, before) = google_card(&person).unwrap();

        // A new job title: only the organizations go, the department and the second job stay.
        let mut after = before.clone();
        after.insert("titles".into(), json!({ "t": { "@type": "Title", "name": "Head cat herder" } }));
        let (body, fields) = google_changes(&person, &before, &after);
        assert_eq!(fields, ["organizations"]);
        assert_eq!(
            body["organizations"],
            json!([{ "name": "Nyu & Co", "title": "Head cat herder", "department": "Paws" }, { "name": "Second job" }])
        );

        // A second phone: the first keeps its own label; names, emails, addresses aren't sent.
        let mut after = before.clone();
        after["phones"]["p2"] = json!({ "@type": "Phone", "number": "+43 1 3", "features": { "mobile": true } });
        let (body, fields) = google_changes(&person, &before, &after);
        assert_eq!(fields, ["phoneNumbers"]);
        assert_eq!(
            body["phoneNumbers"],
            json!([{ "value": "+43 1 2", "type": "school" }, { "value": "+43 1 3", "type": "mobile" }])
        );

        // Another wedding day: the graduation stays. A new surname keeps the title before the name.
        let mut after = before.clone();
        after["anniversaries"]["w1"]["date"]["day"] = json!(2);
        after["name"]["components"][1]["value"] = json!("Kater");
        let (body, fields) = google_changes(&person, &before, &after);
        assert_eq!(fields, ["names", "events"]);
        assert_eq!(
            body["names"],
            json!([{ "honorificPrefix": "Dr.", "givenName": "Otto", "middleName": "", "familyName": "Kater" }])
        );
        assert_eq!(
            body["events"],
            json!([
                { "type": "graduation", "date": { "year": 2010, "month": 7, "day": 2 } },
                { "type": "anniversary", "date": { "year": 2020, "month": 6, "day": 2 } }
            ])
        );
        // Nothing changed: nothing goes.
        assert!(google_changes(&person, &before, &before).1.is_empty());
    }

    #[test]
    fn graph_changes_and_copies_keep_the_rest() {
        let contact = json!({
            "@odata.etag": "W/\"x\"", "id": "C1", "changeKey": "k", "parentFolderId": "F1",
            "createdDateTime": "2026-01-01T00:00:00Z", "displayName": "Mina", "givenName": "Mina",
            "emailAddresses": [{ "name": "Mina Sommer", "address": "mina@example.org" }],
            "categories": ["Family"], "imAddresses": ["mina@im.example"], "spouseName": "Otto",
            "birthday": "1990-05-01T11:59:00Z", "homePhones": []
        });
        let (_, _, before) = graph_card(&contact).unwrap();
        let mut after = before.clone();
        after.insert("titles".into(), json!({ "t": { "@type": "Title", "name": "Cat herder" } }));
        after["emails"]["e2"] = json!({ "@type": "EmailAddress", "address": "mina@example.net" });
        let changes = graph_changes(&contact, &before, &after);
        let mut keys: Vec<&str> = changes.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["emailAddresses", "jobTitle"]);
        assert_eq!(
            changes["emailAddresses"],
            json!([{ "address": "mina@example.org", "name": "Mina Sommer" }, { "address": "mina@example.net", "name": "mina@example.net" }]),
            "a known address keeps its name"
        );

        let copy = graph_copy(&contact, &before, &after);
        for gone in ["@odata.etag", "id", "changeKey", "parentFolderId", "createdDateTime"] {
            assert!(copy.get(gone).is_none(), "{gone}");
        }
        assert_eq!(copy["categories"], json!(["Family"]));
        assert_eq!(copy["imAddresses"], json!(["mina@im.example"]));
        assert_eq!(copy["spouseName"], "Otto");
        assert_eq!(copy["jobTitle"], "Cat herder");
        assert_eq!(copy["birthday"], "1990-05-01T11:59:00Z");
    }

    #[test]
    fn google_resource_names_are_checked() {
        assert_eq!(google_resource("people/c123"), Some("people/c123"));
        assert!(google_resource("people/../../x").is_none());
        assert!(google_resource("contactGroups/x").is_none());
        assert!(google_resource("people/").is_none());
    }
}
