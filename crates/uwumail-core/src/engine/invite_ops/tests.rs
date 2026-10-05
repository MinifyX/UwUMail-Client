//! Invitations end to end against fakes on 127.0.0.1: a mailbox without calendar (the copy on
//! this device, the REPLY over a fake SMTP server), Microsoft Graph and Google Calendar.

use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::*;
use crate::cloud::fake::{Reply, Request, Server};
use crate::oauth::TokenEndpoint;
use crate::secrets::MemorySecrets;
use crate::store::FolderInfo;

const OWN: &str = "mini@example.com";

fn ics(method: &str, sequence: u32, extra: &str) -> String {
    format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//Test//EN\r\nMETHOD:{method}\r\nBEGIN:VEVENT\r\n\
UID:kaffee-1@example.org\r\nDTSTAMP:20260917T080000Z\r\nDTSTART:20261020T070000Z\r\nDTEND:20261020T080000Z\r\n\
SUMMARY:Kaffee\r\nLOCATION:Café Nyu\r\nSEQUENCE:{sequence}\r\n{extra}\
ORGANIZER;CN=Emma Vogt:mailto:emma@example.org\r\n\
ATTENDEE;CN=Emma Vogt;PARTSTAT=ACCEPTED:mailto:emma@example.org\r\n\
ATTENDEE;CN=Mini;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:{OWN}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    )
}

fn mail(from: &str, calendar: &str) -> String {
    format!(
        "From: {from}\r\nTo: {OWN}\r\nSubject: Einladung: Kaffee\r\nMessage-ID: <{}@example.org>\r\n\
MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\n\
Kommst du?\r\n--b\r\nContent-Type: text/calendar; method=REQUEST; charset=utf-8\r\n\
Content-Disposition: attachment; filename=\"invite.ics\"\r\n\r\n{calendar}\r\n--b--\r\n",
        uuid::Uuid::new_v4()
    )
}

struct Setup {
    engine: Engine,
    inbox: String,
    uid: AtomicUsize,
    _dir: tempfile::TempDir,
}

impl Setup {
    /// Stores a mail as synced, with its attachments already downloaded.
    fn receive(&self, raw: &str) -> String {
        let parsed = crate::mime::parse(raw.as_bytes());
        let uid = self.uid.fetch_add(1, Ordering::SeqCst) as u32 + 1;
        let id = self
            .engine
            .inner
            .store
            .insert_message("m", &self.inbox, uid, MessageFlags::default(), raw.len() as u64, None, &parsed)
            .unwrap()
            .unwrap();
        for index in 0..parsed.attachments.len() {
            self.engine.inner.attachments.store_from_raw(&id, index, raw.as_bytes()).unwrap();
        }
        id
    }
}

async fn setup(auth: AuthKind, smtp_port: u16, secret: Secret) -> (Setup, Arc<MemorySecrets>) {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let engine = Engine::new(EngineOptions {
        data_dir: dir.path().to_path_buf(),
        secrets: secrets.clone(),
        open_url: Arc::new(|_| {}),
        recognizer: None,
    })
    .unwrap();
    let store = &engine.inner.store;
    store
        .insert_account(&AccountRecord {
            id: "m".into(),
            name: "Mini".into(),
            email: OWN.into(),
            display_name: "Mini".into(),
            color: AccountColor::Pink,
            auth,
            username: OWN.into(),
            imap: ServerSettings { host: "127.0.0.1".into(), port: 1, security: Security::None },
            smtp: ServerSettings { host: "127.0.0.1".into(), port: smtp_port, security: Security::None },
            protocol: Protocol::Imap,
            jmap_url: None,
        })
        .unwrap();
    secrets.set("m", &secret).unwrap();
    let inbox = store
        .upsert_folder(
            "m",
            &FolderInfo {
                path: "INBOX",
                name: "INBOX",
                role: Some(FolderRole::Inbox),
                delimiter: Some("/"),
                selectable: true,
                parent_ref: None,
            },
        )
        .unwrap();
    (Setup { engine, inbox, uid: AtomicUsize::new(0), _dir: dir }, secrets)
}

/// A mailbox without any calendar: discovery is never asked (it would go to the internet).
async fn without_calendar(engine: &Engine) {
    engine.inner.calendar_sources.lock().await.insert(
        "m".into(),
        calendar::SourceState::Unavailable {
            problem: Error::not_supported("No calendar server was found for this mailbox."),
            since: std::time::Instant::now(),
        },
    );
}

/// An SMTP server that takes any login and keeps what it is sent: (recipients, message).
async fn fake_smtp() -> (u16, Arc<StdMutex<Vec<(Vec<String>, String)>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let received = Arc::new(StdMutex::new(Vec::new()));
    let kept = Arc::clone(&received);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let kept = Arc::clone(&kept);
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut lines = BufReader::new(read).lines();
                let _ = write.write_all(b"220 fake.test ESMTP\r\n").await;
                let mut recipients = Vec::new();
                while let Ok(Some(line)) = lines.next_line().await {
                    let upper = line.to_ascii_uppercase();
                    let answer: &[u8] = if upper.starts_with("EHLO") {
                        b"250-fake.test\r\n250 AUTH PLAIN LOGIN\r\n"
                    } else if upper.starts_with("AUTH") {
                        b"235 ok\r\n"
                    } else if upper.starts_with("RCPT TO:") {
                        recipients.push(line[8..].trim().trim_matches(['<', '>']).to_string());
                        b"250 ok\r\n"
                    } else if upper.starts_with("DATA") {
                        let _ = write.write_all(b"354 go on\r\n").await;
                        let mut data = String::new();
                        while let Ok(Some(line)) = lines.next_line().await {
                            if line == "." {
                                break;
                            }
                            data.push_str(&line);
                            data.push_str("\r\n");
                        }
                        kept.lock().unwrap().push((std::mem::take(&mut recipients), data));
                        b"250 queued\r\n"
                    } else if upper.starts_with("QUIT") {
                        let _ = write.write_all(b"221 bye\r\n").await;
                        break;
                    } else {
                        b"250 ok\r\n"
                    };
                    if write.write_all(answer).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    (port, received)
}

fn the_calendar_part(raw: &str) -> String {
    use mail_parser::MimeHeaders;
    let parsed = mail_parser::MessageParser::default().parse(raw.as_bytes()).unwrap();
    parsed
        .parts
        .iter()
        .find(|part| part.content_type().is_some_and(|ct| ct.ctype() == "text" && ct.subtype() == Some("calendar")))
        .and_then(|part| part.text_contents())
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn without_a_calendar_the_copy_stays_here_and_the_organizer_gets_a_reply() {
    let (port, sent) = fake_smtp().await;
    let (setup, _) = setup(AuthKind::Password, port, Secret::Password { password: "pw".into() }).await;
    let engine = &setup.engine;
    without_calendar(engine).await;
    let id = setup.receive(&mail("Emma Vogt <emma@example.org>", &ics("REQUEST", 0, "")));

    let shown = engine.mail_invitation(&id).await.unwrap().unwrap();
    assert_eq!(shown.kind, "invitation");
    assert_eq!(shown.title, "Kaffee");
    assert_eq!(shown.location, "Café Nyu");
    assert_eq!(shown.start.as_deref(), Some("2026-10-20T07:00:00Z"));
    assert_eq!(shown.organizer.as_deref(), Some("Emma Vogt"));
    assert_eq!(shown.attendees.len(), 2);
    assert!(shown.attendees[0].email == "emma@example.org", "the organizer first");
    assert!(shown.verified && shown.can_answer && shown.can_comment && !shown.in_calendar);
    assert!(!shown.sender_confirmed, "no Authentication-Results");
    assert_eq!(shown.place, InvitePlace::Device);
    assert_eq!(shown.status, Partstat::NeedsAction);
    assert!(sent.lock().unwrap().is_empty(), "showing it sends nothing");

    engine
        .respond_to_invitation(&id, Partstat::Accepted, Some("Gern, ich bringe Kuchen mit."), Some("de"))
        .await
        .unwrap();
    let mails = sent.lock().unwrap().clone();
    assert_eq!(mails.len(), 1);
    let (recipients, raw) = &mails[0];
    assert_eq!(recipients, &vec!["emma@example.org".to_string()]);
    assert!(raw.contains("Subject: Angenommen: Kaffee"), "{raw}");
    let reply = Component::parse(&the_calendar_part(raw)).unwrap();
    assert_eq!(itip::method(&reply).as_deref(), Some("REPLY"));
    assert_eq!(itip::partstats(&reply, OWN), vec![(None, "ACCEPTED".to_string())]);
    assert_eq!(itip::unescape(reply.main_event().unwrap().value("COMMENT").unwrap()), "Gern, ich bringe Kuchen mit.");

    // The event is in the calendar "Invitations" on this device, answered.
    let calendars = engine.calendars().await.unwrap();
    let local = calendars.iter().find(|c| c.id == format!("m:{LOCAL_INVITES}")).expect("the invitations calendar");
    assert!(local.is_local && !local.may_write);
    let events = engine.calendar_events("2026-10-19T00:00:00", "2026-10-22T00:00:00", "Europe/Berlin").await.unwrap();
    let event = events.iter().find(|e| e.calendar_id == local.id).expect("its event");
    assert_eq!((event.title.as_str(), event.start.as_str()), ("Kaffee", "2026-10-20T09:00:00"));
    assert!(event.read_only);
    let again = engine.mail_invitation(&id).await.unwrap().unwrap();
    assert_eq!((again.status, again.revision, again.in_calendar), (Partstat::Accepted, Revision::Same, true));
    assert!(engine.update_event(&event.event_id, sample_input(&local.id), None).await.is_err());

    // An update at another time asks again; an older mail than the calendar has can't be answered.
    let moved = ics("REQUEST", 2, "").replace("20261020T07", "20261021T07");
    let update = setup.receive(&mail("emma@example.org", &moved));
    let shown = engine.mail_invitation(&update).await.unwrap().unwrap();
    assert_eq!(shown.revision, Revision::Update);
    engine.respond_to_invitation(&update, Partstat::Tentative, None, None).await.unwrap();
    let old = engine.mail_invitation(&id).await.unwrap().unwrap();
    assert_eq!(old.revision, Revision::Outdated);
    assert!(!old.can_answer);
    assert!(engine.respond_to_invitation(&id, Partstat::Declined, None, None).await.is_err());
    assert_eq!(sent.lock().unwrap().len(), 2, "the outdated mail sent nothing");
    assert!(sent.lock().unwrap()[1].1.contains("Subject: Tentative: Kaffee"));

    // The organizer cancels: the event can go, on a click.
    let cancel = setup.receive(&mail("emma@example.org", &ics("CANCEL", 3, "STATUS:CANCELLED\r\n")));
    let shown = engine.mail_invitation(&cancel).await.unwrap().unwrap();
    assert!(shown.cancelled && shown.can_remove && !shown.can_answer);
    engine.remove_cancelled_event(&cancel).await.unwrap();
    assert!(engine.inner.store.local_invites("m").unwrap().is_empty());
    assert!(engine.calendars().await.unwrap().iter().all(|c| c.id != local.id), "the empty calendar goes");
    assert_eq!(sent.lock().unwrap().len(), 2, "removing tells no one");
}

fn sample_input(calendar_id: &str) -> EventInput {
    EventInput {
        calendar_id: calendar_id.into(),
        title: "Changed".into(),
        description: String::new(),
        location: String::new(),
        all_day: false,
        start: "2026-10-20T09:00:00".into(),
        end: "2026-10-20T10:00:00".into(),
        time_zone: Some("Europe/Berlin".into()),
        recurrence: None,
    }
}

#[tokio::test]
async fn invitations_from_someone_else_are_shown_but_never_answered() {
    let (port, sent) = fake_smtp().await;
    let (setup, _) = setup(AuthKind::Password, port, Secret::Password { password: "pw".into() }).await;
    let engine = &setup.engine;
    without_calendar(engine).await;
    let forged = setup.receive(&mail("Mallory <mallory@example.net>", &ics("REQUEST", 0, "")));
    let shown = engine.mail_invitation(&forged).await.unwrap().unwrap();
    assert!(!shown.verified && !shown.can_answer);
    assert_eq!(shown.sender, "mallory@example.net");
    assert!(engine.respond_to_invitation(&forged, Partstat::Accepted, None, None).await.is_err());
    let cancel = setup.receive(&mail("mallory@example.net", &ics("CANCEL", 5, "")));
    assert!(!engine.mail_invitation(&cancel).await.unwrap().unwrap().can_remove);
    assert!(engine.remove_cancelled_event(&cancel).await.is_err());
    assert!(sent.lock().unwrap().is_empty());
    assert!(engine.inner.store.local_invites("m").unwrap().is_empty());

    // Not for this mailbox at all, or not an invitation: nothing to show.
    let other = ics("REQUEST", 0, "").replace(&format!("mailto:{OWN}"), "mailto:leni@example.net");
    assert!(engine.mail_invitation(&setup.receive(&mail("emma@example.org", &other))).await.unwrap().is_none());
    let plain = "From: emma@example.org\r\nTo: mini@example.com\r\nSubject: Hi\r\n\r\nHallo\r\n";
    assert!(engine.mail_invitation(&setup.receive(plain)).await.unwrap().is_none());
    // A part too big to be anyone's invitation, or no calendar at all, is no invitation and no panic.
    let huge = ics("REQUEST", 0, &format!("DESCRIPTION:{}\r\n", "x".repeat(invite::MAX_ICS_BYTES)));
    assert!(engine.mail_invitation(&setup.receive(&mail("emma@example.org", &huge))).await.unwrap().is_none());
    let deep = format!("BEGIN:VCALENDAR\r\n{}END:VCALENDAR\r\n", "BEGIN:VEVENT\r\n".repeat(5000));
    assert!(engine.mail_invitation(&setup.receive(&mail("emma@example.org", &deep))).await.unwrap().is_none());
    assert!(engine.respond_to_invitation("nothing", Partstat::Accepted, None, None).await.is_err());
}

#[tokio::test]
async fn answers_to_own_events_show_who_answered() {
    let (setup, _) = setup(AuthKind::Password, 1, Secret::Password { password: "pw".into() }).await;
    let engine = &setup.engine;
    without_calendar(engine).await;
    let reply = ics("REPLY", 0, "")
        .replace("mailto:emma@example.org", "mailto:organizer-tmp")
        .replace(&format!("mailto:{OWN}"), "mailto:emma@example.org")
        .replace("mailto:organizer-tmp", &format!("mailto:{OWN}"))
        .replace("PARTSTAT=NEEDS-ACTION;RSVP=TRUE", "PARTSTAT=DECLINED");
    let id = setup.receive(&mail("emma@example.org", &reply));
    let shown = engine.mail_invitation(&id).await.unwrap().unwrap();
    assert_eq!(shown.kind, "reply");
    assert!(shown.verified && !shown.can_answer);
    assert_eq!(shown.attendee_email.as_deref(), Some("emma@example.org"));
    let from_stranger = setup.receive(&mail("mallory@example.net", &reply));
    assert!(!engine.mail_invitation(&from_stranger).await.unwrap().unwrap().verified);
}

fn token_reply(request: &Request, count: &AtomicUsize) -> Reply {
    let n = count.fetch_add(1, Ordering::SeqCst) + 1;
    let scope = request.form("scope").unwrap_or_else(|| crate::oauth::GOOGLE_CALENDAR_SCOPE.to_string());
    Reply::json(
        json!({ "access_token": format!("access-{n}"), "refresh_token": format!("refresh-{n}"), "expires_in": 3600, "scope": scope }),
    )
}

async fn cloud_setup(auth: AuthKind, handler: impl Fn(&Request) -> Reply + Send + Sync + 'static) -> (Setup, Server) {
    let (setup, _) = setup(auth, 1, Secret::oauth("refresh-0", None)).await;
    let server = Server::start(handler).await;
    let token =
        TokenEndpoint { url: format!("{}/token", server.base), client_id: "test-app".into(), client_secret: None };
    setup.engine.set_cloud_endpoints(cloud::Endpoints {
        graph: server.url("/graph/"),
        google_calendar: server.url("/gcal/"),
        google_people: server.url("/people/"),
        microsoft_token: Some(token.clone()),
        microsoft_business_token: None,
        google_token: Some(token),
    });
    (setup, server)
}

#[tokio::test]
async fn microsoft_answers_through_graph() {
    let tokens = Arc::new(AtomicUsize::new(0));
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = Arc::clone(&cancelled);
    let (setup, server) = cloud_setup(AuthKind::Microsoft, move |request: &Request| {
        let path = request.path();
        match (request.method.as_str(), path) {
            (_, "/token") => token_reply(request, &tokens),
            ("GET", "/graph/me") => Reply::json(json!({ "mail": OWN, "userPrincipalName": OWN })),
            ("GET", "/graph/me/events") => {
                assert_eq!(request.query("$filter").as_deref(), Some("iCalUId eq 'kaffee-1@example.org'"));
                Reply::json(json!({ "value": [{
                    "id": "EV/1", "type": "singleInstance", "isCancelled": flag.load(Ordering::SeqCst),
                    "responseStatus": { "response": "notResponded" },
                    "organizer": { "emailAddress": { "address": "Emma@example.org" } }
                }] }))
            }
            ("POST", "/graph/me/events/EV%2F1/tentativelyAccept") => Reply::empty(),
            ("DELETE", "/graph/me/events/EV%2F1") => Reply::empty(),
            _ => Reply::status(404, json!({ "error": { "code": "ErrorItemNotFound" } })),
        }
    })
    .await;
    let engine = &setup.engine;
    let id = setup.receive(&mail("emma@example.org", &ics("REQUEST", 0, "")));
    let shown = engine.mail_invitation(&id).await.unwrap().unwrap();
    assert_eq!(shown.place, InvitePlace::Microsoft);
    assert!(shown.can_answer && shown.can_comment && shown.in_calendar);
    engine.respond_to_invitation(&id, Partstat::Tentative, Some("Vielleicht später"), None).await.unwrap();
    let posted =
        server.seen().into_iter().find(|r| r.method == "POST" && r.path().ends_with("tentativelyAccept")).unwrap();
    assert_eq!(posted.json(), json!({ "sendResponse": true, "comment": "Vielleicht später" }));
    assert!(engine.inner.store.local_invites("m").unwrap().is_empty(), "Microsoft keeps it");

    // Microsoft cancelled it: it can go from the calendar.
    cancelled.store(true, Ordering::SeqCst);
    let cancel = setup.receive(&mail("emma@example.org", &ics("CANCEL", 1, "")));
    let shown = engine.mail_invitation(&cancel).await.unwrap().unwrap();
    assert!(shown.cancelled && shown.can_remove);
    engine.remove_cancelled_event(&cancel).await.unwrap();
    assert_eq!(server.count("DELETE", "/graph/me/events/"), 1);

    // An event under this UID with another organizer: the mail isn't believed.
    let other = ics("REQUEST", 0, "").replace("mailto:emma@example.org", "mailto:mallory@example.net");
    let other = setup.receive(&mail("mallory@example.net", &other));
    assert!(!engine.mail_invitation(&other).await.unwrap().unwrap().verified);
}

#[tokio::test]
async fn google_answers_through_the_calendar_api() {
    let tokens = Arc::new(AtomicUsize::new(0));
    let (setup, server) =
        cloud_setup(AuthKind::Google, move |request: &Request| match (request.method.as_str(), request.path()) {
            (_, "/token") => token_reply(request, &tokens),
            ("GET", "/gcal/users/me/calendarList") => Reply::json(json!({ "items": [] })),
            ("GET", "/gcal/calendars/primary/events") => {
                assert_eq!(request.query("iCalUID").as_deref(), Some("kaffee-1@example.org"));
                Reply::json(json!({ "items": [{
                    "id": "g1", "status": "confirmed", "organizer": { "email": "emma@example.org" },
                    "attendees": [
                        { "email": "emma@example.org", "organizer": true, "responseStatus": "accepted" },
                        { "email": OWN, "self": true, "responseStatus": "needsAction" }
                    ]
                }] }))
            }
            ("PATCH", "/gcal/calendars/primary/events/g1") => Reply::json(json!({ "id": "g1" })),
            _ => Reply::status(404, json!({ "error": { "code": 404 } })),
        })
        .await;
    let engine = &setup.engine;
    let id = setup.receive(&mail("emma@example.org", &ics("REQUEST", 0, "")));
    let shown = engine.mail_invitation(&id).await.unwrap().unwrap();
    assert_eq!(shown.place, InvitePlace::Google);
    assert!(shown.can_answer);
    engine.respond_to_invitation(&id, Partstat::Declined, None, None).await.unwrap();
    let patched = server.seen().into_iter().find(|r| r.method == "PATCH").unwrap();
    assert_eq!(patched.query("sendUpdates").as_deref(), Some("all"));
    let attendees = patched.json()["attendees"].clone();
    assert_eq!(attendees[1]["responseStatus"], "declined");
    assert_eq!(attendees[0]["responseStatus"], "accepted", "the others stay as they are");
}

#[tokio::test]
async fn a_known_uid_never_overwrites_or_removes_an_unrelated_own_event() {
    let (port, sent) = fake_smtp().await;
    let (setup, _) = setup(AuthKind::Password, port, Secret::Password { password: "pw".into() }).await;
    let engine = &setup.engine;
    without_calendar(engine).await;
    // Events of the person's own with the invitation's UID (e.g. from an exported .ics): one
    // without organizer, one where they aren't invited (IV-2).
    let personal = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//Test//EN\r\nBEGIN:VEVENT\r\n\
UID:kaffee-1@example.org\r\nDTSTAMP:20260917T080000Z\r\nDTSTART:20261020T070000Z\r\nSUMMARY:Zahnarzt\r\n\
END:VEVENT\r\nEND:VCALENDAR\r\n";
    let not_invited = ics("REQUEST", 0, "").replace(&format!("mailto:{OWN}"), "mailto:leni@example.net");
    for stored in [personal.to_string(), not_invited.replace("METHOD:REQUEST\r\n", "")] {
        engine.inner.store.set_local_invite("m", "kaffee-1@example.org", &stored, 1).unwrap();
        let request = setup.receive(&mail("Emma Vogt <emma@example.org>", &ics("REQUEST", 1, "")));
        let shown = engine.mail_invitation(&request).await.unwrap().unwrap();
        assert!(!shown.verified && !shown.can_answer, "shown as not verified");
        assert!(engine.respond_to_invitation(&request, Partstat::Accepted, None, None).await.is_err());
        let cancel = setup.receive(&mail("emma@example.org", &ics("CANCEL", 3, "STATUS:CANCELLED\r\n")));
        assert!(!engine.mail_invitation(&cancel).await.unwrap().unwrap().can_remove);
        assert!(engine.remove_cancelled_event(&cancel).await.is_err());
        assert_eq!(
            engine.inner.store.local_invite("m", "kaffee-1@example.org").unwrap().as_deref(),
            Some(stored.as_str()),
            "the own event stays as it was"
        );
        assert!(sent.lock().unwrap().is_empty());
    }
}
