//! "Sign in with UwUMail" against a fake UwUMail server on this machine: metadata, registration,
//! the browser round trip (loopback and app link), the token and the app password. Runs everywhere.

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uwumail_core::oauth::Redirect;
use uwumail_core::uwumail_login::{self, Clients};

use crate::support::{self, Request, Response, https_stub};

/// What the fake server saw of the sign-in.
#[derive(Default)]
struct Seen {
    challenge: Option<String>,
    redirect_uri: Option<String>,
    registered: Vec<Value>,
    app_password_names: Vec<String>,
}

#[derive(Clone, Copy)]
struct Behaviour {
    offers_app_passwords: bool,
    grants_scope: bool,
}

fn origin_of(request: &Request) -> String {
    format!("https://{}", request.header("host").unwrap_or("localhost"))
}

fn query(request: &Request) -> std::collections::HashMap<String, String> {
    let url = url::Url::parse(&format!("https://localhost{}", request.path)).unwrap();
    url.query_pairs().into_owned().collect()
}

fn form(request: &Request) -> std::collections::HashMap<String, String> {
    url::form_urlencoded::parse(&request.body).into_owned().collect()
}

fn fake_server(seen: Arc<Mutex<Seen>>, behaviour: Behaviour) -> impl Fn(&Request) -> Response + Send + Sync {
    move |request| {
        let origin = origin_of(request);
        let path = request.path.split('?').next().unwrap_or_default();
        match (request.method.as_str(), path) {
            ("GET", "/.well-known/oauth-authorization-server") => {
                let mut scopes = vec!["openid", "mail", "smtp", "dav"];
                if behaviour.offers_app_passwords {
                    scopes.push("app-password");
                }
                Response::json(&json!({
                    "issuer": origin,
                    "authorization_endpoint": format!("{origin}/oauth/authorize"),
                    "token_endpoint": format!("{origin}/oauth/token"),
                    "registration_endpoint": format!("{origin}/oauth/register"),
                    "scopes_supported": scopes,
                    "code_challenge_methods_supported": ["S256"],
                }))
            }
            ("POST", "/oauth/register") => {
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                seen.lock().unwrap().registered.push(body.clone());
                Response::new(
                    201,
                    json!({ "client_id": "uwu-test", "redirect_uris": body["redirect_uris"] }).to_string(),
                )
                .header("Content-Type", "application/json")
            }
            ("GET", "/oauth/authorize") => {
                let q = query(request);
                assert_eq!(q["scope"], "app-password");
                assert_eq!(q["code_challenge_method"], "S256");
                assert_eq!(q["client_id"], "uwu-test");
                let mut s = seen.lock().unwrap();
                s.challenge = Some(q["code_challenge"].clone());
                s.redirect_uri = Some(q["redirect_uri"].clone());
                let mut back = url::Url::parse(&q["redirect_uri"]).unwrap();
                back.query_pairs_mut()
                    .append_pair("code", "c1")
                    .append_pair("state", &q["state"])
                    .append_pair("iss", &origin);
                Response::new(302, "").header("Location", back.as_str())
            }
            ("POST", "/oauth/token") => {
                let f = form(request);
                let s = seen.lock().unwrap();
                let verified = URL_SAFE_NO_PAD.encode(Sha256::digest(f["code_verifier"].as_bytes()));
                if f["code"] != "c1"
                    || Some(&verified) != s.challenge.as_ref()
                    || Some(&f["redirect_uri"]) != s.redirect_uri.as_ref()
                {
                    return Response::new(400, json!({ "error": "invalid_grant" }).to_string());
                }
                let scope = if behaviour.grants_scope { "app-password" } else { "mail" };
                Response::json(
                    &json!({ "access_token": "uwu_at_1", "token_type": "Bearer", "expires_in": 3600, "scope": scope }),
                )
            }
            ("POST", "/oauth/app-password") => {
                if request.header("authorization") != Some("Bearer uwu_at_1") || !behaviour.grants_scope {
                    return Response::new(403, json!({ "error": "insufficient_scope" }).to_string())
                        .header("WWW-Authenticate", "Bearer error=\"insufficient_scope\"");
                }
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                let name = body["name"].as_str().unwrap().to_string();
                seen.lock().unwrap().app_password_names.push(name.clone());
                Response::new(
                    201,
                    json!({ "id": 7, "name": name, "username": "lorin@example.org", "password": "app-secret",
                            "scopes": ["mail", "smtp", "dav"] })
                    .to_string(),
                )
                .header("Content-Type", "application/json")
            }
            _ => Response::new(404, ""),
        }
    }
}

fn http() -> reqwest::Client {
    support::http_builder(&[support::stub_certificate().0.clone()])
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .unwrap()
}

/// A browser: follows the authorize page's redirect back to the app, wherever that is.
fn browser() -> impl Fn(&str) + Send + Sync {
    let client = support::http_builder(&[support::stub_certificate().0.clone()]).no_proxy().build().unwrap();
    move |url: &str| {
        let (client, url) = (client.clone(), url.to_string());
        tokio::spawn(async move {
            let _ = client.get(url).send().await;
        });
    }
}

#[tokio::test]
async fn signs_in_through_the_loopback_and_makes_a_named_app_password() {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let stub =
        https_stub(fake_server(seen.clone(), Behaviour { offers_app_passwords: true, grants_scope: true })).await;
    let session = stub.url("localhost", "/.well-known/jmap").to_string();
    let http = http();
    let meta = uwumail_login::metadata(&http, &session).await.expect("a UwUMail server");
    let clients = Clients::default();

    let made = uwumail_login::sign_in(
        &http,
        &meta,
        &clients,
        "  Lorins MacBook ",
        "lorin@example.org",
        &browser(),
        Redirect::Loopback,
    )
    .await
    .expect("an app password");
    assert_eq!((made.username.as_str(), made.password.as_str()), ("lorin@example.org", "app-secret"));

    let seen = seen.lock().unwrap();
    assert_eq!(seen.app_password_names, ["Lorins MacBook"]);
    let registered = &seen.registered[0];
    assert_eq!(registered["client_name"], "UwUMail – Lorins MacBook");
    assert_eq!(registered["redirect_uris"], json!(["http://127.0.0.1/oauth"]), "one registration for every port");
    let used = seen.redirect_uri.as_deref().unwrap();
    assert!(used.starts_with("http://127.0.0.1:") && used.ends_with("/oauth"), "{used}");
}

#[tokio::test]
async fn signs_in_through_the_app_link_on_a_phone() {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let stub =
        https_stub(fake_server(seen.clone(), Behaviour { offers_app_passwords: true, grants_scope: true })).await;
    let http = http();
    let meta = uwumail_login::metadata(&http, stub.url("localhost", "/.well-known/jmap").as_str()).await.unwrap();
    let (links, incoming) = tokio::sync::mpsc::channel(8);
    // The platform hands over the link the browser was sent to; something else's link comes first.
    let browser = {
        let client = support::http_builder(&[support::stub_certificate().0.clone()])
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap();
        move |url: &str| {
            let (client, url, links) = (client.clone(), url.to_string(), links.clone());
            tokio::spawn(async move {
                let answer = client.get(url).send().await.unwrap();
                let location = answer.headers()["location"].to_str().unwrap().to_string();
                links.send("app.uwumail://oauth?code=evil&state=guess".into()).await.unwrap();
                links.send(location).await.unwrap();
            });
        }
    };
    let clients = Clients::default();
    let redirect = Redirect::App { uri: "app.uwumail://oauth".into(), incoming };
    let made = uwumail_login::sign_in(&http, &meta, &clients, "iPhone", "lorin@example.org", &browser, redirect)
        .await
        .expect("an app password");
    assert_eq!(made.password, "app-secret");
    assert_eq!(seen.lock().unwrap().registered[0]["redirect_uris"], json!(["app.uwumail://oauth"]));
}

#[tokio::test]
async fn an_older_server_offers_no_uwumail_login_and_a_token_without_the_scope_makes_nothing() {
    let older =
        https_stub(fake_server(Default::default(), Behaviour { offers_app_passwords: false, grants_scope: true }))
            .await;
    let http = http();
    assert!(uwumail_login::metadata(&http, older.url("localhost", "/.well-known/jmap").as_str()).await.is_none());

    let seen = Arc::new(Mutex::new(Seen::default()));
    let stingy =
        https_stub(fake_server(seen.clone(), Behaviour { offers_app_passwords: true, grants_scope: false })).await;
    let meta = uwumail_login::metadata(&http, stingy.url("localhost", "/.well-known/jmap").as_str()).await.unwrap();
    let error = uwumail_login::sign_in(
        &http,
        &meta,
        &Clients::default(),
        "Laptop",
        "lorin@example.org",
        &browser(),
        Redirect::Loopback,
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("app password"), "{error:?}");
    assert!(seen.lock().unwrap().app_password_names.is_empty());

    // Straight to the endpoint with that token: refused as insufficient_scope.
    let refused = uwumail_login::create_app_password(&http, &meta, "uwu_at_1", "Laptop").await.unwrap_err();
    assert!(refused.message.contains("insufficient_scope"), "{refused:?}");
}

#[tokio::test]
async fn a_bad_name_never_reaches_the_server() {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let stub =
        https_stub(fake_server(seen.clone(), Behaviour { offers_app_passwords: true, grants_scope: true })).await;
    let http = http();
    let meta = uwumail_login::metadata(&http, stub.url("localhost", "/").as_str()).await.unwrap();
    let opened = Arc::new(Mutex::new(0));
    let counter = opened.clone();
    let error = uwumail_login::sign_in(
        &http,
        &meta,
        &Clients::default(),
        &"x".repeat(81),
        "lorin@example.org",
        &move |_: &str| *counter.lock().unwrap() += 1,
        Redirect::Loopback,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, uwumail_core::error::ErrorCode::InvalidInput);
    assert_eq!(*opened.lock().unwrap(), 0, "no browser");
    assert!(stub.seen().iter().all(|r| r.method == "GET"), "nothing registered");
}
