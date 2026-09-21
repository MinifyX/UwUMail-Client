# Roadmap

This is my to-do and wish list, not a promise. There are no dates: things get
built when I need them or feel like it, the order changes, and some of it may
never happen. See [Why this exists](../README.md#why-this-exists).

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
- [x] Undo send: 0–30 seconds (10 by default), the mail waits in a local outbox and goes out even after closing UwUMail
- [x] Several sender addresses per mailbox: aliases from the JMAP server or added by hand, replies from the address the mail went to
- [x] Signatures per sender address: formatted with pictures, several per address, defaults for new mail and replies, switchable while writing
- [x] Embedded images (cid:) in received mail; pictures in sent mail travel as inline parts
- [x] Move to folder (menu with search, v, drag and drop), multi-select (Ctrl/Shift+click, x), spam and not spam, blocked senders, undo for moves (toast and z), shortcuts g i / g s / g d / g f, ! and Ctrl+Shift+D
- [x] Unsubscribe button for newsletters: one click (RFC 8058) or by mail, otherwise the sender's page; archive earlier issues with undo
- [x] Print a mail (desktop) and save it as an .eml file
- [x] Unified inbox across all mailboxes
- [x] Conversation view (can be turned off)
- [x] Offline reading and local full-text search
- [x] Contacts from mail history with autocomplete
- [x] Sign in with Microsoft (OAuth 2) — needs a registered client id, see [oauth.md](oauth.md)
- [x] Microsoft 365 and Exchange Online: company domains recognised through their Entra tenant, switch to Microsoft by hand, shared mailboxes, and a plain explanation when the tenant blocks IMAP or SMTP ([oauth.md](oauth.md#microsoft-365-and-exchange-online))
- [x] Sign in with Google (OAuth 2) — needs a registered client id, see [oauth.md](oauth.md)
- [x] System notifications for new mail
- [ ] Addon host: permissions dialog, sandbox frames, RPC bridge, install from file
- [x] Addon SDK: manifest validation, wire protocol, typed client
- [ ] Addon catalog (`MinifyX/UwUMail-Addons`) with one-click install
- [x] Installers for Windows and Linux in CI, release workflow with macOS
- [x] UwUMail's own setup on macOS (Apple chip and Intel) and Linux (AppImage), tested on GitHub's runners ([install.md](install.md))
- [x] UwUMail's own Windows installer with Nyu: one click, no admin, options, uninstaller that can keep mail
- [x] Auto-update on Windows: signed, downloaded quietly, Stable and Beta channels
- [ ] Releases and update feeds in this repo, old `UwUMail-Releases` archived (ships with 0.2.0-beta.3)
- [x] Keep running in the notification area, start with Windows, default mail app (`mailto:` links)
- [x] Auto-update on macOS and Linux (same signed feed as Windows)
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
- [x] Update check (starts working with the first Android release)
- [ ] APK on every release with the update feed (`android-beta.json`, `android-stable.json`)
- [ ] Home screen widget
- [ ] Sign in with Microsoft and Google on Android

## iOS

- [x] Same app and engine on the iPhone, unsigned IPA from CI, simulator smoke test ([how it works](ios.md))
- [x] Unsigned IPA on every release, for sideloading
- [x] Phone layout, swipe actions, app lock with Face ID, haptics, passwords in the iOS keychain
- [x] Notifications for mail that arrives while UwUMail runs
- [x] Attachments saved into UwUMail's folder in the Files app; profiles and apps from mail refused
- [ ] Share sheet: hand attachments to other apps, print, share a mail
- [ ] Background refresh: answer iOS' wake-up and look for mail
- [ ] `mailto:` links and the redirect back from Microsoft and Google sign-in

## After v0.1 — official addons

- [ ] Send later + Snooze
- [ ] Templates + snippets
- [ ] PGP encryption
- [ ] AI helper (off by default)
- [ ] Calendar (CalDAV, invitations)

## Later

- [ ] CardDAV contact sync
- [ ] Self-hostable sync server for settings, signatures and addons (AGPL-3.0)
- [ ] Code signing for Windows and macOS
