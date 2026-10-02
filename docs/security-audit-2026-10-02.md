# Security audit — UwUMail client, 2 October 2026

A pass over everything new in 0.8.0-beta.1 (`git diff origin/main...release/0.8.0-beta.1`, about 7k
lines): calendars and contacts through Microsoft Graph, Google Calendar and Google People
(`cloud.rs`, `calendar/graph_cal.rs`, `calendar/google_cal.rs`, `contacts/cloud_cards.rs`,
`engine/cloud_ops.rs`), one OAuth token per resource with refresh-token rotation (`oauth.rs`,
`Inner::credential`), shared mailboxes found through Exchange Autodiscover (POX) and nested under their
account (`shared.rs`, `engine/shared_ops.rs`, `store/shared.rs` with its migration), the new Tauri
commands (`find_shared_mailboxes`, `add_shared_mailbox`, `sign_in_again`, `remove_account` with
`keepShared`) and the UI around them.

Looked at in particular: panics on odd or hostile answers, bounded and same-host paging, where bearer
tokens go (redirects, next links, logs, errors), XML limits, path building with addresses and ids, SQL
and the migration, races in refresh-token rotation, whether a shared mailbox can reach another account's
secret, consent and scopes, all-day and time-zone conversion, and data lost when a contact is written back.

Done with Claude, like the passes before; not an independent firm. It leaves out step-by-step exploits.
To report something new see [SECURITY.md](../SECURITY.md).

## Counts

| Severity | Found | Fixed | Not fixed |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 0 | 0 | 0 |
| Medium | 7 | 7 | 0 |
| Low | 7 | 7 | 0 |
| Info | 6 | 0 | 6 (see table) |

All fixes are in commit 594125e, each with a test.

## Findings

| ID | Severity | Area | file:line | Issue | Fix |
|---|---|---|---|---|---|
| CL-1 | Medium | Google Calendar | crates/uwumail-core/src/calendar/google_cal.rs:77 | `BYDAY` was split two *bytes* before its end. A day value with a multi-byte character (e.g. `éA`) put the split inside the character and `split_at` panicked, which took the calendar read (and the app's engine task) down. | Split only on a char boundary and accept only two ASCII letters as a day; anything else makes the rule unreadable (the event stays, without a rule). |
| CL-2 | Medium | Google Calendar, time zones | crates/uwumail-core/src/calendar/google_cal.rs:67 | `UNTIL=…Z` (UTC, as Google writes it for timed series) was taken as a wall time of the event's zone. West of UTC the series gained a day (the end of 30 Sep in New York is 04:00 UTC on 1 Oct), and every rewrite of the rule (`rule_to_rrule` converts back to UTC) moved it again by the offset. | `rule_from_rrule` gets the event's zone (else the calendar's): UTC `UNTIL` becomes the same instant in that zone; all-day rules end on a date. Round trip is now stable. |
| CL-3 | Medium | Google contacts, data loss | crates/uwumail-core/src/engine/cloud_ops.rs (`cloud_update_card`), contacts/cloud_cards.rs | Every edit sent all nine mapped person fields with `updatePersonFields` covering all of them. Google replaces whole fields, so editing a phone number deleted every organization but the first (and the first's department etc.), every event but the wedding anniversary (graduations, custom events), name prefixes/suffixes/phonetic names, further nicknames, text-only birthdays, custom labels of emails and phones, and PO box / extended address. | `google_changes`: only fields whose mapped value changed are sent and named in `updatePersonFields`; nothing changed means no request. Within a changed field, what the app doesn't map is merged back from the contact as read: other organizations and the first one's other keys, non-anniversary events, the name's other parts, custom labels and display names of unchanged entries, unchanged addresses verbatim. |
| CL-4 | Medium | Graph contacts, data loss | crates/uwumail-core/src/engine/cloud_ops.rs (`cloud_update_card`) | Moving a contact to another folder created a new contact from the *mapped* fields only and deleted the original: categories, IM addresses, spouse, children, Yomi names, second and third email names etc. were gone. A plain edit also rewrote every mapped field, replacing the Outlook display name of each email address with the address. | Move: copy of the whole contact as Graph returned it (read-only fields `id`, `changeKey`, timestamps, `parentFolderId`, `@odata.*` removed) with the changes on top (`graph_copy`). Edit: only changed fields (`graph_changes`); unchanged addresses keep their names. |
| CL-5 | Medium | Graph calendar | crates/uwumail-core/src/engine/cloud_ops.rs (`cloud_update_event`) | Graph has no event move, so moving an event to another calendar was "create a copy, delete the original". For a meeting the delete sends a cancellation to every attendee and the copy invites no one, i.e. changing the calendar of a meeting in UwUMail cancelled it for everyone. | When moving, the event is read with `attendees`; a meeting with attendees is refused with "Move it in Outlook". Single events without attendees still move. |
| CL-6 | Medium | Shared mailboxes, Graph path | crates/uwumail-core/src/engine/cloud_ops.rs (`graph_base`) | A mailbox whose address isn't one of the signed-in person's fell back to `me` whenever `users/<address>/calendars` failed for any reason but network/sign-in (403 because Graph wasn't given access, 404). For a shared mailbox this showed the person's **own** calendars and contacts under the shared mailbox's name; events and contacts created "in the shared mailbox" went into the person's own. | The fallback to `me` (meant for an alias Graph doesn't list) only applies to a mailbox opened with its own sign-in. A nested shared mailbox, or one whose sign-in is noted as someone else's, gets "Microsoft doesn't open this shared mailbox's calendar and contacts for you" (not supported, remembered like other "none here"). |
| CL-7 | Medium | Refresh-token rotation | crates/uwumail-core/src/engine.rs (`Inner::credential`) | The mail refresh read the refresh token *before* waiting for the token lock. With this release three refreshers share one refresh token (mail of the account, mail of each nested shared mailbox, the Graph token in `cloud_token`). One that waited behind another's refresh then redeemed the already rotated, older refresh token: refused once Microsoft enforces single use, and its answer's rotated token overwrote the newer one. | The refresh token is read under the lock. The mail refresh goes through the same configurable token endpoint as Graph's (`oauth::mail_scopes` + `refresh_at`), which made a deterministic test possible. |
| CL-8 | Low | Token transport | crates/uwumail-core/src/cloud.rs (`send`) | Graph/Google calls used the engine's shared HTTP client, which follows redirects. reqwest drops `Authorization` on a cross-origin redirect, so this was no leak, but a same-origin redirect could carry the token to a path outside the checked API base, and a 307 would replay PATCH/DELETE elsewhere. | Own client without redirects (as for Autodiscover and the token endpoint); a redirect is an error. Next links stay checked by `stays_under`. |
| CL-9 | Low | Google path building | crates/uwumail-core/src/engine/cloud_ops.rs (`cloud_card_raw`) | The `…:updateContact` path was built from the `resourceName` of Google's *answer*, not from the checked id the app asked with. `stays_under` kept it below the People API, but any path there was possible. | The answer's resource name must pass `google_resource` (`people/` + `[A-Za-z0-9_-]`). |
| CL-10 | Low | Shared mailbox secrets | crates/uwumail-core/src/engine/shared_ops.rs (`secret_holder`) | Only "the parent row exists" was checked before lending the parent's secret. All writers of `parent_id` are Microsoft-only today, but a row with a password or Google parent would have sent that password/token to the child's servers. | The parent's secret is used only when both are Microsoft mailboxes. |
| CL-11 | Low | Shared mailbox nesting | crates/uwumail-core/src/store/shared.rs (`shared_by_sign_in`) | A standalone mailbox signed in as alex@ was nested under any top-level Microsoft account with the *address* alex@ and its own secret deleted, even if that account's own sign-in was known to be someone else's (Kim opening Alex's mailbox). The nested mailbox then used Kim's token. | The parent's own sign-in, where known, must be that same person. |
| CL-12 | Low | Shared mailbox addresses | crates/uwumail-core/src/shared.rs (`is_mailbox_address`), shared_ops.rs (`add_shared_mailbox`) | `split_email` only checks the domain; the local part of an address typed in or listed by Autodiscover could hold spaces, control characters, quotes or brackets. It becomes an IMAP user, a sender and a Graph path (all escaped or validated downstream — lettre refuses it — so no injection was found). | Shared mailbox addresses must be plain `local@domain` (≤ 320 chars, no controls, whitespace or `<>"(),;:\[]`); Autodiscover entries that aren't fall back to the owner address or are skipped. |
| CL-13 | Low | Date overflow | google_cal.rs (`event`, `times`), graph_cal.rs (`event`) | `date + 1 day` / `start + n days` on the last representable date or with a huge duration panicked (same class as C-D-5). | `checked_add_signed` / `succ_opt`, staying at the start. |
| CL-14 | Low | Contacts, no-op writes | cloud_ops.rs (`cloud_update_card`) | Changing only the full name of a Google contact with a structured name sent an update that changed nothing (Google keeps given/family). | With CL-3 nothing is sent then. Known limitation: the full name is only written for contacts without structured parts (see CL-I-4). |

### Info, not changed

| ID | Area | Note |
|---|---|---|
| CL-I-1 | Paging / memory | Paging is bounded (50 pages; 32 MiB per answer; Graph next links must stay on the same origin and below `/v1.0/`, Google page tokens are only a query value). The worst case, 50 × 32 MiB held at once, is large but finite; a listing cut at 50 pages is silently partial (25k events / 50k contacts). |
| CL-I-2 | Graph all-day | All-day events without `originalStartTimeZone` and not at midnight UTC are placed with a "≥ 12:00 UTC → next day" guess, wrong only for UTC+12…+14 and UTC−12. Graph always sends the zone in practice. |
| CL-I-3 | Graph series move | Moving a repeating series without attendees to another calendar is still copy + delete: modified or deleted occurrences of the series are lost, and an HTML description becomes text. Meetings are refused (CL-5). |
| CL-I-4 | Google names | The editor's full name isn't written when the contact has structured name parts (Google derives the display name from them). |
| CL-I-5 | Token claims | `token_owner` reads the JWT without checking its signature. It only comes from Microsoft's token endpoint over TLS and is used to tell this device's mailboxes apart, never for an access decision at a server. |
| CL-I-6 | Floating events | A timed event without a zone would be written in UTC. The editor always sets the device zone, so this doesn't happen from the UI. |

## Checked and fine

- **Bearer tokens** go only to the fixed API bases (`Endpoints::default`, overridable in tests only);
  `Call::url` rejects joined paths and next links outside the base (origin + path prefix, `..` and
  `%2e%2e` refused). Ids from the API or the app are escaped as one path segment (`segment`), including
  `users/<address>` of shared mailboxes (`@` → `%40`); event ids are `calendar/event` of two escaped
  segments and split strictly. Google resource names are checked before use; delete and read check the
  app-supplied id too.
- **Errors and logs** carry the provider's error code/message (shortened to 200 characters), never the
  token, refresh token or request. Token endpoint errors only show `error_description`.
- **Autodiscover**: fixed URL (tests replace it in-process only), no redirects, 20 s timeout, 512 KiB
  limit, 401/403 → "sign in again", anything else → "nothing found". XML through `calendar::xml`:
  DOCTYPE refused (no entities, no XXE), depth 48, 200k elements, text capped. The request body escapes
  the address.
- **Consent and scopes**: personal Microsoft accounts are never asked for `.Shared` or EWS scopes;
  company accounts that weren't given the shared scopes fall back to their own; refusals map to
  "sign in again" / "administrator must agree" for calendars and contacts only, mail goes on. Google's
  token is checked for the calendar/contacts scope before use.
- **Sign in again** for a Microsoft mailbox checks that the new token belongs to the noted person and that
  it opens the mailbox over IMAP before replacing the stored refresh token (under the token lock).
- **Store**: all new queries are parameterized; the migration only adds nullable columns and a table with
  `ON DELETE CASCADE`; nesting is one level only (`nested_order`), a child of a removed parent falls back
  to itself (and has no secret, so it fails closed). Removing an account removes its shared mailboxes or,
  with `keepShared`, gives each a copy of the sign-in.
- **Tauri commands** take ids that are looked up in the store (unknown → not found) and addresses that are
  validated; `add_shared_mailbox` proves access with an IMAP login before saving anything.
- **UI**: no new raw HTML; shared mailbox names and addresses are rendered as text; tokens never reach the
  front end.

## Checks

`cargo fmt --all --check`; `cargo clippy -p uwumail-core -p uwumail-labels -p uwumail-tnef -p uwumail-ocr
-p uwumail-android --all-targets --locked -- -D warnings`; `cargo test` for those crates (uwumail-core:
384 tests); `apps/desktop`: `pnpm lint`, `pnpm typecheck`, `pnpm test` (849 tests). The Tauri crate
(`apps/desktop/src-tauri`) doesn't build on the review host and only forwards to the engine here.
