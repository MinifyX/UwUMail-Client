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
- [ ] Drafts saved to the server, multiple identities per mailbox
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

## After v0.1 — official addons

- [ ] Send later + Snooze
- [ ] Templates + snippets
- [ ] PGP encryption
- [ ] AI helper (off by default)
- [ ] Calendar (CalDAV, invitations)

## Later

- [ ] CardDAV contact sync
- [ ] Self-hostable sync server for settings, signatures and addons (AGPL-3.0)
- [ ] Mobile apps (Tauri iOS / Android)
- [ ] Code signing for Windows and macOS
