# Architecture

```
┌──────────────────────────── UwUMail desktop app ─────────────────────────────┐
│                                                                              │
│  WebView (React UI)                           Rust process (Tauri shell)     │
│  ┌────────────────────────────┐   commands    ┌───────────────────────────┐  │
│  │ Layouts: Simple / Pro      │ ────────────▶ │ apps/desktop/src-tauri    │  │
│  │ Mail, compose, settings    │ ◀──────────── │  commands.rs, events      │  │
│  │ Addon host                 │    events     └────────────┬──────────────┘  │
│  │  ┌──────────┐ ┌──────────┐ │                            │                 │
│  │  │ addon A  │ │ addon B  │ │ postMessage RPC            ▼                 │
│  │  │ sandbox  │ │ sandbox  │ │ (permission-checked) ┌───────────────────┐   │
│  │  └──────────┘ └──────────┘ │                      │ crates/uwumail-core│  │
│  └────────────────────────────┘                      │  accounts, sync,  │   │
│                                                      │  smtp, store, fts │   │
│                                                      └──┬──────────┬─────┘   │
└─────────────────────────────────────────────────────────┼──────────┼─────────┘
                                                          │          │
                                   OS keychain ◀──────────┘          ▼
                                   (passwords, tokens)   IMAP / SMTP or JMAP servers
```

## Components

### `crates/uwumail-core` — the mail engine

Plain Rust library without any Tauri dependency, so it can be tested on its own
and reused (CLI, future sync server).

| Module | Responsibility |
| --- | --- |
| `autoconfig` | Find server settings from an address: Thunderbird ISPDB, the domain's own autoconfig, RFC 6186 SRV records, MX-based provider lookup, then educated guesses |
| `secrets` | Store passwords and OAuth refresh tokens in the OS keychain (`keyring`) |
| `oauth` | Authorization code flow with PKCE and a loopback redirect for Microsoft and Google |
| `imap` | Connect (TLS / STARTTLS), authenticate (LOGIN / XOAUTH2), list folders with special-use detection, sync, IDLE |
| `jmap` | JMAP client (RFC 8620/8621): discovery, sign-in with password or API token, method calls, blobs, EventSource push |
| `jmap_sync` | Mailboxes and emails into the store from saved states; keywords, moves, deletes and sending via EmailSubmission |
| `sync` | Per-account task: incremental header sync (CONDSTORE when available, otherwise UIDNEXT + flag window), body prefetch, change events |
| `smtp` | Send through submission (465 TLS / 587 STARTTLS), then store in the Sent folder |
| `mime` | Parse with `mail-parser`, build with `mail-builder`, sanitize HTML with `ammonia` |
| `threading` | Conversation grouping (Message-ID / In-Reply-To / References, Gmail thread IDs when present) |
| `store` | SQLite (WAL) with migrations and an FTS5 index for instant search |
| `contacts` | Address book fed by sent and received mail, later CardDAV |

The mail server is always the source of truth. The local store is a cache that
can be deleted at any time and rebuilt.

### JMAP

Each account uses either IMAP + SMTP or JMAP. Setup looks for JMAP next to the
IMAP settings (known providers such as Fastmail, the `_jmap._tcp` SRV record,
then `https://<domain | mail host | mail.<domain> | jmap.<domain>>/.well-known/jmap`)
and picks JMAP when a server answers; the account settings can switch back to
IMAP (and forth), which rebuilds the local cache.

- **Sign-in:** HTTP Basic with the password; if the server refuses it, the same
  secret is tried as a Bearer token (Fastmail API tokens).
- **Addresses:** self-hosted servers often announce a public hostname that isn't
  reachable from the client (reverse proxy, LAN). If the announced API address
  can't be reached, UwUMail uses the origin of the session URL it was given.
- **Sync:** mailboxes become folders (path = mailbox id, nesting from
  `parentId`). The first sync lists the newest 400 emails per mailbox; later
  syncs only fetch `Email/changes` since the saved state. Emails up to 2 MB are
  downloaded whole; bigger ones are stored from their headers and downloaded on
  open. An email in several mailboxes is shown in one (trash, junk, inbox,
  custom, drafts, sent, archive — first match).
- **Push:** an EventSource connection wakes the sync on every state change,
  with a check every minute when the server offers no push.
- **Sending:** the message is built like for SMTP, uploaded, imported into Sent
  and submitted with an explicit envelope (so Bcc works); if the submission
  fails, the Sent copy is removed.
- **Tests:** `dev/stalwart.sh` starts Stalwart with two users;
  `tests/stalwart.rs` covers setup, nested mailboxes, sending with attachments,
  push, flags in both directions, reply threading and trash.

### `apps/desktop/src-tauri` — the shell

Thin layer that owns the app lifecycle: windows, tray, notifications, updater,
and the command/event bridge. Each Tauri command maps to one core function.
Long-running work (sync, IDLE) lives in core tasks that push events such as
`mail:changed` and `account:status` to the UI.

Desktop and Android share this crate; `src/lib.rs` holds the commands and
`src/desktop.rs` / `src/android.rs` (both as `platform`) what differs: tray,
updater and dialogs on desktop, the Kotlin bridge on Android.

### Android

The Android app is the same Tauri app (`tauri.android.conf.json`, package
`app.uwumail`, Android 10+). The Gradle project in `src-tauri/gen/android` is
checked in because it carries UwUMail's own Kotlin code.

- **The engine lives as long as the process**, not as long as the window:
  `UwuApplication.onCreate` starts it through `crates/uwumail-android`, and
  the Tauri window borrows it (`tauri::async_runtime::set` joins its Tokio
  runtime). That way `MailWatchService`, a foreground service with a quiet
  notification, keeps IMAP IDLE and JMAP push connected without a window.
  When Android destroys the window while the service runs, the next start
  goes through `RelaunchActivity` into a fresh process, because a web view
  can't be attached to a second activity.
- **Bridge:** Rust calls `UwuBridge.call(method, json)` and Kotlin calls
  `UwuNative.call(method, json)` — one JNI function each way, on jni 0.21
  like tao and wry (0.22 failed its class lookups on Android). Kotlin handles
  the Android Keystore (passwords), notifications with actions, shares and
  `mailto:` intents, opening files, Downloads, the APK installer and the
  system bars.
- **TLS:** IMAP, SMTP, JMAP and HTTPS check certificates against Mozilla's
  root list (`uwumail_core::tls`), because Android's own check needs Java
  classes loaded before the first connection. Certificates a user installed
  on the phone aren't trusted yet.
- **Offline window:** phones keep the last 90 days complete
  (`Engine::set_offline_days`); older mail is stored with headers and a
  preview, and `Engine::search_server` finds and adds mail that never came
  down.
- **Signing:** CI builds the APK unsigned, then signs it in a separate step
  with the key in the `UWUMAIL_ANDROID_KEYSTORE_*` secrets and checks the
  pinned certificate, so newer builds install over older ones and the key is
  never around while third-party build code runs.
- **App lock:** covers the UI (dialogs close while locked); with it on,
  notifications leave out sender and subject and Recents shows no preview.

### `apps/desktop/src` — the UI

React 19, Vite, Tailwind CSS 4, TypeScript.

- `backend/` — one `Backend` interface with two implementations:
  `TauriBackend` (real engine) and `DemoBackend` (in-memory sample data).
  `pnpm dev` runs the UI in a normal browser on demo data, which keeps UI
  work fast and makes screenshots reproducible.
- `state/` — UI state (zustand) and persisted settings.
- `i18n/` — English and German strings in two i18next namespaces per
  language: `neutral` (complete) and `playful` (overrides). `useT()` picks the
  namespace for the active tone; missing playful keys fall back to neutral.
- `features/` — mail list, reader, composer, onboarding, settings, addons.
  `features/mobile` is the phone layout below 700 px: list, reader, drawer,
  swipes, pull to refresh, app lock and the Android bridge hooks.
- `addons/` — the addon host (sandbox frames, RPC, permission checks).

### Mail rendering

Message HTML is sanitized in Rust, then displayed in an `<iframe sandbox>`
without script permissions and with a CSP that blocks all remote content.
"Load remote images" re-renders with images allowed for that message. "Always
load" remembers the address or the company domain (the registrable domain from
the public suffix list, never a mail provider), kept in the settings and listed
under Settings → Reading.

### Addons

See [addons.md](addons.md). In short: each addon runs in its own sandboxed
iframe with an opaque origin and no access to Tauri. It talks to the host over
`postMessage`; the host checks every call against the permissions the user
granted and forwards allowed calls to the backend. Network access goes through
the host too, limited to the hosts in the manifest.

## Data locations

| Data | Where |
| --- | --- |
| Mail cache, contacts, addon storage | `<app data>/uwumail.db` |
| Opened attachments (trimmed at 1 GB) | `<app data>/attachments/<message id>/` |
| Sender pictures (30 days per domain) | `<app data>/pictures/<domain>.<logo\|icon>.<ext>` |
| Installed addons | `<app data>/addons/<addon id>/` |
| Passwords, OAuth refresh tokens | OS keychain, service `UwUMail` |
| UI settings | WebView local storage (`uwumail.settings`) |

`<app data>` is `%APPDATA%\app.uwumail.desktop` on Windows,
`~/Library/Application Support/app.uwumail.desktop` on macOS and
`~/.local/share/app.uwumail.desktop` on Linux (from the Tauri identifier).
On Android it's the app's private data folder of `app.uwumail`; passwords are
encrypted with a key in the Android Keystore and kept in the app's private
preferences.

## Sender pictures

For company addresses the engine looks for a picture in this order: the BIMI
logo (`default._bimi.<domain>` TXT record, SVG over HTTPS), the app icon or
largest icon linked from the website, then `/favicon.ico`. It only contacts the
registrable domain (`news.mail.shop.example` → `shop.example`), over HTTPS,
without cookies or referrer, at most four domains at a time, and remembers the
result (including "nothing found") for 30 days. Addresses at mail providers
(Gmail, GMX, Outlook, …) and names without a public suffix never cause a
request, and icon links or redirects to IP addresses, `localhost` or local
names are ignored. The setting lives under Reading and is on by default.

## Windows installer and updates

`apps/setup` is UwUMail's own installer: a small Tauri app with Nyu that
carries the UwUMail executable inside (zstd-packed at build time,
`pnpm build:setup`). It installs for the current user without admin rights:

| What | Where |
| --- | --- |
| App and `uninstall.exe` | `%LOCALAPPDATA%\Programs\UwUMail` (changeable) |
| Shortcuts | Start menu (always, with the AppUserModelID notifications need), desktop (optional) |
| "Installed apps" entry | `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\UwUMail` |
| Start with Windows | `HKCU\…\Run` → `UwUMail.exe --autostart` (starts hidden in the tray) |
| Default mail app | `HKCU\Software\Classes\UwUMail.mailto`, `Software\UwUMail\Capabilities`, `RegisteredApplications`, then Windows' default apps page |
| Remembered options | `HKCU\Software\UwUMail\Setup` |

The setup replaces the old NSIS installation of 0.1.0 and keeps mail data. The
uninstaller runs from a temporary copy so it can delete itself, and removes
mail data and keychain entries only if asked. Without WebView2 it offers to
download it first. `UWUMAIL_SETUP_SANDBOX=<folder>` redirects files, shortcuts
and registry keys for testing.

Updates: the app checks `stable.json` or `beta.json` in the public
`MinifyX/UwUMail-Releases` repo 20 seconds after start and every six hours
(`tauri-plugin-updater`, signature checked against the public key in
`tauri.conf.json`). It downloads the new `UwUMail-Setup-<version>.exe` into
`%LOCALAPPDATA%\app.uwumail.desktop\updates`, shows Nyu's hint, and either
restarts into it now or on the next start (`--update --relaunch --wait-pid`).
Right before the setup runs, its signature is checked again, and in update mode
the setup refuses to replace a newer installed version, because the version
number in the feed isn't signed.

## Security

See [security-audit.md](security-audit.md) for the threat model, the last audit
and accepted risks, and [SECURITY.md](../SECURITY.md) for reporting issues. In
short: mail content never runs in the app page; file access, the dangerous-file
warning and save locations are decided in Rust, not by the page; links only
open for `https`, `http` and `mailto`, with a warning when the text shows a
different site than the target.

## Build and release

- Every push: typecheck, lint, unit tests, `cargo clippy`, `cargo test`
  (including integration tests against GreenMail and Stalwart), `cargo audit`
  and `pnpm audit --prod`. All actions are pinned to commit SHAs.
- Every push to `main`: `UwUMail-Setup-<version>.exe` for Windows and the Linux
  packages as workflow artifacts.
- Tags `vX.Y.Z` (or `vX.Y.Z-beta.N`): the signed setup goes to
  `MinifyX/UwUMail-Releases` as a release and into the update feeds (see
  `release-notes/README.md`); macOS and Linux get a draft release here.
