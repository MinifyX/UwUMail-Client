//! New mail through a push service for JMAP accounts (on Android: UnifiedPush). The mail server
//! POSTs its StateChange objects to the push service, which wakes UwUMail for a sync, so no
//! connection has to stay open while UwUMail rests. See `jmap_push` for the protocol side.
//!
//! One subscription per account is kept in the store (`sync_state`, kind `PushSubscription`). It is
//! renewed about once a day (after syncs, and by the platform's periodic `push_maintain`), made
//! again when the server lost it or its verification never came, and dropped when the server's
//! push key (VAPID) changed; the app then registers with the push service again.

use chrono::Utc;

use super::*;
use crate::jmap_push::{self, Endpoint, Message, Overview, Renewal, Subscription, Target};

const RECORD: &str = "PushSubscription";
/// How long `push_targets` and `push_maintain` wait for one account's server.
const SERVER_WAIT: Duration = Duration::from_secs(15);
/// A changed session is read again at most this often to look for a new push key.
const KEY_CHECK_EVERY: Duration = Duration::from_secs(60 * 60);

impl Engine {
    /// The JMAP accounts whose servers take push subscriptions over Web Push (they announce their
    /// VAPID key), and the ids of JMAP accounts whose server couldn't be asked right now (their
    /// registration is best left as it is).
    pub async fn push_targets(&self) -> Result<(Vec<Target>, Vec<String>)> {
        let accounts: Vec<AccountRecord> =
            self.inner.store.accounts()?.into_iter().filter(|a| a.protocol == Protocol::Jmap).collect();
        let checks = accounts.iter().map(|account| async move {
            let key = async {
                let client = self.inner.jmap_client(&account.id).await?;
                Ok::<_, Error>(client.session.vapid_key.clone())
            };
            (account, tokio::time::timeout(SERVER_WAIT, key).await)
        });
        let mut targets = Vec::new();
        let mut unreachable = Vec::new();
        for (account, outcome) in futures::future::join_all(checks).await {
            match outcome {
                Ok(Ok(Some(vapid_key))) => {
                    targets.push(Target { account_id: account.id.clone(), email: account.email.clone(), vapid_key })
                }
                Ok(Ok(None)) => {}
                Ok(Err(error)) => {
                    tracing::info!("Couldn't ask {} about push: {error}", account.id);
                    unreachable.push(account.id.clone());
                }
                Err(_) => unreachable.push(account.id.clone()),
            }
        }
        Ok((targets, unreachable))
    }

    /// Makes sure the server pushes the account's changes to `endpoint`: keeps and renews the
    /// subscription for it, or replaces the one for an older endpoint. `install_id` stays the same
    /// for this installation; with the account it makes the `deviceClientId`.
    pub async fn push_subscribe(&self, account_id: &str, install_id: &str, endpoint: Endpoint) -> Result<()> {
        endpoint.check()?;
        let inner = &self.inner;
        let _guard = inner.push_lock.lock().await;
        if inner.store.account(account_id)?.protocol != Protocol::Jmap {
            return Err(Error::not_supported("Only JMAP mailboxes get new mail through a push service."));
        }
        let client = inner.jmap_client(account_id).await?;
        if client.session.vapid_key.is_none() {
            return Err(Error::not_supported("This mail server doesn't push over Web Push."));
        }
        let device = jmap_push::device_client_id(install_id, account_id);
        let existing = inner.push_record(account_id);
        if let Some(record) = existing.as_ref().filter(|record| {
            record.endpoint == endpoint
                && record.device_client_id == device
                && record.vapid_key == client.session.vapid_key
        }) {
            // The same registration again (the app registers at every start): only look after it.
            return inner.maintain_push(&client, account_id, record.clone()).await;
        }
        // A new endpoint or new keys: the old subscription can't be used anymore, nor can
        // leftovers of earlier attempts on this device.
        let mut stale = jmap_push::ours(&client, &device).await.unwrap_or_default();
        if let Some(old) = &existing {
            stale.push(old.id.clone());
            if old.device_client_id != device {
                stale.extend(jmap_push::ours(&client, &old.device_client_id).await.unwrap_or_default());
            }
        }
        stale.sort();
        stale.dedup();
        if let Err(error) = jmap_push::destroy(&client, &stale).await {
            tracing::info!("Couldn't remove old push subscriptions of {account_id}: {error}");
        }
        inner.forget_push(account_id);
        inner.create_push(&client, account_id, device, endpoint, 0).await
    }

    /// Stops the account's push subscription on the server and forgets it.
    pub async fn push_unsubscribe(&self, account_id: &str) -> Result<()> {
        let inner = &self.inner;
        let _guard = inner.push_lock.lock().await;
        let Some(record) = inner.push_record(account_id) else { return Ok(()) };
        inner.forget_push(account_id);
        inner.emit(EngineEvent::PushChanged { reregister: false });
        let client = inner.jmap_client(account_id).await?;
        jmap_push::destroy(&client, &[record.id]).await
    }

    /// Looks after every push subscription: renews the ones that are due, makes the ones whose
    /// verification never came again, and drops the ones whose server has a new key. For the
    /// platform to call now and then, since a phone that syncs nothing for a week would otherwise
    /// let them end. A server that doesn't answer is tried again the next time.
    pub async fn push_maintain(&self) -> Result<()> {
        let accounts: Vec<String> = self
            .inner
            .store
            .accounts()?
            .into_iter()
            .filter(|account| account.protocol == Protocol::Jmap)
            .map(|account| account.id)
            .filter(|id| self.inner.push_record(id).is_some())
            .collect();
        for account_id in accounts {
            let work = async {
                let client = self.inner.jmap_client(&account_id).await?;
                let _guard = self.inner.push_lock.lock().await;
                let Some(record) = self.inner.push_record(&account_id) else { return Ok(()) };
                self.inner.maintain_push(&client, &account_id, record).await
            };
            match tokio::time::timeout(SERVER_WAIT, work).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => tracing::info!("Couldn't look after the push subscription of {account_id}: {error}"),
                Err(_) => tracing::info!("The server of {account_id} took too long to renew its push subscription"),
            }
        }
        Ok(())
    }

    /// Handles a decrypted push message for the account: answers a verification, or syncs what a
    /// state change names. Returns once that is done, so the platform can keep UwUMail awake until then.
    pub async fn push_received(&self, account_id: &str, body: &[u8]) -> Result<()> {
        let message = jmap_push::parse_message(body)?;
        let inner = &self.inner;
        if inner.store.account(account_id)?.protocol != Protocol::Jmap {
            return Ok(());
        }
        let client = inner.jmap_client(account_id).await?;
        match message {
            Message::Verification { subscription_id, code } => {
                // Waits for a subscription that is still being made (RFC 8620: the verification
                // may arrive before the server answered the creation).
                let _guard = inner.push_lock.lock().await;
                // Only the subscription UwUMail keeps for this account is answered (RFC 8620 asks
                // clients to leave others alone).
                let Some(mut record) = inner.push_record(account_id).filter(|record| record.id == subscription_id)
                else {
                    tracing::info!("A push verification of {account_id} was for another subscription");
                    return Ok(());
                };
                if record.verified {
                    return Ok(());
                }
                jmap_push::verify(&client, &record.id, &code).await?;
                record.verified = true;
                record.lost = 0;
                inner.save_push(account_id, &record)?;
                inner.emit(EngineEvent::PushChanged { reregister: false });
                Ok(())
            }
            Message::StateChange(changed) => {
                // Only a verified subscription gets state changes, even if its verification was missed here.
                if let Ok(_guard) = inner.push_lock.try_lock()
                    && let Some(mut record) = inner.push_record(account_id).filter(|record| !record.verified)
                {
                    record.verified = true;
                    record.lost = 0;
                    inner.save_push(account_id, &record)?;
                    inner.emit(EngineEvent::PushChanged { reregister: false });
                }
                // Shared mailboxes reached with this login follow its push (one subscription per login).
                // One that can't be synced now doesn't keep the login's own mail from it.
                for shared in inner.shares_changed(account_id, &changed) {
                    let synced = match inner.jmap_client(&shared).await {
                        Ok(shared_client) => inner.sync_jmap(&shared_client, &shared).await,
                        Err(error) => Err(error),
                    };
                    if let Err(error) = synced {
                        tracing::info!("Couldn't sync shared mailbox {shared}: {error}");
                    }
                }
                let Some(change) = jmap_push::state_change_for(&changed, &client.account_ids()) else {
                    return Ok(());
                };
                if inner.apply_state_change(&client, account_id, &change) {
                    inner.sync_jmap(&client, account_id).await?;
                }
                Ok(())
            }
        }
    }

    /// How many accounts get their new mail through the push service. Only reads the store.
    pub fn push_overview(&self) -> Result<Overview> {
        let mut overview = Overview::default();
        for account in self.inner.store.accounts()? {
            match self.inner.push_record(&account.id).filter(|_| account.protocol == Protocol::Jmap) {
                Some(record) if record.verified => overview.active += 1,
                Some(_) => overview.waiting += 1,
                None => overview.other += 1,
            }
        }
        Ok(overview)
    }
}

impl Inner {
    pub(super) fn push_record(&self, account_id: &str) -> Option<Subscription> {
        let saved = self.store.sync_state(account_id, RECORD).ok().flatten()?;
        serde_json::from_str(&saved).ok()
    }

    fn save_push(&self, account_id: &str, record: &Subscription) -> Result<()> {
        self.store.set_sync_state(account_id, RECORD, Some(&serde_json::to_string(record)?))
    }

    fn forget_push(&self, account_id: &str) {
        if let Err(error) = self.store.set_sync_state(account_id, RECORD, None) {
            tracing::warn!("Couldn't forget the push subscription of {account_id}: {error}");
        }
    }

    /// Creates the subscription and keeps it; the server then sends the verification to the
    /// endpoint. `lost` counts the earlier subscriptions for the endpoint whose verification never came.
    async fn create_push(
        &self,
        client: &JmapClient,
        account_id: &str,
        device: String,
        endpoint: Endpoint,
        lost: u32,
    ) -> Result<()> {
        let now = Utc::now();
        let wanted = jmap_push::utc_date(now + jmap_push::LIFETIME);
        let (id, expires) = jmap_push::create(client, &device, &endpoint, &wanted).await?;
        let record = Subscription {
            device_client_id: device,
            endpoint,
            vapid_key: client.session.vapid_key.clone(),
            id,
            expires: expires.or(Some(wanted)),
            verified: false,
            renewed_at: now.timestamp(),
            lost,
        };
        self.save_push(account_id, &record)?;
        self.emit(EngineEvent::PushChanged { reregister: false });
        // RFC 9749 §5: the key may have changed just before the subscription was made, and the
        // push service then refuses the verification.
        if client.session_outdated() {
            self.push_key_checked.lock().unwrap().remove(account_id);
            self.check_push_key(client, account_id, &record).await;
        }
        Ok(())
    }

    /// Keeps a subscription going: made again when its verification never came or the server lost
    /// it, renewed when that's due. The caller holds `push_lock`.
    async fn maintain_push(&self, client: &JmapClient, account_id: &str, mut record: Subscription) -> Result<()> {
        if self.check_push_key(client, account_id, &record).await {
            return Ok(());
        }
        let now = Utc::now();
        if record.verification_lost(now) {
            tracing::info!("The push verification of {account_id} never came, subscribing again");
            if let Err(error) = jmap_push::destroy(client, std::slice::from_ref(&record.id)).await {
                tracing::info!("Couldn't remove the unverified push subscription of {account_id}: {error}");
            }
            self.forget_push(account_id);
            let lost = record.lost.saturating_add(1);
            return self.create_push(client, account_id, record.device_client_id, record.endpoint, lost).await;
        }
        if !record.renewal_due(now) {
            return Ok(());
        }
        let wanted = jmap_push::utc_date(now + jmap_push::LIFETIME);
        match jmap_push::renew(client, &record.id, &wanted).await? {
            Renewal::Renewed(expires) => {
                record.expires = expires.or(Some(wanted));
                record.renewed_at = now.timestamp();
                self.save_push(account_id, &record)
            }
            Renewal::Gone => {
                tracing::info!("The push subscription of {account_id} ended on the server, making it again");
                self.forget_push(account_id);
                self.emit(EngineEvent::PushChanged { reregister: false });
                self.create_push(client, account_id, record.device_client_id, record.endpoint, 0).await
            }
        }
    }

    /// Drops the subscription when the server signs with another key now (RFC 9749 §5): the push
    /// service only takes messages signed with the key the endpoint was made for. Returns whether
    /// it was dropped.
    async fn check_push_key(&self, client: &JmapClient, account_id: &str, record: &Subscription) -> bool {
        let mut current = client.session.vapid_key.clone();
        if current == record.vapid_key && client.session_outdated() {
            let due = {
                let mut checked = self.push_key_checked.lock().unwrap();
                let due = checked.get(account_id).is_none_or(|at| at.elapsed() >= KEY_CHECK_EVERY);
                if due {
                    checked.insert(account_id.to_string(), Instant::now());
                }
                due
            };
            if !due {
                return false;
            }
            // Read the session again; the sync picks up the new one the next time it signs in.
            self.jmap.lock().await.remove(account_id);
            match self.jmap_client(account_id).await {
                Ok(fresh) => current = fresh.session.vapid_key.clone(),
                Err(error) => {
                    tracing::info!("Couldn't read the session of {account_id} again: {error}");
                    return false;
                }
            }
        }
        if current == record.vapid_key {
            return false;
        }
        tracing::info!("The server of {account_id} has a new push key, registering again");
        if let Err(error) = jmap_push::destroy(client, std::slice::from_ref(&record.id)).await {
            tracing::info!("Couldn't remove the old push subscription of {account_id}: {error}");
        }
        self.forget_push(account_id);
        self.emit(EngineEvent::PushChanged { reregister: true });
        true
    }

    /// After a sync: looks after the account's push subscription, if it has one. Skipped while a
    /// subscription is being made or answered.
    pub(super) async fn check_push(&self, client: &JmapClient, account_id: &str) {
        let Ok(_guard) = self.push_lock.try_lock() else { return };
        let Some(record) = self.push_record(account_id) else { return };
        if let Err(error) = self.maintain_push(client, account_id, record).await {
            tracing::info!("Couldn't renew the push subscription of {account_id}: {error}");
        }
    }
}
