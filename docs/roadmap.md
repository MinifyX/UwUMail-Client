# Roadmap

## v0.1 — MVP

- [x] Project foundation: monorepo, docs, brand, CI
- [x] UI shell: Simple and Pro layouts, dark mode, German and English, tone setting
- [x] Onboarding: layout and tone choice, add a mailbox with autoconfig
- [x] Mail engine: IMAP sync with local cache, IDLE push, SMTP sending
- [x] Reading: sanitized HTML, remote content blocked by default, attachment list
- [x] Attachments: open, save and preview (images, PDF, text, CSV, audio, video, invitations, contact cards), warning for files that run programs, local cache
- [x] Nested folders as a collapsible tree
- [x] Sender pictures from brand logos (BIMI) and website icons, once per domain, can be turned off
- [x] JMAP next to IMAP/SMTP: discovery, sync, push, sending, switchable per account (tested against Stalwart)
- [ ] JMAP: verify against Fastmail and Cyrus with real accounts
- [x] Writing: compose, reply, reply all, forward, attachments
- [x] Drafts saved automatically to the server's Drafts folder, continued on any device, removed when sent
- [ ] Undo send, signatures, multiple identities per mailbox
- [ ] Unsubscribe button, spam and blocked senders, move to folder, print and save as file, multi-select, more shortcuts
- [x] Unified inbox across all mailboxes
- [x] Conversation view (can be turned off)
- [x] Offline reading and local full-text search
- [x] Contacts from mail history with autocomplete
- [x] Sign in with Microsoft (OAuth 2) — needs a registered client id, see [oauth.md](oauth.md)
- [x] Sign in with Google (OAuth 2) — needs a registered client id, see [oauth.md](oauth.md)
- [x] System notifications for new mail
- [ ] Addon host: permissions dialog, sandbox frames, RPC bridge, install from file
- [x] Addon SDK: manifest validation, wire protocol, typed client
- [ ] Addon catalog (`MinifyX/UwUMail-Addons`) with one-click install
- [x] Installers for Windows and Linux in CI, release workflow with macOS
- [x] UwUMail's own Windows installer with Nyu: one click, no admin, options, uninstaller that can keep mail
- [x] Auto-update on Windows: signed, downloaded quietly, Stable and Beta channels, public `UwUMail-Releases` repo
- [x] Keep running in the notification area, start with Windows, default mail app (`mailto:` links)
- [ ] Auto-update on macOS and Linux
- [x] Security audit with fixes, `SECURITY.md`, dependency audit in CI ([report](security-audit.md))
- [x] Warning for links whose text shows a different site than the target
- [x] First beta: 0.2.0-beta.1

## Android

- [x] Same app and engine on Android, signed APK from CI, emulator smoke test
- [x] Phone layout: list with filters, conversation with thumb-height actions, drawer, full-screen composer
- [x] Swipe actions (configurable), long press to select, Nyu pull to refresh, back gesture
- [x] Instant new mail through a foreground service; notifications with "Mark as read" and "Archive"
- [x] Passwords in the Android Keystore, optional app lock with fingerprint, face or PIN
- [x] Last 90 days offline (configurable), older mail as previews; server search for everything
- [x] Share to UwUMail, `mailto:` links, attachments to Downloads, Nyu splash and themed icon
- [x] Update check against UwUMail-Releases (starts working with the first Android release)
- [ ] Android release in UwUMail-Releases with the update feed (`android-stable.json`)
- [ ] Home screen widget
- [ ] Sign in with Microsoft and Google on Android

## After v0.1 — official addons

- [ ] Send later + Snooze
- [ ] Templates + snippets
- [ ] PGP encryption
- [ ] AI helper (off by default)
- [ ] Calendar (CalDAV, invitations)

## Later

- [ ] CardDAV contact sync
- [ ] Self-hostable sync server for settings, signatures and addons (AGPL-3.0)
- [ ] iOS app
- [ ] Code signing for Windows and macOS
