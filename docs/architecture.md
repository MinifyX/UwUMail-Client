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

### Settings sync

A UwUMail server keeps one settings document per login
(`urn:uwumail:jmap:settings`, UwUMail-Server `docs/jmap-settings.md`) that the
webmail and the apps share. The engine only carries it (`jmap_settings.rs`,
commands `settings_sync_accounts`, `load_user_settings`, `save_user_settings`)
and reports `settings:changed` when a push names `UserSettings`, and once push
is up. Everything else happens in the page, in two files that are identical in
UwUMail-Webmail:

- `lib/settingsSync.ts` maps settings onto keys (choices one key each, lists one
  key per entry, signatures `signature:<id>`), checks values the way the server
  does, and merges: the first time lists become the union of both sides and the
  server's choices win; after that the server wins unless a change made here is
  still waiting.
- `lib/settingsSyncQueue.ts` sends changes batched after a short pause, with
  `ifInState`; on `stateMismatch` it reads, merges and sends again. Changes made
  offline wait in `localStorage` and go out on the next push, reconnect or retry.
  Keys the server refuses stay on the device.

`state/accountSync.ts` picks the account (Settings → Accounts, "Sync settings";
first account that can by default, or off), keeps signatures in the local
database and cleans the ones that come in. Device-only settings (layout,
density, swipes, motion, app lock, background, updates, workspaces) never
travel. `tests/uwumail_server.rs` runs against a local server:

```bash
# in UwUMail-Server: create a.test and mini@a.test, then serve with plain HTTP
UWUMAIL_LISTEN__PROXY=127.0.0.1:18080 … cargo run -p uwumail-server -- serve
UWUMAIL_TEST_SERVER=http://127.0.0.1:18080 UWUMAIL_TEST_LOGIN=mini@a.test \
UWUMAIL_TEST_PASSWORD=… cargo test -p uwumail-core --test uwumail_server -- --test-threads=1
```

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
- **Sign-in with Microsoft or Google:** the browser comes back through
  `app.uwumail://oauth`. `Launch.kt` passes only that URL to
  `Engine::finish_sign_in`, which hands it to the waiting sign-in (state and
  PKCE checked there); the link itself is never logged.
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

### Drafts

The composer saves 2.5 seconds after the last change (at least every 15
seconds while typing) and when it closes. `Engine::save_draft` builds the
message like for sending, but keeps Bcc and a stable Message-ID, the draft
key: over IMAP it appends to the Drafts folder with `\Draft \Seen`, finds all
versions with `UID SEARCH HEADER Message-ID` and deletes all but the newest;
over JMAP it imports into the Drafts mailbox and destroys older emails with
the same `messageId` (compared on the client, because servers don't reliably
filter by that header). Sending with the key removes every version.
`open_draft` reads the saved message back, including Bcc and attachments.
Next to the server copy the composer keeps one local copy (local storage):
drafts that never reached the server come back on the next start, and on the
phone the open draft always comes back as its bar.

### Undo send

With undo send on (Settings → Writing, 10 seconds by default) the composer
hands the message to `Engine::queue_send`, which checks it can be built,
stores it in the `outbox` table and sends it when its time comes. `cancel_send`
and the sender both take the row with one `DELETE … RETURNING`, so a mail is
either taken back or sent, never both. Queued mail survives closing UwUMail and
goes out on the next start. The result arrives as `send:done` or
`send:failed`; a failed mail is kept as a draft.

### Moving, spam and blocked senders

Archive, trash, move and spam share one engine path (`Inner::move_to`) and
return every moved message with the folder it came from; the UI's "Undo"
(toast or `z`) moves them back. Spam and not spam set the `$Junk` /
`$NotJunk` keywords first where the server takes them, then move to the junk
folder or the inbox. Blocking a sender of an account on a UwUMail server puts
the address or `@domain` on that server's list over JMAP (`SenderList/get` and
`/set`, capability `urn:uwumail:jmap:senders`), so the server sorts new mail
into junk even while the app is closed. For every other account the entry
lives in `blocked_senders` on this device, and new inbox mail from it is moved
into junk during sync, before any notification. Blocking also marks the open
mail as spam.

Conversations leave out their messages in the trash, except in the trash
itself: there a conversation (id `trash:<thread>`) holds only what was trashed,
so a trashed reply shows up in the trash while the rest of its conversation
stays where it was.

Mail already in the target folder stays where it is, so trashing mail twice
never deletes it. Deleting for good is its own call, `Engine::delete_forever`,
which only touches mail lying in its account's trash; the UI asks first. An
IMAP message moved there moments ago still has a placeholder uid and is found
on the server by its Message-ID.

### Unsubscribing

The engine keeps a mail's `List-Unsubscribe` options. `Engine::unsubscribe`
sends the one-click POST (`List-Unsubscribe-Post`) itself, but only to HTTPS
URLs with a public domain and without following redirects, so a header can't
send requests into the local network. Otherwise it mails the list address from
the identity the newsletter went to, and as a last resort hands the page URL to
the app to open.

### Senders and signatures

Every mailbox can send from its own address and from identities: JMAP
mailboxes bring theirs from the server (`Identity/get`, checked every ten
minutes), and aliases can be added by hand. The engine refuses a From address
that isn't set up for that mailbox. Signatures are kept on this device per
sender address (`signatures` table); one can be the default for new mail and
one for replies. The composer marks the inserted block with
`data-uwu-signature`, so switching the sender or picking another signature
replaces it; the marker is removed before sending.

Pictures in the HTML (`data:` URLs from signatures or pasting) become inline
parts in a `multipart/related` body with `cid:` links, because many mail
programs don't show `data:` images. Received mail works the other way round:
attachments keep their Content-ID, and the reader turns `cid:` links into blob
URLs of the cached files, which the mail frame's policy already allows.

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

## Installer and updates

`apps/setup` is UwUMail's own installer, the same small Tauri app with Nyu on
Windows, macOS and Linux. It carries UwUMail inside (zstd-packed at build time
by `pnpm build:setup`, see [install.md](install.md) for the user's side) and
installs for the current user without admin rights. `--silent` does the same
without a window, which CI uses to test it.

### Windows

The payload is the UwUMail executable.

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

### macOS

Separate builds for Apple chips (`aarch64-apple-darwin`) and Intel
(`x86_64-apple-darwin`). The payload is a tar of `UwUMail.app`; the download is
a `.dmg` with `UwUMail Setup.app`. Both bundles are signed ad hoc
(`codesign --sign -`): there's no Apple developer ID, and Apple chips refuse
unsigned code.

| What | Where |
| --- | --- |
| App | `~/Applications/UwUMail.app` |
| Start with the Mac | LaunchAgent `~/Library/LaunchAgents/app.uwumail.autostart.plist` → `… --autostart` |
| `mailto:` | `CFBundleURLTypes` in UwUMail's Info.plist (`Info.macos.plist`); the setup registers the app with Launch Services and calls `LSSetDefaultHandlerForURLScheme` |
| Remembered options | `~/Library/Application Support/app.uwumail.setup/setup.json` |

A LaunchAgent and not `SMAppService`: the setup has to switch autostart on for
another app, while `SMAppService` only lets an app register itself, and wants a
properly signed one. macOS may ignore or confirm the default-handler request;
the setup doesn't insist. UwUMail receives `mailto:` links as "open URL" events
(`RunEvent::Opened`), not on the command line.

### Linux

x86_64 only. The payload is Tauri's AppImage of UwUMail, unpacked at build
time and packed as a tar: the installed app runs through its own `AppRun`
without FUSE and starts quicker. The download is the setup as an AppImage.

| What | Where |
| --- | --- |
| App | `~/.local/share/uwumail/app` (the folder is private, `0700`) |
| Menu entry and icon | `~/.local/share/applications/uwumail.desktop`, `~/.local/share/icons/hicolor/*/apps/uwumail.png` |
| Command | `~/.local/bin/uwumail`, a two-line launcher for `AppRun` (only if nothing else has that name; a link would make `AppRun` look for its libraries in `~/.local/bin`) |
| Start when signing in | `~/.config/autostart/uwumail.desktop` → `… --autostart` |
| `mailto:` | `MimeType=x-scheme-handler/mailto` in the menu entry, the default in `~/.config/mimeapps.list`, plus `xdg-mime default` |
| Remembered options | `~/.local/share/uwumail/setup.json` |

Everything the setup starts gets a clean environment without the variables an
AppImage's start script sets, so UwUMail never looks for libraries in the
setup's (by then gone) AppImage and vice versa.

### How macOS and Linux install

The app is unpacked next to its place (`.UwUMail.app.new-<pid>`), checked, and
renamed into place; the old version is moved aside first and only deleted once
the new one is there. The tar can't set setuid bits or make anything writable
for others, and can't write outside its folder. Uninstalling works from the
setup's page ("Uninstall UwUMail" under Options); the folder to remove never
comes from the command line.

### Updates

The app checks `stable.json` or `beta.json` on the `updates` branch of this
repo 20 seconds after start and every six hours (`tauri-plugin-updater`,
signature checked against the public key in `tauri.conf.json`). Each feed has
one entry per system, under Tauri's platform keys:

| Key | Download |
| --- | --- |
| `windows-x86_64` | `UwUMail-Setup-<version>.exe` |
| `darwin-aarch64` | `UwUMail-Update-<version>-macos-apple-silicon` |
| `darwin-x86_64` | `UwUMail-Update-<version>-macos-intel` |
| `linux-x86_64` | `UwUMail-Setup-<version>-x86_64.AppImage` |

On macOS the download is the setup program from inside `UwUMail Setup.app`, on
its own (and signed ad hoc on its own): one file the signature covers
completely, with nothing to unpack before it is checked. It runs fine outside
its bundle.

The app saves the download into its local data folder (`…/updates`, private to
the user on macOS and Linux, the file only executable by the user), shows Nyu's
hint, and either restarts into it now or on the next start (`--update
--relaunch --wait-pid`). Right before the setup runs, its signature is checked
again, and in update mode the setup refuses to replace a newer installed
version, because the version number in the feed isn't signed. On Linux the
setup AppImage unpacks itself into that private folder
(`APPIMAGE_EXTRACT_AND_RUN`, `TMPDIR`) instead of mounting with FUSE. On macOS
and Linux only a UwUMail running from where the setup installed it updates
itself.

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
- Every push to `main`: `UwUMail-Setup-<version>.exe` for Windows as a workflow
  artifact; the macOS setups (Apple chip on `macos-15`, Intel on
  `macos-15-intel`) and the Linux AppImage setup, each installed, started,
  updated and uninstalled in a throwaway home folder
  (`.github/workflows/desktop.yml`, Linux on Ubuntu 22.04 and 24.04); the
  signed Android APK with its emulator test; the unsigned iPhone IPA with its
  simulator test.
- Tags `vX.Y.Z` (or `vX.Y.Z-beta.N`): a GitHub release here with the signed
  setups for Windows, macOS and Linux, the APK and the IPA the Android and iOS
  workflows built and tested for that commit, and the update feeds on the
  `updates` branch (`scripts/release-feeds.mjs`, see
  `release-notes/README.md`). The branch holds nothing else and is protected
  against deletion and force pushes. When GitHub can't run the workflow,
  `pnpm release` on a Windows PC publishes the Windows setup the same way; its
  feeds then only list Windows, so Macs and Linux PCs skip that version.
- Until everyone is past 0.2.0-beta.2, releases also update the feeds in the
  old `MinifyX/UwUMail-Releases` repo, which those versions still ask. After
  that it is archived.
