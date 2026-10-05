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
