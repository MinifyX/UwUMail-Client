//! The CardDAV client against small servers on this machine: discovery keeps the password on the
//! mailbox's sites, a whole address book is read with a listing and a multiget, cards are written
//! with the right preconditions, and hostile answers are refused. Runs everywhere; the stubs
//! listen on 127.0.0.1 with a certificate made for the run, which only these tests trust.
//!
//! `localhost` and `127.0.0.1` are two different sites here: the mailbox's mail server is
//! `127.0.0.1`, everything on `localhost` is someone else.

mod support;

use support::{Request, Response, https_stub};
use uwumail_core::calendar::dav::{self, CARDDAV_SERVICE, DavClient};
use uwumail_core::contacts::{carddav, vcard};

const MAIL_HOST: &str = "127.0.0.1";
const FOREIGN_HOST: &str = "localhost";

fn client() -> DavClient {
    let http = support::http_builder(&[support::stub_certificate().0.clone()]);
    DavClient::with_http(http, "mini@a.test", "dummy-password", &[MAIL_HOST]).unwrap().serving(carddav::WHAT)
}

const CARD: &str =
    "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:urn:uuid:1\r\nFN:Mina Sommer\r\nEMAIL:mina@example.org\r\nEND:VCARD\r\n";

/// An address book server with one book holding one card, like Radicale or Nextcloud.
fn address_book_server(request: &Request) -> Response {
    if !request.has_password() {
        return Response::new(401, "").header("WWW-Authenticate", "Basic realm=\"dav\"");
    }
    let body = request.text();
    match (request.method.as_str(), request.path.as_str()) {
        ("PROPFIND", "/dav/") => Response::multistatus(
            r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:response><d:href>/dav/</d:href>
<d:propstat><d:prop><d:current-user-principal><d:href>/dav/principals/mini/</d:href></d:current-user-principal></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#,
        ),
        ("PROPFIND", "/dav/principals/mini/") if body.contains("addressbook-home-set") => Response::multistatus(
            r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:response><d:href>/dav/principals/mini/</d:href>
<d:propstat><d:prop><c:addressbook-home-set><d:href>/dav/ab/mini/</d:href></c:addressbook-home-set></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#,
        ),
        ("PROPFIND", "/dav/ab/mini/") => Response::multistatus(
            r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
<d:response><d:href>/dav/ab/mini/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/dav/ab/mini/contacts/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:addressbook/></d:resourcetype><d:displayname>Kontakte</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>"#,
        ),
        ("PROPFIND", "/dav/ab/mini/contacts/") => Response::multistatus(
            r#"<d:multistatus xmlns:d="DAV:">
<d:response><d:href>/dav/ab/mini/contacts/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/dav/ab/mini/contacts/mina.vcf</d:href><d:propstat><d:prop><d:resourcetype/><d:getetag>"1"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>"#,
        ),
        ("REPORT", "/dav/ab/mini/contacts/") if body.contains("/dav/ab/mini/contacts/mina.vcf") => {
            Response::multistatus(format!(
                r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:response><d:href>/dav/ab/mini/contacts/mina.vcf</d:href>
<d:propstat><d:prop><d:getetag>"1"</d:getetag><c:address-data>{CARD}</c:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#
            ))
        }
        ("PUT", path) if path.ends_with(".vcf") => Response::new(201, "").header("ETag", "\"2\""),
        _ => Response::new(404, ""),
    }
}

#[tokio::test]
async fn an_address_book_is_found_and_read_whole() {
    let mail = https_stub(address_book_server).await;
    let manual = mail.url(MAIL_HOST, "/dav/");
    let home = dav::discover_for(&client(), Some(&manual), "a.test", &[], &CARDDAV_SERVICE).await.unwrap();
    assert_eq!(home, mail.url(MAIL_HOST, "/dav/ab/mini/"));

    let books = carddav::books(&client(), &home).await.unwrap();
    assert_eq!(books.len(), 1);
    assert_eq!(books[0].name, "Kontakte");

    let cards = carddav::cards(&client(), &books[0].url).await.unwrap();
    assert_eq!(cards.len(), 1);
    let card = vcard::from_vcard(&cards[0].data).unwrap();
    assert_eq!(card["name"]["full"], "Mina Sommer");
    assert_eq!(cards[0].etag.as_deref(), Some("\"1\""));
}

#[tokio::test]
async fn cards_are_written_with_preconditions() {
    let mail = https_stub(address_book_server).await;
    let url = mail.url(MAIL_HOST, "/dav/ab/mini/contacts/new.vcf");
    assert_eq!(carddav::put_card(&client(), &url, CARD, None).await.unwrap().as_deref(), Some("\"2\""));
    carddav::put_card(&client(), &url, CARD, Some("\"1\"")).await.unwrap();
    let puts: Vec<Request> = mail.seen().into_iter().filter(|r| r.method == "PUT").collect();
    assert_eq!(puts[0].header("if-none-match"), Some("*"));
    assert_eq!(puts[1].header("if-match"), Some("\"1\""));
    assert!(puts[0].header("content-type").unwrap().starts_with("text/vcard"));
}

/// security-audit C-3, for address books too: the mail domain's website is asked without the
/// password; its redirect to the mail server is followed, and only there the password goes.
#[tokio::test]
async fn discovery_asks_the_mail_domain_without_the_password() {
    let mail = https_stub(address_book_server).await;
    let target = mail.url(MAIL_HOST, "/dav/");
    let website = https_stub(move |request: &Request| {
        if request.path == "/.well-known/carddav" {
            Response::redirect(target.as_str())
        } else {
            Response::new(404, "")
        }
    })
    .await;
    let candidates = [website.url(FOREIGN_HOST, "/.well-known/carddav")];
    let home = dav::discover_among_for(&client(), &candidates, &CARDDAV_SERVICE).await.unwrap();
    assert_eq!(home, mail.url(MAIL_HOST, "/dav/ab/mini/"));
    assert!(website.seen().iter().all(|request| !request.has_password()));
}

/// A listing naming cards on another site or outside the book: none of them is fetched.
#[tokio::test]
async fn cards_elsewhere_are_not_fetched() {
    let collector = https_stub(|_: &Request| Response::new(200, CARD)).await;
    let foreign = collector.url(FOREIGN_HOST, "/dav/ab/mini/contacts/x.vcf");
    let mail = https_stub(move |request: &Request| match request.method.as_str() {
        "PROPFIND" => Response::multistatus(format!(
            r#"<d:multistatus xmlns:d="DAV:">
<d:response><d:href>{foreign}</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/dav/ab/other/y.vcf</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>"#
        )),
        _ => Response::new(404, ""),
    })
    .await;
    let cards = carddav::cards(&client(), &mail.url(MAIL_HOST, "/dav/ab/mini/contacts/")).await.unwrap();
    assert!(cards.is_empty());
    assert!(mail.seen().iter().all(|request| request.method == "PROPFIND"), "no multiget for nothing");
    assert!(collector.seen().is_empty());
}

/// Answers that are too big end in an error that names the address book server.
#[tokio::test]
async fn hostile_answers_are_refused() {
    let huge = https_stub(|_: &Request| {
        Response::multistatus(format!(
            "<d:multistatus xmlns:d=\"DAV:\">{}</d:multistatus>",
            " ".repeat(dav::MAX_LISTING + 1)
        ))
    })
    .await;
    let error = carddav::books(&client(), &huge.url(MAIL_HOST, "/dav/")).await.unwrap_err();
    assert!(error.message.contains("address book server"), "{}", error.message);
    assert!(error.message.contains("too big"), "{}", error.message);
}

/// security-audit 2026-09-23 CC-8: an address book whose every multiget answer is as big as allowed
/// is read only up to `MAX_BOOK_BYTES`, not 50 answers of 16 MB each.
#[tokio::test]
async fn a_huge_address_book_is_read_only_so_far() {
    let padding = "X".repeat(90 * 1024);
    let mail = https_stub(move |request: &Request| match request.method.as_str() {
        "PROPFIND" => {
            let cards: String = (0..500)
                .map(|n| {
                    format!(
                        "<d:response><d:href>/dav/ab/mini/contacts/{n}.vcf</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
                    )
                })
                .collect();
            Response::multistatus(format!("<d:multistatus xmlns:d=\"DAV:\">{cards}</d:multistatus>"))
        }
        "REPORT" => {
            let body = request.text();
            let cards: String = body
                .split("<d:href>")
                .skip(1)
                .filter_map(|rest| rest.split("</d:href>").next())
                .map(|href| {
                    format!(
                        r#"<d:response><d:href>{href}</d:href><d:propstat><d:prop><c:address-data>BEGIN:VCARD
VERSION:3.0
FN:{padding}
END:VCARD
</c:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#
                    )
                })
                .collect();
            Response::multistatus(format!(
                r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">{cards}</d:multistatus>"#
            ))
        }
        _ => Response::new(404, ""),
    })
    .await;
    let cards = carddav::cards(&client(), &mail.url(MAIL_HOST, "/dav/ab/mini/contacts/")).await.unwrap();
    let read: usize = cards.iter().map(|card| card.data.len()).sum();
    assert!((carddav::MAX_BOOK_BYTES..2 * carddav::MAX_BOOK_BYTES).contains(&read), "{read}");
    let multigets = mail.seen().iter().filter(|request| request.method == "REPORT").count();
    assert!(multigets < 5, "stopped after {multigets} of 5 batches");
}
