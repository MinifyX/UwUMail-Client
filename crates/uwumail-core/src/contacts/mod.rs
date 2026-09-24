//! Contacts: JMAP Contacts (RFC 9610) on UwUMail servers, CardDAV (RFC 6352) for other
//! mailboxes that sign in with a password. Online only: each account's address books and cards
//! are kept in memory for a few minutes and read from the server again after that.
//!
//! Both paths meet in the JSContact shape (RFC 9553): a UwUMail server sends it over JMAP, and
//! CardDAV's vCards are converted into it with `calcard` (`vcard`). The app gets cards as
//! JSContact with ids of its own, the same shape the webmail reads.

pub mod carddav;
pub mod jmap_contacts;
pub mod vcard;

use std::sync::Arc;
use std::time::Instant;

use serde_json::{Map, Value};
use url::Url;

use crate::calendar::dav::DavClient;
use crate::error::Error;
use crate::model::AddressBookInfo;

pub use crate::calendar::{app_id, dav_url, split_id};

/// Where an account's contacts live.
#[derive(Clone)]
pub enum Source {
    /// The account's JMAP session has contacts.
    Jmap,
    Dav {
        client: Arc<DavClient>,
        home: Url,
    },
}

/// What's known about an account's contacts.
pub enum SourceState {
    Ready(Source),
    /// No contacts for this account; asked again after a while.
    Unavailable {
        problem: Error,
        since: Instant,
    },
}

/// An address book and how the server knows it: the JMAP id, or the CardDAV collection's path.
#[derive(Debug, Clone)]
pub struct BookEntry {
    pub info: AddressBookInfo,
    pub remote: String,
}

/// A card as the server has it: JSContact, with the server's id (or path) and address book.
#[derive(Debug, Clone)]
pub struct RemoteCard {
    pub remote: String,
    pub book_remote: String,
    pub card: Map<String, Value>,
}

/// A card for the app: its own ids in `id` and `addressBookIds`, everything else as it came.
pub fn app_card(account_id: &str, remote: &RemoteCard) -> Value {
    let mut card = remote.card.clone();
    card.insert("id".into(), Value::String(app_id(account_id, &remote.remote)));
    let mut books = Map::new();
    books.insert(app_id(account_id, &remote.book_remote), Value::Bool(true));
    card.insert("addressBookIds".into(), Value::Object(books));
    Value::Object(card)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cards_carry_app_ids() {
        let mut card = Map::new();
        card.insert("uid".into(), Value::String("urn:uuid:1".into()));
        card.insert("id".into(), Value::String("k1".into()));
        let remote = RemoteCard { remote: "k1".into(), book_remote: "b1".into(), card };
        let app = app_card("acc", &remote);
        assert_eq!(app["id"], "acc:k1");
        assert_eq!(app["addressBookIds"], serde_json::json!({ "acc:b1": true }));
        assert_eq!(app["uid"], "urn:uuid:1");
    }
}
