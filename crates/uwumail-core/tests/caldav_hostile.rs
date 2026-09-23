//! The CalDAV client against small hostile servers on this machine: where the password may go
//! during discovery and redirects, and what answers it refuses. Runs everywhere; the stubs
//! listen on 127.0.0.1 with a certificate made for the run, which only these tests trust.
//!
//! `localhost` and `127.0.0.1` are two different sites here: the mailbox's mail server is
//! `127.0.0.1`, everything on `localhost` is someone else.

mod support;

use support::{Request, Response, Stub, https_stub};
use uwumail_core::ErrorCode;
use uwumail_core::calendar::dav::{self, DavClient};
use uwumail_core::calendar::ical;

const MAIL_HOST: &str = "127.0.0.1";
const FOREIGN_HOST: &str = "localhost";

fn client() -> DavClient {
    let http = support::http_builder(&[support::stub_certificate().0.clone()]);
    DavClient::with_http(http, "mini@a.test", "dummy-password", &[MAIL_HOST]).unwrap()
}

fn home_answer(href: &str) -> Response {
    Response::multistatus(format!(
        r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
<d:response><d:href>/dav/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>{href}</d:href></c:calendar-home-set>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#
    ))
}

/// A calendar server that wants the password and names its home.
async fn mail_server() -> Stub {
    https_stub(|request: &Request| {
        if !request.has_password() {
            return Response::new(401, "").header("WWW-Authenticate", "Basic realm=\"dav\"");
        }
        home_answer("/dav/calendars/mini/")
    })
    .await
}

fn nobody_got_the_password(stub: &Stub) {
    assert!(stub.seen().iter().all(|request| !request.has_password()), "{:?}", stub.seen());
}

/// security-audit C-3: the mail domain's website (often someone else's) is asked without the
/// password; its redirect to the mail server is followed, and only there the password goes.
#[tokio::test]
async fn discovery_asks_the_mail_domain_without_the_password() {
    let mail = mail_server().await;
    let target = mail.url(MAIL_HOST, "/dav/");
    let website = https_stub(move |request: &Request| {
        if request.path == "/.well-known/caldav" { Response::redirect(target.as_str()) } else { Response::new(404, "") }
    })
    .await;

    let home = dav::discover_among(&client(), &[website.url(FOREIGN_HOST, "/.well-known/caldav")]).await.unwrap();
    assert_eq!(home, mail.url(MAIL_HOST, "/dav/calendars/mini/"));
    assert_eq!(website.seen().len(), 1);
    nobody_got_the_password(&website);
    assert!(mail.seen().iter().any(Request::has_password), "the mail server got the sign-in");
}

/// A website that asks for a password itself gets nothing, and discovery moves on.
#[tokio::test]
async fn a_website_asking_for_the_password_gets_none() {
    let website =
        https_stub(|_: &Request| Response::new(401, "").header("WWW-Authenticate", "Basic realm=\"x\"")).await;
    let mail = mail_server().await;
    let candidates = [website.url(FOREIGN_HOST, "/.well-known/caldav"), mail.url(MAIL_HOST, "/.well-known/caldav")];
    let home = dav::discover_among(&client(), &candidates).await.unwrap();
    assert_eq!(home.host_str(), Some(MAIL_HOST));
    nobody_got_the_password(&website);
}

/// The mail server redirecting the signed-in request elsewhere: refused before anything is sent.
#[tokio::test]
async fn a_redirect_to_another_site_is_refused() {
    let collector = https_stub(|_: &Request| home_answer("/stolen/")).await;
    let to = collector.url(FOREIGN_HOST, "/collect");
    let mail = https_stub(move |_: &Request| Response::redirect(to.as_str())).await;
    let error = dav::home_at(&client(), &mail.url(MAIL_HOST, "/dav/")).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::AuthFailed);
    assert!(error.message.contains("didn't send your password"), "{}", error.message);
    assert!(collector.seen().is_empty(), "the other site got no request at all");

    // Down to plain HTTP neither, even on the same host.
    let mail = https_stub(|_: &Request| Response::redirect("http://127.0.0.1:9/dav/")).await;
    assert!(dav::home_at(&client(), &mail.url(MAIL_HOST, "/dav/")).await.is_err());
}

/// A home set or principal on another site, and `href`s with tricks, never get the password.
#[tokio::test]
async fn hrefs_to_other_sites_get_nothing() {
    let collector = https_stub(|_: &Request| home_answer("/x/")).await;
    let foreign = collector.url(FOREIGN_HOST, "/principal/");
    for href in [foreign.to_string(), format!("//{FOREIGN_HOST}:{}/principal/", collector.port)] {
        let principal = href.clone();
        let mail = https_stub(move |_: &Request| {
            Response::multistatus(format!(
                r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href><d:propstat><d:prop>
<d:current-user-principal><d:href>{principal}</d:href></d:current-user-principal></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#
            ))
        })
        .await;
        let error = dav::home_at(&client(), &mail.url(MAIL_HOST, "/dav/")).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::AuthFailed, "{href}");
    }
    assert!(collector.seen().is_empty());

    // A home on another site is refused when it's used.
    let mail = https_stub(move |_: &Request| home_answer(foreign.as_str())).await;
    let home = dav::home_at(&client(), &mail.url(MAIL_HOST, "/dav/")).await.unwrap().unwrap();
    assert!(dav::calendars(&client(), &home).await.is_err());
    assert!(collector.seen().is_empty());
}

/// Answers that are too big, entity bombs and endless redirects end in an error, not in memory.
#[tokio::test]
async fn hostile_answers_are_refused() {
    let huge = https_stub(|_: &Request| {
        Response::multistatus(format!(
            "<d:multistatus xmlns:d=\"DAV:\">{}</d:multistatus>",
            " ".repeat(dav::MAX_LISTING + 1)
        ))
    })
    .await;
    let error = dav::calendars(&client(), &huge.url(MAIL_HOST, "/dav/")).await.unwrap_err();
    assert!(error.message.contains("too big"), "{}", error.message);

    let bomb = https_stub(|_: &Request| {
        Response::multistatus(
            r#"<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;">]>
<d:multistatus xmlns:d="DAV:">&b;</d:multistatus>"#,
        )
    })
    .await;
    assert!(dav::calendars(&client(), &bomb.url(MAIL_HOST, "/dav/")).await.is_err());

    let deep = https_stub(|_: &Request| {
        Response::multistatus(format!("{}{}", "<d:x xmlns:d=\"DAV:\">".repeat(5000), "</d:x>".repeat(5000)))
    })
    .await;
    assert!(dav::calendars(&client(), &deep.url(MAIL_HOST, "/dav/")).await.is_err());

    let looping = https_stub(|request: &Request| Response::redirect(&format!("{}x", request.path))).await;
    let error = dav::calendars(&client(), &looping.url(MAIL_HOST, "/dav/")).await.unwrap_err();
    assert!(error.message.contains("redirecting"), "{}", error.message);
    assert_eq!(looping.seen().len(), 6);

    let not_dav = https_stub(|_: &Request| Response::new(200, "<html>hello</html>")).await;
    assert_eq!(
        dav::calendars(&client(), &not_dav.url(MAIL_HOST, "/")).await.unwrap_err().code,
        ErrorCode::NotSupported
    );
}

/// Hostile events: nested too deep (C-6) or repeating every minute with a long text (C-4). The
/// listing is read, the deep one is refused, and the other shows only what fits.
#[tokio::test]
async fn hostile_events_neither_crash_nor_fill_the_memory() {
    let deep = format!(
        "BEGIN:VCALENDAR\r\n{}{}END:VCALENDAR\r\n",
        "BEGIN:VEVENT\r\n".repeat(20_000),
        "END:VEVENT\r\n".repeat(20_000)
    );
    let long = format!(
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:tick\r\nDTSTART:20260901T000000Z\r\nDURATION:PT1M\r\n\
RRULE:FREQ=MINUTELY\r\nSUMMARY:Tick\r\nDESCRIPTION:{}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        "x".repeat(500_000)
    );
    let listing = format!(
        r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
<d:response><d:href>/dav/cal/deep.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><c:calendar-data>{deep}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/dav/cal/long.ics</d:href><d:propstat><d:prop><d:getetag>"2"</d:getetag><c:calendar-data>{long}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>"#
    );
    let server = https_stub(move |_: &Request| Response::multistatus(listing.clone())).await;
    let from = chrono::DateTime::parse_from_rfc3339("2026-09-01T00:00:00Z").unwrap().to_utc();
    let to = chrono::DateTime::parse_from_rfc3339("2026-10-12T00:00:00Z").unwrap().to_utc();
    let objects = dav::objects_between(&client(), &server.url(MAIL_HOST, "/dav/cal/"), from, to).await.unwrap();
    assert_eq!(objects.len(), 2);
    assert!(ical::parse(&objects[0].data).is_err(), "nested too deep");
    let parsed = ical::parse(&objects[1].data).unwrap();
    let group = ical::to_jscalendar(&parsed).unwrap();
    let mut budget = ical::Budget::default();
    let found = ical::instances(&parsed, &group, from, to, chrono_tz::UTC, &mut budget);
    let bytes: usize = found.iter().map(|instance| instance.event.to_string().len()).sum();
    assert!(bytes <= ical::MAX_SHOWN_BYTES && found.len() < 100, "{} occurrences, {bytes} bytes", found.len());
}
