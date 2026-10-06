//! One bounded round of looking for new mail in every account, for a phone the system woke up
//! for a short while (iOS background refresh, `BGAppRefreshTask`).
//!
//! The accounts' own sync loops do the work: they are woken, and this waits until each has
//! gone through one round to its end ([`EngineEvent::SyncFinished`]), or until the time the
//! system granted is up. New mail on the way is announced as [`EngineEvent::MailReceived`]
//! like at any other time, which is what rings.
//!
//! A loop that fails — after a long rest its connection is usually gone — is woken once more:
//! that makes it connect again at once instead of waiting out its back-off.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::broadcast::error::RecvError;

use super::Engine;
use crate::model::{AccountStatus, EngineEvent};

/// How a round went.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshOutcome {
    /// Accounts that were looked at.
    pub accounts: usize,
    /// Of those, the ones that finished their round (the rest failed or ran out of time).
    pub finished: usize,
    /// New unread mails announced on the way.
    pub new_mail: usize,
    /// The time was up before every account was through.
    pub timed_out: bool,
}

/// A failing account is woken this many times again before it counts as done.
const RETRIES: u8 = 1;

impl Engine {
    /// Wakes every account's sync and waits until each went through one round, at most `budget`.
    pub async fn refresh_all(&self, budget: Duration) -> RefreshOutcome {
        // Subscribed first, so nothing that happens right after the wake-up is missed.
        let mut events = self.subscribe();
        let ids: Vec<String> = self.inner.accounts.lock().unwrap().keys().cloned().collect();
        let mut outcome = RefreshOutcome { accounts: ids.len(), ..RefreshOutcome::default() };
        if ids.is_empty() {
            return outcome;
        }
        let mut waiting: HashSet<String> = ids.iter().cloned().collect();
        let mut retries: HashMap<String, u8> = HashMap::new();
        self.sync_now(None);

        let round = async {
            while !waiting.is_empty() {
                match events.recv().await {
                    Ok(EngineEvent::SyncFinished { account_id }) => {
                        if waiting.remove(&account_id) {
                            outcome.finished += 1;
                        }
                    }
                    Ok(EngineEvent::MailReceived { message_ids, .. }) => outcome.new_mail += message_ids.len(),
                    Ok(EngineEvent::AccountStatus {
                        account_id,
                        status: AccountStatus::Offline | AccountStatus::Error { .. },
                    }) if waiting.contains(&account_id) => {
                        let tried = retries.entry(account_id.clone()).or_default();
                        if *tried < RETRIES {
                            *tried += 1;
                            self.inner.wake(&account_id);
                        } else {
                            waiting.remove(&account_id);
                        }
                    }
                    Ok(_) | Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => break,
                }
            }
        };
        outcome.timed_out = tokio::time::timeout(budget, round).await.is_err();
        outcome
    }
}
