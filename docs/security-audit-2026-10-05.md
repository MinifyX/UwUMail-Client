# Security review — UwUMail client 0.10.0-beta.1, 5 October 2026

A pass over everything new in 0.10.0-beta.1 (`git diff origin/main...release/0.10.0-beta.1`, about 15k
lines): the mail frame that may now run scripts (the WebKit link fix), Safe Links, the Teams button and the
other reader additions, send later (server-held on UwUMail servers, the local outbox everywhere else),
invitations in mail (iTIP REPLY over SMTP, Microsoft Graph, Google Calendar, JMAP, CalDAV and the
device's own "Invitations" calendar), masked addresses, the profile picture, calendar sharing, contact
photos, the label picker and the folder-name checks.

Done with Claude, like the passes before; not an independent firm. It leaves out step-by-step exploits.
To report something new see [SECURITY.md](../SECURITY.md).

## Counts

| Severity | Found | Fixed | Known limitation |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 0 | 0 | 0 |
| Medium | 7 | 7 | 0 |
| Low | 16 | 3 (RD-3, SL-5, SL-6) | 13 (see below) |
| Info | 15 | 0 | 15 (not listed one by one) |

Medium findings are fixed with a regression test each (branch `fix/0.10-sec-r1`). By decision, Low findings
are documented as known limitations unless a Medium fix covered them anyway.

## Fixed

| ID | Severity | Area | Issue | Fix |
|---|---|---|---|---|
| RD-1 | Medium | Mail frame | The mail frame now has `allow-scripts allow-same-origin`. If a navigation ever slipped past the link guard, it could load a page with the app's origin: embedded `cid:` parts became `blob:` URLs typed as the attachment file server guessed (possibly `text/html`), `cid:` was also replaced in `<a href>`, and the app's `frame-src` allowed `blob:`. One fragile JS layer stood between a mail and code with the app's privileges. | Inline parts become blob URLs only when their bytes are a raster picture (PNG, JPEG, GIF, WebP, AVIF, BMP), typed from the bytes (`rasterImageType`); anything else stays a tile. `cid:` is replaced only where a picture loads (`src`, `srcset`, `background`, `poster`, SVG picture `href`, CSS), never in links; the sanitizer also drops `href`/`xlink:href`/`action`/`data` with `cid:` or `blob:`. The PDF preview frames the attachment file server's own address instead of a blob copy, so `frame-src` no longer allows `blob:`. |
| RD-3 | Low | PDF preview | The checked PDF copy was a `blob:` URL (app origin) in an unsandboxed frame. | Fixed with RD-1: the frame shows the `asset:` address (another origin), which the file server types `application/pdf` from the same bytes the preview checked (`%PDF-` at the start). A PDF with junk before its header is no longer previewed in the app ("open it with your PDF app"). |
| SL-1 | Medium | Send later (server) | A new time or "send now" sent the cancel and the new submission in one JMAP request; the server runs both, so a mail that went out just before the cancel was submitted again. | The cancel goes alone and must be confirmed; only then the new submission follows in its own request. A lost answer to it is resolved by looking for the pending submission of that mail (`EmailSubmission/query` by `emailIds`) instead of submitting again or moving the mail. |
| SL-6 | Low | Send later (server) | A cancel counted as confirmed when the answer said nothing. | Only an `updated` entry for the submission confirms it; an unclear answer is checked by reading the submission again (`canceled` = stopped, `pending` = error, anything else = too late). |
| SL-2 | Medium | Sending | Every non-permanent SMTP error, including a broken connection after the final dot of DATA, and a lost JMAP submission answer counted as "server not reachable"; scheduled mail retried those up to six times (up to 7 copies). | SMTP runs step by step on lettre's connection: failures up to and including DATA, and the server's own 4xx/5xx answer to the message, are definite; a break while the message is handed over or before its answer is `ErrorCode::MaybeSent`. JMAP submissions use `call_submission`, which does the same for a lost or unreadable answer and 5xx/gateway errors. Only definite connection failures are retried. A maybe-sent mail is held in the outbox as "may have gone out" (not put into Drafts, which would invite sending it twice) until the person decides. |
| SL-3 | Medium | Send later (device) | Due rows were deleted before sending; a quit, crash or suspend while sending lost the mail (its draft was already gone). | Rows are claimed (`claimed_at`) and deleted only after the mail went out or Drafts took it. Rows still claimed at the next start were being sent when UwUMail stopped: they are held as "may have gone out" instead of being sent again. |
| SL-4 | Medium | Send later (device) | When the retries ran out while offline, the fallback draft needed the same unreachable server; the mail then only existed in an event nobody might listen to. | If Drafts can't take it, the row stays held as "not sent" with the reason: listed under Scheduled, never sent on its own; a new time or "send now" sends it again, edit and stop work as usual. `send:failed` says whether the mail is in Drafts or under Scheduled. Also for undo-send mail. |
| SL-5 | Low | Send later (device) | Stopping a local mail parked it a year ahead while Drafts was written; a crash in between left draft and a self-sending entry. | Stopping holds the row (never sent on its own) while Drafts is written; on failure the previous state comes back. |
| IV-1 | Medium | Invitations | A lone CR inside SUMMARY, LOCATION, TZID or ORGANIZER/ATTENDEE parameters survived parsing, was copied into the REPLY and put unescaped into its text part; the user's authenticated SMTP session then carried bare-CR sequences chosen by a stranger (SMTP smuggling class). | `Component::parse` replaces every control character but TAB (also in folded lines), `fold` never writes one besides its own CRLF, `itip::summary` cleans title, location, zone and organizer name, and the reply's text part keeps only line breaks. |
| IV-2 | Medium | Invitations | A found calendar copy was only "not the same invitation" when stored and mail organizer both existed and differed. A personal event (no ORGANIZER) with a known UID could be replaced or deleted with one click, shown as verified. | A found copy needs an organizer equal to the mail's (missing = different, also JMAP's `organizerCalendarAddress`), and in CalDAV and device copies the person must be invited (the organizer for a REPLY). Otherwise the mail is unverified and has no buttons. |

## Known limitations (security review 0.10)

Low findings, accepted for this release. Each is defense in depth or needs a hostile server, a forged
sender plus a known UID, or unusual data.

| ID | Area | Limitation |
|---|---|---|
| RD-1 (rest) | Mail frame | `frame-src` still allows `asset:` (needed for the PDF preview). If a navigation ever slipped past the link guard to an HTML attachment saved under the app's data folder, that page runs script on the `asset:` origin: no app IPC, but read access to other files in the asset scope (attachments, pictures). Tauri's asset protocol types files by content and falls back to HTML; a protocol that never answers renderable types would close this. |
| RD-2 | Print | The print frame removes `<style>` from sanitized markup with a regex; engines that don't escape `<`/`>` in attribute values could re-join markup. The frame's own CSP (`default-src 'none'`, first in `<head>`) still blocks scripts. |
| SL-7 | Send later (server) | Editing or stopping a server-held mail drops its Bcc: the held mail has no Bcc header and the envelope isn't read back. |
| SL-8 | Send later (server) | Stop: if moving to Drafts fails after a successful cancel, the stopped mail stays in Sent and looks sent. Edit destroys the server copy before the composer saved its own draft. |
| SL-9 | Send later (device) | Local entries have no size limit (attachments inline as base64, up to 500 entries, up to a year) and the list parses every entry. |
| SL-10 | Send later (server) | `MAX_LISTED` limits the request, not the answer; a hostile server's large answer makes the scheduled list slow (n × m match). |
| IV-3 | Invitations | Updates and cancellations of existing events rely on From = ORGANIZER; DMARC results (`sender_confirmed`) only warn. Where DMARC isn't enforced a forged From with a known UID and higher SEQUENCE can change or cancel a meeting with one click; the reply still goes to the real organizer. |
| IV-4 | Invitations | The UID lookup doesn't prefer the person's own calendars: with calendar sharing (JMAP) or CalDAV servers that list shared calendars in the home, an answer or "remove cancelled" can hit a colleague's copy. |
| IV-5 | Invitations | Attendee de-duplication is O(n²); a ~1 MB invitation can cost seconds of CPU each time the mail is opened. |
| IV-6 | Invitations | The REPLY repeats the invitation's parameters on the user's ATTENDEE line (CN, SENT-BY, DELEGATED-*, X-*). |
| AC-1 | Contacts | JMAP and CardDAV contact photos aren't size/type-checked in Rust (Graph/Google are); a buggy or compromised page could store any `data:` URI in a card. |
| AC-2 | Masked addresses | Texts from the server keep bidi override characters (U+202A–E, U+2066–9). |
| AC-3 | Masked addresses | The `url` is checked for its scheme only in the page, not in Rust. |
| AC-4 | Photos | Photos from servers reach the web view without a pixel limit (decompression bombs possible from a hostile DAV/JMAP server). |

The iTIP code is a copy of UwUMail Server's (`crates/uwumail-store/src/itip.rs`); the IV-1 parsing fix
belongs there too.

## Round 2

A second pass over the round-1 fix commits, the sweep commits merged after them and UwUMail Server's iTIP
code (against IV-1). The round-1 fixes hold for what they set out to fix.

| Severity | Found | Fixed | Known limitation |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 0 | 0 | 0 |
| Medium | 2 | 2 | 0 |
| Low | 11 | 1 (RD-4) | 10 (see below; SV-1 belongs to the server) |
| Info | 11 | 1 (IV-I-7) | 10 (not listed one by one) |

### Fixed (round 2)

| ID | Severity | Area | Issue | Fix |
|---|---|---|---|---|
| SL-11 | Medium | Send later (server) | After a lost answer to the new submission, SL-1 looked only for a *pending* submission of the mail. "Send now" makes one that is `final` almost at once, so the mail was moved to Drafts as "didn't take" although the server had sent it, inviting a second send. | The lookup queries every submission of the mail (`emailIds` only) and reads their `undoStatus`. Any submission other than the cancelled old one, `pending` or `final`, means the new time took. Only "no other submission" puts the mail into Drafts; a failed lookup still leaves it where it is and asks to look at Sent. |
| NT-1 | Medium | Notifications (Linux) | Freedesktop notification servers with `body-markup`/`body-hyperlinks` read the body as markup, so a stranger's subject could show as formatting or as a clickable link outside the app's link check. | On Linux the body is escaped (`&`, `<`, `>`, `"`, `'`, `notify::markup_escape`) right before it goes to the notification. The title (summary) is plain text by the spec and stays as is; Windows and macOS show text literally and get no escaping. |
| RD-4 | Low | Mail frame | `frame-src` still allowed `'self'` although no frame loads an app address any more. | `frame-src` is `asset: http://asset.localhost` only. Mail and print frames (`srcdoc`) and the PDF preview (`asset:`) still load; an app-origin frame is refused (checked in WebKit and Chromium under the app's CSP). |
| IV-I-7 | Info | Invitations | `plain_address` stripped only a lowercase `mailto:`, so genuine invitations with `MAILTO:` showed as unverified. | The scheme is stripped case-insensitively. |

### Known limitations (round 2)

| ID | Area | Limitation |
|---|---|---|
| SL-12 | Sending | A local database error after the server accepted a mail (or stored a draft) is reported as the send's error; send later then puts a Drafts copy in place although the mail went out. Needs a failing local database (disk full, locked). |
| SL-13 | Send later | The page doesn't show "may have gone out" as its own state: the toast and composer use the generic "couldn't send" text with an "Open" action, and "send now" on such an entry runs without asking. The core still holds the mail and never sends it on its own. |
| SL-14 | Send later (device) | If writing Drafts fails while stopping a local mail that is due by then, the row's previous state comes back and the next outbox pass can send it; a reschedule during a stop doesn't see the stop, and the row-take result after Drafts isn't checked. Narrow window. |
| IV-7 | Invitations | IV-2's role check covers CalDAV and device copies only. For JMAP, Microsoft and Google a copy counts as the same invitation when the organizer matches, and an ORGANIZER that is one of the person's own addresses isn't treated as unverified. Needs a forged own From (no DMARC enforcement, IV-3 class) plus a known UID. |
| ST-1 | Settings | Stored settings are type-checked at the top level only; elements of arrays and records are taken as stored. Local data only; no path found that turns a security-relevant setting off. |
| UN-1 | Unsubscribe | The page and the engine decode a `mailto:` List-Unsubscribe differently (strict vs. lenient `%`), so for a malformed header the page can offer "Send mail" for a target it didn't show. The engine still applies the W-30 address checks. |
| DR-1 | Drafts | A local-copy timer scheduled before the server confirmed a draft can write the full draft back after it was reduced to its id, so the text stays on the device. Privacy, not integrity. |
| PC-1 | Sender pictures | Sender pictures are kept as `data:` URLs (up to ~2.8 MB each) in a page-level map without eviction; many distinct senders can exhaust the web view's memory on mobile. |
| PC-2 | Sender pictures | Removing an account doesn't clear its picture cache and login map in the engine until restart. |
| SV-1 | UwUMail Server | Belongs to the server, not the client: its iTIP code (`crates/uwumail-store/src/itip.rs`) still has the IV-1 lone-CR gap. SMTP smuggling is closed there (SMTP-9 normalizes line ends), but a REQUEST from outside is stored without a click and served raw over CalDAV, and a REPLY answered from a CalDAV client can carry extra iCalendar lines. To be fixed in the server by porting the IV-1 parsing fix. |

## Round 3

A re-check of the round-2 fixes (SL-11, NT-1, RD-4, IV-I-7) found nothing critical, high or medium in
the client; the fixes hold and add no way to send a mail twice or lose it.

- **SV-2 (low, UwUMail Server):** on "send now" the server queues the mail before it writes the
  submission record. A failed record write, or a crash between the two, leaves no record, so the
  client's lookup (SL-11) finds nothing and puts a mail that does go out into Drafts. To be fixed in the
  server (record first, or a best-effort record after a successful queue).
- Info only: a submission made by another client before a new time can be mistaken for the new one
  after a lost answer (SL-I-8); submissions without a readable `undoStatus` are skipped (SL-I-9); the
  lookup's limit has no sort order (SL-I-10); only the notification body is escaped on Linux, as the
  freedesktop spec has the title as plain text (NT-I-2).

## Checked and fine

- **Mail frame**: the srcdoc's CSP is the first element in `<head>` with `default-src 'none'` and no
  script source; the app CSP (`script-src 'self'`) applies on top. DOMPurify forbids script, frames,
  objects, forms, inputs, meta, link and base plus `srcdoc`/`formaction`/`ping`; no `allow-forms`,
  `allow-popups` or `allow-top-navigation`; clicks, middle clicks, drags and long presses on links go to
  the link question. `data-uwu-safelink` can only be set by the reader; Safe Links only unwrap to http(s).
- **Send later**: SQL parameterised and filtered by id, account and `later`; ids checked; time limits and
  overflow tested; single instance; `sender_for` checked on schedule and send; no credentials in rows or
  errors.
- **Invitations**: nothing is sent or written without a click; the reply goes only to the ORGANIZER (which
  must equal From) from the matching own identity; header injection tested; parser limits (1 MB, 100k
  lines, depth 16); UID control-checked and escaped for Graph `$filter`, CalDAV REPORT and JMAP.
- **Account features**: every server command goes through the JMAP server client, ids and principals are
  validated before use as patch keys, answers are bounded, no tokens in results or errors; no new Tauri
  capability or plugin.
