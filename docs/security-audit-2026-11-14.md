# Security review — UwUMail client, backup search, 14 November 2026

A pass over everything on `feat/backup-search` since v0.12.0-beta.7
(`git diff v0.12.0-beta.7...feat/backup-search`, about 1.2k lines): the search of the own deleted mail
in the server's backups (`urn:uwumail:jmap:backups`, UwUMail-Server `docs/jmap-backups.md`) with its
preview and restore (`crates/uwumail-core/src/jmap_backups.rs`, the session field `backups` in
`jmap.rs`, three engine methods in `engine/account_ops.rs`, three Tauri commands in
`apps/desktop/src-tauri/src/account.rs`, the dialog `apps/desktop/src/features/backups/BackupSearch.tsx`
and the backend bindings), plus the calendar button fix (8370913, CSS only).

Done with Claude, like the passes before; not an independent firm. It leaves out step-by-step exploits.
To report something new see [SECURITY.md](../SECURITY.md).

## Counts

| Severity | Found | Fixed | Open |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 0 | 0 | 0 |
| Medium | 0 | 0 | 0 |
| Low | 2 | 0 | 2 |
| Info | 6 | 0 | 6 |

Every finding needs a hostile or buggy server; the server's own ownership check is not weakened by any
of them.

## Findings

| ID | Severity | Area | Location | Cause | Fix | Status |
|---|---|---|---|---|---|---|
| BK-1 | Low | Backup search | `jmap_backups.rs` `clean` | Server texts (subject, sender name and address, folder, attachment names, preview text) lose only control characters (`Cc`). Bidi overrides and isolates (U+202A–E, U+2066–9) and other format characters stay, so a sender or an attachment name can show in a different order than it is, right where the person decides what to take back. Same class as AC-2 (masked addresses). | Drop U+202A–U+202E and U+2066–U+2069 in `clean` (for the one-line fields also U+200B–U+200F and U+FEFF); a test next to `reads_a_search`. | fixed (bidi controls dropped in `clean`) |
| BK-2 | Low | Backup search | `jmap_backups.rs` `id_of`, `parse_search`, `checked_ids`; `BackupSearch.tsx` `BackupRow`, `BackupPreviewPane` | Ids accept any non-control text up to 255 bytes instead of the JMAP `Id` characters, and duplicates are kept. The page puts them into `id`/`htmlFor`/`aria-labelledby` (`${ids}-${mail.id}`, `${mail.id}-files`), React keys and the chosen set: a space breaks the label list, a duplicate makes two rows one choice (both restored) and React keys collide. | `id_of` takes only `[A-Za-z0-9_-]{1,255}` (RFC 8620 §1.2); `parse_search` keeps the first of equal ids; `checked_ids` drops duplicates. | fixed (JMAP Id characters only, duplicates dropped) |
| BK-3 | Info | Backup search | `jmap_backups.rs` `email_of` (`receivedAt`, `snapshots`) | Dates from the server are only cleaned and cut to 40 characters, not read as dates; the page shows "Invalid Date". The brief asks for dates checked in Rust. | Parse with `DateTime::parse_from_rfc3339` and give them in UTC; leave out an unreadable snapshot, set `received_at` to `None`. | accepted |
| BK-4 | Info | Backup search | `jmap_backups.rs` `search`, `utc_date` | `after` later than `before` is sent as is (finds nothing), and any year chrono reads is taken. | Refuse `after > before` with `Error::invalid`; optional bound on the year. | accepted |
| BK-5 | Info | Backup search | `jmap_backups.rs` `answer`; `jmap.rs` `From<MethodError>` | For every kind but `forbidden` the server's `description` goes into the error message uncleaned and unbounded. The dialog only shows texts by error code, but the message reaches the page and the dev tools. | Clean and cut the description (as for `forbidden`) for every kind in `answer`. | accepted |
| BK-6 | Info | Backup dialog | `BackupSearch.tsx` `BackupPreviewPane` | The preview of a deleted mail stays in the query cache (memory only; there is no persister) for the default 5 minutes after the dialog closed. | `gcTime: 0` for `backupPreview`, or remove those queries when the dialog closes. | accepted |
| BK-7 | Info | Backup dialog | `BackupSearch.tsx` `BackupPreviewPane` | The preview query inherits `retry: 1`, so a `forbidden` or failed answer asks the backup storage a second time. | `retry: false` (or no retry for `forbidden`). | accepted |
| BK-8 | Info | Tests | `BackupSearch.test.tsx` | No test pins that preview text with markup stays text (it does today: React text in a `<pre>`). | One test with markup in `textBody` asserting it shows literally and adds no element. | accepted |

## Checked and fine

- **Own account only**: `Session::parse` sets `backups` only when the capability is in the session and in
  the `accountCapabilities` of the login's own mail account (test
  `offers_the_backups_only_for_the_own_account`); `Session::shared_view` sets it to `false`, so a shared
  mailbox (its own app account working through `shared_view`) is refused with `not_supported` before any
  request. The capability goes into `using` only when offered; requests carry `client.account_id()`, never
  an id from the page.
- **Tauri commands**: `search_backups`, `preview_backup_mail` and `restore_backup_mail` take an app
  account id; `server_client` needs a stored account with protocol JMAP, so unknown ids and IMAP, Graph
  or Google accounts are refused. No new capability file, plugin or permission.
- **Input checks in Rust**: search text trimmed and cut to 256 characters; dates must be RFC 3339 and are
  sent in UTC; 1–10 ids for a preview, 1–50 for a restore, no empty or control characters. The restore
  outcome lists only ids that were asked; one the server leaves out counts as `notFound`.
- **Answers bounded**: at most 200 hits, 10 previews, 100k characters of text, 500 attachments, 100
  addresses and 1000 snapshots per mail; the whole answer is limited by `MAX_ANSWER`.
- **No HTML**: the preview is the server's `textBody`, cleaned of control characters but line breaks and
  tabs, rendered as React text; no `innerHTML` or `dangerouslySetInnerHTML` in the change. Restore reasons
  are mapped to fixed texts; unknown ones show as "other".
- **No secrets**: the auth header is only on the request; no request bodies, search texts or tokens in
  logs, results or errors. Demo and test data use `example.com/.net/.org`.
- **Calendar fix (8370913)**: one class change, no logic.
