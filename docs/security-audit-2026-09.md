# Security audit — UwUMail client, September 2026

A second full security pass over the UwUMail client (desktop and Android), after the first audit in
[security-audit.md](security-audit.md). Scope: the mail engine (`crates/uwumail-core`), the desktop
shell and UI (`apps/desktop`), the Android host and JNI bridge (`crates/uwumail-android`,
`apps/desktop/src-tauri/gen/android`), the Windows installer, updater and uninstaller
(`apps/setup`, `updates.rs`), the addon SDK (`packages/addon-sdk`, `addons/`), and the build and
release pipeline (`.github/workflows/*`, `scripts/*`). The state reviewed is `main` including the
uncommitted Microsoft 365 work in the tree (`oauth.rs`, `engine.rs`, `AccountSetup.tsx`).

Like the earlier one this was done with Claude, not an independent firm. It is an honest sweep, not
a certificate. It deliberately leaves out step-by-step exploits; reproduction notes live in the
private `security-test-notes.local.md` (gitignored). To report something new see
[SECURITY.md](../SECURITY.md).

## Summary

State on 23 September 2026, both passes (the second is the
[addendum](#addendum--23-september-2026-calendar-rules-folders-and-end-to-end-runs) at the end):

| Severity | New | Fixed | Accepted / open |
| --- | --- | --- | --- |
| High | 0 | — | 0 |
| Medium | 6 (R-1, C-3, C-4, C-5, C-6, C-9) | 6 | 0 |
| Low | 5 (C-1, C-7, C-8, C-10, C-11) | 1 (C-1) | 4 listed |
| Informational | 4 (C-2, C-12, C-13, C-14) | 1 (C-2) | 3 listed |

The first pass found R-1 (Medium), C-1 (Low) and C-2 (Informational); all three have been fixed
since — R-1 in 6153a3d and 6ce98e1, C-1 in b18d68f, C-2 in 36e1ec1. The addendum's Medium findings
are C-3, C-4, C-5, C-6 and C-9, all fixed on `feat/calendar-rules`.

The headline is a regression check: every earlier finding (H1–H3, M1–M8, L1–L10, and the Android
AM1–AM4, AL1–AL8) still holds. The mail-rendering pipeline, the WebView↔Rust boundary, OAuth, JMAP
discovery, the installer and the release chain were re-reviewed against their fixes and against new
attack ideas. One new medium finding concerns the desktop release pipeline; the rest are low or
informational.

## Threat model (unchanged)

The main attacker is **whoever sends a mail**. Secondary attackers are **the network**, **a server
the user didn't mean to trust**, **other apps on the phone**, **someone holding an unlocked phone**,
and **the release supply chain**. Malware already running as the same user is out of scope.

## New findings

### R-1 — The desktop update-signing key is exposed to third-party build scripts *(Medium, fixed)*

| Field | Content |
| --- | --- |
| ID | R-1 |
| Severity | Medium — CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:C/C:H/I:H/A:N (needs a foothold in a build dependency) |
| Component | `.github/workflows/release.yml` (`windows` job), `scripts/build-setup.mjs` |
| Attacker & preconditions | The supply chain: a malicious or compromised Cargo/npm build dependency that runs during the release build |
| Impact | The build dependency can read `TAURI_SIGNING_PRIVATE_KEY` (and its password) from the environment. Whoever holds that key can sign a malicious update that every installed UwUMail accepts and installs. |
| Evidence | Code review, local. The `windows` job sets `TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD` as environment of the whole `pnpm build:setup` step. `build-setup.mjs` builds the app (`tauri build`, line 25) and the setup (line 30) — running every dependency's build script — and only *then* signs with `tauri signer sign` (line 35–37). `run()` spreads `process.env`, so both build steps inherit the signing key. |
| Recommended fix | Mirror the Android fix (AM4): keep the key out of the build. In `build-setup.mjs`, read the key and password into local variables at the top, `delete process.env.TAURI_SIGNING_PRIVATE_KEY` and `…_PASSWORD`, and pass them only in the `env` of the `tauri signer sign` call. In `release.yml`, move the two signing secrets off the `pnpm build:setup` step onto a separate signing step (or rely on the script no longer needing them in the ambient env). |
| Regression test | A test (or CI assertion) that builds the setup with the signing variables present in the parent environment and confirms the child processes that run the build do not see them; and that signing still happens. |
| Status (23 September 2026) | **Fixed.** 6153a3d takes the key and password out of `process.env` at the top of `build-setup.mjs`, hands them only to `tauri signer sign`, and fails the build if they are back before building. 6ce98e1 goes further: the Windows, macOS and Linux build jobs no longer get the secrets at all; a separate `sign` job, on a runner that built nothing, installs only the Tauri CLI (`--ignore-scripts`), signs the downloaded artifacts and checks every signature before `publish` uses them. Verified by reading both files: `TAURI_SIGNING_PRIVATE_KEY` appears in `release.yml` only in the `Sign` step of that job, and in no other workflow. Not run (no signing key here). |

This is the desktop counterpart of the Android **AM4** finding, which was fixed by building the APK
unsigned and signing it in a separate step. On Android the signing key is only ever visible to
`apksigner`; on Windows the updater key is visible to the whole build. The window is smaller than it
looks — `pnpm install` runs in its own step *without* the key, so npm lifecycle scripts don't see it
— but Cargo `build.rs` scripts of every dependency run during `pnpm build:setup`, with the key in
their environment.

### C-1 — Quoted mail keeps layout styles in the composer *(Low, fixed in b18d68f)*

| Field | Content |
| --- | --- |
| ID | C-1 |
| Severity | Low — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:N |
| Component | `apps/desktop/src/lib/safeHtml.ts` (`quotableHtml`) |
| Attacker & preconditions | A mail sender; triggers when the user replies to or forwards the mail |
| Impact | Quoted HTML is rendered inside the app page (not the sandboxed mail frame). `quotableHtml` removes remote content and `style` attributes that contain `url(...)`, but keeps other inline `style` attributes. A crafted mail can therefore carry layout styles (for example `position`, `width`, `height`, `background`) into the composer and visually disrupt or overlay parts of it (UI redressing). It cannot run code — the app-page CSP still blocks scripts, forms and remote loads — so the worst case is a misleading composer, not data theft. |
| Evidence | Code review, local. `FORBID_TAGS` includes `style` (the element) but the inline `style` attribute is only stripped when it matches `url(`. |
| Recommended fix | Strip the `style` attribute from quoted HTML entirely (mail quotes rarely need it), or neutralise layout-affecting properties, or render quoted content in the same sandboxed, script-less frame the reader uses. |
| Regression test | A `quotableHtml` unit test asserting that a `style` attribute with `position:fixed`/`width`/`height` is removed. |

### C-2 — The desktop app does not restrict runtime DLL loading *(Informational, fixed in 36e1ec1)*

| Field | Content |
| --- | --- |
| ID | C-2 |
| Severity | Informational |
| Component | `apps/desktop/src-tauri/src/desktop.rs` (`before_start` is empty) |
| Attacker & preconditions | A same-user process able to drop a DLL into the install folder (which is user-writable — accepted risk **I4**) |
| Impact | Both executables link with `/DEPENDENTLOADFLAG:0x800`, so *statically imported* system DLLs load from System32 only. The **setup** additionally calls `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)` at startup (M7), which also covers DLLs loaded at runtime by name. The **desktop** app does not, so a DLL loaded dynamically by name (for example by a component that isn't a static import) could still be resolved from the install folder. Reaching this needs write access to the install folder, which already implies same-user code execution. |
| Recommended fix | Call `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)` in the desktop `before_start()` too, before any dynamic load, matching the setup. |
| Regression test | Manual: confirm the app still starts (WebView2 loads) with the restriction in place. |

## Regression check of earlier findings

All fixes were re-reviewed. Status *holds* means the fix is present and I could not get past it.

| ID | Topic | Status |
| --- | --- | --- |
| H1 | Disguised attachment preview runs as a page | holds — PDF preview checks content type + `%PDF` signature; other previews use non-executing elements |
| H2 | Save-attachment wrote any page-chosen path | holds — destination only from the native dialog / Downloads; no path from the page |
| H3 | Send could attach any local file | holds — attachments are composer data only; no path variant |
| M1 | Native warning for dangerous files | holds — `open_attachment` shows the warning from the engine; the page can't skip it |
| M2 | Quoted mail bypassed the sandbox | holds — `quotableHtml` strips remote/style/scripts (but see C-1 on layout styles) |
| M3 | Waiting update trusted from a user file | holds — setup path fixed by version, signature re-checked before running |
| M4 | Feed could offer an older release | holds — `check_not_older` refuses a downgrade (unit-tested) |
| M5 | JMAP credentials followed redirects | holds — `may_send_credentials` blocks cross-site and HTTPS→HTTP; verified by tests |
| M6 | Links: scope + misleading warning | holds — opener scoped to http/https/mailto; `misleadingLink` compares shown vs real host (IDN punycode differs from ASCII text → warns) |
| M7 | DLL search order for the setup | holds — `/DEPENDENTLOADFLAG` on both; setup restricts runtime loads (see C-2 for the desktop gap) |
| M8 | Release pipeline hardening | holds — all actions SHA-pinned, minimal `permissions`, feed branch protected, version validated |
| L1 | CRLF in names/subjects/message-ids | holds — header values reduced to one line |
| L2 | Local program could cancel OAuth | holds — foreign redirects ignored, sign-in continues (tested) |
| L3 | Composer accepted script URLs | holds — only http/https/mailto |
| L4 | Gaps in dangerous-file detection | holds — extended list, trailing dots/spaces and RTL overrides handled |
| L5 | Background wrapper added after sanitising | holds — wrapper built before ammonia, re-sanitised |
| L6 | Attachment files outlived the account | holds — cached files removed with the account/protocol |
| L7 | Sender pictures reached the local network | holds — `is_public_web_url` blocks IPs/local names; redirects re-checked |
| L8 | Autoconfig accepted HTTP/odd domains | holds — HTTPS enforced after redirects, domain validated, address encoded |
| L9 | Unencrypted connections without warning | holds — clear warning kept |
| L10 | No dependency audit | holds — `cargo audit`/`pnpm audit` in CI; `cargo audit` now shows only the known unmaintained crates (I9) |
| AM1 | App lock bypass via dialogs | holds — dialogs close while locked; turning the lock off asks to unlock |
| AM2 | Share could attach UwUMail's own files | holds — only `content://` files from other apps are accepted |
| AM3 | APKs went straight to the installer | holds — app packages never opened, save-only, refused by name and type |
| AM4 | Signing key present during the build | holds for Android — APK built unsigned, signed separately (see R-1 for the desktop gap) |
| AL1–AL3 | Lock screen: notifications, Recents, archive | holds |
| AL4 | Other apps could open a chosen message | holds — only UwUMail's own notifications carry the token |
| AL5 | Shared files copied without a limit | holds — 25 MB cap |
| AL6 | Attachment names could reword the dialog | holds — control characters removed |
| AL7 | Line breaks in a server search | holds — control characters become spaces before quoting |
| AL8 | Build/update supply chain | holds — Gradle pinned by checksum, wrapper validated, HTTPS-only updates |

The attachment cache path was checked specifically for the traversal idea in the brief
(`attachments/<message id>/`): the message id is run through `safe_filename`, which maps `..`, `/`,
`\` and `:` to `_`, so a crafted Message-ID cannot escape the cache folder.

## New or changed accepted risks

No change. The earlier informational items (I1–I11, AI1–AI8) still describe the situation:
local data is unencrypted (I1), the page can call every app command which is why mail never runs in
the app page (I10), sender pictures can be reached by a domain that resolves to a private address
(I6/L7 — name-based filtering only), and the addon host isn't loaded yet (I11). None changed enough
to re-rate.

## What was checked and held up (highlights)

- **Mail HTML.** The engine sanitises with ammonia (scripts, event handlers, SVG, MathML, forms,
  `<meta>`, `<link>` all removed; `srcset` and `formaction` not allowed), the UI sanitises again with
  DOMPurify, and the result renders in a `srcdoc` iframe with `sandbox="allow-same-origin"` (no
  `allow-scripts`) under `default-src 'none'; img-src …; style-src 'unsafe-inline'; font-src data:;
  media-src data:`. Remote images, CSS `@import`, remote fonts, `background=` and CSS `url()` are all
  governed by that CSP and blocked until the user allows images. Links are intercepted and never
  navigate the frame.
- **`cid:` images** resolve only to the current message's own attachments; a mail cannot reference
  another mail's parts.
- **OAuth.** PKCE (S256), a random `state`, foreign redirects ignored (L2), a one-shot loopback
  listener, and no logging of codes or tokens. The new Microsoft admin-consent URL percent-encodes
  the domain, so it cannot inject path or query parameters.
- **JMAP discovery.** The "announced address unreachable → fall back" logic only ever rebases session
  URLs to the origin the user already connected to, never to a server-suggested one, and only on a
  connection failure.
- **Installer.** The payload is compiled into the setup (no feed-controlled extraction path), the
  downgrade check holds, and `mailto:` argument injection into the desktop exe is inert — the desktop
  only acts on a `mailto:` argument and `--autostart`, not on update or uninstall flags.
- **Tooling.** `cargo audit` (only the known unmaintained transitive crates), `pnpm audit`,
  `cargo clippy`, and `gitleaks` over the **entire git history** of `main` and `feat/android` — no
  secrets found.

## Priorities before 1.0 / before real mail

1. ~~**R-1**~~ — done (6153a3d, 6ce98e1).
2. ~~**C-1**~~ — done (b18d68f).
3. ~~**C-2**~~ — done (36e1ec1).
4. Re-run this audit when the addon host ships (I11) and when server-side drafts / multiple
   identities land.

The addendum below has its own list for the calendar, rules and folders.

## What could not be tested, and why

- **macOS and Linux packages** are workflow artifacts only, unsigned and without auto-update; not
  exercised here.
- **Real OAuth providers** (Microsoft, Google) were not contacted — out of scope by the rules. The
  flow was reviewed statically and against the redirect/PKCE/state logic.
- **A signed release build** was not produced (no signing key on this machine); R-1 is from code
  review, not from a built artifact.
- **The Android app** was reviewed from source; no APK was built or run on a device/emulator in this
  pass (the CI emulator smoke test still runs on every push).

## Addendum — 23 September 2026: calendar, rules, folders and end-to-end runs

A third pass, over the branch `feat/calendar-rules` before it is merged (`git diff main...HEAD`,
commits 7e1e344 to 3b2c1b4): creating, renaming, deleting and emptying folders over IMAP and JMAP
(`folders.rs`, `engine/folder_ops.rs`, the new functions in `imap.rs` and `jmap_sync.rs`), mail
rules over JMAP for Sieve (`jmap_sieve.rs`, the shared `lib/sieveRules.ts`, `features/rules`),
calendars over JMAP Calendars and CalDAV (`calendar/*`, `engine/calendar_ops.rs`), the 19 new Tauri
commands, the calendar and rules UI, and the CalDAV address setting. It also ports the webmail's
findings on the same features (W-22 to W-26 in the webmail's report), re-checks every earlier
finding, and — for the first time — runs the client against a real UwUMail server on this machine
and against small hostile servers written for the tests.

The threat model gains two points, as in the webmail's pass. **Calendar data** comes from whoever
can write to a calendar the user sees — the calendar server itself, another user of a shared
calendar, or an invitation a server files by itself — so it is untrusted like a mail. **Discovery**
(DNS SRV records, `/.well-known/caldav` on the mail domain) is answered by parties the user never
chose; nothing it says may make the password go somewhere new. Done with Claude, like the passes
above; reproduction notes stay in the private notes file.

### Summary

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| C-3 | Medium | CalDAV discovery sent the mailbox password to the mail domain's website | fixed in 1f8510d |
| C-4 | Medium | One small repeating CalDAV event could fill the memory | fixed in ec2df26 |
| C-5 | Medium | Quoted mail loads pictures whose address doesn't start with "http" or "//" (webmail W-22) | fixed in 8329ad2 |
| C-6 | Medium | A calendar object nested thousands deep ends the app | fixed in 869150e |
| C-9 | Medium | A mail server given by IP address made its "neighbours" trusted for the password | fixed in d44ba96 |
| C-7 | Low | IMAP folder names with `"` or `\` are kept escaped, so actions can hit another folder | listed |
| C-8 | Low | The "has subfolders" check sends the folder name unquoted | listed |
| C-10 | Low | Deleting or emptying a folder or calendar answers to the key that opened the menu (webmail W-24) | listed |
| C-11 | Low | Saving rules switches off another active Sieve script without saying so (webmail W-25) | listed |
| C-12 | Informational | Links in calendar events can be dragged out without the link question (webmail W-23) | listed |
| C-13 | Informational | The server's Sieve engine reads `${…}` in rule text as a variable (webmail W-26) | listed |
| C-14 | Informational | JMAP answers and blobs are read whole before any size check | listed |

Nothing Critical or High. The new UI adds no way to run script on the app page: event and rule
text is rendered as React text, calendar colours reach a style only as a checked `#rrggbb`, event
links are only `http(s)` and a click goes through the link question, and neither the calendar nor
the rules use `dangerouslySetInnerHTML`. The webmail's W-27 (one broken event empties the view) does
not apply: the client skips unreadable events and calendars one by one. W-28 was already fixed on
this branch (d5b0be2). The shared `sieveRules.ts` was also brought back in line with the webmail's
copy (a03909c, a correctness fix found by the webmail's end-to-end run).

### C-3 · Medium · CalDAV discovery sent the mailbox password to the mail domain's website

| Field | Content |
| --- | --- |
| Severity | Medium — CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:H/A:N (6.8) |
| Component | `crates/uwumail-core/src/engine/calendar_ops.rs:95` and `calendar/dav.rs:258-262` (before 1f8510d) |
| Attacker & preconditions | Whoever runs the website of the mail address's domain, when that isn't the mail provider (a web agency, a site builder, a hoster). The account signs in with a password. |
| Impact | Discovery counted the mail domain itself among the sites trusted with the password and asked `https://<domain>/.well-known/caldav` (and an SRV target on that site) with the password attached to the very first request — no challenge needed. It runs by itself when the calendar or Settings → Mailboxes opens. The website's operator, or anything that logs request headers there, gets the mailbox password. |
| Evidence | Verified locally, yes. With the trust list as the engine built it, a local HTTPS stub standing in for the domain's website received `Authorization: Basic …` on its first request. |
| Fix | Only the mail servers (IMAP, SMTP, JMAP) and an address typed in by hand are trusted with the password (`password_hosts`). Every other candidate is asked without it (`DavClient::locate`); only a redirect from there to a trusted site is followed, and only there the password is used. A domain that forwards `/.well-known/caldav` to its provider keeps working. |
| Regression test | `tests/caldav_hostile.rs` (`discovery_asks_the_mail_domain_without_the_password`, `a_website_asking_for_the_password_gets_none`, redirects and `href`s to other sites), `calendar_ops::tests::only_the_mail_servers_get_the_password` |

### C-4 · Medium · One small repeating CalDAV event could fill the memory

| Field | Content |
| --- | --- |
| Severity | Medium — CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:N/A:H (5.3) |
| Component | `crates/uwumail-core/src/calendar/ical.rs:139,167` (`instances`, before ec2df26), `engine/calendar_ops.rs` (CalDAV read) |
| Attacker & preconditions | A hostile or broken CalDAV server, or anyone who can put an event into a calendar the user sees (a shared calendar, an invitation the server files by itself). |
| Impact | Every occurrence carried two full copies of its event, and one object may repeat up to 20,000 times in view (5,000 objects per calendar). An object of 10 kB repeating every minute already held about 400 MB for one month's view; the 1 MB an object may have scales to tens of gigabytes, and the app ends. It comes back every time the calendar opens. |
| Evidence | Verified locally, yes (measured: 10 kB object → 20,000 occurrences, ~406 MB held). |
| Fix | Occurrences copy only what they show and share their series; one read of an account shows at most 5,000 occurrences (as many as the JMAP path asks the server for), 32 MB of them and a million expanded instances. What doesn't fit is left out with a warning in the log. |
| Regression test | `ical::tests::a_read_shows_only_what_fits`, `caldav_hostile::hostile_events_neither_crash_nor_fill_the_memory` |

### C-5 · Medium · Quoted mail loads pictures whose address doesn't start with "http" or "//"

| Field | Content |
| --- | --- |
| Severity | Medium — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:N/A:N (4.3) |
| Component | `apps/desktop/src/lib/safeHtml.ts:3,17` (the former `REMOTE` pattern), reached from Reply/Forward (`features/compose/draft.ts`), paste, drop, restored drafts and signatures |
| Attacker & preconditions | Anyone who sends the user a mail; the user replies to or forwards it. Remote pictures may be blocked for that sender. |
| Impact | The webmail's W-22 in the app. `quotableHtml` removed a picture address only when it started with `http:`, `https:` or `//`. The WebView also reads `https:\\host`, `\\host`, an address with a tab or line break in the scheme or a leading control character, `<table background>`, and — where the app page is served as `tauri://localhost` (macOS, Linux) — `http:host` as addresses on `host`. The ammonia cleaner in the engine passes them on as written. The quote is shown on the app page, whose policy allows `http:` and `https:` pictures, so pressing Reply fired the sender's tracking pixel (reader's IP address, the fact of the reply), although the reader frame had blocked it. In the app a relative address only reaches the app's own bundled files, so the webmail's session-GET variant has no counterpart. |
| Evidence | Verified locally, yes: the new unit tests failed for 9 of 10 spellings before the fix; each spelling was resolved with the WHATWG URL parser against the app's origins. |
| Fix | A picture address stays only if, read the way the browser reads it, it is `data:` or `cid:` (`isEmbeddedSource`), as in the webmail. Everything else is removed. |
| Regression test | `apps/desktop/src/lib/safeHtml.test.ts` (each spelling, cell and table backgrounds, a relative address; `data:` and `cid:` stay) |

### C-6 · Medium · A calendar object nested thousands deep ends the app

| Field | Content |
| --- | --- |
| Severity | Medium — CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:N/A:H (5.3) |
| Component | `crates/uwumail-core/src/calendar/ical.rs:16,22` (`parse`, `to_jscalendar`, before 869150e) |
| Attacker & preconditions | As C-4: a hostile CalDAV server or anyone who can write to a calendar the user sees. |
| Impact | `calcard` reads an object with components nested a few thousand deep (about 130 kB, far under the 1 MB limit), but converting it recurses once per level and overflows the stack. A stack overflow can't be caught: the whole app ends, every time the range with that object is shown. |
| Evidence | Verified locally, yes: 2,000 levels converted, 5,000 levels ended the process with a stack overflow. |
| Fix | `ical::parse` refuses objects nested deeper than eight components (real ones nest three deep), counted without recursion; such an object is skipped like any unreadable one. |
| Regression test | `ical::tests::refuses_objects_nested_too_deep` (50,000 levels refused, an event with an alarm and a zone still read), `caldav_hostile::hostile_events_neither_crash_nor_fill_the_memory` |

### C-9 · Medium · A mail server given by IP address made its "neighbours" trusted for the password

| Field | Content |
| --- | --- |
| Severity | Medium — CVSS:3.1/AV:A/AC:H/PR:N/UI:R/S:U/C:H/I:H/A:N (6.4) |
| Component | `crates/uwumail-core/src/calendar/dav.rs:27` (`site`, before d44ba96) |
| Attacker & preconditions | Someone who can forge a DNS answer for the mail domain (same network) or get a redirect from the calendar server, and runs HTTPS with a valid certificate on an address that shares the last two numbers with the mail server's. The mail server is configured by IP address. |
| Impact | `site()` asked the public-suffix list for the "registrable domain" of an IP address, which answers with its last two numbers: `192.168.0.1` counted as `0.1`, like `10.0.0.1` or any public address ending in `.0.1`. Such an address was trusted with the password during discovery and redirects. |
| Evidence | Verified locally, yes (`site("192.168.0.1")`, `site("10.0.0.1")` and `site("127.0.0.1")` were all `0.1`). |
| Fix | An IP address is a site of its own (written in its canonical form, IPv6 without brackets). JMAP's older `may_send_credentials` shares the quirk, but only after a redirect from the server that already has the password, so there it gives nothing away. |
| Regression test | `dav::tests::an_address_is_a_site_of_its_own` |

### Low findings

- **C-7 · IMAP folder names with `"` or `\` are kept escaped, so actions can hit another folder** —
  `crates/uwumail-core/src/imap.rs:250-251` (`list_folders`), consequences through
  `engine/folder_ops.rs`. CVSS `AV:N/AC:H/PR:L/UI:R/S:U/C:N/I:L/A:L` (3.7). The IMAP library hands
  back a quoted folder name from `LIST` with its escapes, so the client stores `a\"b` for a folder
  called `a"b`, shows the backslash and addresses the folder under that name. Such a folder can't be
  opened; worse, if a folder whose real name is the escaped form exists, selecting, renaming,
  emptying or deleting the first acts on the second (verified locally with two such folders: the
  first one's stored name opened the second). Folder names are chosen by the account (or by whoever
  may name folders the account sees), so this needs a deliberate pair of names. _Evidence:_
  verified locally, yes. _Fix:_ unescape `\\` and `\"` in quoted names from `LIST` before storing
  them. _Regression test:_ add the two-folder case to `tests/uwumail_server_imap.rs` and a parser
  unit test.
- **C-8 · The "has subfolders" check sends the folder name unquoted** — `imap.rs:665-670`
  (`has_children`). CVSS `AV:N/AC:H/PR:H/UI:R/S:U/C:N/I:L/A:N` (2.0). `async-imap`'s `list()` quotes
  the reference but writes the pattern as given, and `has_children` passes the folder's path plus
  `%`. For any name with a space the server matches nothing, so the check silently says "no
  subfolders" (verified locally); the check against the local folder list still runs first, and the
  UwUMail server refuses to delete a folder that has some. A line break in the path would inject a
  command, but paths come from `clean_name` (no control characters) or from the same server's own
  `LIST` (the UwUMail server refuses control characters in names and has no shared namespace), so no
  way across a trust boundary was found. _Evidence:_ verified locally, yes. _Fix:_ quote the pattern
  (escape `\` and `"`, refuse CR/LF) before handing it to `list()`. _Regression test:_ a parent with
  a space in its name in `tests/uwumail_server_imap.rs`, which today uses one without on purpose.
- **C-10 · Deleting or emptying a folder or calendar answers to the key that opened the menu** —
  `apps/desktop/src/features/mail/FolderDialogs.tsx:162,202`, `features/calendar/CalendarList.tsx:152`,
  `components/ui/Menu.tsx:53`. CVSS `AV:L/AC:H/PR:N/UI:R/S:U/C:N/I:N/A:L` (2.5). The webmail's W-24:
  menus focus their first item and the questions focus their danger button, so a held Enter can go
  through both; emptying the trash is permanent. No attacker. _Evidence:_ code review, not run (the
  test DOM can't repeat a held key). _Fix:_ focus "Cancel", or arm the danger button only after the
  key was released. _Regression test:_ a component test that a keydown with `repeat: true` on the
  danger button does nothing.
- **C-11 · Saving rules switches off another active Sieve script without saying so** —
  `crates/uwumail-core/src/jmap_sieve.rs:101,106`. CVSS `AV:N/AC:H/PR:L/UI:R/S:U/C:N/I:L/A:N` (2.6).
  The webmail's W-25: every save activates "UwUMail", and the server runs one script, so a filter
  written in another client silently stops. _Evidence:_ code review; the end-to-end rules test shows
  the activation. _Fix:_ say so and ask when another script is active. _Regression test:_ a
  `jmap_hostile.rs` case with another active script, expecting a question instead of a silent switch.

### Informational

- **C-12 · Links in calendar events can be dragged out without the link question** —
  `apps/desktop/src/features/calendar/EventPopover.tsx:16-43` (`LinkedText`). CVSS
  `AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:N/A:N` (0.0). The webmail's W-23. A click asks. A middle click
  opens nothing in the app: with no new-window handler installed, wry
  refuses the WebView's request for a new window (read in wry 0.55's WebView2 code). A link dragged
  onto a browser outside the app opens there without the question — a deliberate gesture, like
  copying the address. Code review, not run in the WebView. _Fix (defence in depth):_ the reader's
  `auxclick`/`dragstart` handling (`linkEvents.ts`) for these links too, with a test like
  `linkEvents.test.ts`.
- **C-13 · The server's Sieve engine reads `${…}` in rule text as a variable** —
  `apps/desktop/src/lib/sieveRules.ts:114` (`quote`). CVSS `AV:N/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:N`
  (0.0). The webmail's W-26, same shared file. Correctness, not injection: nothing leaves the string (covered by `sieveRules.test.ts`). _Fix:_
  write `$` as `${hex:24}`, in both copies.
- **C-14 · JMAP answers and blobs are read whole before any size check** —
  `crates/uwumail-core/src/jmap.rs:344,388`, `jmap_sieve.rs:77-80`. CVSS
  `AV:N/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:L` (1.8). `jmap_sieve` checks the script's size only after the
  download. A server the account already trusts could answer with gigabytes. The CalDAV client streams with limits; the JMAP client
  predates that. `jmap_hostile.rs` shows the script is refused, but only after all of it arrived.
  _Fix:_ read answers in chunks up to a limit, as `dav::send` does.

The unit-test data still uses `example-company.de` (older than this branch) where the project's rule
is a reserved example domain; harmless, noted for the next clean-up.

### What held up

- **Where the password goes.** CalDAV sends it only over HTTPS and only to the mail servers' sites
  and an address typed in by hand; redirects are followed by hand and checked at every hop,
  `current-user-principal` and `calendar-home-set` addresses on other sites are refused before any
  request, calendars on another origin than the home are dropped, and event and calendar ids are
  paths that are always joined onto the home's origin (`dav_url`), so the page can't aim them at
  another host. All of this ran against local stubs.
- **Hostile answers.** The XML reader refuses DOCTYPEs (no entity expansion), nesting beyond 48 and
  more than 200,000 elements; listings stop at 16 MB and objects at 1 MB while streaming; endless
  redirects stop after five; never-ending or never-matching recurrence rules stay bounded.
- **Accounts and ids.** Every calendar and event id carries its account; moving an event between
  mailboxes is refused, CalDAV writes go through the account's own client, and JMAP ids go to the
  account's own session. Another login's calendars on the UwUMail server stayed closed in every way
  tried (list, read, write, rename, delete).
- **Folders.** New names are trimmed, limited to 200 characters, and refused with control
  characters, the server's delimiter or the `LIST` wildcards; IMAP commands other than the `LIST`
  pattern (C-8) quote names and refuse line breaks; system folders can't be renamed or deleted, and
  only trash and junk can be emptied. SQL is parameterised throughout.
- **Rules.** As in the webmail: rule text can't leave its Sieve string or comment, a script from
  elsewhere is shown as text, and a Sieve blob id from the server is one escaped path segment of the
  download address.
- **App lock (AM1).** The new questions use the lock-aware dialog; the calendar popover sits below
  the lock screen.

### Regression check

| ID | Status |
| --- | --- |
| H1–H3, M1, M3, M4, M7, M8 | hold — untouched by this branch (no changes in the attachment, update, installer or workflow code); spot-checked |
| M2 | holds after C-5 — quoted mail keeps no remote or relative pictures, no styles, no scripts |
| M5 | holds — JMAP unchanged; CalDAV applies the same rule, stricter since C-3 and C-9 |
| M6, L3 | hold — calendar links go through `requestOpenLink` and the same checks; only `http(s)` is linked |
| L1, L2, L4–L9 | hold — untouched by this branch |
| L10 | holds — `cargo audit` and `pnpm audit` run (below) |
| AM1 | holds — see "What held up" |
| AM2–AM4, AL1–AL8 | hold — no Android file changed on this branch |
| R-1 | **fixed** (6153a3d, 6ce98e1) — was listed as open; see its status row above |
| C-1, C-2 | fixed earlier (b18d68f, 36e1ec1); still in place |

### What was run

- **Tools:** `cargo audit` (no vulnerabilities; seven warnings for the known unmaintained or unsound
  transitive crates, I9), `cargo clippy --workspace --all-targets -- -D warnings` (clean),
  `pnpm audit --prod` (no known vulnerabilities), `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `cargo test --workspace`, and a search of the branch's diff for secrets and real data (none; one
  dummy password in a unit test). There is no `deny.toml`, so `cargo deny` wasn't run. The tests'
  certificate generator `rcgen` was added as a dev-dependency; it isn't part of the app.
- **End to end against a local UwUMail server** (0.6.3, dummy accounts): the existing JMAP tests for
  rules and calendars (`uwumail_server_calendar.rs`) and settings (`uwumail_server.rs`); new,
  gated by environment variables so CI skips them: `uwumail_server_caldav.rs` (discovery,
  calendars, a weekly series, updates with the etag and a stale one refused, one occurrence deleted
  by EXDATE, another login's calendars refused) and `uwumail_server_imap.rs` (create, nest, rename,
  move, empty and delete folders; names that would break a command are refused). They trust only
  the server's own certificate, through a constructor the app never uses; the app's certificate
  checks are unchanged. All pass.
- **Hostile servers written for the tests** (run in CI): `caldav_hostile.rs` (discovery, redirects,
  `href`s to other sites, oversized, entity-bomb, deep and looping answers, hostile events) and
  `jmap_hostile.rs` (a Sieve blob id with path and query characters, an oversized script, events with
  broken dates, zones, durations, colours and markup).

### What could not be tested, and why

- **Android** — no SDK or device here. From source: no Android file changed on this branch; the new
  commands are registered in the same handler list for the phone (`lib.rs`), CalDAV there checks
  certificates against Mozilla's root list (AI1), and the calendar and rules screens reuse the
  lock-aware dialog. Not run.
- **Signed release builds** — no signing key here; R-1's fix was read, not run.
- **The engine's own CalDAV path end to end** — the engine checks certificates with the system only,
  and the local server's certificate is self-signed; the end-to-end test runs the same module calls
  the engine makes, not the engine itself.
- **Real third-party CalDAV servers and real DNS** — not contacted (local only). The SRV path was
  reviewed; forged answers were stood in for by redirects from local stubs.
- **A held key (C-10) and a middle click (C-12) in the real WebView** — not sent; read from code
  (and wry's source).
- **One unexplained abort** — the very first run of `uwumail_server_caldav.rs` ended with an abort
  status after one test had finished its work; it did not come back in eleven further runs. Left
  here so it isn't forgotten.

### Priorities

1. Merge the fixes with the branch (done on `feat/calendar-rules`).
2. **C-7 and C-8** before folder management is used on servers where people name folders freely:
   unescape `LIST` names and quote the `LIST` pattern.
3. **C-10 and C-11** with the webmail, which has the same two.
4. C-12 to C-14 when convenient.
