//! End-to-end test of JMAP Contacts against a real UwUMail server.
//!
//! Start a server like for `uwumail_server.rs` (UwUMail-Server docs/development.md, "Without
//! Docker", `UWUMAIL_LISTEN__PROXY=127.0.0.1:18080`), create an account with CardDAV on, then:
//!
//!   UWUMAIL_TEST_SERVER=http://127.0.0.1:18080 UWUMAIL_TEST_LOGIN=mini@a.test \
//!   UWUMAIL_TEST_PASSWORD=… cargo test -p uwumail-core --test uwumail_server_contacts -- --test-threads=1
//!
//! Skipped when `UWUMAIL_TEST_SERVER` isn't set, or when the server doesn't offer JMAP Contacts.
//! The test works in an address book of its own and deletes it again.

use serde_json::{Map, json};
use uwumail_core::contacts::jmap_contacts;
use uwumail_core::jmap::Client;

async fn client() -> Option<Client> {
    let url = std::env::var("UWUMAIL_TEST_SERVER").ok()?;
    let login = std::env::var("UWUMAIL_TEST_LOGIN").expect("UWUMAIL_TEST_LOGIN");
    let password = std::env::var("UWUMAIL_TEST_PASSWORD").expect("UWUMAIL_TEST_PASSWORD");
    let session = format!("{}/.well-known/jmap", url.trim_end_matches('/'));
    let http = reqwest::Client::builder().build().unwrap();
    Some(Client::connect(&http, &session, &login, &password).await.expect("sign in"))
}

#[tokio::test]
async fn contacts_travel_through_the_server() {
    let Some(client) = client().await else {
        eprintln!("UWUMAIL_TEST_SERVER not set, skipping");
        return;
    };
    if client.session.contacts_account_id.is_none() {
        eprintln!("The server has no JMAP Contacts, skipping");
        return;
    }
    let book = jmap_contacts::create_book(&client, "UwUMail test").await.unwrap();
    assert!(jmap_contacts::books(&client).await.unwrap().iter().any(|b| b.id == book && b.name == "UwUMail test"));

    let card = json!({
        "@type": "Card",
        "name": { "full": "Lea Muster", "components": [
            { "kind": "given", "value": "Lea" }, { "kind": "surname", "value": "Muster" }
        ] },
        "emails": { "e1": { "address": "lea@example.net" } },
    })
    .as_object()
    .cloned()
    .unwrap();
    let id = jmap_contacts::create_card(&client, &book, card).await.unwrap();
    let stored = jmap_contacts::card(&client, &id).await.unwrap();
    assert_eq!(stored.book_remote, book);
    assert_eq!(stored.card["emails"]["e1"]["address"], "lea@example.net");
    assert!(stored.card.get("vCard").is_none(), "the raw vCard stays on the server");

    let mut patch = Map::new();
    patch.insert("emails/e1/address".into(), json!("lea@example.org"));
    jmap_contacts::update_card(&client, &id, patch).await.unwrap();
    let changed = jmap_contacts::card(&client, &id).await.unwrap();
    assert_eq!(changed.card["emails"]["e1"]["address"], "lea@example.org");
    assert!(jmap_contacts::cards(&client).await.unwrap().iter().any(|c| c.remote == id));

    jmap_contacts::destroy_card(&client, &id).await.unwrap();
    assert!(jmap_contacts::card(&client, &id).await.is_err());
    jmap_contacts::delete_book(&client, &book).await.unwrap();
}
