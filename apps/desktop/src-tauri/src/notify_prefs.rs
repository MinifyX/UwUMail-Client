//! How new-mail notifications read on the desktop and on iOS, as the page last said (Settings →
//! "Show sender and subject"). Until the page has said anything, they show sender and subject,
//! as before; the app lock hides them too.

use std::sync::{Mutex, PoisonError};

use uwumail_core::notify::NotifyPrefs;

static PREFS: Mutex<Option<NotifyPrefs>> = Mutex::new(None);

pub fn set(prefs: NotifyPrefs) {
    *PREFS.lock().unwrap_or_else(PoisonError::into_inner) = Some(prefs);
}

pub fn get() -> NotifyPrefs {
    PREFS.lock().unwrap_or_else(PoisonError::into_inner).clone().unwrap_or_default()
}
