# Features

Everything UwUMail does, in more words than the [README](../README.md) has room
for. What is planned but not there yet is on the [roadmap](roadmap.md).

## Mailboxes

- **Any IMAP/SMTP mailbox**, set up with the address and password: the settings
  are found automatically (autoconfig, DNS). Several sender addresses per
  mailbox — aliases from a JMAP server or added by hand — and replies from the
  address the mail went to.
- **JMAP next to IMAP**, switchable per mailbox: discovery, sync, push and
  sending, tested against Stalwart and UwUMail Server.
- **Microsoft and Google sign in with their own page** (OAuth 2). Microsoft works
  for Outlook.com and Microsoft 365, company domains recognised through their
  tenant, with a plain explanation when a tenant blocks IMAP or SMTP; on
  Android and iPhone the browser comes back to the app.
- **Shared mailboxes in Microsoft 365** show up on their own after signing in
  (Exchange Autodiscover, for mailboxes granted with automapping) and nested
  under the account whose sign-in opens them, with their own folders; others
  are added by address. Counters, notifications, the unified inbox and sending
  as the shared address work like in any mailbox.
  Google on the iPhone is best added with an app password. See
  [oauth.md](oauth.md).
- **A unified inbox** across all mailboxes, and private and business mailboxes
  kept apart if you like.
- **Offline.** Mail is cached locally with full-text search in milliseconds; on
  Android the last 90 days are kept complete (configurable) and older mail as
  previews, with the server's search for everything.

## Reading

- **Simple or Pro.** A calm two-column layout, or a dense three-column one with
  keyboard shortcuts (`g i`, `v`, `x`, `z`, `!` and more), switchable any time.
- **Conversations**, a folder tree, multi-select, drag and drop, spam and not
  spam, blocked senders, and undo for moves.
- **Safe HTML.** Mail is cleaned before it is shown, remote content is blocked
  until you allow it (per sender or domain), and links whose text shows another
  site than their target get a warning.
- **Pictures without the wait.** Once they may load, the text shows at once and
  every picture waits in its final size with a shimmer; a bar counts them in,
  and dead hosts and tracking pixels hold nothing up. Pictures can go through
  a SOCKS5 or HTTP proxy of your own; mailboxes on a UwUMail server get them
  through the server, so senders don't learn who reads their mail.
- **Dark mode for newsletters.** Pictures in newsletters follow dark mode, photos
  stay as they are.
- **Attachments** open, save and preview (images, PDF, text, CSV, audio, video,
  invitations, contact cards), with a warning for files that run programs.
- **Sender pictures** from the UwUMail server, brand logos (BIMI) and website
  icons, once per domain, can be turned off.
- **Unsubscribe in one click** (RFC 8058) or by mail, and archive earlier issues
  with undo.

## Writing

- Compose, reply, reply all and forward, with attachments and pictures.
- **Drafts** are saved to the server's Drafts folder as you type and continue on
  any device.
- **Undo send** for 0–30 seconds (10 by default): the mail waits in a local
  outbox and goes out even after UwUMail was closed.
- **Signatures** per domain: pick a domain, write one signature for all your
  addresses there (or for all domains), with `{name}`, `{adresse}` and
  `{domain}` filled in per address. On a UwUMail server (0.22 and later) it
  lives on the server, shared with the webmail and the portal, single
  addresses can differ, and the composer says when the server adds your
  organisation's mandatory footer. For other mailboxes the domain signature
  stays on the device. Signatures of single addresses work as before:
  formatted, with pictures, several per address, with defaults for new mail
  and replies, and they go first on this device.
- **Addresses** suggested from the address books and the mail history.

## Calendar, contacts and birthdays

- **Calendar and contacts** next to the mail: JMAP Calendars and Contacts on
  UwUMail servers, CalDAV and CardDAV for other mailboxes with a password, and
  for Microsoft and Google sign-ins their own calendars and contacts (Microsoft
  Graph: own and shared calendars, contact folders, shared mailboxes; Google
  Calendar and People API), read and written. Mailboxes signed in before that
  get a "Sign in again" button; mail keeps working without it. See
  [oauth.md](oauth.md#calendars-and-contacts).
- **Birthdays** with a cake and the age. Mailboxes on a UwUMail server show the
  server's birthdays calendar, other mailboxes with contacts get one of
  their own. Anniversaries, birthdays without a year, and birthday events from
  other calendars moved into the contacts; reminders per contact on UwUMail
  servers.
- **Invitations in mail** like the webmail: the card in the reader shows when,
  where, the organizer, who is invited and what they answered, updates and
  cancellations, and your answer so far. *Accept*, *Maybe* and *Decline* (with
  a comment where the answer can carry one) work in every mailbox: UwUMail
  servers tell the organizer themselves, Microsoft and Google answer through
  their calendar, other mailboxes keep the event in their CalDAV calendar or
  the device's "Invitations" calendar and mail an iTIP answer (RFC 5546) to
  the organizer. Cancellations offer removing the event or date. Nothing is
  sent without a click; invitations or cancellations that don't come from the
  organizer get a warning and no buttons.

## Appointments in mail

Dates in a mail's text are underlined, a bar above the mail lists what it
found, and *Add to calendar* opens the event already filled in. Text on
pictures such as posters counts too: mailboxes on a UwUMail server have the
server read it, other mailboxes the system's text recognition on Mac, iPhone,
Windows and Android (not on Linux). Time ranges such as "Samstag 03.10.26,
zwischen 10:00 und 12:00" keep their start and end. This is done by rules on the device; the AI
assistant only reads a mail for dates when you click *Find appointment* or
*Check with AI*, or when you switched that on for every mail.

## AI assistant

Writing and rewriting, summaries, a second opinion on spam, appointments and
labels, with the server's assistant for UwUMail mailboxes and your own
providers (a local Ollama or LM Studio in one click) for all others. Every AI
button tells on hover what it will take in tokens and money. The spam check
weighs the facts and phishing checks (lookalike domains, spoofed display names,
misleading links) first and shows them with their weights; the model only
chooses among the verdicts they allow. Labels start with eight base labels
(invoice, shipping, appointment, newsletter, account, personal, work,
promotions), each switchable; a mail gets at most two, and the model is only
asked when the rules, detectors and what was learned leave a label in doubt. See [ai-assistant.md](ai-assistant.md).

## Phones

- **Android:** the phone layout with swipe actions (configurable), long press to
  select, Nyu pull to refresh, instant new mail through a background service or
  UnifiedPush (for UwUMail servers 0.14 or newer), notifications with *Mark as
  read* and *Archive*, sharing to UwUMail, `mailto:` links, and an app lock with
  fingerprint, face or PIN; passwords in the Android Keystore.
- **iPhone:** the same app, sideloaded ([ios.md](ios.md)), with Face ID app lock,
  passwords in the iOS keychain, and notifications while UwUMail runs.

## Around it

- **Updates** by itself on Windows, macOS and Linux (.deb/.rpm), signed, with
  Stable and Beta channels; the installer needs no administrator.
- **Tray and default mail app** on the desktop: keep running in the notification
  area, start with the system, open `mailto:` links.
- **Playful or plain.** UwUMail talks with a wink by default (Settings → Tone →
  Neutral for plain). Nyu reacts to what happens — peeks at an opened mail,
  waves a sent one goodbye, thinks while the AI works — and can be set to on,
  reduced or off ([nyu-animations.md](nyu-animations.md)).
- **German and English**, light and dark.
- **No telemetry.** Passwords and keys live in the system's keychain.
