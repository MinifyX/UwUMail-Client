//! vCard (RFC 6350) ↔ JSContact (RFC 9553) with `calcard`, as the UwUMail server does it.
//!
//! What calcard can't map to JSContact it keeps in the card's `vCard` property (RFC 9555), and
//! that goes back into the vCard when the card is written: a change made here loses nothing a
//! phone put into the card.

use calcard::jscontact::JSContact;
use calcard::vcard::{VCard, VCardVersion};
use serde_json::{Map, Value};

use crate::error::{Error, Result};

/// Properties of the app's cards that never go into a vCard.
const APP_PROPERTIES: &[&str] = &["id", "addressBookIds"];
/// vCards nested deeper than this (an AGENT holding a vCard holding a vCard …) aren't read.
const MAX_NESTING: usize = 4;

/// Reads a vCard as JSContact. `None` when it isn't one calcard can read.
pub fn from_vcard(text: &str) -> Option<Map<String, Value>> {
    if nesting(text) > MAX_NESTING {
        return None;
    }
    let card = VCard::parse(text).ok()?;
    match serde_json::to_value(card.into_jscontact::<String, String>()) {
        Ok(Value::Object(object)) => Some(object),
        _ => None,
    }
}

/// How deep BEGIN:VCARD lines nest in a text.
fn nesting(text: &str) -> usize {
    let (mut depth, mut deepest) = (0usize, 0usize);
    for line in text.lines() {
        let line = line.trim();
        if line.eq_ignore_ascii_case("BEGIN:VCARD") {
            depth += 1;
            deepest = deepest.max(depth);
        } else if line.eq_ignore_ascii_case("END:VCARD") {
            depth = depth.saturating_sub(1);
        }
    }
    deepest
}

/// A card as vCard text: in the version it came in, a new one as vCard 3.0, which every CardDAV
/// server and client reads.
pub fn to_vcard(card: &Map<String, Value>) -> Result<String> {
    let mut card = card.clone();
    for property in APP_PROPERTIES {
        card.remove(*property);
    }
    let json = Value::Object(card).to_string();
    let contact = JSContact::<String, String>::parse(&json)
        .map_err(|_| Error::invalid("This contact can't be written as a vCard."))?;
    let vcard = contact.into_vcard().ok_or_else(|| Error::invalid("This contact can't be written as a vCard."))?;
    let mut out = String::new();
    vcard
        .write_to(&mut out, vcard.version().unwrap_or(VCardVersion::V3_0))
        .map_err(|_| Error::internal("The vCard couldn't be written."))?;
    Ok(out)
}

/// The card's uid without a `urn:uuid:` in front, for a file name.
pub fn file_name(uid: &str) -> String {
    let bare = uid.strip_prefix("urn:uuid:").unwrap_or(uid);
    let safe: String = bare.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).collect();
    let safe = safe.trim_start_matches('.');
    if safe.is_empty() || safe.len() > 200 { format!("{}.vcf", uuid::Uuid::new_v4()) } else { format!("{safe}.vcf") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CARD: &str = "BEGIN:VCARD\r
VERSION:3.0\r
UID:urn:uuid:4fbe8971-0bc3-424c-9c26-36c3e1eff6b1\r
FN:Mina Sommer\r
N:Sommer;Mina;;;\r
EMAIL;TYPE=HOME:mina@example.org\r
TEL;TYPE=CELL:+49 30 5550123\r
X-PHONE-COLOR:pink\r
END:VCARD\r
";

    #[test]
    fn a_vcard_goes_through_jscontact_and_back() {
        let card = from_vcard(CARD).unwrap();
        assert_eq!(card["name"]["full"], "Mina Sommer");
        let email = card["emails"].as_object().unwrap().values().next().unwrap();
        assert_eq!(email["address"], "mina@example.org");

        let mut changed = card.clone();
        changed.insert("id".into(), json!("acc:/ab/x.vcf"));
        changed.insert("addressBookIds".into(), json!({ "acc:/ab/": true }));
        changed["name"]["full"] = json!("Mina Winter");
        let text = to_vcard(&changed).unwrap();
        assert!(text.contains("FN:Mina Winter"), "{text}");
        assert!(text.contains("mina@example.org"), "{text}");
        // What JSContact has no word for comes back as it was.
        assert!(text.contains("X-PHONE-COLOR:pink"), "{text}");
        assert!(!text.contains("acc:"), "{text}");
    }

    #[test]
    fn broken_and_deeply_nested_cards_are_left_out() {
        assert!(from_vcard("BEGIN:VEVENT\nEND:VEVENT\n").is_none());
        let nested = "BEGIN:VCARD\n".repeat(MAX_NESTING + 1) + &"END:VCARD\n".repeat(MAX_NESTING + 1);
        assert!(from_vcard(&nested).is_none());
    }

    #[test]
    fn file_names_come_from_the_uid() {
        assert_eq!(file_name("urn:uuid:4fbe8971-0bc3"), "4fbe8971-0bc3.vcf");
        assert!(file_name("../../etc/passwd").ends_with(".vcf"));
        assert!(!file_name("../../etc/passwd").contains('/'));
        assert!(file_name("///").ends_with(".vcf"));
    }
}
