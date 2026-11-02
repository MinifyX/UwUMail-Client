//! How new-mail notifications read on the desktop and on iOS, as the page last said (Settings →
//! "Show sender and subject"). Kept in a small file next to the engine's data, so a start with a
//! hidden window honours it before the page has loaded. Only when nothing was ever stored do they
//! show sender and subject. Muted accounts and quiet hours (synced settings `notify.muted:<addr>`,
//! `notify.quietHours`) live here too, so mail that comes while no page runs keeps quiet as well.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde_json::{Value, json};
use uwumail_core::notify::{NotifyPrefs, QuietHours};

const FILE: &str = "notification-prefs.json";
/// The file holds two switches, six short lines, account ids and quiet hours.
const MAX_FILE: u64 = 64 * 1024;

struct State {
    file: Option<PathBuf>,
    prefs: Option<NotifyPrefs>,
}

static STATE: Mutex<State> = Mutex::new(State { file: None, prefs: None });

/// Reads what was stored in `dir` (the app's data directory) at start.
pub fn init(dir: &Path) {
    let file = dir.join(FILE);
    let prefs = read(&file);
    let mut state = STATE.lock().unwrap_or_else(PoisonError::into_inner);
    state.file = Some(file);
    // The page may have spoken first; what it said is newer.
    if state.prefs.is_none() {
        state.prefs = prefs;
    }
}

pub fn set(prefs: NotifyPrefs) {
    let mut state = STATE.lock().unwrap_or_else(PoisonError::into_inner);
    if state.prefs.as_ref() == Some(&prefs) {
        return;
    }
    if let Some(file) = &state.file
        && let Err(error) = write(file, &prefs)
    {
        tracing::warn!("Couldn't keep the notification settings: {error}");
    }
    state.prefs = Some(prefs);
}

pub fn get() -> NotifyPrefs {
    STATE.lock().unwrap_or_else(PoisonError::into_inner).prefs.clone().unwrap_or_default()
}

/// What the file holds, read by its shape; anything else counts as never stored.
fn read(file: &Path) -> Option<NotifyPrefs> {
    if std::fs::metadata(file).ok()?.len() > MAX_FILE {
        return None;
    }
    let value: Value = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    let show_content = value.get("showContent")?.as_bool()?;
    let text = |key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    let muted = value
        .get("muted")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let quiet = value.get("quietHours").and_then(QuietHours::from_value);
    let on_lock_screen = value.get("codeOnLockScreen").and_then(Value::as_bool).unwrap_or(false);
    Some(
        NotifyPrefs::new(show_content, &text("newMail"), &text("hidden"), &text("many"))
            .with_filter(muted, quiet)
            .with_codes(&text("codeTitle"), &text("linkTitle"), &text("copyCode"), on_lock_screen),
    )
}

/// Written next to the file and moved over it, so a crash never leaves half of it.
fn write(file: &Path, prefs: &NotifyPrefs) -> std::io::Result<()> {
    let body = json!({
        "showContent": prefs.show_content,
        "newMail": prefs.new_mail,
        "hidden": prefs.hidden,
        "many": prefs.many,
        "muted": prefs.muted,
        "quietHours": prefs.quiet.as_ref().map(QuietHours::to_value),
        "codeTitle": prefs.code_title,
        "linkTitle": prefs.link_title,
        "copyCode": prefs.copy_code,
        "codeOnLockScreen": prefs.code_on_lock_screen,
    });
    let temporary = file.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec(&body)?)?;
    std::fs::rename(&temporary, file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("uwumail-notify-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn keeps_the_choice_across_starts() {
        let dir = temp_dir("keep");
        let file = dir.join(FILE);
        assert_eq!(read(&file), None);
        let hidden = NotifyPrefs::new(false, "Neue Mail", "Öffne UwUMail, um sie zu lesen.", "{n} neue Mails");
        write(&file, &hidden).unwrap();
        assert_eq!(read(&file), Some(hidden));
        // Another shape, or a huge file, counts as never stored.
        std::fs::write(&file, br#"{"showContent":"no"}"#).unwrap();
        assert_eq!(read(&file), None);
        std::fs::write(&file, vec![b' '; MAX_FILE as usize + 1]).unwrap();
        assert_eq!(read(&file), None);
        // Texts from the file go through the same cleaning as the page's.
        std::fs::write(&file, r#"{"showContent":false,"newMail":"a\u202eb","hidden":""}"#).unwrap();
        assert_eq!(read(&file).unwrap().new_mail, "ab");
        // Muted accounts and quiet hours come back as they were kept.
        let quiet = QuietHours::parse("22:00", "07:00", &[0, 6]);
        let filtered = NotifyPrefs::default().with_filter(vec!["acc-1".into()], quiet);
        write(&file, &filtered).unwrap();
        assert_eq!(read(&file), Some(filtered));
        std::fs::write(&file, r#"{"showContent":true,"quietHours":{"from":"25:00","to":"07:00","days":[1]}}"#).unwrap();
        assert_eq!(read(&file).unwrap().quiet, None);
        // The texts for sign-in codes too; the code stays off the lock screen unless switched on.
        let codes =
            NotifyPrefs::default().with_codes("Anmeldecode von {sender}", "Link von {sender}", "Kopieren", true);
        write(&file, &codes).unwrap();
        assert_eq!(read(&file), Some(codes));
        std::fs::write(&file, r#"{"showContent":true}"#).unwrap();
        assert!(!read(&file).unwrap().code_on_lock_screen);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
