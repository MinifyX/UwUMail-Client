# Vision

**UwUMail is the mail client I want to use.** Every mail client I tried
annoyed me in one way or another, and so did the self-hosted mail servers, so
I started building my own. It isn't trying to be the mail client for
everyone. If it happens to fit you too, great.

## What to expect

- **A hobby project.** No company, no team, no schedule, no support. I build
  what I need and what I find fun, when I have time and feel like it. That can
  mean a lot of changes in a week and then nothing for months.
- **Written with AI.** I decide what UwUMail should do and how it should look
  and feel; almost all of the code is written with Claude, because I'm
  honestly not a great programmer. Automated tests catch what they can. If
  that's a dealbreaker, that's completely fine, there are plenty of other mail
  clients.
- **Free to take.** Anyone may use it, fork it and turn it into something else
  under the GPL-3.0.

## Principles

These are the rules I build by.

1. **Simple first, powerful on request.** A new user adds a mailbox with an
   address and a password and reads mail. Power lives one switch away (Pro
   layout, shortcuts, addons), never in the way.
2. **A small core, room for addons.** The core does mail and contacts really
   well. Everything else — calendars, encryption, snooze, templates, AI — is
   meant to be an addon, including the official ones. The core only grows when
   something clearly belongs in it.
3. **Addons are guests, not owners.** An addon can only do what its manifest
   declares and the user approved. No addon ever sees a password.
4. **Private by default.** No telemetry, no tracking pixels, no remote content
   without consent, no cloud account required. Everything works offline with
   the local cache.
5. **Cute, not childish.** The playful tone is the default and part of the
   brand, but it never hides information, and one setting makes it neutral.
6. **Open.** GPL-3.0 for the app, MIT for the addon SDK. Documentation and code
   are in English so anyone can read, fork and change them; the UI speaks
   German and English.

## Who it's for

Me, first of all. These are the kinds of mail days I had in mind; if you
recognize yourself, UwUMail might suit you too.

| Person | What they get from UwUMail |
| --- | --- |
| "I just want my mail" | One inbox, big readable rows, no settings to understand |
| "I have five mailboxes" | Unified inbox, fast switching, per-account identities |
| "Keyboard all day" | Pro layout, shortcuts, command palette, instant search |
| "I want it my way" | Addons, themes, tone packs, and an API that is fun to build on — mostly still to come |

## Non-goals

- Pleasing everyone. Features land when I need them or feel like building
  them, not because they are popular.
- A mail provider or cloud service. The app talks straight to your mail
  server, whether that's a big provider or your own
  [UwUMail Server](https://github.com/MinifyX/UwUMail-Server).
- Proprietary protocols (Exchange EWS, Graph mail). IMAP/SMTP and JMAP only,
  with OAuth where providers require it.
- Ads, sponsored content, or selling any data.
