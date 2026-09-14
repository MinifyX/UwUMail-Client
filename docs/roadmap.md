# Roadmap

## v0.1 — MVP

- [x] Project foundation: monorepo, docs, brand, CI
- [x] UI shell: Simple and Pro layouts, dark mode, German and English, tone setting
- [x] Onboarding: layout and tone choice, add a mailbox with autoconfig
- [x] Mail engine: IMAP sync with local cache, IDLE push, SMTP sending
- [x] Reading: sanitized HTML, remote content blocked by default, attachment list
- [x] Attachments: open, save and preview (images, PDF, text, CSV, audio, video, invitations, contact cards), warning for files that run programs, local cache
- [x] Nested folders as a collapsible tree
- [ ] Sender pictures from brand logos (BIMI) and website icons
- [ ] JMAP (Fastmail, Stalwart, Cyrus) next to IMAP/SMTP
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
- [ ] Auto-update (needs an update signing key)

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
