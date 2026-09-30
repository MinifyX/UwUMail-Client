//! The price list behind this device's assistant costs: kept in memory and in the store
//! (`assist_settings`, key `prices`), fetched again once a day in the background. Only the very
//! first time is waited for, briefly, so an estimate shows a cost from the start; offline, the
//! last good copy keeps serving.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;
use crate::assist::prices::{self, PriceTable, Sources};

/// Where the table is kept in `assist_settings`.
const PRICES_KEY: &str = "prices";
/// How long a call waits for the very first fetch.
const FIRST_WAIT: Duration = Duration::from_secs(8);

pub(super) struct PriceState {
    table: Mutex<Option<Arc<PriceTable>>>,
    /// Where prices come from; `None` never fetches (tests).
    sources: Mutex<Option<Sources>>,
    refreshing: AtomicBool,
}

impl PriceState {
    pub(super) fn new() -> Self {
        let sources = if cfg!(test) { None } else { Some(Sources::default()) };
        Self { table: Mutex::new(None), sources: Mutex::new(sources), refreshing: AtomicBool::new(false) }
    }
}

/// The currency asked for: three letters, EUR when missing or odd.
pub fn currency(value: Option<&str>) -> String {
    match value.map(str::trim) {
        Some(code) if code.len() == 3 && code.chars().all(|c| c.is_ascii_alphabetic()) => code.to_ascii_uppercase(),
        _ => "EUR".into(),
    }
}

impl Engine {
    fn price_state(&self) -> &PriceState {
        &self.inner.assist.prices
    }

    /// The table as far as it is known, from memory or else the store; never waits for the network.
    pub(super) fn known_prices(&self) -> Option<Arc<PriceTable>> {
        let state = self.price_state();
        if let Some(table) = state.table.lock().unwrap().clone() {
            return Some(table);
        }
        let stored = self.inner.store.assist_setting(PRICES_KEY).ok().flatten()?;
        let table: PriceTable = serde_json::from_str(&stored).ok()?;
        let table = Arc::new(table);
        let mut slot = state.table.lock().unwrap();
        Some(slot.get_or_insert(table).clone())
    }

    /// The table for a cost the page shows: fetched again when a day old (in the background when
    /// there is a copy, else waited for a few seconds).
    pub(super) async fn current_prices(&self) -> Option<Arc<PriceTable>> {
        let known = self.known_prices();
        let due = known.as_ref().is_none_or(|table| table.due(now_millis() / 1000));
        if !due || self.price_state().sources.lock().unwrap().is_none() {
            return known;
        }
        match known {
            Some(table) => {
                let engine = self.clone();
                tokio::spawn(async move { engine.refresh_prices().await });
                Some(table)
            }
            None => {
                let _ = tokio::time::timeout(FIRST_WAIT, self.refresh_prices()).await;
                self.known_prices()
            }
        }
    }

    /// Fetches the sources once, merges what came and keeps it; one fetch at a time.
    async fn refresh_prices(&self) {
        let state = self.price_state();
        let Some(sources) = state.sources.lock().unwrap().clone() else { return };
        if state.refreshing.swap(true, Ordering::AcqRel) {
            return;
        }
        struct Done<'a>(&'a AtomicBool);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _done = Done(&state.refreshing);
        let Ok(http) = self.assist_http() else { return };
        let fetched = prices::fetch(http, &sources).await;
        let mut table = self.known_prices().map(|table| (*table).clone()).unwrap_or_default();
        table.merge(fetched, now_millis() / 1000);
        if let Ok(text) = serde_json::to_string(&table) {
            let _ = self.inner.store.set_assist_setting(PRICES_KEY, Some(&text));
        }
        *state.table.lock().unwrap() = Some(Arc::new(table));
    }

    #[cfg(test)]
    pub(super) fn use_price_sources(&self, sources: Sources) {
        *self.price_state().sources.lock().unwrap() = Some(sources);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn currencies_are_three_letters() {
        assert_eq!(currency(Some("usd")), "USD");
        assert_eq!(currency(Some(" jpy ")), "JPY");
        assert_eq!(currency(Some("euro")), "EUR");
        assert_eq!(currency(Some("€")), "EUR");
        assert_eq!(currency(None), "EUR");
    }
}
