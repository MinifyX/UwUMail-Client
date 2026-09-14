# Vision

**UwUMail is THE mail client for everyone.** For people who want it simple,
for people who want everything in one place, and for everyone in between.

## Principles

1. **Simple first, powerful on request.** A new user adds a mailbox with an
   address and a password and reads mail. Power lives one switch away (Pro
   layout, shortcuts, addons), never in the way.
2. **A small core, a big ecosystem.** The core does mail and contacts really
   well. Everything else — calendars, encryption, snooze, templates, AI — is an
   addon, including the official ones. The core only grows when most people
   need something.
3. **Addons are guests, not owners.** An addon can only do what its manifest
   declares and the user approved. No addon ever sees a password.
4. **Private by default.** No telemetry, no tracking pixels, no remote content
   without consent, no cloud account required. Everything works offline with
   the local cache.
5. **Cute, not childish.** The playful tone is the default and part of the
   brand, but it never hides information, and one setting makes it neutral.
6. **Open.** GPL-3.0 for the app, MIT for the addon SDK. Documentation and code
   are in English so anyone can contribute; the UI speaks German and English
   from day one.

## Who we build for

| Person | What they need from UwUMail |
| --- | --- |
| "I just want my mail" | One inbox, big readable rows, no settings to understand |
| "I have five mailboxes" | Unified inbox, fast switching, per-account identities |
| "Keyboard all day" | Pro layout, shortcuts, command palette, instant search |
| "I want it my way" | Addons, themes, tone packs, and an API that is fun to build on |

## Non-goals

- A web or hosted service. UwUMail is a desktop app. A small, self-hostable
  sync server for settings may come later, but mail always stays between the
  app and the user's mail provider.
- Proprietary protocols (Exchange EWS, Graph mail). IMAP/SMTP only, with
  OAuth where providers require it.
- Ads, sponsored content, or selling any data.
