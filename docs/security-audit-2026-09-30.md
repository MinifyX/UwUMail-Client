# Security audit — UwUMail client, 30 September 2026

A full pass over the whole repository before 0.7.0-beta.1, with extra depth on what is new in it: the
resizable layout, labels everywhere, labels without a model on this device (`crates/uwumail-labels`, a
copy of the server's crate, and its store tables), and mail of other mailboxes going to a UwUMail
server's assistant (the "AI from your UwUMail server" setting). The open items of the
[23 September audit](security-audit-2026-09-23.md) were looked at again and fixed where possible; their
status there is updated.

Done with Claude, like the passes before; not an independent firm. It leaves out step-by-step exploits.
To report something new see [SECURITY.md](../SECURITY.md).

## Counts

| Severity | Found | Fixed | Not fixed |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 0 | 0 | 0 |
| Medium | 8 | 8 | 0 |
| Low | 53 | 52 | 1 (CC-10, by design) |
| Info | 21 | 8 | 13 (see table) |

## Findings

| ID | Severity | Area | file:line | Issue | Fix | Commit |
|---|---|---|---|---|---|---|
| C-E-1 | Medium | Foreign mail | crates/uwumail-core/src/engine/assist_ops.rs:198 | With serverAssist on but the chosen server unreachable, lacking `foreignMail` or removed, AI features and auto-labels silently fell back to device providers, i.e. mail went to a provider the person had replaced. | `foreign_server` answers `assistUnavailable`; nothing is sent anywhere; auto-labels run non-AI only. | b9690e2 |
| C-E-2 | Medium | Foreign mail | crates/uwumail-core/src/assist/foreign.rs:27 | Spam check sent the first 100 headers (Received, internal IPs) to the server, which reads two. | Only Authentication-Results and X-Spam-Status are sent. | b9690e2 |
| C-E-9 | Medium | Store / SQL | crates/uwumail-core/src/store.rs:1050 | Threading matched references with LIKE on the Message-ID; `%`/`_` in a hostile Message-ID merged unrelated conversations into the sender's thread. | Exact match with `instr`. | b9690e2 |
| C-D-1 | Medium | TNEF | crates/uwumail-tnef/src/html.rs:92,106 | HTML→text quadratic (lower-casing the rest per tag, `;` search per `&`): a crafted winmail.dat ran minutes–hours per parse. | Case-insensitive search without copying; `;` looked for in 11 bytes. Server copy informed. | abdcfff |
| C-D-3 | Medium | Labels | crates/uwumail-labels/src/detect.rs, mail.rs | Subject/headers/attachment names uncapped; appointment detector O(N²) on a long word (= server LABELS-H1). | Server's fixed crate copied byte-identically (caps `MAX_FIELD_CHARS`, one pass over words). | 8ad68c5 |
| C-D-5 | Medium | Calendar | crates/uwumail-core/src/calendar/ical.rs:201 | Huge DURATION from a CalDAV server panicked on `start + delta` and crashed the app when reading the calendar. | `checked_add_signed`, falling back to the start. | aa4d0f7 |
| C-shell-CI-1 (CS-7) | Medium | Android signing | .github/workflows/android.yml, release.yml | Every push to main was signed with the release key. | Release key only on `v*` tags; main uses `UWUMAIL_ANDROID_CI_KEYSTORE_*` secrets or a throwaway key; a CI build with the release cert fails. | 789a472 |
| C-shell-CI-2 (CS-9) | Medium | Release artifacts | .github/workflows/release.yml, desktop.yml, scripts/artifact-digest.mjs | One release job could replace another job's artifact before signing. | Digests passed as job outputs and verified by sign/publish. | 789a472 |
| C-B-1 (CS-8) | Low | Composer | apps/desktop/src/lib/signatures.ts:32 | Stored/synced signature HTML went into the live editor uncleaned. | Through `quotableHtml` before insertion. | abbed23 |
| C-B-2 | Low | Destructive dialogs | FolderDialogs.tsx, CalendarList.tsx, DeleteForeverQuestion.tsx, DeleteContactQuestion.tsx | Focused danger button: the Enter/double click that opened the question could confirm a permanent delete. | `ArmedButton` ignores the first 600 ms and key repeats. | abbed23 |
| C-B-5 | Low | Labels drag & drop | LabelNav.tsx, MailboxNav.tsx, ThreadRow.tsx, threadDrag.ts | Drops trusted thread ids in drag data another app could supply (move/label arbitrary threads). | Drops use the rows the list itself dragged. | abbed23 |
| C-B-6 | Low | Reader sanitizer | apps/desktop/src/features/mail/MessageBody.tsx:44 | DOMPurify kept `href` on MathML; WebKit follows it, bypassing the link question (defence in depth; ammonia already strips MathML). | Hook drops MathML `href`/`xlink:href`. Webmail informed. | abbed23 |
| C-B-7 | Low | AI output | apps/desktop/src/features/assist/labels.ts:108,132, LabelSuggestCard.tsx | AI new-label proposals skipped the form checks; bidi controls could reverse names. | Only proposals passing the form checks are offered; C1/bidi refused. | abbed23 |
| C-B-11 (W-40) | Low | Reader pictures | apps/desktop/src/lib/remoteImages.ts | A mail could write its own `uwuimg:` address and pick which account's server fetches; SVG `feImage` not proxied. | Mail-written `uwuimg:` loads nothing; `feImage` proxied. | 5a75998 |
| C-B-12 (W-41) | Low | Reader | features/mail/remotePictures.ts, MessageBody.tsx | Deferring pictures stripped the reader's own date marks. | Only its own markers removed; mail-supplied `data-uwu-*` stripped. | 5a75998 |
| C-B-13 (W-42) | Low | Composer | lib/safeHtml.ts, compose/draft.ts:30, Composer.tsx | Quoted/pasted/dropped mail kept `data-uwu-signature`. | `quotableHtml(html, {foreign: true})`. | 5a75998 |
| C-B-14 (W-43) | Low | Attachments | crates/uwumail-core/src/attachments.rs | Zero-width/invisible chars kept in attachment names. | Removed (emoji joiner kept). | 5a75998 |
| C-B-15 (W-44) | Low | Attachments | attachments.rs, apps/desktop/src/lib/attachments.ts | `.xht/.xsl/.xslt` opened without warning. | Added to both lists. | 5a75998 |
| C-B-16 (W-24) | Low | Destructive dialogs | SettingsDialog.tsx, ContactsSidebar.tsx, MailRules.tsx, DeleteScopeQuestion.tsx | Four more questions answerable by the opening Enter (account removal used `window.confirm`). | In-app question / ArmedButton. | 5a75998 |
| C-B-17 (W-25) | Low | Mail rules | crates/uwumail-core/src/jmap_sieve.rs, model.rs, MailRules.tsx | Saving rules silently deactivated another app's Sieve script. | Engine reports it; UI asks before replacing. | 5a75998 |
| C-E-3 | Low | Foreign mail | engine/assist_ops.rs:673,689 | Compose forwarded the whole page request (incl. page-supplied foreignMails); replied-to mail went wherever the draft's AI went. | Only contract fields; reply mail only when its mailbox uses device AI. | b9690e2 |
| C-E-4 | Low | Scope ownership | engine/assist_ops.rs:604 | `assist_recent_inbox` accepted any account id as scope. | Scope must be `device` or a UwUMail account with the assistant. | b9690e2 |
| C-E-5 | Low | Label keywords | assist/validate.rs:460, assist/local.rs:567 | Labels named Junk/NonJunk/Seen/Deleted became those plain keywords (read as marks by other clients). | `label-<kw>` for reserved names (new labels). | b9690e2 |
| C-E-6 | Low | Learning / DB size | store/assist.rs:573 | Learned senders unbounded, any address length. | ≤ 5,000 per label, addresses ≤ 320 chars. | b9690e2 |
| C-E-7 | Low | DB size | store/assist.rs:809 | Label log bounded by age only. | Also newest 20,000 kept. | b9690e2 |
| C-E-8 | Low | Account removal | store.rs:693 | Removing an account left label log, examples and the serverAssist choice. | Removed with the account (choice falls back to off). | b9690e2 |
| C-E-10 | Low | Store / SQL | store.rs:359, ~1811 | Contact search didn't escape `_`. | `ESCAPE '\'`. | b9690e2 |
| C-E-11 | Low | Store | store.rs:1403 | Label keyword with a space matched two neighbouring keywords. | Such keywords match nothing. | b9690e2 |
| C-E-12 | Low (functional gap) | Device labels | engine/assist_ops.rs:452, store/assist.rs:711 | Deleting a device label only removed its keyword from mail in the last 500 log entries. | Exact-keyword store query per device-served account; removal in batches of 200, ≤ 20,000 mails, 60 s/batch, 5 min total, failed batches logged and skipped. | b9690e2 |
| C-NET-1 | Low | IMAP | crates/uwumail-core/src/imap.rs:412 | `store_keyword` wrote the keyword raw into `UID STORE`; only one caller validated. | Validated at the sink. | 271127c |
| C-NET-2 | Low | JMAP | jmap_sync.rs:481 | Keywords unvalidated; `/`,`~` unescaped in patch path. | RFC 8621 atoms; JSON-pointer escaping. | 271127c |
| C-NET-3 | Low | JMAP | jmap_sync.rs:160 | `Email/changes` loop endless with a lying `hasMoreChanges`. | ≤ 100 rounds, then bounded full compare. | 271127c |
| C-NET-4 | Low | IMAP | imap.rs:331 | Quoted LIST names kept escapes → actions on another folder. | Unescaped. | 271127c |
| C-NET-5 | Low | IMAP | imap.rs:769 | Subfolder LIST pattern unquoted. | Quoted; CR/LF/NUL refused. | 271127c |
| C-NET-6 (EG-3) | Low | JMAP | jmap.rs:725 | API answers, blobs, pictures, session, errors read whole. | Chunked reads with limits (64 MB/256 MB/10 MB/4 MB). | 271127c |
| C-NET-7 (EG-2) | Low | JMAP pictures | jmap.rs:573 | Server content type passed through. | Typed by bytes; non-images refused. | 271127c |
| C-NET-8 (CC-11) | Low | JMAP | jmap.rs:811,835 | Session endpoints / assistant `streamUrl` on other sites got credentials; IPs grouped by PSL. | Must be on the session's site; each IP its own site. | 271127c |
| C-NET-9 (CC-9) | Low | Discovery | engine.rs:1597 | Old off-site JMAP address from discovery used with the password. | `trusted_jmap_url`. | 271127c |
| C-NET-10 (CC-4) | Low | OAuth | oauth.rs:261 | Redirect names `localhost`, listener only on 127.0.0.1. | Binds both 127.0.0.1 and ::1. | 271127c |
| C-NET-12 (CC-5) | Low | Discovery | autoconfig.rs:171 | Domain's autoconfig could name itself a big provider. | Name only when IMAP host is on the domain's site. | 271127c |
| C-NET-14 (EG-4) | Low | Pictures | pictures.rs:482 | BIMI DNS lookup bypassed the privacy proxy. | Only without a proxy. | 271127c |
| C-NET-15 | Low | Local DB | store.rs:377 | Data dir/DB with default umask (0755/0644). | 0700 dir, 0600 DB + journals on Unix. | b9690e2 |
| CC-10 | Low | DAV/JMAP | dav::site | Password may go to any host on the mail server's registrable domain. | — | not fixed (by design, listed before) |
| C-D-2 | Low | TNEF | crates/uwumail-tnef/src/meeting.rs:555 | Addresses from the mail went unchecked into ORGANIZER/ATTENDEE (new iCal properties). | `internet_address()` filter. Server informed. | abdcfff |
| C-D-4 | Low | Labels | crates/uwumail-labels/src/classifier.rs:115 | Count overflow / negative counts → panic in debug / NaN. | From the server's fixed crate. | 8ad68c5 |
| C-D-6 | Low | Calendar | calendar/jscal.rs:28,32,108,324 | Panics near chrono limits. | Years 1–9999, safe shifting. | aa4d0f7 |
| C-D-7 | Low | Calendar | calendar/ical.rs:188 | O(occurrences × events) uid lookup. | Index map. | aa4d0f7 |
| C-D-8 | Low | Sanitizer | mime.rs:279 | ammonia allowed `data:` on every URL attribute. | Only img src / table backgrounds. | aa4d0f7 |
| C-D-9 | Low | Attachments | attachments.rs:239,279 | Reserved Windows names/length gaps in `safe_filename`. | Reserved-name check, trim, 150 chars/200 bytes. | aa4d0f7 |
| C-D-11 | Low | OCR | ocr.rs:41,139 | Tag-end search over the rest of the HTML per `<img`. | Bounded to 32 KB. | aa4d0f7 |
| C-D-12 | Low | Birthdays | birthdays/mod.rs:246,330 | Year overflow; O(n²) X-ABDATE. | `checked_sub`; ≤ 40 dates. | aa4d0f7 |
| C-D-13 | Low | AI mail text | assist/mail.rs:102,196; mime.rs:49 | Subject/headers/addresses to the AI uncapped. | 998 / 2,000 / 200 chars. | aa4d0f7 |
| C-shell-1 (CS-4) | Low | Dialogs | apps/desktop/src-tauri/src/desktop.rs:138, ios.rs:132 | "Open anyway" was the default button; plugin reports Esc as 2nd custom button. | rfd directly, safe answer first, only "yes" counts. | 2d320b0 |
| C-shell-2 (UP-1) | Low | Updater | updates.rs:346, apps/setup/src-tauri/src/system_unix.rs | Relaunched app kept setup's TMPDIR / APPIMAGE_EXTRACT_AND_RUN. | Original TMPDIR restored, variable dropped. | 2d320b0 |
| C-shell-3 (EG-2) | Low | uwuimg: | src-tauri/src/lib.rs:898 | Server content type served as-is with ACAO *. | Sniffed type, never a page; CSP sandbox. | 2d320b0 |
| C-shell-4 (EG-3) | Low | uwuimg: | src-tauri/src/lib.rs:898 | No size limit. | 10 MB cap (core half in C-NET-6). | 2d320b0 |
| C-shell-5 | Low | Capabilities | src-tauri/capabilities/ | Page had `core:default` + `notification:default` but only listens to events. | `core:event:allow-listen/unlisten` only. | 2d320b0 |
| C-shell-6 | Low | open_url | desktop.rs:61, ios.rs:52, uwumail-android/src/host.rs:85, Files.kt:21 | Engine open_url opened any scheme. | http(s) only (`links::external_url`), BROWSABLE on Android. | 2d320b0 |
| C-shell-CI-3 | Low | Workflows | .github/workflows/* | Checkout token persisted in .git/config. | `persist-credentials: false`. | 789a472 |
| C-shell-CI-4 | Low | Workflows | ios.yml, ci.yml | `${{ }}` directly in `run:`. | Via `env:`/`jq --arg`. | 789a472 |
| C-shell-CI-5 | Low | Scripts | scripts/build-setup.mjs:67 | Version unchecked into file names / shell string. | semver check. | 789a472 |
| C-B-3 | Info | Calendar | EventPopover.tsx:41 | Event description links draggable/context-menu past the link question. | Blocked; middle click asks. | abbed23 |
| C-B-4 (EG-6) | Info | Settings | PrivacyProxy.tsx:19 | Proxy password shown in plain text. | Masked in UI; still stored in plain text. | abbed23 (partly) |
| C-NET-11 | Info | OAuth | oauth.rs:390 | Token requests followed redirects; answer unbounded. | No redirects; 256 KB cap. | 271127c |
| C-NET-13 (CC-6) | Info | Discovery | autoconfig.rs:190 | Plain-HTTP hop allowed; body unbounded. | HTTPS-only redirects (≤ 5); 256 KB. | 271127c |
| C-NET-16 | Info | Ollama detect | assist/discover.rs:18 | Model list read whole before check. | Chunked, 1 MB. | 271127c |
| C-D-10 | Info | Attachments | attachments.rs:144 | Missing Outlook-blocked types; U+061C. | Extended. | aa4d0f7 |
| C-shell-7 | Info | Commands | src-tauri/src/lib.rs:617 | `language` argument unchecked into the prompt. | `language_tag` check. | 2d320b0 |
| C-shell-8 (CS-6) | Info | .deb/.rpm update | updates.rs:359 | pkexec/dpkg/rpm via PATH. | Absolute system paths (swap-before-install half open: needs same-user code + admin password). | 2d320b0 (partly) |
| C-B-8 | Info | Composer | useComposeAssist.ts | AI drafts already escaped. | — | no issue |
| C-B-9 | Info | Addons | packages/addon-sdk | No addon host yet; SDK checks parent frame. | Review when the host is built. | not fixed (nothing to fix) |
| C-B-10 | Info | Navigation | src-tauri/src/lib.rs | No `on_navigation` guard for the main webview. | Recommended; not added without a runtime test on all three WebView engines (subframe semantics differ). | not fixed |
| C-B-18 (WM-A) | Info | Local draft | features/compose/localDraft.ts | Saved draft stays in app localStorage. | App-private storage; mail is in local SQLite anyway. | not applicable |
| C-B-19 (WM-B) | Info | Push | jmap_push.rs:149 | Device id per login. | Already per installation+account hash. | not applicable |
| C-E-13 | Info | Sieve | apps/desktop/src/lib/sieveRules.ts | Keywords `[a-z0-9._-]{1,64}` and quoted. | — | no issue (byte-identical with webmail) |
| C-E-14 | Info | AI output | validate.rs, estimate.rs | AI only adds configured labels; never removes; proposals bounded; cost maths NaN-safe. | — | no issue |
| C-NET-17 | Info | IMAP | async-imap | Library buffers a single response up to 512 MiB. | Needs a library fork. | not fixed (library) |
| C-NET-18 | Info | AI providers | assist/local.rs | Changing a provider's base URL keeps its key. | Only the person's own settings can do this. | not fixed (accepted) |
| C-shell-9 | Info | Setup (Windows) | apps/setup/src-tauri/src/system.rs:359 | WebView2 bootstrapper run without Authenticode check (HTTPS only). | WinVerifyTrust. | not fixed (Windows-only, can't build/test here) |
| C-shell-10 | Info | Android update | crates/uwumail-android/src/updates.rs:116 | APK read whole into memory (HTTPS + sha256 checked). | Stream with cap. | not fixed (low value) |
| C-shell-CI-6 | Info | Secrets | android.yml, release.yml | Release keystore/update key are repo-wide secrets. | Move into a tag-only GitHub Environment. | not fixed (repo settings, owner) |
| C-shell-CI-7 | Info | Supply chain | Cargo.lock | cargo audit: 0 vulnerabilities, 7 warnings (unmaintained/unsound via Tauri/GTK, no compatible update); pnpm audit --prod clean. | — | not fixed (upstream) |

## What held up

TLS verification everywhere (no global accept-invalid, STARTTLS fails closed); secrets only in the
keychain, long-token split correct; AI keys only to their provider, no redirects, bounded reads; SMTP
headers can't be injected; reader iframe sandbox `allow-same-origin` only + CSP blocking remote loads until
allowed; all link paths through the link question and Rust `open_link`; Safe Links show what is opened;
`mailto:` can't add attachments; AI output rendered as text, colors `#rrggbb`; serverAssist off by default
with the warning and only eligible servers offered; the foreign-mail gate needs the device setting AND the
chosen server's `foreignMail` and sends only to that account's API URL (now also site-checked);
`sieveRules.ts` byte-identical with the webmail; all other SQL parameterized; migrations transactional.

## Shared with the server and the webmail

The two TNEF fixes (C-D-1, C-D-2) went to the server's copy of `uwumail-tnef`; the labels crate is the
server's fixed one (C-D-3, C-D-4). The MathML link (C-B-6), reserved label keywords, the learned-senders cap
and the Message-ID matching were reported to the server and webmail. The client took the webmail review's
hints W-24, W-25 and W-40 to W-44.

## Open, for the maintainer

- Secrets `UWUMAIL_ANDROID_CI_KEYSTORE_BASE64` and `UWUMAIL_ANDROID_CI_KEYSTORE_PASSWORD` for Android builds
  of `main` (without them each build gets a throwaway key).
- Release secrets into a GitHub Environment limited to `v*` tags.
- The v0.7.0-beta.1 tag run is the first real run of the Android signing split and the artifact digests.
