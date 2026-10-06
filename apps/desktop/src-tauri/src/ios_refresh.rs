//! iPhone and iPad: looking for new mail while UwUMail rests in the background.
//!
//! iOS keeps no app running, but it wakes one now and then for a few seconds when the app asked
//! for it (`BGAppRefreshTask`, identifier [`TASK`] in `BGTaskSchedulerPermittedIdentifiers` of
//! Info.ios.plist). iOS alone decides when: it learns when UwUMail is usually opened, and skips
//! it in Low Power Mode or with Background App Refresh switched off.
//!
//! - The handler is registered while the app finishes launching ([`register`], from `after_start`,
//!   which Tauri runs inside `didFinishLaunching`); iOS ends an app that registers later.
//! - The next wake-up is asked for whenever UwUMail goes into the background, and again at the
//!   start of every wake-up, at the earliest [`EVERY`] later.
//! - A wake-up runs one bounded round of the engine (`Engine::refresh_all`, at most [`BUDGET`]):
//!   every account's sync looks for mail once, and new mail rings through the same notifications
//!   as at any other time (`ios.rs` `on_engine_event`), as UwUMail isn't the app in front.
//! - When iOS takes the time back early (the expiration handler), the round stops and the task is
//!   reported unsuccessful; either way it is reported exactly once.
//!
//! The simulator can't run background tasks at all (submitting fails there with
//! `BGTaskSchedulerErrorCodeUnavailable`). For the smoke test the same round can be started at
//! launch instead: with `UWUMAIL_REFRESH_NOW` in the environment (`simctl launch` passes
//! `SIMCTL_CHILD_UWUMAIL_REFRESH_NOW`), see scripts/ios-smoke.sh. Each round leaves its outcome
//! in `background-refresh.json` in the app's data folder.

use std::ptr::NonNull;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use block2::RcBlock;
use objc2::AllocAnyThread;
use objc2::rc::Retained;
use objc2_background_tasks::{BGAppRefreshTaskRequest, BGTask, BGTaskScheduler};
use objc2_foundation::{NSDate, NSNotification, NSNotificationCenter, NSString};
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;
use uwumail_core::Engine;

/// The task's identifier, as in Info.ios.plist.
pub const TASK: &str = "app.uwumail.refresh";
/// The earliest next wake-up after the last one; iOS usually waits longer.
const EVERY: f64 = 15.0 * 60.0;
/// iOS grants about 30 seconds; the rest is for the notifications and reporting back.
const BUDGET: Duration = Duration::from_secs(25);
/// Time for the notifications of the last new mail to reach the system before UwUMail is
/// suspended again.
const SETTLE: Duration = Duration::from_millis(1500);

/// Whether UwUMail is the app in front. False until iOS says otherwise: a launch for a background
/// wake-up never becomes active.
static ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn in_foreground() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

/// The `BGTask` handed to the launch handler, to report back from the engine's threads.
struct Task(Retained<BGTask>);
// SAFETY: BGTask's methods (`setTaskCompletedWithSuccess:`, `setExpirationHandler:`) may be
// called from any thread; Apple's own samples call them from background queues.
unsafe impl Send for Task {}
unsafe impl Sync for Task {}

pub fn register(app: &AppHandle) {
    observe("UIApplicationDidBecomeActiveNotification", || ACTIVE.store(true, Ordering::Relaxed));
    observe("UIApplicationWillResignActiveNotification", || ACTIVE.store(false, Ordering::Relaxed));
    observe("UIApplicationDidEnterBackgroundNotification", schedule);

    let handle = app.clone();
    let launch = RcBlock::new(move |task: NonNull<BGTask>| {
        // SAFETY: iOS hands over a valid task; retaining keeps it alive while the round runs.
        let Some(task) = (unsafe { Retained::retain(task.as_ptr()) }) else { return };
        run(handle.clone(), Some(Task(task)));
    });
    let identifier = NSString::from_str(TASK);
    // SAFETY: called once, during launch; `None` is iOS' own background queue.
    let registered = unsafe {
        BGTaskScheduler::sharedScheduler().registerForTaskWithIdentifier_usingQueue_launchHandler(
            &identifier,
            None,
            &launch,
        )
    };
    println!("UwUMail: background refresh {}", if registered { "registered" } else { "not registered" });
    if registered {
        schedule();
    }

    if std::env::var_os("UWUMAIL_REFRESH_NOW").is_some() {
        run(app.clone(), None);
    }
}

/// Calls `then` on every notification of that name, for the life of the app.
fn observe(name: &str, then: fn()) {
    let block = RcBlock::new(move |_: NonNull<NSNotification>| then());
    let name = NSString::from_str(name);
    // SAFETY: the block only touches an atomic or asks for a task; `None` delivers on the posting
    // thread, which is fine for both.
    let observer = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(&name),
            None,
            None,
            &block,
        )
    };
    // The center keeps the observer as long as it is registered, which is for good.
    std::mem::forget(observer);
}

/// Asks iOS for the next wake-up. A pending request is replaced, so asking often is harmless.
fn schedule() {
    let identifier = NSString::from_str(TASK);
    // SAFETY: a plain request with a date; submitting is allowed from any thread.
    let result = unsafe {
        let request = BGAppRefreshTaskRequest::initWithIdentifier(BGAppRefreshTaskRequest::alloc(), &identifier);
        request.setEarliestBeginDate(Some(&NSDate::dateWithTimeIntervalSinceNow(EVERY)));
        BGTaskScheduler::sharedScheduler().submitTaskRequest_error(&request)
    };
    match result {
        Ok(()) => println!("UwUMail: background refresh scheduled"),
        // 1 = unavailable (simulator, Background App Refresh off), 2 = too many requests.
        Err(error) => println!("UwUMail: background refresh not scheduled ({})", error.code()),
    }
}

/// One round, reported to iOS (when it asked for it) exactly once.
fn run(app: AppHandle, task: Option<Task>) {
    let task = task.map(Arc::new);
    let expired = Arc::new(Notify::new());
    if let Some(task) = &task {
        schedule();
        let expired = Arc::clone(&expired);
        let on_expiry = RcBlock::new(move || expired.notify_one());
        // SAFETY: the handler only wakes the round below, which then reports back.
        unsafe { task.0.setExpirationHandler(Some(&on_expiry)) };
    }
    tauri::async_runtime::spawn(async move {
        let outcome = match app.try_state::<Engine>() {
            Some(engine) => {
                let engine = engine.inner().clone();
                tokio::select! {
                    outcome = engine.refresh_all(BUDGET) => Some(outcome),
                    _ = expired.notified() => None,
                }
            }
            None => None,
        };
        if outcome.as_ref().is_some_and(|outcome| outcome.new_mail > 0) {
            tokio::time::sleep(SETTLE).await;
        }
        record(&app, outcome.as_ref());
        let success = outcome.as_ref().is_some_and(|outcome| !outcome.timed_out);
        println!("UwUMail: background refresh finished ({})", if success { "done" } else { "cut short" });
        if let Some(task) = task {
            // SAFETY: reported once, here; iOS may suspend the app right after.
            unsafe { task.0.setTaskCompletedWithSuccess(success) };
        }
    });
}

/// The last round's outcome, for a look from Xcode or the smoke test. Holds no mail.
fn record(app: &AppHandle, outcome: Option<&uwumail_core::engine::RefreshOutcome>) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    let json = serde_json::json!({ "at": at, "expired": outcome.is_none(), "outcome": outcome });
    let _ = std::fs::write(dir.join("background-refresh.json"), json.to_string());
}
