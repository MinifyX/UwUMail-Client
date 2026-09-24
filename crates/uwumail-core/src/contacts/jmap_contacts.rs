//! JMAP Contacts (RFC 9610) on a UwUMail server: address books, cards as JSContact, and
//! changes as JMAP patches.

use serde_json::{Map, Value, json};

use super::RemoteCard;
use crate::error::{Error, Result};
use crate::jmap::{self, Client};

/// Cards asked for in one query; the server allows up to 5000.
const QUERY_LIMIT: usize = 5000;

fn account(client: &Client) -> Result<&str> {
    client
        .session
        .contacts_account_id
        .as_deref()
        .ok_or_else(|| Error::not_supported("This mail server has no address books."))
}

fn list(arguments: &Value) -> Vec<Value> {
    arguments.get("list").and_then(Value::as_array).cloned().unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq)]
pub struct JmapBook {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub is_default: bool,
    pub may_write: bool,
    pub may_delete: bool,
}

pub fn parse_book(value: &Value) -> Option<JmapBook> {
    let rights = value.get("myRights");
    let right = |key: &str| rights.and_then(|r| r.get(key)).and_then(Value::as_bool);
    Some(JmapBook {
        id: value.get("id")?.as_str()?.to_string(),
        name: value.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
        sort_order: value.get("sortOrder").and_then(Value::as_i64).unwrap_or(0),
        is_default: value.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
        // Without rights, the address books are the login's own.
        may_write: rights.is_none() || right("mayWrite").unwrap_or(false),
        may_delete: rights.is_none() || right("mayDelete").unwrap_or(false),
    })
}

pub async fn books(client: &Client) -> Result<Vec<JmapBook>> {
    let responses = client
        .call(vec![(
            "AddressBook/get",
            json!({
                "accountId": account(client)?,
                "ids": null,
                "properties": ["id", "name", "sortOrder", "isDefault", "myRights"],
            }),
        )])
        .await?;
    Ok(list(responses.get(0, "AddressBook/get")?).iter().filter_map(parse_book).collect())
}

/// A `/set` answer's first problem, as an error.
fn refused(arguments: &Value, fallback: &str) -> Error {
    match jmap::set_errors(arguments) {
        Some(error) if error.kind == "addressBookHasContents" => {
            Error::invalid("This address book still has contacts.")
        }
        Some(error) if error.kind == "tooLarge" => Error::invalid("This contact is too big for the server."),
        Some(error) => error.into(),
        None => Error::internal(fallback.to_string()),
    }
}

async fn set(client: &Client, method: &str, mut arguments: Map<String, Value>, fallback: &str) -> Result<Value> {
    arguments.insert("accountId".into(), json!(account(client)?));
    let responses = client.call(vec![(method, Value::Object(arguments))]).await?;
    let answer = responses.get(0, method)?.clone();
    if jmap::set_errors(&answer).is_some() {
        return Err(refused(&answer, fallback));
    }
    Ok(answer)
}

pub async fn create_book(client: &Client, name: &str) -> Result<String> {
    let mut arguments = Map::new();
    arguments.insert("create".into(), json!({ "new": { "name": name } }));
    let answer = set(client, "AddressBook/set", arguments, "The address book wasn't created.").await?;
    answer
        .pointer("/created/new/id")
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| Error::internal("The address book wasn't created."))
}

pub async fn rename_book(client: &Client, id: &str, name: &str) -> Result<()> {
    let mut arguments = Map::new();
    arguments.insert("update".into(), json!({ id: { "name": name } }));
    set(client, "AddressBook/set", arguments, "The address book wasn't renamed.").await.map(|_| ())
}

/// Deletes an address book with its cards.
pub async fn delete_book(client: &Client, id: &str) -> Result<()> {
    let mut arguments = Map::new();
    arguments.insert("destroy".into(), json!([id]));
    arguments.insert("onDestroyRemoveContents".into(), json!(true));
    set(client, "AddressBook/set", arguments, "The address book wasn't deleted.").await.map(|_| ())
}

pub async fn set_default_book(client: &Client, id: &str) -> Result<()> {
    let mut arguments = Map::new();
    arguments.insert("update".into(), json!({ id: {} }));
    arguments.insert("onSuccessSetIsDefault".into(), json!(id));
    set(client, "AddressBook/set", arguments, "The default address book wasn't changed.").await.map(|_| ())
}

/// A card from the server, with its id and address book taken out.
fn remote_card(value: Value) -> Option<RemoteCard> {
    let Value::Object(mut card) = value else { return None };
    let remote = card.remove("id")?.as_str()?.to_string();
    let book_remote = card
        .remove("addressBookIds")
        .and_then(|ids| ids.as_object()?.iter().find(|(_, on)| on.as_bool() == Some(true)).map(|(id, _)| id.clone()))?;
    // The raw vCard the server keeps is its business; the app works with the JSContact.
    card.remove("vCard");
    Some(RemoteCard { remote, book_remote, card })
}

/// Every card of the account (up to the query limit).
pub async fn cards(client: &Client) -> Result<Vec<RemoteCard>> {
    let account = account(client)?;
    let responses =
        client.call(vec![("ContactCard/query", json!({ "accountId": account, "limit": QUERY_LIMIT }))]).await?;
    let ids: Vec<String> = responses
        .get(0, "ContactCard/query")?
        .get("ids")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(|id| id.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let mut found = Vec::new();
    for chunk in jmap::chunks(&ids, client.session.max_objects_in_get) {
        let responses = client.call(vec![("ContactCard/get", json!({ "accountId": account, "ids": chunk }))]).await?;
        found.extend(list(responses.get(0, "ContactCard/get")?).into_iter().filter_map(remote_card));
    }
    Ok(found)
}

pub async fn card(client: &Client, id: &str) -> Result<RemoteCard> {
    let responses =
        client.call(vec![("ContactCard/get", json!({ "accountId": account(client)?, "ids": [id] }))]).await?;
    list(responses.get(0, "ContactCard/get")?)
        .into_iter()
        .find_map(remote_card)
        .ok_or_else(|| Error::not_found("This contact no longer exists."))
}

/// Creates a card in an address book and returns its id; the server fills in uid and dates.
pub async fn create_card(client: &Client, book: &str, mut card: Map<String, Value>) -> Result<String> {
    card.remove("id");
    card.insert("addressBookIds".into(), json!({ book: true }));
    let mut arguments = Map::new();
    arguments.insert("create".into(), json!({ "new": card }));
    let answer = set(client, "ContactCard/set", arguments, "The contact wasn't saved.").await?;
    answer
        .pointer("/created/new/id")
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| Error::internal("The contact wasn't saved."))
}

pub async fn update_card(client: &Client, id: &str, patch: Map<String, Value>) -> Result<()> {
    if patch.is_empty() {
        return Ok(());
    }
    let mut arguments = Map::new();
    arguments.insert("update".into(), json!({ id: patch }));
    set(client, "ContactCard/set", arguments, "The contact wasn't changed.").await.map(|_| ())
}

pub async fn destroy_card(client: &Client, id: &str) -> Result<()> {
    let mut arguments = Map::new();
    arguments.insert("destroy".into(), json!([id]));
    set(client, "ContactCard/set", arguments, "The contact wasn't deleted.").await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_books_and_their_rights() {
        let book = parse_book(&json!({
            "id": "b1", "name": "Kontakte", "isDefault": true,
            "myRights": { "mayRead": true, "mayWrite": true, "mayDelete": false }
        }))
        .unwrap();
        assert_eq!(book.name, "Kontakte");
        assert!(book.is_default && book.may_write && !book.may_delete);
        assert!(parse_book(&json!({ "name": "no id" })).is_none());
    }

    #[test]
    fn cards_lose_the_server_ids_and_the_raw_vcard() {
        let card = remote_card(json!({
            "id": "k1", "addressBookIds": { "b2": true }, "uid": "urn:uuid:1", "vCard": { "x": 1 }
        }))
        .unwrap();
        assert_eq!((card.remote.as_str(), card.book_remote.as_str()), ("k1", "b2"));
        assert_eq!(Value::Object(card.card), json!({ "uid": "urn:uuid:1" }));
        assert!(remote_card(json!({ "id": "k1", "addressBookIds": {} })).is_none());
    }
}
