//! Shipments across all accounts (UwUMail-Server docs/plans/pakete-und-feiertage.md §6):
//!
//! - A UwUMail server (`urn:uwumail:jmap:shipments`) finds them in the mail itself; the app reads,
//!   renames, hides, deletes and adds them there.
//! - Every other mailbox gets them found here, in new inbox mail (the auto-label queue, so Junk
//!   never counts), kept in the cache only. Tracking pages are never fetched.
//!
//! Statuses in `shipments::NOTIFIED` notify once each, through `EngineEvent::ShipmentsChanged`.

use chrono::{DateTime, Utc};

use super::*;
use crate::jmap::ShipmentsBy;
use crate::jmap_shipments;
use crate::shipments::{self, NOTIFIED, Shipment, ShipmentAccount, ShipmentNotice};

/// How long one server may take to list its shipments.
const LIST_WAIT: Duration = Duration::from_secs(8);
/// Only a status reached this recently notifies (one from a mail found late is old news).
const NOTICE_WITHIN: i64 = 24 * 60 * 60;
/// `sync_state` kind: notifications for this account's shipments began.
const NOTICES_BEGAN: &str = "shipmentNotify";

/// Where an account's shipments are kept (`Inner::shipments_source`).
enum Source {
    Server(Arc<JmapClient>),
    Local,
    /// Switched off on its server, or a shared mailbox.
    Off,
}

fn off() -> Error {
    Error::not_supported("Parcels are switched off for this mailbox.")
}

fn new_local_id() -> String {
    format!("l{}", uuid::Uuid::new_v4().simple())
}

impl Engine {
    /// The hidden shipments of every account, or the others, last changed first.
    pub async fn shipments(&self, hidden: bool) -> Result<Vec<Shipment>> {
        let accounts = self.inner.store.accounts()?;
        let asks = accounts.into_iter().map(|account| async move {
            match self.inner.shipments_source(&account.id, account.protocol).await {
                Source::Server(client) => {
                    match tokio::time::timeout(LIST_WAIT, jmap_shipments::list(&client, hidden)).await {
                        Ok(Ok(list)) => self.inner.with_local_email_ids(&account.id, list),
                        Ok(Err(error)) => {
                            tracing::debug!("{} couldn't list its shipments: {error}", account.id);
                            Vec::new()
                        }
                        Err(_) => Vec::new(),
                    }
                }
                Source::Off => Vec::new(),
                Source::Local => self
                    .inner
                    .store
                    .local_shipments(&account.id)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|shipment| shipment.hidden == hidden)
                    .map(|mut shipment| {
                        shipment.tracking_url =
                            shipment.tracking_url.and_then(|url| crate::links::external_url(&url).ok());
                        shipment
                    })
                    .collect(),
            }
        });
        let mut all: Vec<Shipment> = futures::future::join_all(asks).await.into_iter().flatten().collect();
        all.sort_by_key(|shipment| std::cmp::Reverse(shipments::seconds(&shipment.updated)));
        Ok(all)
    }

    /// Per account whether it has parcels and may switch them; shared mailboxes and servers that
    /// can't be reached right now are left out.
    pub async fn shipment_accounts(&self) -> Result<Vec<ShipmentAccount>> {
        let accounts = self.inner.store.accounts()?;
        let asks = accounts.into_iter().map(|account| async move {
            if self.inner.jmap_share_of(&account.id).is_some() {
                return None;
            }
            let (on, switchable) = if account.protocol == Protocol::Jmap {
                let client = tokio::time::timeout(LIST_WAIT, self.inner.jmap_client(&account.id)).await.ok()?.ok()?;
                let session = &client.session;
                (session.shipments_by() != ShipmentsBy::Off, session.shipments_offered && session.user_settings)
            } else {
                (true, false)
            };
            Some(ShipmentAccount { account_id: account.id, on, switchable })
        });
        Ok(futures::future::join_all(asks).await.into_iter().flatten().collect())
    }

    /// Follows a parcel by hand. Returns its id.
    pub async fn create_shipment(
        &self,
        account_id: &str,
        carrier: &str,
        number: &str,
        title: Option<&str>,
    ) -> Result<String> {
        let account = self.inner.store.account(account_id)?;
        let id = match self.inner.shipments_source(account_id, account.protocol).await {
            Source::Server(client) => jmap_shipments::create(&client, carrier, number, title).await?,
            Source::Off => return Err(off()),
            Source::Local => self.inner.change_local(account_id, |list| {
                let shipment = shipments::create(list, carrier, number, title, new_local_id(), Utc::now())?;
                let id = shipment.id.clone();
                list.push(shipment);
                Ok(id)
            })?,
        };
        self.inner.emit(EngineEvent::ShipmentsChanged { notices: Vec::new() });
        Ok(id)
    }

    /// Renames one (`Some(None)`: back to the shop's name) or hides it.
    pub async fn update_shipment(
        &self,
        account_id: &str,
        id: &str,
        title: Option<Option<&str>>,
        hidden: Option<bool>,
    ) -> Result<()> {
        let account = self.inner.store.account(account_id)?;
        match self.inner.shipments_source(account_id, account.protocol).await {
            Source::Server(client) => jmap_shipments::update(&client, id, title, hidden).await?,
            Source::Off => return Err(off()),
            Source::Local => {
                let title = title.map(shipments::normalize_title).transpose()?;
                self.inner.change_local(account_id, |list| {
                    let shipment = list
                        .iter_mut()
                        .find(|shipment| shipment.id == id)
                        .ok_or_else(|| Error::not_found("That shipment is gone."))?;
                    if let Some(title) = title {
                        shipment.title = title;
                    }
                    if let Some(hidden) = hidden {
                        shipment.hidden = hidden;
                    }
                    shipment.updated = shipments::format_time(Utc::now());
                    Ok(())
                })?
            }
        }
        self.inner.emit(EngineEvent::ShipmentsChanged { notices: Vec::new() });
        Ok(())
    }

    /// Marks one `status` at `at` (RFC 3339) by hand, or takes that mark back (`undo`).
    pub async fn mark_shipment(&self, account_id: &str, id: &str, at: &str, status: &str, undo: bool) -> Result<()> {
        let status = uwumail_labels::ShipmentStatus::from_id(status)
            .ok_or_else(|| Error::invalid("That is no shipment status."))?;
        let at = DateTime::parse_from_rfc3339(at)
            .map(|at| shipments::format_time(at.with_timezone(&Utc)))
            .map_err(|_| Error::invalid("That is no time."))?;
        let account = self.inner.store.account(account_id)?;
        match self.inner.shipments_source(account_id, account.protocol).await {
            Source::Server(client) => jmap_shipments::mark(&client, id, &at, status, undo).await?,
            Source::Off => return Err(off()),
            Source::Local => self.inner.change_local(account_id, |list| {
                let shipment = list
                    .iter_mut()
                    .find(|shipment| shipment.id == id)
                    .ok_or_else(|| Error::not_found("That shipment is gone."))?;
                shipment.mark(&at, status, undo, Utc::now());
                Ok(())
            })?,
        }
        self.inner.emit(EngineEvent::ShipmentsChanged { notices: Vec::new() });
        Ok(())
    }

    /// Asks its server to ask the carrier now. `None` when it did, else why not (`tooSoon`,
    /// `notSupported`, `unavailable` or `notFound`); only UwUMail servers with the lookup can.
    pub async fn refresh_shipment(&self, account_id: &str, id: &str) -> Result<Option<String>> {
        let account = self.inner.store.account(account_id)?;
        let Source::Server(client) = self.inner.shipments_source(account_id, account.protocol).await else {
            return Ok(Some("notSupported".into()));
        };
        let refused = jmap_shipments::refresh(&client, id).await?;
        if refused.is_none() {
            self.inner.emit(EngineEvent::ShipmentsChanged { notices: Vec::new() });
        }
        Ok(refused)
    }

    pub async fn delete_shipment(&self, account_id: &str, id: &str) -> Result<()> {
        let account = self.inner.store.account(account_id)?;
        match self.inner.shipments_source(account_id, account.protocol).await {
            Source::Server(client) => jmap_shipments::destroy(&client, id).await?,
            Source::Off => return Err(off()),
            Source::Local => self.inner.change_local(account_id, |list| {
                let before = list.len();
                list.retain(|shipment| shipment.id != id);
                if list.len() == before { Err(Error::not_found("That shipment is gone.")) } else { Ok(()) }
            })?,
        }
        self.inner.emit(EngineEvent::ShipmentsChanged { notices: Vec::new() });
        Ok(())
    }

    /// Looks for shipments in new inbox mail of a mailbox whose server keeps none.
    pub(super) async fn detect_shipments(&self, account_id: &str, message_ids: &[String]) {
        let Ok(account) = self.inner.store.account(account_id) else { return };
        if self.inner.jmap_share_of(account_id).is_some() {
            return;
        }
        if account.protocol == Protocol::Jmap {
            // A UwUMail server finds them itself or has them switched off; an unreachable one is left for now.
            match self.inner.jmap_client(account_id).await {
                Ok(client) if client.session.shipments_by() == ShipmentsBy::App => {}
                _ => return,
            }
        }
        let Ok(messages) = self.inner.store.messages_by_ids(message_ids) else { return };
        let found: Vec<_> = messages
            .iter()
            .filter_map(|message| {
                let facts = uwumail_labels::shipment(&self.label_mail(message).ok()?)?;
                (facts.confidence >= shipments::MIN_CONFIDENCE).then_some((message, facts))
            })
            .collect();
        if found.is_empty() {
            return;
        }
        let now = Utc::now();
        let notices = self.inner.change_local(account_id, |list| {
            for (message, facts) in &found {
                let received =
                    DateTime::parse_from_rfc3339(&message.date).map(|d| d.with_timezone(&Utc)).unwrap_or(now);
                shipments::record(
                    list,
                    facts,
                    &message.id,
                    received,
                    &message.subject,
                    &chrono::Local,
                    now,
                    new_local_id,
                );
            }
            shipments::prune(list, now);
            let ids: Vec<String> = list.iter().map(|shipment| shipment.id.clone()).collect();
            self.inner.store.retain_shipment_notices(account_id, &ids)?;
            self.inner.notices(account_id, list, now)
        });
        match notices {
            Ok(notices) => self.inner.emit(EngineEvent::ShipmentsChanged { notices }),
            Err(error) => tracing::warn!("Couldn't keep the shipments found: {error}"),
        }
    }
}

impl Inner {
    /// Where the account's shipments are kept. A shared mailbox has none of its own; an
    /// unreachable server leaves those kept here.
    async fn shipments_source(&self, account_id: &str, protocol: Protocol) -> Source {
        if self.jmap_share_of(account_id).is_some() {
            return Source::Off;
        }
        if protocol != Protocol::Jmap {
            return Source::Local;
        }
        match tokio::time::timeout(LIST_WAIT, self.jmap_client(account_id)).await {
            Ok(Ok(client)) => match client.session.shipments_by() {
                ShipmentsBy::Server => Source::Server(client),
                ShipmentsBy::Off => Source::Off,
                ShipmentsBy::App => Source::Local,
            },
            _ => Source::Local,
        }
    }

    /// The server's email ids as this device's message ids; mail not stored here is left out.
    fn with_local_email_ids(&self, account_id: &str, mut list: Vec<Shipment>) -> Vec<Shipment> {
        for shipment in &mut list {
            shipment.account_id = account_id.to_owned();
            let local = self.store.ids_by_remote(account_id, &shipment.email_ids).unwrap_or_default();
            shipment.email_ids = shipment.email_ids.iter().filter_map(|remote| local.get(remote).cloned()).collect();
            for event in &mut shipment.events {
                event.email_id = event.email_id.as_ref().and_then(|remote| local.get(remote).cloned());
            }
        }
        list
    }

    /// Changes the shipments this device keeps for an account, and keeps the result.
    fn change_local<T>(&self, account_id: &str, change: impl FnOnce(&mut Vec<Shipment>) -> Result<T>) -> Result<T> {
        let _one = self.shipments_lock.lock().unwrap();
        let mut list = self.store.local_shipments(account_id)?;
        let value = change(&mut list)?;
        self.store.replace_local_shipments(account_id, &list)?;
        Ok(value)
    }

    /// The statuses in `list` that notify now, each once. The first time for an account, all that
    /// is there counts as notified, so nothing old rings at once.
    fn notices(&self, account_id: &str, list: &[Shipment], now: DateTime<Utc>) -> Result<Vec<ShipmentNotice>> {
        let began = self.store.sync_state(account_id, NOTICES_BEGAN)?.is_some();
        let mut notices = Vec::new();
        for shipment in list.iter().filter(|shipment| !shipment.hidden && NOTIFIED.contains(&shipment.status.as_str()))
        {
            if !self.store.note_shipment_notice(account_id, &shipment.id, &shipment.status)? {
                continue;
            }
            if began && now.timestamp() - shipments::seconds(&shipment.status_at) <= NOTICE_WITHIN {
                notices.push(ShipmentNotice {
                    account_id: account_id.to_owned(),
                    shipment_id: shipment.id.clone(),
                    status: shipment.status.clone(),
                    name: shipment.display_name(),
                });
            }
        }
        if !began {
            self.store.set_sync_state(account_id, NOTICES_BEGAN, Some("1"))?;
        }
        Ok(notices)
    }

    /// The account's server switched its parcels on or off: the app looks again, and once off,
    /// switching them on again starts like the first time (nothing old rings).
    pub(super) fn shipments_switched(&self, account_id: &str, on: bool) {
        self.shipments_checked.lock().unwrap().remove(account_id);
        if !on && let Err(error) = self.store.set_sync_state(account_id, NOTICES_BEGAN, None) {
            tracing::debug!("Couldn't forget the shipment notifications of {account_id}: {error}");
        }
        self.emit(EngineEvent::ShipmentsChanged { notices: Vec::new() });
    }

    /// Looks at a UwUMail server's shipments for statuses that notify.
    pub(super) async fn check_server_shipments(&self, client: &JmapClient, account_id: &str) {
        // shortcut: notices of shipments deleted on the server stay (3 tiny rows a parcel at most);
        // forget them like the local ones if that ever adds up.
        let notices = match jmap_shipments::list(client, false).await {
            Ok(list) => self.notices(account_id, &list, Utc::now()),
            Err(error) => Err(error),
        };
        match notices {
            Ok(notices) if !notices.is_empty() => self.emit(EngineEvent::ShipmentsChanged { notices }),
            Ok(_) => {}
            Err(error) => {
                tracing::debug!("Couldn't look at the shipments: {error}");
                // Try again with the next sync.
                self.shipments_checked.lock().unwrap().remove(account_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AccountColor, AuthKind, MessageFlags, Security, ServerSettings};
    use crate::store::{AccountRecord, FolderInfo};

    fn engine() -> (tempfile::TempDir, Engine, String) {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::new(EngineOptions {
            data_dir: dir.path().to_path_buf(),
            secrets: Arc::new(crate::secrets::MemorySecrets::default()),
            open_url: Arc::new(|_| {}),
            recognizer: None,
        })
        .unwrap();
        let store = &engine.inner.store;
        store
            .insert_account(&AccountRecord {
                id: "acc".into(),
                name: "Test".into(),
                email: "leni@example.org".into(),
                display_name: "Leni".into(),
                color: AccountColor::Pink,
                auth: AuthKind::Password,
                username: "leni@example.org".into(),
                imap: ServerSettings { host: "imap.example.org".into(), port: 993, security: Security::Tls },
                smtp: ServerSettings { host: "smtp.example.org".into(), port: 465, security: Security::Tls },
                protocol: Protocol::Imap,
                jmap_url: None,
            })
            .unwrap();
        let info = FolderInfo {
            path: "INBOX",
            name: "INBOX",
            role: Some(FolderRole::Inbox),
            delimiter: Some("/"),
            selectable: true,
            parent_ref: None,
        };
        let inbox = store.upsert_folder("acc", &info).unwrap();
        (dir, engine, inbox)
    }

    fn mail(engine: &Engine, inbox: &str, uid: u32, subject: &str, body: &str) -> String {
        let date = chrono::Utc::now().to_rfc2822();
        let raw = format!(
            "Authentication-Results: mx.example.org; dkim=pass header.d=dhl.example; spf=pass \
smtp.mailfrom=dhl.example; dmarc=pass header.from=dhl.example\r\n\
Received: from a.example (a.example [192.0.2.1]) by mx.example.org\r\n\
From: DHL Paket <noreply@dhl.example>\r\nTo: leni@example.org\r\nSubject: {subject}\r\nDate: {date}\r\n\
Message-ID: <{uid}@dhl.example>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n"
        );
        let parsed = crate::mime::parse(raw.as_bytes());
        engine
            .inner
            .store
            .insert_message("acc", inbox, uid, MessageFlags::default(), raw.len() as u64, None, &parsed)
            .unwrap()
            .unwrap()
    }

    fn shipment(id: &str, status: &str, at: DateTime<Utc>) -> Shipment {
        Shipment {
            id: id.into(),
            carrier: "dhl".into(),
            number: Some("00340434161234567890".into()),
            status: status.into(),
            status_at: shipments::format_time(at),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn statuses_notify_once_and_not_on_the_first_look() {
        let (_dir, engine, _) = engine();
        let now = Utc::now();
        let old = shipment("s1", "delivered", now);
        // The first look only notes what is there.
        assert!(engine.inner.notices("acc", std::slice::from_ref(&old), now).unwrap().is_empty());
        let out = shipment("s2", "outForDelivery", now);
        let stale = shipment("s3", "readyForPickup", now - chrono::Duration::days(2));
        let mut hidden = shipment("s4", "delivered", now);
        hidden.hidden = true;
        let moving = shipment("s5", "inTransit", now);
        let list = [old, out, stale, hidden, moving];
        let notices = engine.inner.notices("acc", &list, now).unwrap();
        assert_eq!(notices.iter().map(|n| n.shipment_id.as_str()).collect::<Vec<_>>(), ["s2"]);
        assert_eq!(notices[0].name, "DHL 00340434161234567890");
        // A second sync rings no more.
        assert!(engine.inner.notices("acc", &list, now).unwrap().is_empty());
    }

    /// The mailbox as one on a UwUMail server whose session (see jmap's tests) has parcels off.
    async fn on_server_with_parcels_off(engine: &Engine) {
        // The client below is kept, so the app never signs in or calls the server.
        engine.inner.store.set_account_protocol("acc", Protocol::Jmap).unwrap();
        let base = url::Url::parse("https://mail.uwumail.test/jmap/session").unwrap();
        let session = crate::jmap::Session::parse(
            &serde_json::json!({
                "capabilities": { crate::jmap::CORE: {}, crate::jmap::MAIL: {}, crate::jmap::SETTINGS: {}, crate::jmap::SHIPMENTS: {} },
                "accounts": { "a1": { "accountCapabilities": { crate::jmap::MAIL: {} } } },
                "primaryAccounts": { crate::jmap::MAIL: "a1" },
                "apiUrl": "/jmap/api", "downloadUrl": "/jmap/download", "uploadUrl": "/jmap/upload",
            }),
            &base,
        )
        .unwrap();
        let client = Arc::new(crate::jmap::Client::with_session(session));
        engine.inner.jmap.lock().await.insert("acc".into(), client);
    }

    #[tokio::test]
    async fn parcels_switched_off_find_nothing_and_ring_no_more() {
        let (_dir, engine, inbox) = engine();
        on_server_with_parcels_off(&engine).await;
        let mut events = engine.subscribe();
        let id = mail(
            &engine,
            &inbox,
            1,
            "Ihr DHL Paket wird heute zugestellt",
            "Ihr Paket JJD000390000000000001 wird heute zugestellt.",
        );
        engine.detect_shipments("acc", std::slice::from_ref(&id)).await;
        assert!(engine.shipments(false).await.unwrap().is_empty());
        assert!(events.try_recv().is_err(), "no parcel event, so no notification");
        let accounts = engine.shipment_accounts().await.unwrap();
        assert_eq!(accounts, [ShipmentAccount { account_id: "acc".into(), on: false, switchable: true }]);

        // Switching off forgets where the notices began, so switching on again doesn't ring for old parcels.
        engine.inner.store.set_sync_state("acc", NOTICES_BEGAN, Some("x")).unwrap();
        engine.inner.shipments_switched("acc", false);
        assert!(engine.inner.store.sync_state("acc", NOTICES_BEGAN).unwrap().is_none());
        assert!(
            matches!(events.recv().await.unwrap(), EngineEvent::ShipmentsChanged { notices } if notices.is_empty())
        );
    }

    #[tokio::test]
    async fn finds_shipments_in_new_mail_and_keeps_them_here() {
        let (_dir, engine, inbox) = engine();
        let mut events = engine.subscribe();
        let first = mail(
            &engine,
            &inbox,
            1,
            "Ihr DHL Paket wird heute zugestellt",
            "Ihr Paket JJD000390000000000001 wird heute zugestellt.",
        );
        engine.detect_shipments("acc", std::slice::from_ref(&first)).await;
        let list = engine.shipments(false).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].account_id.as_str(), list[0].status.as_str()), ("acc", "outForDelivery"));
        assert_eq!(list[0].email_ids, [first]);
        assert!(
            matches!(events.recv().await.unwrap(), EngineEvent::ShipmentsChanged { notices } if notices.is_empty())
        );

        let second = mail(
            &engine,
            &inbox,
            2,
            "Ihr DHL Paket wurde zugestellt",
            "Ihre Sendung JJD000390000000000001 wurde zugestellt.",
        );
        engine.detect_shipments("acc", std::slice::from_ref(&second)).await;
        let EngineEvent::ShipmentsChanged { notices } = events.recv().await.unwrap() else { panic!() };
        assert_eq!(notices.iter().map(|n| n.status.as_str()).collect::<Vec<_>>(), ["delivered"]);

        let id = list[0].id.clone();
        engine.update_shipment("acc", &id, Some(Some("Schuhe")), Some(true)).await.unwrap();
        assert!(engine.shipments(false).await.unwrap().is_empty());
        assert_eq!(engine.shipments(true).await.unwrap()[0].title.as_deref(), Some("Schuhe"));
        let added = engine.create_shipment("acc", "ups", "1Z 999", None).await.unwrap();
        assert!(engine.create_shipment("acc", "ups", "1z999", None).await.is_err());
        engine.delete_shipment("acc", &added).await.unwrap();
        engine.delete_shipment("acc", &id).await.unwrap();
        assert!(engine.shipments(true).await.unwrap().is_empty());
    }
}
