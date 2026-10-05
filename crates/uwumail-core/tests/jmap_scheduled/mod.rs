//! Server-held "send later" against a UwUMail-like JMAP server on this machine: a new time never
//! lets the mail go twice (security review 0.10 SL-1, SL-6).

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use uwumail_core::ErrorCode;
use uwumail_core::jmap::{CORE, Client, MAIL, SUBMISSION};
use uwumail_core::jmap_scheduled;
use uwumail_core::store::Store;

use crate::support::{Request, Response, Stub, http_stub};

const SETTINGS: &str = "urn:uwumail:jmap:settings";

fn session() -> Value {
    json!({
        "capabilities": { CORE: {}, MAIL: {}, SUBMISSION: {}, SETTINGS: {} },
        "accounts": { "a1": { "name": "mini@a.test", "accountCapabilities": {
            SUBMISSION: { "maxDelayedSend": 31_536_000 } } } },
        "primaryAccounts": { MAIL: "a1", SUBMISSION: "a1", SETTINGS: "a1" },
        "username": "mini@a.test",
        "apiUrl": "/api",
        "downloadUrl": "/download/{accountId}/{blobId}/{name}?type={type}",
        "uploadUrl": "/upload/{accountId}/",
        "state": "s1",
    })
}

/// How the fake server answers the cancel and the new submission.
#[derive(Clone, Copy)]
enum Server {
    /// Everything as it should be.
    Fine,
    /// The held mail went out just before the cancel arrived.
    AlreadySent,
    /// The cancel's answer says nothing; the submission is still pending.
    SilentCancel,
    /// The new submission is made, but its answer gets lost on the way back.
    LostAnswer,
    /// Like `LostAnswer`, but the new submission was sent at once ("send now"): it is `final`.
    LostAnswerSent,
    /// The answer gets lost and the server made no new submission.
    LostAnswerNothing,
}

fn answer(server: Server, request: &Request, canceled: &Mutex<bool>) -> Response {
    if request.path.starts_with("/.well-known/jmap") {
        return Response::json(&session());
    }
    let body: Value = serde_json::from_slice(&request.body).unwrap_or_default();
    let calls = body["methodCalls"].as_array().cloned().unwrap_or_default();
    let creates = calls.iter().any(|call| call[1].get("create").is_some());
    let lost = matches!(server, Server::LostAnswer | Server::LostAnswerSent | Server::LostAnswerNothing);
    if creates && lost {
        return Response::new(502, "gateway timeout");
    }
    let responses: Vec<Value> = calls
        .iter()
        .map(|call| {
            let (name, arguments, id) = (call[0].as_str().unwrap_or_default(), &call[1], &call[2]);
            let status = if *canceled.lock().unwrap() { "canceled" } else { "pending" };
            let result = match name {
                // The lookup after a lost answer: every submission of the mail.
                "EmailSubmission/get" if arguments.get("#ids").is_some() => match server {
                    Server::LostAnswerSent => json!({ "list": [
                        { "id": "S1", "undoStatus": "canceled" }, { "id": "S2", "undoStatus": "final" }] }),
                    Server::LostAnswerNothing => json!({ "list": [{ "id": "S1", "undoStatus": "canceled" }] }),
                    _ => json!({ "list": [
                        { "id": "S1", "undoStatus": "canceled" }, { "id": "S2", "undoStatus": "pending" }] }),
                },
                "EmailSubmission/get" => json!({ "list": [{ "id": "S1", "identityId": "i1", "emailId": "M1",
                    "envelope": { "mailFrom": { "email": "mini@a.test" }, "rcptTo": [{ "email": "kim@b.test" }] },
                    "undoStatus": status }] }),
                "EmailSubmission/set" if arguments.get("update").is_some() => match server {
                    Server::AlreadySent => json!({ "notUpdated": { "S1": { "type": "cannotUnsend" } } }),
                    Server::SilentCancel => json!({}),
                    Server::Fine | Server::LostAnswer | Server::LostAnswerSent | Server::LostAnswerNothing => {
                        *canceled.lock().unwrap() = true;
                        json!({ "updated": { "S1": null } })
                    }
                },
                "EmailSubmission/set" => json!({ "created": { "again": { "id": "S2" } } }),
                "EmailSubmission/query" => match server {
                    Server::LostAnswerNothing => json!({ "ids": ["S1"] }),
                    _ => json!({ "ids": ["S1", "S2"] }),
                },
                _ => json!({}),
            };
            json!([name, result, id])
        })
        .collect();
    Response::json(&json!({ "methodResponses": responses, "sessionState": "s1" }))
}

async fn server(server: Server) -> (Stub, Client) {
    let canceled = Arc::new(Mutex::new(false));
    let stub = http_stub(move |request| answer(server, request, &canceled)).await;
    let http = reqwest::Client::builder().build().unwrap();
    let client =
        Client::connect(&http, stub.url("127.0.0.1", "/.well-known/jmap").as_str(), "mini@a.test", "pw").await.unwrap();
    (stub, client)
}

/// Every JMAP request body the stub got, as text.
fn requests(stub: &Stub) -> Vec<String> {
    stub.seen().iter().filter(|r| r.path == "/api").map(Request::text).collect()
}

#[tokio::test]
async fn a_new_time_cancels_first_and_submits_again_in_a_request_of_its_own() {
    let (stub, client) = server(Server::Fine).await;
    let store = Store::open_in_memory().unwrap();
    let id = jmap_scheduled::resubmit(&client, &store, "acc", "S1", "2030-01-01T08:00:00Z").await.unwrap();
    assert_eq!(id, "S2");
    let sent = requests(&stub);
    let cancel = sent.iter().position(|body| body.contains("canceled")).unwrap();
    let create = sent.iter().position(|body| body.contains("\"create\"")).unwrap();
    assert!(cancel < create, "the new submission only after the cancel");
    assert!(!sent[cancel].contains("\"create\""), "never in the same request as the cancel");
}

#[tokio::test]
async fn a_mail_already_on_its_way_is_never_submitted_again() {
    for kind in [Server::AlreadySent, Server::SilentCancel] {
        let (stub, client) = server(kind).await;
        let store = Store::open_in_memory().unwrap();
        let error = jmap_scheduled::resubmit(&client, &store, "acc", "S1", "2030-01-01T08:00:00Z").await.unwrap_err();
        if matches!(kind, Server::AlreadySent) {
            assert_eq!(error.code, ErrorCode::NotFound, "too late");
        }
        assert!(requests(&stub).iter().all(|body| !body.contains("\"create\"")), "no second submission");
        // Stopping it isn't confirmed either, so it isn't moved anywhere.
        assert!(jmap_scheduled::cancel(&client, "S1").await.is_err());
    }
}

#[tokio::test]
async fn a_lost_answer_to_the_new_submission_finds_the_one_the_server_made() {
    let (stub, client) = server(Server::LostAnswer).await;
    let store = Store::open_in_memory().unwrap();
    let id = jmap_scheduled::resubmit(&client, &store, "acc", "S1", "2030-01-01T08:00:00Z").await.unwrap();
    assert_eq!(id, "S2", "the server's own submission, not a third one");
    let creates = requests(&stub).iter().filter(|body| body.contains("\"create\"")).count();
    assert_eq!(creates, 1, "never submitted twice");
}

#[tokio::test]
async fn a_lost_answer_to_send_now_finds_the_mail_already_sent_and_keeps_it_out_of_drafts() {
    let (stub, client) = server(Server::LostAnswerSent).await;
    let store = Store::open_in_memory().unwrap();
    let id = jmap_scheduled::resubmit(&client, &store, "acc", "S1", "2030-01-01T08:00:00Z").await.unwrap();
    assert_eq!(id, "S2", "the final submission counts as taken (SL-11)");
    let sent = requests(&stub);
    assert_eq!(sent.iter().filter(|body| body.contains("\"create\"")).count(), 1, "never submitted twice");
    assert!(sent.iter().all(|body| !body.contains("$draft")), "never moved to Drafts");
    let lookup = sent.iter().find(|body| body.contains("EmailSubmission/query")).unwrap();
    assert!(!lookup.contains("undoStatus\":\"pending"), "the lookup isn't limited to waiting submissions");
}

#[tokio::test]
async fn a_lost_answer_without_any_new_submission_reports_that_it_didnt_take() {
    let (_stub, client) = server(Server::LostAnswerNothing).await;
    let store = Store::open_in_memory().unwrap();
    let error = jmap_scheduled::resubmit(&client, &store, "acc", "S1", "2030-01-01T08:00:00Z").await.unwrap_err();
    // The cancelled old submission alone doesn't count as the new one.
    assert!(error.message.contains("didn't take"), "{}", error.message);
}
