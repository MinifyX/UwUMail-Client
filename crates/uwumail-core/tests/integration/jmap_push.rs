//! JMAP push subscriptions (RFC 8620 §7.2) as the engine keeps them for a push service such as
//! UnifiedPush, against a fake mail server on this machine that behaves like UwUMail Server 0.14
//! (docs/jmap-push.md there): the VAPID key in the session, a PushVerification for every new
//! subscription, at most seven days, `invalidProperties` for a wrong code. Runs everywhere.

use crate::support;

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use chrono::{DateTime, TimeDelta, Utc};
use serde_json::{Value, json};
use support::{Request, Response, Stub, http_stub};
use uwumail_core::jmap::{CORE, MAIL, WEBPUSH_VAPID};
use uwumail_core::jmap_push::{self, Endpoint, Subscription};
use uwumail_core::model::*;
use uwumail_core::secrets::MemorySecrets;
use uwumail_core::store::Store;
use uwumail_core::{Engine, EngineOptions};

const VAPID_KEY: &str = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const WEEK: TimeDelta = TimeDelta::days(7);

#[derive(Debug, Clone)]
struct Sub {
    id: String,
    device_client_id: String,
    url: String,
    keys: Value,
    types: Value,
    code: String,
    verified: bool,
    expires: DateTime<Utc>,
}

/// The fake server's side of things.
#[derive(Default)]
struct Server {
    web_push: bool,
    subscriptions: Vec<Sub>,
    made: usize,
    /// Every PushSubscription/set call as it came, and the methods of every call.
    sets: Vec<Value>,
    methods: Vec<String>,
}

type Shared = Arc<Mutex<Server>>;

fn session(web_push: bool) -> Value {
    let mut capabilities = json!({ CORE: { "maxObjectsInGet": 500 }, MAIL: {} });
    if web_push {
        capabilities[WEBPUSH_VAPID] = json!({ "applicationServerKey": VAPID_KEY });
    }
    json!({
        "capabilities": capabilities,
        "accounts": { "a1": { "name": "mini@a.test" } },
        "primaryAccounts": { MAIL: "a1" },
        "username": "mini@a.test",
        "apiUrl": "/api",
        "downloadUrl": "/download/{accountId}/{blobId}/{name}?type={type}",
        "uploadUrl": "/upload/{accountId}/",
        "state": "s1",
    })
}

fn utc_date(time: DateTime<Utc>) -> String {
    time.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// `expires` as UwUMail Server takes it: at most a week ahead, which `null` means too.
fn expires(asked: Option<&Value>) -> Result<DateTime<Utc>, Value> {
    let latest = Utc::now() + WEEK;
    match asked.and_then(Value::as_str) {
        None => Ok(latest),
        Some(date) => match DateTime::parse_from_rfc3339(date) {
            Ok(at) if at.with_timezone(&Utc) > Utc::now() => Ok(at.with_timezone(&Utc).min(latest)),
            _ => Err(json!({ "type": "invalidProperties", "properties": ["expires"] })),
        },
    }
}

fn push_subscription_set(server: &mut Server, arguments: &Value) -> Value {
    server.sets.push(arguments.clone());
    let mut created = json!({});
    let mut not_created = json!({});
    for (creation_id, object) in arguments["create"].as_object().into_iter().flatten() {
        let url = object["url"].as_str().unwrap_or_default();
        let keys = &object["keys"];
        if !url.starts_with("https://") || keys["p256dh"].as_str().is_none() || keys["auth"].as_str().is_none() {
            not_created[creation_id] = json!({ "type": "invalidProperties" });
            continue;
        }
        let Ok(until) = expires(object.get("expires")) else {
            not_created[creation_id] = json!({ "type": "invalidProperties" });
            continue;
        };
        server.made += 1;
        let sub = Sub {
            id: format!("w{}", server.made),
            device_client_id: object["deviceClientId"].as_str().unwrap_or_default().to_string(),
            url: url.to_string(),
            keys: keys.clone(),
            types: object["types"].clone(),
            code: format!("code-{}", server.made),
            verified: false,
            expires: until,
        };
        created[creation_id] = json!({ "id": sub.id, "expires": utc_date(until) });
        server.subscriptions.push(sub);
    }
    let mut updated = json!({});
    let mut not_updated = json!({});
    for (id, patch) in arguments["update"].as_object().into_iter().flatten() {
        let Some(sub) = server.subscriptions.iter_mut().find(|sub| &sub.id == id) else {
            not_updated[id] = json!({ "type": "notFound" });
            continue;
        };
        if let Some(code) = patch.get("verificationCode") {
            if code.as_str() != Some(sub.code.as_str()) {
                not_updated[id] = json!({ "type": "invalidProperties", "properties": ["verificationCode"] });
                continue;
            }
            sub.verified = true;
        }
        let mut answer = Value::Null;
        if let Some(asked) = patch.get("expires") {
            match expires(Some(asked)) {
                Ok(until) => {
                    sub.expires = until;
                    if asked.as_str() != Some(utc_date(until).as_str()) {
                        answer = json!({ "expires": utc_date(until) });
                    }
                }
                Err(error) => {
                    not_updated[id] = error;
                    continue;
                }
            }
        }
        updated[id] = answer;
    }
    let mut destroyed = Vec::new();
    for id in arguments["destroy"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        let before = server.subscriptions.len();
        server.subscriptions.retain(|sub| sub.id != id);
        if server.subscriptions.len() < before {
            destroyed.push(id.to_string());
        }
    }
    json!({ "created": created, "notCreated": not_created, "updated": updated, "notUpdated": not_updated,
        "destroyed": destroyed })
}

fn answer(server: &Shared, request: &Request) -> Response {
    let mut server = server.lock().unwrap();
    if request.path.starts_with("/.well-known/jmap") {
        return Response::json(&session(server.web_push));
    }
    let body: Value = serde_json::from_slice(&request.body).unwrap_or_default();
    let calls = body["methodCalls"].as_array().cloned().unwrap_or_default();
    let mut responses = Vec::new();
    for call in &calls {
        let (name, arguments, id) = (call[0].as_str().unwrap_or_default(), &call[1], &call[2]);
        server.methods.push(name.to_string());
        let result = match name {
            "PushSubscription/get" if server.web_push => {
                let wanted = arguments["ids"].as_array().map(|ids| ids.iter().filter_map(Value::as_str).collect());
                let list: Vec<Value> = server
                    .subscriptions
                    .iter()
                    .filter(|sub| wanted.as_ref().is_none_or(|ids: &Vec<&str>| ids.contains(&sub.id.as_str())))
                    .map(|sub| {
                        json!({ "id": sub.id, "deviceClientId": sub.device_client_id,
                            "verificationCode": sub.verified.then_some(&sub.code), "expires": utc_date(sub.expires),
                            "types": sub.types })
                    })
                    .collect();
                json!({ "list": list, "notFound": [] })
            }
            "PushSubscription/set" if server.web_push => push_subscription_set(&mut server, arguments),
            "Core/echo" => arguments.clone(),
            // Just enough for a sync of an empty mailbox.
            "Mailbox/get" => json!({ "accountId": "a1", "state": "m1", "notFound": [],
                "list": [{ "id": "m1", "name": "Inbox", "role": "inbox" }] }),
            "Email/get" => json!({ "accountId": "a1", "state": "e1", "list": [], "notFound": [] }),
            "Email/query" => json!({ "accountId": "a1", "ids": [], "position": 0, "queryState": "q1" }),
            "Email/changes" => json!({ "accountId": "a1", "oldState": "e1", "newState": "e1", "hasMoreChanges": false,
                "created": [], "updated": [], "destroyed": [] }),
            "Identity/get" => json!({ "accountId": "a1", "state": "i1", "list": [], "notFound": [] }),
            _ => {
                responses.push(json!(["error", { "type": "unknownMethod" }, id]));
                continue;
            }
        };
        responses.push(json!([name, result, id]));
    }
    Response::json(&json!({ "methodResponses": responses, "sessionState": "s1" }))
}

struct Setup {
    engine: Engine,
    account_id: String,
    server: Shared,
    _stub: Stub,
    data: tempfile::TempDir,
}

async fn setup(web_push: bool) -> Setup {
    let server: Shared = Arc::new(Mutex::new(Server { web_push, ..Server::default() }));
    let handler = Arc::clone(&server);
    let stub = http_stub(move |request| answer(&handler, request)).await;
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::new(EngineOptions {
        data_dir: data.path().to_path_buf(),
        secrets: Arc::new(MemorySecrets::default()),
        open_url: Arc::new(|_| {}),
        recognizer: None,
    })
    .unwrap();
    let no_server = ServerSettings { host: String::new(), port: 0, security: Security::Tls };
    let account = engine
        .add_account(NewAccount {
            display_name: "Mini".into(),
            email: "mini@a.test".into(),
            auth: AuthKind::Password,
            password: Some("dummy-password".into()),
            imap: no_server.clone(),
            smtp: no_server,
            username: "mini@a.test".into(),
            color: AccountColor::Pink,
            protocol: Protocol::Jmap,
            jmap_url: Some(stub.url("127.0.0.1", "/.well-known/jmap").to_string()),
            sign_in_as: None,
        })
        .await
        .expect("add the account");
    Setup { engine, account_id: account.id, server, _stub: stub, data }
}

impl Setup {
    fn subscriptions(&self) -> Vec<Sub> {
        self.server.lock().unwrap().subscriptions.clone()
    }

    fn sets(&self) -> Vec<Value> {
        self.server.lock().unwrap().sets.clone()
    }

    fn count(&self, method: &str) -> usize {
        self.server.lock().unwrap().methods.iter().filter(|m| *m == method).count()
    }

    /// The subscription as the engine keeps it, read from its database.
    fn record(&self) -> Option<Subscription> {
        let store = Store::open(&self.data.path().join("uwumail.db")).unwrap();
        let saved = store.sync_state(&self.account_id, "PushSubscription").unwrap()?;
        Some(serde_json::from_str(&saved).unwrap())
    }

    /// Makes the engine think the subscription was made or renewed `ago`.
    fn age(&self, ago: TimeDelta) {
        let store = Store::open(&self.data.path().join("uwumail.db")).unwrap();
        let mut record = self.record().expect("a subscription");
        record.renewed_at = (Utc::now() - ago).timestamp();
        store
            .set_sync_state(&self.account_id, "PushSubscription", Some(&serde_json::to_string(&record).unwrap()))
            .unwrap();
    }

    /// What the server pushes to a new subscription (RFC 8620 §7.2.2).
    fn verification(&self, sub: &Sub) -> Vec<u8> {
        json!({ "@type": "PushVerification", "pushSubscriptionId": sub.id, "verificationCode": sub.code })
            .to_string()
            .into_bytes()
    }

    /// Waits until the engine's own first sync of the account is done, so it doesn't run into
    /// what a test counts.
    async fn synced(&self, events: &mut tokio::sync::broadcast::Receiver<EngineEvent>) {
        tokio::time::timeout(std::time::Duration::from_secs(20), async {
            loop {
                match events.recv().await {
                    Ok(EngineEvent::AccountStatus { account_id, status: AccountStatus::Idle })
                        if account_id == self.account_id =>
                    {
                        return;
                    }
                    Ok(_) => {}
                    Err(error) => panic!("events ended: {error}"),
                }
            }
        })
        .await
        .expect("the first sync");
    }
}

fn endpoint(path: &str) -> Endpoint {
    let key = [&[4u8][..], &[7u8; 64][..]].concat();
    Endpoint {
        url: format!("https://push.example.net/up/{path}"),
        p256dh: B64.encode(key),
        auth: B64.encode([9u8; 16]),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn subscribes_verifies_renews_and_ends() {
    let setup = setup(true).await;
    let mut events = setup.engine.subscribe();
    setup.synced(&mut events).await;
    let engine = &setup.engine;
    let account = setup.account_id.as_str();

    let (targets, unreachable) = engine.push_targets().await.unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].account_id, account);
    assert_eq!(targets[0].vapid_key, VAPID_KEY);
    assert!(unreachable.is_empty());

    // Subscribing: the endpoint, its keys and a week, for every type and this device.
    engine.push_subscribe(account, "install-1", endpoint("one")).await.unwrap();
    let subs = setup.subscriptions();
    assert_eq!(subs.len(), 1);
    let first = subs[0].clone();
    assert_eq!(first.device_client_id, jmap_push::device_client_id("install-1", account));
    assert_eq!(first.url, "https://push.example.net/up/one");
    assert_eq!(first.keys, json!({ "p256dh": endpoint("one").p256dh, "auth": endpoint("one").auth }));
    assert_eq!(first.types, Value::Null, "every type");
    assert!(first.expires > Utc::now() + WEEK - TimeDelta::minutes(5));
    let create = &setup.sets()[0];
    assert!(create.get("accountId").is_none(), "push subscriptions belong to the login, not an account");
    let overview = engine.push_overview().unwrap();
    assert_eq!((overview.active, overview.waiting, overview.other), (0, 1, 0));
    assert!(!overview.covers_all(), "until the server verified the endpoint");

    // A verification for somebody else's subscription isn't answered.
    let foreign = Sub { id: "w99".into(), ..first.clone() };
    engine.push_received(account, &setup.verification(&foreign)).await.unwrap();
    assert_eq!(setup.sets().len(), 1);

    // The server's verification goes back to it.
    engine.push_received(account, &setup.verification(&first)).await.unwrap();
    assert_eq!(setup.sets()[1], json!({ "update": { "w1": { "verificationCode": "code-1" } } }));
    assert!(setup.subscriptions()[0].verified);
    let overview = engine.push_overview().unwrap();
    assert_eq!((overview.active, overview.waiting, overview.other), (1, 0, 0));
    assert!(overview.covers_all());

    // The app registers at every start: the same endpoint again changes nothing while it's fresh.
    engine.push_subscribe(account, "install-1", endpoint("one")).await.unwrap();
    engine.push_maintain().await.unwrap();
    assert_eq!(setup.sets().len(), 2);

    // About a day later it's renewed, for another week.
    setup.age(TimeDelta::hours(21));
    engine.push_maintain().await.unwrap();
    let renew = &setup.sets()[2];
    let asked = renew["update"]["w1"]["expires"].as_str().expect("a new end");
    let asked = DateTime::parse_from_rfc3339(asked).unwrap().with_timezone(&Utc);
    assert!(asked > Utc::now() + WEEK - TimeDelta::minutes(5) && asked <= Utc::now() + WEEK);
    let record = setup.record().unwrap();
    assert!(Utc::now().timestamp() - record.renewed_at < 60);
    assert!(record.verified);
    assert_eq!(setup.subscriptions().len(), 1);

    // A subscription the server lost is made again, and has to be verified again.
    setup.server.lock().unwrap().subscriptions.clear();
    setup.age(TimeDelta::hours(21));
    engine.push_maintain().await.unwrap();
    let subs = setup.subscriptions();
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].id, "w2");
    assert_eq!(subs[0].url, "https://push.example.net/up/one");
    let record = setup.record().unwrap();
    assert_eq!(record.id, "w2");
    assert!(!record.verified);

    // A verification that never comes: after a while the subscription is made anew.
    setup.age(TimeDelta::minutes(11));
    engine.push_maintain().await.unwrap();
    let subs = setup.subscriptions();
    assert_eq!(subs.iter().map(|sub| sub.id.as_str()).collect::<Vec<_>>(), ["w3"]);
    assert_eq!(setup.record().unwrap().lost, 1);
    engine.push_received(account, &setup.verification(&subs[0])).await.unwrap();
    assert_eq!(setup.record().unwrap().lost, 0);

    // A new endpoint (another distributor, new keys) replaces the subscription.
    engine.push_subscribe(account, "install-1", endpoint("two")).await.unwrap();
    let subs = setup.subscriptions();
    assert_eq!(subs.len(), 1, "the one for the old endpoint is gone: {subs:?}");
    assert_eq!(subs[0].url, "https://push.example.net/up/two");
    assert_eq!(setup.record().unwrap().id, subs[0].id);

    // Switched off: the server stops pushing.
    engine.push_unsubscribe(account).await.unwrap();
    assert!(setup.subscriptions().is_empty());
    assert!(setup.record().is_none());
    let overview = engine.push_overview().unwrap();
    assert_eq!((overview.active, overview.waiting, overview.other), (0, 0, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_push_wakes_a_sync_for_its_account() {
    let setup = setup(true).await;
    let mut events = setup.engine.subscribe();
    setup.synced(&mut events).await;
    let account = setup.account_id.as_str();
    let syncs = || setup.count("Mailbox/get");
    let before = syncs();

    // About accounts of the login UwUMail doesn't read: nothing to do.
    let elsewhere = json!({ "@type": "StateChange", "changed": { "b9": { "Email": "e7" } } });
    setup.engine.push_received(account, elsewhere.to_string().as_bytes()).await.unwrap();
    assert_eq!(syncs(), before);

    // New mail: synced before the call returns, so the phone stays awake for it.
    let mail = json!({ "@type": "StateChange", "changed": { "a1": { "Email": "e2", "EmailDelivery": "e2" } } });
    setup.engine.push_received(account, mail.to_string().as_bytes()).await.unwrap();
    assert_eq!(syncs(), before + 1);
    assert!(setup.count("Email/changes") > 0);

    // What isn't a JMAP push object is refused.
    assert!(setup.engine.push_received(account, b"{\"@type\":\"Hello\"}").await.is_err());
    assert_eq!(syncs(), before + 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn servers_without_web_push_keep_their_own_connection() {
    let setup = setup(false).await;
    let (targets, unreachable) = setup.engine.push_targets().await.unwrap();
    assert!(targets.is_empty() && unreachable.is_empty());
    let error = setup.engine.push_subscribe(&setup.account_id, "install-1", endpoint("one")).await.unwrap_err();
    assert_eq!(error.code, uwumail_core::ErrorCode::NotSupported, "{error:?}");
    assert_eq!(setup.count("PushSubscription/set") + setup.count("PushSubscription/get"), 0);
    let overview = setup.engine.push_overview().unwrap();
    assert_eq!((overview.active, overview.waiting, overview.other), (0, 0, 1));
    assert!(!overview.covers_all());
}
