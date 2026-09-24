//! CardDAV (RFC 6352) for mailboxes whose server has no JMAP Contacts: finding the address book
//! home (RFC 6764), listing address books, reading their vCards and writing them back.
//!
//! The connection rules are the calendar's (`calendar::dav`): HTTPS only, the password only to
//! the sites the mailbox already trusts, size-limited answers read with the careful XML reader.

use reqwest::StatusCode;
use url::Url;

use crate::calendar::dav::{self, DavClient, DavObject, MAX_LISTING, check_as, prop, responses};
use crate::calendar::xml::{self, CARDDAV, DAV, Element};
use crate::error::{Error, Result};

/// What the server is called in messages.
pub const WHAT: &str = "address book server";
/// Cards read from one address book at most.
const MAX_CARDS: usize = 5000;
/// Cards asked for in one multiget.
const MULTIGET_BATCH: usize = 100;
/// vCard text read from one address book at most: what one calendar listing may hold.
pub const MAX_BOOK_BYTES: usize = MAX_LISTING;

#[derive(Debug, Clone, PartialEq)]
pub struct DavBook {
    pub url: Url,
    pub name: String,
    pub writable: bool,
}

const BOOKS_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/><d:current-user-privilege-set/></d:prop></d:propfind>"#;

/// The address books in a multistatus answer about the home.
pub fn parse_books(root: &Element, base: &Url) -> Vec<DavBook> {
    responses(root, base)
        .into_iter()
        .filter_map(|(url, props)| {
            prop(&props, DAV, "resourcetype")?.child(CARDDAV, "addressbook")?;
            let privileges = prop(&props, DAV, "current-user-privilege-set");
            // Servers that don't list privileges usually let the owner write.
            let writable = privileges.is_none_or(|set| {
                set.children_named(DAV, "privilege")
                    .flat_map(|privilege| privilege.children.iter())
                    .filter(|element| element.namespace == DAV)
                    .any(|element| matches!(element.name.as_str(), "all" | "write" | "write-content" | "bind"))
            });
            let name = prop(&props, DAV, "displayname").map(|e| e.trimmed_text().to_string()).unwrap_or_default();
            let name = if name.is_empty() {
                url.path_segments()
                    .and_then(|mut segments| segments.rfind(|segment| !segment.is_empty()))
                    .map(|segment| percent_encoding::percent_decode_str(segment).decode_utf8_lossy().into_owned())
                    .unwrap_or_else(|| "Contacts".into())
            } else {
                name
            };
            Some(DavBook { url, name, writable })
        })
        .collect()
}

pub async fn books(client: &DavClient, home: &Url) -> Result<Vec<DavBook>> {
    let (root, landed) = client.multistatus("PROPFIND", home, "1", BOOKS_BODY).await?;
    Ok(parse_books(&root, &landed))
}

/// A new address book under the home (extended MKCOL, RFC 5689).
pub async fn make_book(client: &DavClient, home: &Url, name: &str) -> Result<Url> {
    let mut url = home.clone();
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    let url = url
        .join(&format!("{}/", uuid::Uuid::new_v4()))
        .map_err(|_| Error::internal("The address book's address couldn't be built."))?;
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:set><d:prop><d:resourcetype><d:collection/><c:addressbook/></d:resourcetype><d:displayname>{}</d:displayname></d:prop></d:set></d:mkcol>"#,
        xml::escape(name)
    );
    let response =
        client.send("MKCOL", &url, &[], Some(("application/xml; charset=utf-8", body.as_bytes())), MAX_LISTING).await?;
    check_as(response.status, WHAT)?;
    Ok(url)
}

/// Renames an address book.
pub async fn rename_book(client: &DavClient, url: &Url, name: &str) -> Result<()> {
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>{}</d:displayname></d:prop></d:set></d:propertyupdate>"#,
        xml::escape(name)
    );
    let response = client
        .send("PROPPATCH", url, &[], Some(("application/xml; charset=utf-8", body.as_bytes())), MAX_LISTING)
        .await?;
    check_as(response.status, WHAT)?;
    // A 207 can still say the name was refused.
    if response.status == StatusCode::MULTI_STATUS {
        let root = xml::parse(&response.body)?;
        let refused =
            root.children_named(DAV, "response").flat_map(|r| r.children_named(DAV, "propstat")).any(|propstat| {
                propstat
                    .child(DAV, "status")
                    .is_some_and(|status| status.trimmed_text().split(' ').nth(1) != Some("200"))
            });
        if refused {
            return Err(Error::invalid("The address book server didn't take the new name."));
        }
    }
    Ok(())
}

const LISTING_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>"#;

/// The cards' addresses in a listing of an address book: what isn't a collection, on the same
/// server and under the book.
pub fn parse_listing(root: &Element, base: &Url, book: &Url) -> Vec<Url> {
    responses(root, base)
        .into_iter()
        .filter(|(url, props)| {
            let collection =
                prop(props, DAV, "resourcetype").is_some_and(|kind| kind.child(DAV, "collection").is_some());
            !collection
                && url.origin() == book.origin()
                && url.path().starts_with(book.path())
                && url.path() != book.path()
        })
        .map(|(url, _)| url)
        .take(MAX_CARDS)
        .collect()
}

/// The vCards in a multiget answer.
pub fn parse_cards(root: &Element, base: &Url) -> Vec<DavObject> {
    responses(root, base)
        .into_iter()
        .filter_map(|(url, props)| {
            let data = prop(&props, CARDDAV, "address-data")?.text.clone();
            (!data.trim().is_empty() && data.len() <= dav::MAX_OBJECT).then(|| DavObject {
                etag: prop(&props, DAV, "getetag").map(|e| e.trimmed_text().to_string()).filter(|e| !e.is_empty()),
                url,
                data,
            })
        })
        .collect()
}

/// Every card of an address book: the listing, then the vCards in batches (addressbook-multiget),
/// which every CardDAV server answers. At most [`MAX_BOOK_BYTES`] of vCards (and one batch more):
/// each answer may be 16 MB, and 5000 cards come in 50 of them, which a hostile server, or anyone
/// who can write to a shared address book, could use to fill the memory.
pub async fn cards(client: &DavClient, book: &Url) -> Result<Vec<DavObject>> {
    let (root, landed) = client.multistatus("PROPFIND", book, "1", LISTING_BODY).await?;
    let urls = parse_listing(&root, &landed, book);
    let mut found = Vec::new();
    let mut read = 0;
    for batch in urls.chunks(MULTIGET_BATCH) {
        if read >= MAX_BOOK_BYTES {
            tracing::warn!("The address book at {book} holds more than UwUMail reads; the rest is left out.");
            break;
        }
        let hrefs: String = batch
            .iter()
            .map(|url| format!("<d:href>{}</d:href>", xml::escape(url.path())))
            .collect::<Vec<_>>()
            .join("");
        let body = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<c:addressbook-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><c:address-data/></d:prop>{hrefs}</c:addressbook-multiget>"#
        );
        let (root, landed) = client.multistatus("REPORT", book, "1", &body).await?;
        let cards = parse_cards(&root, &landed);
        read += cards.iter().map(|card| card.data.len()).sum::<usize>();
        found.extend(cards);
    }
    Ok(found)
}

pub async fn get_card(client: &DavClient, url: &Url) -> Result<DavObject> {
    dav::get_object_as(client, url, "text/vcard").await
}

/// Stores a card: new (`etag` None, fails if something is there) or replacing that version.
pub async fn put_card(client: &DavClient, url: &Url, data: &str, etag: Option<&str>) -> Result<Option<String>> {
    dav::put_object_as(client, url, data, "text/vcard; charset=utf-8", etag).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Element {
        xml::parse(text.as_bytes()).unwrap()
    }

    #[test]
    fn address_books_are_found_in_the_home() {
        let home = Url::parse("https://dav.example.org/addressbooks/mini/").unwrap();
        let root = parse(
            r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
<d:response><d:href>/addressbooks/mini/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/addressbooks/mini/contacts/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:addressbook/></d:resourcetype><d:displayname>Kontakte</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/addressbooks/mini/shared%20club/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:addressbook/></d:resourcetype><d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>"#,
        );
        let books = parse_books(&root, &home);
        assert_eq!(books.len(), 2);
        assert_eq!(books[0].name, "Kontakte");
        assert!(books[0].writable);
        assert_eq!(books[1].name, "shared club");
        assert!(!books[1].writable);
    }

    #[test]
    fn listings_keep_to_the_book() {
        let book = Url::parse("https://dav.example.org/ab/mini/contacts/").unwrap();
        let root = parse(
            r#"<d:multistatus xmlns:d="DAV:">
<d:response><d:href>/ab/mini/contacts/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/ab/mini/contacts/a.vcf</d:href><d:propstat><d:prop><d:resourcetype/><d:getetag>"1"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/ab/other/b.vcf</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>https://evil.example/ab/mini/contacts/c.vcf</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>"#,
        );
        let urls = parse_listing(&root, &book, &book);
        assert_eq!(
            urls.iter().map(Url::as_str).collect::<Vec<_>>(),
            ["https://dav.example.org/ab/mini/contacts/a.vcf"]
        );
    }

    #[test]
    fn multiget_answers_give_the_vcards() {
        let book = Url::parse("https://dav.example.org/ab/mini/contacts/").unwrap();
        let root = parse(
            r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
<d:response><d:href>/ab/mini/contacts/a.vcf</d:href><d:propstat><d:prop><d:getetag>"7"</d:getetag><c:address-data>BEGIN:VCARD
VERSION:3.0
FN:A
END:VCARD
</c:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/ab/mini/contacts/gone.vcf</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>
</d:multistatus>"#,
        );
        let cards = parse_cards(&root, &book);
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].etag.as_deref(), Some("\"7\""));
        assert!(cards[0].data.contains("FN:A"));
    }
}
