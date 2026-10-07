//! Shared mailboxes on a JMAP server: other people's mail accounts in a login's session
//! (`isPersonal: false`), such as UwUMail's shared mailboxes (UwUMail-Server docs/groups.md) and
//! mailboxes someone shared folders of.
//!
//! Each one is an account of its own here, nested under the account whose login reaches it, as
//! with Microsoft 365 (see `shared_ops`). It has no secret and no connection of its own: it is
//! that login's connection working in another `accountId` ([`JmapClient::shared_view`]). They
//! come and go with the session: a new one is added at the next sync, one no longer there is
//! removed with its local mail. One the person removed stays away until added again by address.
//!
//! Sending from one goes through the login's own account, where the server keeps the shared
//! addresses as identities: an `EmailSubmission` in the shared account itself is refused.

use super::*;
use crate::jmap::SharedAccount;

/// A shared mailbox of a JMAP login.
pub(super) struct JmapShare {
    /// The account whose login reaches it.
    parent_id: String,
    /// Its `accountId` in that login's session.
    jmap_account_id: String,
}

/// After a sync of a JMAP account: adds and removes its shared mailboxes when its session changed.
pub(super) async fn check_shares(inner: &Arc<Inner>, client: &JmapClient, account_id: &str) {
    let engine = Engine { inner: Arc::clone(inner) };
    if let Err(error) = engine.check_jmap_shares(client, account_id).await {
        tracing::info!("Couldn't look at the shared mailboxes of {account_id}: {error}");
    }
}

/// The identities among a login's that belong to the shared mailbox `email`: its own address and
/// the aliases the server names after it (they carry the name of its own identity). Never one of
/// the login's own address `own_email`.
fn identities_of_shared(
    identities: &[(String, String, String)],
    email: &str,
    own_email: &str,
) -> Vec<(String, String, String)> {
    let names: Vec<&str> = identities
        .iter()
        .filter(|(_, address, name)| address.eq_ignore_ascii_case(email) && !name.trim().is_empty())
        .map(|(_, _, name)| name.as_str())
        .collect();
    identities
        .iter()
        .filter(|(_, address, name)| {
            !address.eq_ignore_ascii_case(own_email)
                && (address.eq_ignore_ascii_case(email) || names.contains(&name.as_str()))
        })
        .cloned()
        .collect()
}

/// The name a new shared mailbox shows: its identity's name, or the start of its address.
fn display_name_of(identities: &[(String, String, String)], email: &str) -> String {
    identities
        .iter()
        .find(|(_, address, name)| address.eq_ignore_ascii_case(email) && !name.trim().is_empty())
        .map(|(_, _, name)| name.trim().to_string())
        .unwrap_or_else(|| email.split('@').next().unwrap_or(email).to_string())
}

impl Inner {
    /// Whether `account_id` is a shared mailbox of a JMAP login, and which.
    pub(super) fn jmap_share_of(&self, account_id: &str) -> Option<JmapShare> {
        let link = self.store.account_link(account_id).ok()?;
        let jmap_account_id = link.jmap_account_id?;
        let parent_id = link.parent_id.filter(|parent| parent != account_id)?;
        Some(JmapShare { parent_id, jmap_account_id })
    }

    /// The connection of a shared mailbox: its login's, working in the shared account.
    pub(super) async fn shared_jmap_client(&self, account_id: &str, share: JmapShare) -> Result<Arc<JmapClient>> {
        if let Some(client) = self.jmap.lock().await.get(account_id) {
            return Ok(Arc::clone(client));
        }
        // Only one level: a login is never a shared mailbox itself.
        if self.jmap_share_of(&share.parent_id).is_some() {
            return Err(Error::internal("This shared mailbox is nested under another shared mailbox."));
        }
        let login = Box::pin(self.jmap_client(&share.parent_id)).await?;
        let client = Arc::new(
            login
                .shared_view(&share.jmap_account_id)
                .ok_or_else(|| Error::not_found("This mailbox is no longer shared with you."))?,
        );
        self.jmap.lock().await.insert(account_id.to_string(), Arc::clone(&client));
        Ok(client)
    }

    /// Refuses changes to mail of a shared mailbox the login may only read.
    pub(super) fn refuse_read_only(&self, locations: &[MessageLocation]) -> Result<()> {
        let mut checked = HashSet::new();
        for location in locations {
            if checked.insert(location.account_id.as_str()) {
                self.refuse_read_only_account(&location.account_id)?;
            }
        }
        Ok(())
    }

    pub(super) fn refuse_read_only_account(&self, account_id: &str) -> Result<()> {
        let link = self.store.account_link(account_id)?;
        if link.jmap_account_id.is_some() && link.read_only {
            return Err(Error::invalid("This shared mailbox may only be read."));
        }
        Ok(())
    }

    /// The sending identities of a JMAP account: for a shared mailbox the ones of its login that
    /// are its addresses; for a login its own, without those of its shared mailboxes.
    pub(super) async fn jmap_identities(
        &self,
        client: &JmapClient,
        account_id: &str,
    ) -> Result<Vec<(String, String, String)>> {
        if let Some(share) = self.jmap_share_of(account_id) {
            let login = Box::pin(self.jmap_client(&share.parent_id)).await?;
            let own = self.store.account(&share.parent_id)?.email;
            let email = self.store.account(account_id)?.email;
            return Ok(identities_of_shared(&jmap_sync::identities(&login).await?, &email, &own));
        }
        let mut found = jmap_sync::identities(client).await?;
        let own = self.store.account(account_id)?.email;
        let links = self.store.account_links()?;
        let mut claimed = HashSet::new();
        for child in self.store.shared_children(account_id)? {
            if links.get(&child).is_some_and(|link| link.jmap_account_id.is_some())
                && let Ok(record) = self.store.account(&child)
            {
                claimed.extend(identities_of_shared(&found, &record.email, &own).into_iter().map(|(id, _, _)| id));
            }
        }
        found.retain(|(id, _, _)| !claimed.contains(id));
        Ok(found)
    }

    /// Sends from a JMAP account. A shared mailbox sends through its login's own account with
    /// one of its addresses; the server files a copy into the shared mailbox's Sent folder.
    pub(super) async fn jmap_send(
        &self,
        account_id: &str,
        raw: Vec<u8>,
        from: &str,
        recipients: &[String],
    ) -> Result<()> {
        match self.jmap_share_of(account_id) {
            Some(share) => {
                let login = self.jmap_client(&share.parent_id).await?;
                jmap_sync::send_as(&login, &self.store, &share.parent_id, raw, from, recipients, true).await?;
                self.wake(&share.parent_id);
                Ok(())
            }
            None => {
                let client = self.jmap_client(account_id).await?;
                jmap_sync::send(&client, &self.store, account_id, raw, from, recipients).await
            }
        }
    }

    /// The shared mailboxes of the login `account_id` that a push says changed.
    pub(super) fn shares_changed(
        &self,
        account_id: &str,
        changed: &HashMap<String, HashMap<String, String>>,
    ) -> Vec<String> {
        let Ok(links) = self.store.account_links() else { return Vec::new() };
        links
            .into_iter()
            .filter(|(id, link)| {
                id != account_id
                    && link.parent_id.as_deref() == Some(account_id)
                    && link.jmap_account_id.as_ref().is_some_and(|jmap_id| changed.contains_key(jmap_id))
            })
            .map(|(id, _)| id)
            .collect()
    }
}

impl Engine {
    /// Matches the shared mailboxes of the login `account_id` with its session, when the session
    /// changed since the last time (or was never looked at). Returns the ids of the added ones.
    async fn check_jmap_shares(&self, client: &JmapClient, account_id: &str) -> Result<Vec<String>> {
        let inner = &self.inner;
        let link = inner.store.account_link(account_id)?;
        if link.parent_id.is_some() || link.jmap_account_id.is_some() {
            return Ok(Vec::new());
        }
        let state = client.latest_session_state().unwrap_or_default();
        if inner.jmap_shares_seen.lock().unwrap().get(account_id) == Some(&state) {
            return Ok(Vec::new());
        }
        let added = if client.session_outdated() {
            self.refresh_jmap_shares(account_id).await?
        } else {
            self.reconcile_jmap_shares(account_id, client).await?
        };
        inner.jmap_shares_seen.lock().unwrap().insert(account_id.to_string(), state);
        Ok(added)
    }

    /// Reads the login's session again and matches its shared mailboxes with it now.
    pub(super) async fn refresh_jmap_shares(&self, account_id: &str) -> Result<Vec<String>> {
        self.inner.jmap.lock().await.remove(account_id);
        let client = self.inner.jmap_client(account_id).await?;
        let added = self.reconcile_jmap_shares(account_id, &client).await?;
        let state = client.latest_session_state().unwrap_or_default();
        self.inner.jmap_shares_seen.lock().unwrap().insert(account_id.to_string(), state);
        Ok(added)
    }

    /// Adds the shared accounts of the session that aren't here yet (and weren't removed by the
    /// person), removes the ones no longer in it, and notes which may only be read.
    async fn reconcile_jmap_shares(&self, parent_id: &str, client: &JmapClient) -> Result<Vec<String>> {
        let _one_at_a_time = self.inner.shared_lock.lock().await;
        let store = &self.inner.store;
        let parent = store.account(parent_id)?;
        if parent.protocol != Protocol::Jmap {
            return Ok(Vec::new());
        }
        let shares: &[SharedAccount] = &client.session.shared_accounts;
        let links = store.account_links()?;
        let children: Vec<(String, String, bool)> = store
            .shared_children(parent_id)?
            .into_iter()
            .filter_map(|id| {
                let link = links.get(&id)?;
                Some((id, link.jmap_account_id.clone()?, link.read_only))
            })
            .collect();
        let mut changed = false;
        for (child, jmap_id, read_only) in &children {
            match shares.iter().find(|share| share.id == *jmap_id) {
                None => {
                    tracing::info!("Shared mailbox {child} is no longer shared with {parent_id}");
                    self.remove_one_account(child).await?;
                    changed = true;
                }
                Some(share) if share.read_only != *read_only => {
                    store.set_jmap_share(child, jmap_id, share.read_only)?;
                    changed = true;
                }
                Some(_) => {}
            }
        }
        let accounts = store.accounts()?;
        let mut identities = None;
        let mut added = Vec::new();
        for share in shares {
            let here = children.iter().any(|(_, jmap_id, _)| *jmap_id == share.id)
                || accounts.iter().any(|account| account.email.eq_ignore_ascii_case(&share.name));
            if here || store.is_shared_dismissed(parent_id, &share.name)? {
                continue;
            }
            if identities.is_none() {
                identities = Some(jmap_sync::identities(client).await.unwrap_or_default());
            }
            let display_name = display_name_of(identities.as_deref().unwrap_or_default(), &share.name);
            added.push(self.insert_jmap_shared(&parent, share, &display_name)?);
        }
        // A server that shares tells so: from now on the account settings offer adding by address.
        let shares_mail = client.session.principals || !shares.is_empty();
        if shares_mail && links.get(parent_id).and_then(|link| link.shared_state.as_deref()) != Some("done") {
            store.set_shared_search(parent_id, SharedSearch::Done.as_str(), crate::mime::now())?;
            changed = true;
        }
        if !added.is_empty() {
            self.inner.emit(EngineEvent::MailChanged { account_id: parent_id.to_string() });
        }
        if changed || !added.is_empty() {
            self.inner.emit(EngineEvent::AccountsChanged {});
        }
        Ok(added)
    }

    /// Saves a shared account of `parent`'s login and starts syncing it.
    fn insert_jmap_shared(&self, parent: &AccountRecord, share: &SharedAccount, display_name: &str) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let record = AccountRecord {
            id: id.clone(),
            name: share.name.clone(),
            email: share.name.clone(),
            display_name: display_name.to_string(),
            color: parent.color,
            auth: parent.auth,
            username: parent.username.clone(),
            imap: parent.imap.clone(),
            smtp: parent.smtp.clone(),
            protocol: Protocol::Jmap,
            jmap_url: parent.jmap_url.clone(),
        };
        let store = &self.inner.store;
        store.insert_account(&record)?;
        let linked = store
            .set_account_parent(&id, Some(&parent.id))
            .and_then(|()| store.set_jmap_share(&id, &share.id, share.read_only));
        if let Err(error) = linked {
            let _ = store.delete_account(&id);
            return Err(error);
        }
        tracing::info!("Added shared mailbox {id} of {}", parent.id);
        self.inner.spawn_sync(&id);
        Ok(id)
    }

    /// Whether `account_id` is a JMAP login that can have shared mailboxes.
    pub(super) fn is_jmap_login(&self, account_id: &str) -> bool {
        let store = &self.inner.store;
        store.account(account_id).is_ok_and(|record| record.protocol == Protocol::Jmap)
            && store
                .account_link(account_id)
                .is_ok_and(|link| link.parent_id.is_none() && link.jmap_account_id.is_none())
    }

    /// Adds a shared mailbox the person removed before back under its JMAP login, if the
    /// server still shares it with that login.
    pub(super) async fn add_jmap_shared_mailbox(&self, parent_id: &str, email: &str) -> Result<Account> {
        let store = &self.inner.store;
        let parent = store.account(parent_id)?;
        if store.accounts()?.iter().any(|a| a.email.eq_ignore_ascii_case(email)) {
            return Err(Error::invalid("This mailbox is already in UwUMail."));
        }
        store.undismiss_shared(parent_id, email)?;
        self.refresh_jmap_shares(parent_id).await?;
        let links = store.account_links()?;
        let found = store.shared_children(parent_id)?.into_iter().find(|id| {
            links.get(id).is_some_and(|link| link.jmap_account_id.is_some())
                && store.account(id).is_ok_and(|record| record.email.eq_ignore_ascii_case(email))
        });
        let Some(id) = found else {
            return Err(Error::invalid(format!("The server doesn't share {email} with {}.", parent.email)));
        };
        self.list_accounts()?
            .into_iter()
            .find(|account| account.id == id)
            .ok_or_else(|| Error::internal("The new mailbox disappeared."))
    }

    /// Reads the JMAP login's session again for new shared mailboxes ("Search again").
    pub(super) async fn search_jmap_shared(&self, parent_id: &str) -> Result<SharedSearchResult> {
        let added = self.refresh_jmap_shares(parent_id).await?;
        let state = self
            .inner
            .store
            .account_link(parent_id)?
            .shared_state
            .as_deref()
            .and_then(SharedSearch::parse)
            .unwrap_or(SharedSearch::Done);
        let added = self.list_accounts()?.into_iter().filter(|account| added.contains(&account.id)).collect();
        Ok(SharedSearchResult { state, added })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::FolderInfo;
    use serde_json::{Value, json};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A UwUMail server on this machine whose session can change; it keeps every method call.
    struct FakeServer {
        url: String,
        session: Arc<Mutex<Value>>,
        calls: Arc<Mutex<Vec<(String, Value)>>>,
    }

    impl FakeServer {
        fn calls(&self, method: &str) -> Vec<Value> {
            self.calls.lock().unwrap().iter().filter(|(name, _)| name == method).map(|(_, a)| a.clone()).collect()
        }

        /// The session without the shared account `id`, under a new state.
        fn unshare(&self, id: &str, state: &str) {
            let mut session = self.session.lock().unwrap();
            session["accounts"].as_object_mut().unwrap().remove(id);
            session["state"] = json!(state);
        }
    }

    fn session() -> Value {
        json!({
            "capabilities": { crate::jmap::CORE: {}, crate::jmap::MAIL: {}, crate::jmap::SUBMISSION: {},
                              crate::jmap::PRINCIPALS: {} },
            "accounts": {
                "a1": { "name": "mini@uwumail.test", "isPersonal": true,
                        "accountCapabilities": { crate::jmap::MAIL: {}, crate::jmap::SUBMISSION: {} } },
                "a7": { "name": "support@uwumail.test", "isPersonal": false, "isReadOnly": false,
                        "accountCapabilities": { crate::jmap::MAIL: { "mayCreateTopLevelMailbox": false } } },
                "a3": { "name": "Leni@uwumail.test", "isPersonal": false, "isReadOnly": true,
                        "accountCapabilities": { crate::jmap::MAIL: {} } }
            },
            "primaryAccounts": { crate::jmap::MAIL: "a1", crate::jmap::SUBMISSION: "a1", crate::jmap::PRINCIPALS: "a1" },
            "username": "mini@uwumail.test",
            "apiUrl": "/api",
            "downloadUrl": "/download/{accountId}/{blobId}/{name}?type={type}",
            "uploadUrl": "/upload/{accountId}/",
            "state": "s1"
        })
    }

    fn answer(name: &str, arguments: &Value) -> Value {
        match name {
            "Identity/get" => json!({ "list": [
                { "id": "i1", "email": "mini@uwumail.test", "name": "Mini" },
                { "id": "i2", "email": "support@uwumail.test", "name": "Support" },
                { "id": "i3", "email": "help@uwumail.test", "name": "Support" }
            ] }),
            "Email/import" => json!({ "created": { "outgoing": { "id": "e1", "blobId": "b1" } } }),
            "EmailSubmission/set" => json!({ "created": { "submission": { "id": "s1" } } }),
            _ => arguments.clone(),
        }
    }

    async fn fake_server() -> FakeServer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let session = Arc::new(Mutex::new(self::session()));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (document, seen) = (Arc::clone(&session), Arc::clone(&calls));
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 8192];
                let head = loop {
                    if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                        break end;
                    }
                    match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => break usize::MAX,
                        Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                    }
                };
                if head == usize::MAX {
                    continue;
                }
                let text = String::from_utf8_lossy(&buffer[..head]).to_lowercase();
                let length: usize = text
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(0);
                let mut body = buffer[head + 4..].to_vec();
                while body.len() < length {
                    match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => body.extend_from_slice(&chunk[..n]),
                    }
                }
                let current = document.lock().unwrap().clone();
                let reply = if text.starts_with("get") {
                    current
                } else if text.starts_with("post /upload/") {
                    json!({ "blobId": "up1", "type": "message/rfc822", "size": body.len() })
                } else {
                    let request: Value = serde_json::from_slice(&body).unwrap_or_default();
                    let responses: Vec<Value> = request["methodCalls"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                        .iter()
                        .map(|call| {
                            let name = call[0].as_str().unwrap_or_default().to_string();
                            seen.lock().unwrap().push((name.clone(), call[1].clone()));
                            json!([name, answer(&name, &call[1]), call[2]])
                        })
                        .collect();
                    json!({ "methodResponses": responses, "sessionState": current["state"] })
                };
                let body = reply.to_string();
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(body.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        FakeServer { url: format!("{base}/.well-known/jmap"), session, calls }
    }

    /// An engine with the JMAP login `mini` on a fake UwUMail server, and its Sent folder.
    async fn engine_with_login() -> (tempfile::TempDir, Engine, FakeServer) {
        let server = fake_server().await;
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(crate::secrets::MemorySecrets::default());
        let engine = Engine::new(EngineOptions {
            data_dir: dir.path().to_path_buf(),
            secrets: secrets.clone(),
            open_url: Arc::new(|_| {}),
            recognizer: None,
        })
        .unwrap();
        engine.inner.background_sync.store(false, Ordering::Relaxed);
        let store = &engine.inner.store;
        store
            .insert_account(&AccountRecord {
                id: "mini".into(),
                name: "mini@uwumail.test".into(),
                email: "mini@uwumail.test".into(),
                display_name: "Mini".into(),
                color: AccountColor::Pink,
                auth: AuthKind::Password,
                username: "mini@uwumail.test".into(),
                imap: ServerSettings { host: "mail.uwumail.test".into(), port: 993, security: Security::Tls },
                smtp: ServerSettings { host: "mail.uwumail.test".into(), port: 465, security: Security::Tls },
                protocol: Protocol::Jmap,
                jmap_url: Some(server.url.clone()),
            })
            .unwrap();
        secrets.set("mini", &Secret::Password { password: "dummy-password".into() }).unwrap();
        let info = FolderInfo {
            path: "m-sent",
            name: "Sent",
            role: Some(FolderRole::Sent),
            delimiter: None,
            selectable: true,
            parent_ref: None,
        };
        store.upsert_folder("mini", &info).unwrap();
        (dir, engine, server)
    }

    fn shared_ids(engine: &Engine) -> (String, String) {
        let accounts = engine.list_accounts().unwrap();
        let id = |email: &str| accounts.iter().find(|a| a.email == email).unwrap().id.clone();
        (id("support@uwumail.test"), id("Leni@uwumail.test"))
    }

    #[tokio::test]
    async fn shared_accounts_of_the_session_are_nested_under_their_login() {
        let (_dir, engine, server) = engine_with_login().await;
        let client = engine.inner.jmap_client("mini").await.unwrap();
        let added = engine.check_jmap_shares(&client, "mini").await.unwrap();
        assert_eq!(added.len(), 2);
        assert!(engine.check_jmap_shares(&client, "mini").await.unwrap().is_empty(), "the same session again");

        let accounts = engine.list_accounts().unwrap();
        let order: Vec<_> = accounts.iter().map(|a| (a.email.as_str(), a.parent_id.as_deref())).collect();
        assert_eq!(order[0], ("mini@uwumail.test", None));
        assert!(order[1..].iter().all(|(_, parent)| *parent == Some("mini")), "{order:?}");
        assert_eq!(accounts[0].shared_search, Some(SharedSearch::Done), "adding by address is offered");
        let (support, leni) = shared_ids(&engine);
        let support_account = accounts.iter().find(|a| a.id == support).unwrap();
        assert!(support_account.server_shared && !support_account.read_only);
        assert_eq!(support_account.display_name, "Support", "named like its identity");
        assert_eq!(support_account.protocols, [Protocol::Jmap]);
        assert_eq!(support_account.shared_search, None);
        assert!(accounts.iter().find(|a| a.id == leni).unwrap().read_only);

        // Its mail calls go to its own account with the login's connection.
        let shared = engine.inner.jmap_client(&support).await.unwrap();
        assert_eq!(shared.account_id(), "a7");
        assert_eq!(shared.session.submission_account_id, None);
        assert!(engine.inner.secrets.get(&support).is_err(), "no secret of its own");

        // The shared addresses are the shared mailbox's to send with, not the login's.
        let own = engine.inner.jmap_identities(&client, "mini").await.unwrap();
        assert_eq!(own.iter().map(|(id, _, _)| id.as_str()).collect::<Vec<_>>(), ["i1"]);
        let theirs = engine.inner.jmap_identities(&shared, &support).await.unwrap();
        assert_eq!(theirs.iter().map(|(id, _, _)| id.as_str()).collect::<Vec<_>>(), ["i2", "i3"]);

        // Read-only shares take no changes, the others do.
        assert!(engine.inner.refuse_read_only_account(&leni).is_err());
        assert!(engine.inner.refuse_read_only_account(&support).is_ok());
        assert!(engine.inner.refuse_read_only_account("mini").is_ok());
        assert!(engine.inner.calendar_source_known(&support).await.unwrap().is_err(), "no calendars of its own");
        drop(server);
    }

    #[tokio::test]
    async fn a_shared_mailbox_sends_through_its_login_with_its_address() {
        let (_dir, engine, server) = engine_with_login().await;
        let client = engine.inner.jmap_client("mini").await.unwrap();
        engine.check_jmap_shares(&client, "mini").await.unwrap();
        let (support, leni) = shared_ids(&engine);

        let raw = b"From: support@uwumail.test\r\nSubject: Hi\r\n\r\nHello".to_vec();
        let to = ["kim@example.com".to_string()];
        engine.inner.jmap_send(&support, raw.clone(), "support@uwumail.test", &to).await.unwrap();
        let imported = server.calls("Email/import");
        assert_eq!(imported[0]["accountId"], "a1", "stored in the login's own account");
        assert_eq!(imported[0]["emails"]["outgoing"]["mailboxIds"], json!({ "m-sent": true }));
        let submitted = server.calls("EmailSubmission/set");
        assert_eq!(submitted[0]["accountId"], "a1");
        assert_eq!(submitted[0]["create"]["submission"]["identityId"], "i2");

        // Without an identity for the address nothing goes out: never as the login instead.
        let before = server.calls("EmailSubmission/set").len();
        let error = engine.inner.jmap_send(&leni, raw, "Leni@uwumail.test", &to).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "{error:?}");
        assert_eq!(server.calls("EmailSubmission/set").len(), before);
    }

    #[tokio::test]
    async fn shared_mailboxes_follow_the_session_and_removed_ones_stay_away() {
        let (_dir, engine, server) = engine_with_login().await;
        let client = engine.inner.jmap_client("mini").await.unwrap();
        engine.check_jmap_shares(&client, "mini").await.unwrap();
        let (support, leni) = shared_ids(&engine);

        // No longer shared: the next answer names a new session state, and the mailbox goes.
        server.unshare("a3", "s2");
        client.call(vec![("Core/echo", json!({}))]).await.unwrap();
        assert!(client.session_outdated());
        engine.check_jmap_shares(&client, "mini").await.unwrap();
        let ids: Vec<String> = engine.list_accounts().unwrap().into_iter().map(|a| a.id).collect();
        assert!(!ids.contains(&leni) && ids.contains(&support), "{ids:?}");

        // Removed by the person: not added again, until added by address.
        engine.remove_account_with(&support, false).await.unwrap();
        assert!(engine.find_shared_mailboxes("mini").await.unwrap().added.is_empty());
        assert_eq!(engine.list_accounts().unwrap().len(), 1);
        let unknown = engine.add_shared_mailbox("mini", "nobody@uwumail.test", None).await.unwrap_err();
        assert_eq!(unknown.code, ErrorCode::InvalidInput);
        let back = engine.add_shared_mailbox("mini", "support@uwumail.test", None).await.unwrap();
        assert_eq!((back.parent_id.as_deref(), back.server_shared), (Some("mini"), true));

        // They can't stay without their login, whatever was asked.
        engine.remove_account_with("mini", true).await.unwrap();
        assert!(engine.list_accounts().unwrap().is_empty());
    }

    fn identity(id: &str, email: &str, name: &str) -> (String, String, String) {
        (id.into(), email.into(), name.into())
    }

    #[test]
    fn a_shared_mailbox_sends_with_its_own_identities_only() {
        let all = [
            identity("i1", "mini@uwumail.test", "Mini"),
            identity("i2", "support@uwumail.test", "Support"),
            identity("i3", "help@uwumail.test", "Support"),
            identity("i4", "Mini.Alias@uwumail.test", "Mini"),
        ];
        let ids = |found: Vec<(String, String, String)>| found.into_iter().map(|(id, _, _)| id).collect::<Vec<_>>();
        assert_eq!(ids(identities_of_shared(&all, "SUPPORT@uwumail.test", "mini@uwumail.test")), ["i2", "i3"]);
        // Someone whose shared mailbox carries their own name never gets their own address there.
        let same_name = [identity("i1", "mini@uwumail.test", "Mini"), identity("i2", "team@uwumail.test", "Mini")];
        assert_eq!(ids(identities_of_shared(&same_name, "team@uwumail.test", "mini@uwumail.test")), ["i2"]);
        assert!(identities_of_shared(&all, "leni@uwumail.test", "mini@uwumail.test").is_empty());
        assert_eq!(display_name_of(&all, "support@uwumail.test"), "Support");
        assert_eq!(display_name_of(&all, "leni@uwumail.test"), "leni");
    }
}
