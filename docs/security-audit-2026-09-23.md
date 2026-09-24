# Security audit — UwUMail client, 23 September 2026

A focused pass after the [September audit](security-audit-2026-09.md), on four areas: how account setup
decides where OAuth tokens and passwords go (server discovery together with the Microsoft and Google
sign-in), the app shells, release pipeline and updater (the review of `apps/desktop`, `apps/setup`,
`scripts/` and `.github/workflows/` at 502bb93), the Linux updater's AppImage hand-over, and the code
merged since 502bb93 by the egress work (a33860b: the `uwuimg:` picture scheme, the privacy proxy, the
CSP change and the update-check switch). A second part, after the contacts branch was merged
(0259bd3), covers JMAP discovery and which hosts may get the password for the calendar and the
address book, and the new CardDAV client (`git diff a33860b 0259bd3`).

Done with Claude, like the passes before; not an independent firm. It leaves out step-by-step exploits.
To report something new see [SECURITY.md](../SECURITY.md).

## Summary

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| CC-1 | Medium | Discovery could send a Microsoft or Google sign-in token to a server that only looks like the provider's | fixed in 16050b4 |
| CC-2 | Medium | Forged SRV records could point setup at any server, which then receives the password | fixed in 16050b4 |
| CC-3 | Low | A local program could still hold up or end an OAuth sign-in (L2 only partly held) | fixed in f92a5b3 |
| CC-7 | Medium | JMAP discovery could name any server, which then got the password and became trusted for calendars and contacts | fixed in ed82072 |
| CC-8 | Medium | One CardDAV address book could fill the memory | fixed in a9166ba |
| EG-1 | Medium | A `socks5://` privacy proxy let the device look up the sender's host names itself | fixed in f411ce0 |
| CS-1 | Medium | One platform's build could swap another platform's release file before signing | fixed in 5e40a7c |
| CS-2 | Medium | The phone app lock hid the screen but not the keyboard or the screen reader | fixed in 99a5ef0 |
| CS-3 | Medium | macOS: attachments never got the quarantine flag; macOS launcher files not on the dangerous list | fixed in 3ac42ee |
| CC-4 | Low | The Microsoft loopback redirect names `localhost`, the listener only binds `127.0.0.1` | listed |
| CC-5 | Low | Setup shows the name from the domain's autoconfig file, not the servers it names | listed |
| CS-4 | Low | The native "can run programs" question has "Open anyway" as its default button | listed |
| UP-1 | Low | After an update, the relaunched app keeps the setup's `TMPDIR` and `APPIMAGE_EXTRACT_AND_RUN` | listed |
| EG-2 | Low | `uwuimg:` passes a UwUMail server's content type through unchanged | listed |
| EG-3 | Low | Pictures from a UwUMail server are read whole, without a size limit | listed |
| EG-4 | Low | The BIMI lookup for sender pictures bypasses the privacy proxy | listed |
| CC-9 | Low | IMAP mailboxes added earlier keep the JMAP address discovery found; switching to JMAP uses it | listed |
| CC-10 | Low | The password goes to any host on the mail server's registrable domain | listed |
| CC-6 | Informational | An autoconfig answer may pass through a plain-HTTP redirect as long as it ends on HTTPS | listed |
| CS-5 | Informational | `fetch_mail_image`/`uwuimg:` check the host by name only (I6) | listed, comment corrected |
| CS-6 | Informational | `.deb`/`.rpm` self-update: `pkexec` by `PATH`, file checked before root installs it | listed |
| CS-7 | Informational | Android: every push to `main` is signed with the release key | listed |
| CS-8 | Informational | The composer inserts stored signature HTML without cleaning it | listed |
| CS-9 | Informational | Any job of a release run can still replace another job's artifact before signing | listed |
| EG-5 | Informational | With a UwUMail server among the accounts, every account's senders go to it for pictures | listed |
| EG-6 | Informational | The proxy's login is kept and shown in plain text | listed |
| CC-11 | Informational | A JMAP session may name its API endpoints on another site | listed |

Nothing Critical or High. The Linux updater question (does it unpack the setup AppImage into a
predictable folder in `/tmp`?) is answered with no: it has run the setup with `TMPDIR` set to the
private (0700) updates folder since IR12; only the relaunch half is open (UP-1).

## Threat model (unchanged)

The main attacker is **whoever sends a mail**; then **the network**, **a server the user didn't mean to
trust**, **other apps on the phone**, **someone holding an unlocked phone**, and **the release supply
chain**. For account setup this pass counts, as the calendar addendum did for CalDAV, **whoever answers
discovery**: the operator of the mail domain's website (which serves `/.well-known/autoconfig`), its DNS,
and anyone who can forge unsigned DNS answers on the network the phone or laptop is on.

## Findings

### CC-1 · Medium · Discovery could send a Microsoft or Google sign-in token to a server that only looks like the provider's

| Field | Content |
| --- | --- |
| Severity | Medium — CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:H/A:N (6.8) |
| Component | `crates/uwumail-core/src/autoconfig.rs` (`oauth_provider_for`, `parse_client_config`, `from_mx`, `from_srv`), `engine.rs` (`add_account`, `credential`), before 16050b4 |
| Attacker & preconditions | Whoever answers discovery for the address (see threat model); the mailbox is at Microsoft 365 or Google. For the network variant also CC-2's forged DNS. |
| Impact | A discovery answer decided both "sign in with Microsoft/Google" and which servers get the token. A host counted as Microsoft's when it merely *started* with `outlook.`, `hotmail.` or `live.`, so an autoconfig file (or an SRV record) naming `outlook.<their domain>` produced a real Microsoft sign-in whose access token then went to their server — a token that opens the mailbox at Microsoft (IMAP and SMTP) until it expires, and a fresh one on every later connection. The engine never checked the servers of an OAuth account, and setup hid them. It also accepted a plain connection for a token, and the setup page shows no cleartext warning for OAuth. The domain's own autoconfig file wins even over a verified Microsoft tenant (for hybrid setups), so the website operator of a company on Microsoft 365 was enough. |
| Evidence | Code review, local; the new unit test fed the look-alike file to the parser. |
| Fix | A server counts as the provider's only under a domain the provider owns (`oauth_provider_of_host`: `gmail.com`, `googlemail.com`, `google.com`; `outlook.com`, `hotmail.com`, `live.com`, `msn.com`, `office365.com`, `office.com`); the prefix rule stays for a mail address's own domain, which always gets Microsoft's fixed servers. `check_oauth_servers` refuses other servers and unencrypted connections before the browser opens, and again every time a token is used, so an account saved earlier stops sending tokens elsewhere. Real Microsoft and Google accounts are unaffected: their tokens only work on those servers anyway. |
| Regression test | `autoconfig::tests::only_the_providers_own_servers_get_a_sign_in`, `engine::tests::oauth_tokens_only_go_to_the_providers_servers` |

### CC-2 · Medium · Forged SRV records could point setup at any server, which then receives the password

| Field | Content |
| --- | --- |
| Severity | Medium — CVSS:3.1/AV:A/AC:H/PR:N/UI:R/S:U/C:H/I:H/A:N (6.4) |
| Component | `autoconfig.rs` (`from_srv`, `parse_client_config`), before 16050b4 |
| Attacker & preconditions | Someone who can forge DNS answers on the user's network while a mailbox is added (a hostile Wi-Fi), for a domain whose HTTPS lookups they can make fail. |
| Impact | RFC 6186 SRV records are plain DNS. Setup took their targets as the servers, on any site, and a certificate only proves the target's own name, so a server of the attacker's with a valid certificate for its own name passed every check and received the password (and, before CC-1, a token). Setup only named the IMAP host in its "found" line and kept the server settings folded away. Relatedly, an autoconfig file that listed a plain IMAP server before an encrypted one got the plain one used (a warning was shown). |
| Evidence | Code review, local. |
| Fix | An SRV target on another site than the address's own is not used (RFC 6186, section 6 asks for a check or the user's confirmation); setup then guesses and shows the servers it uses. Of the IMAP servers an autoconfig file lists, the most secure is taken, as it already was for SMTP. |
| Regression test | `autoconfig::tests::srv_answers_only_count_on_the_addresses_own_site`, `a_plain_connection_listed_first_is_not_taken` |

### CC-3 · Low · A local program could still hold up or end an OAuth sign-in

`oauth.rs` (`sign_in`, before f92a5b3). CVSS `AV:L/AC:L/PR:L/UI:R/S:U/C:N/I:N/A:L` (2.8). L2 made the
loopback listener ignore redirects with a wrong `state`, but it still handled one connection at a
time and read it without a time limit, and a failed read or accept ended the sign-in. Any program on
the device (another user's too) could connect and say nothing, or connect and reset, and the real
redirect was never read. Low, and the brief only lists Lows, but it is the unfinished part of an earlier
fix and was named for this pass, so it is fixed: every connection is answered in a task of its own with
ten seconds to send its request, and errors on one connection are ignored.
_Regression test:_ `oauth::tests::other_connections_neither_hold_up_nor_end_a_loopback_sign_in`.

### EG-1 · Medium · A `socks5://` privacy proxy let the device look up the sender's host names itself

| Field | Content |
| --- | --- |
| Severity | Medium — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:N/A:N (4.3) |
| Component | `crates/uwumail-core/src/tls.rs` (`set_privacy_proxy`), before f411ce0 |
| Attacker & preconditions | A mail sender whose tracking pictures use a host name made for one reader; the user set a SOCKS5 proxy the way the settings suggest (`socks5://…`). |
| Impact | The privacy proxy exists so the sender "at most sees the proxy". With `socks5://`, reqwest resolves the destination on this device before it hands the connection to the proxy (read in reqwest 0.13.5, `connect.rs`, `DnsResolve::Local`). The device's resolver then asks the sender's DNS server for the per-reader name: the sender learns that and when the mail was opened, and the resolver's address — with EDNS Client Subnet at a public resolver, part of the reader's own. |
| Evidence | Code review of UwUMail and reqwest, local. |
| Fix | A SOCKS5 proxy always resolves names itself: `socks5://` is used as `socks5h://`. Every SOCKS5 proxy in common use (Tor, `ssh -D`, VPN clients) supports that. |
| Regression test | `tls::tests::socks_proxies_look_up_names_themselves` |

### CS-1 · Medium · One platform's build could swap another platform's release file before signing

| Field | Content |
| --- | --- |
| Severity | Medium (release supply chain; needs a foothold in a platform-specific build dependency) |
| Component | `.github/workflows/release.yml` (`sign`, `publish`), `desktop.yml` (packing), before 5e40a7c |
| Impact | The signing job unpacked the macOS and Linux build tars into the folder that already held the Windows setups, overwriting, and nothing checked what a tar held. A compromised dependency of the Linux build could put a `UwUMail-windows-x64-setup.exe` into its tar, which was then signed for the updater and installed by every Windows copy. `publish` merged every `release-*` artifact of the run after the APK's certificate had been checked in another job. |
| Fix | Every artifact is downloaded by its exact name into a folder of its own; `scripts/release-files.mjs` checks that each holds exactly its own files, as plain files, fails on anything missing, extra or already present, and only then copies them. The builds pack only their own files by name. `publish` checks the APK's certificate again right before publishing. |
| Regression test | `scripts/release-files.test.mjs` (a Linux build carrying the Windows setup, a macOS build carrying a `.deb`, a build carrying a signature, a name already present, missing files, folders, links, unknown artifacts), run in CI (`node --test`). The workflows themselves only run for a tag; not run here. |

### CS-2 · Medium · The phone app lock hid the screen but not the keyboard or the screen reader

| Field | Content |
| --- | --- |
| Severity | Medium (someone holding the unlocked phone while UwUMail is locked) |
| Component | `apps/desktop/src/app/App.tsx`, `features/mobile/AppLock.tsx`, `lib/hotkeys.ts`, before 99a5ef0 |
| Impact | The lock was a cover over the still mounted app. TalkBack/VoiceOver could read the mail list behind it, and with a hardware keyboard the shortcuts (`j`/`k`, `e`, `#`, `!`, `c`, …) and Tab reached everything behind it. |
| Fix | Everything but the lock sits in a wrapper that is `inert` while locked (out of reach of focus, clicks and the accessibility tree; `display: contents`, so the layout is unchanged), and the shortcut handler does nothing while locked. |
| Regression test | `features/mobile/AppLock.test.tsx`. The screen-reader path was not tried on a device. |

### CS-3 · Medium · macOS: attachments never got the quarantine flag; macOS launcher files not on the dangerous list

| Field | Content |
| --- | --- |
| Severity | Medium (a mail sender; one attachment the user opens normally) |
| Component | `crates/uwumail-core/src/attachments.rs` (`mark_from_internet`, `DANGEROUS`), `apps/desktop/src/lib/attachments.ts`, before 3ac42ee |
| Impact | NM1 added Windows' Mark of the Web; the macOS counterpart was missing, so an app inside a `.zip` from a mail ran without Gatekeeper's check. `.terminal`, `.tool`, `.fileloc` and `.inetloc` were opened without the "can run programs" question. |
| Fix | On macOS, `mark_from_internet` sets `com.apple.quarantine` (download flag, not yet approved), which covers every existing call site (cache, Save, `.eml`). Not `LSFileQuarantineEnabled`, which would quarantine the downloaded update too. The four macOS types and `xlsb`, `ppsm`, `msu` are on both dangerous lists. Files cached earlier stay unmarked until downloaded again. |
| Regression test | `attachments::tests::extracts_and_caches_attachments` (quarantine attribute, macOS only), `recognizes_dangerous_files`, `lib/attachments.test.ts`. The macOS code was type-checked for `aarch64-apple-darwin` here but not run; CI runs the Rust tests on Linux only. |

### CC-7 · Medium · JMAP discovery could name any server, which then got the password and became trusted for calendars and contacts

| Field | Content |
| --- | --- |
| Severity | Medium — CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:H/A:N (6.8) |
| Component | `crates/uwumail-core/src/jmap.rs` (`discover`, `probe`), `engine/calendar_ops.rs` (`password_hosts`, also used by `engine/contacts_ops.rs`), before ed82072 |
| Attacker & preconditions | Whoever runs the mail domain's website (C-3's attacker), or can forge the `_jmap._tcp` SRV record; the mailbox signs in with a password. |
| Impact | Discovery asked `https://<domain>/.well-known/jmap` (and an SRV target) and followed every redirect, to any site and down to plain HTTP; wherever it landed with a login prompt became the JMAP address. Setup then preselects JMAP, so the first sign-in sent the password there. If the person picked IMAP instead, the address was stored anyway, and `password_hosts` trusted its whole site with the password for CalDAV and, since the contacts branch, CardDAV: a `/.well-known/caldav` or `/.well-known/carddav` redirect from the same website to that site then got the password as well. This is the C-3 rule ("discovery must not make the password go somewhere new") not holding for JMAP, and for IMAP mailboxes too. |
| Evidence | Code review, local. |
| Fix | Discovery only takes an HTTPS session address on the site of the IMAP or SMTP server it found (the hard-coded Fastmail entries aside). `password_hosts` counts the JMAP address only while the mailbox uses JMAP, when it is the mail server itself. A JMAP address typed in by hand is still used as typed. |
| Regression test | `jmap::tests::discovery_only_takes_a_session_on_the_mail_servers_site`, `calendar_ops::tests::only_the_mail_servers_get_the_password`, `an_unused_jmap_address_gets_no_password` (these ran in CI only, see "What was run") |

### CC-8 · Medium · One CardDAV address book could fill the memory

| Field | Content |
| --- | --- |
| Severity | Medium — CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:N/A:H (5.3) |
| Component | `crates/uwumail-core/src/contacts/carddav.rs` (`cards`), before a9166ba |
| Attacker & preconditions | A hostile CardDAV server, or anyone who can write to an address book the user sees (as for C-4). |
| Impact | Each multiget answer was limited to 16 MB, but an address book of 5,000 cards is read in 50 of them, all kept, turned into JSContact and cached, and every address book of an account is read at once. The read runs when the contacts open and for recipient suggestions while typing an address, so the app could be made to hold gigabytes, every time. |
| Evidence | Code review, local; the new hostile-server test serves 45 MB of cards. |
| Fix | Reading an address book stops once 16 MB of vCards (one listing's worth, as for a calendar) have arrived, with a warning in the log; the rest is left out. |
| Regression test | `tests/carddav_hostile.rs` `a_huge_address_book_is_read_only_so_far` (ran in CI only) |

The CardDAV client otherwise held up: discovery and every request go through the calendar's
`DavClient` (HTTPS only, the password only to trusted sites, redirects checked by hand, answers read
with a limit and the XML reader that refuses DOCTYPEs); card and book addresses are kept as paths and
joined onto the home's origin (`dav_url`), listings keep to the book, file names come from a filtered
uid, names sent to the server are XML-escaped, vCards nested deeper than four are skipped. In the
app, contact fields are React text, a photo is only shown as a `data:image/…` address (a link would
tell its site who looks; the app page's CSP would block it anyway), and phone links keep digits and
`+` only. `calcard`'s vCard parser was not fuzzed.

`FolderDialogs.test.tsx` › "creates a folder inside another one from its menu", flaky on `main`, was a
test problem: the first render of the file paid for everything that loads once (about 1.5 s against
0.5 s for the others) inside `findByRole`'s one second. The warm-up now happens in `beforeAll`
(52d9a16).

### Low findings

- **CC-9 · IMAP mailboxes added earlier keep the JMAP address discovery found** — stored for every
  password mailbox (`jmap_url`); since CC-7 it no longer counts for calendars or contacts, but
  Settings still offers to switch such a mailbox to JMAP, which signs in there with the password. For
  mailboxes added before CC-7 that address may be one only the domain's website named. It takes the
  person's own click. _Fix:_ offer the switch only for an address on the mail server's site, or ask
  again for it.
- **CC-10 · The password goes to any host on the mail server's registrable domain** — `dav::site`,
  `jmap::may_send_credentials`. Deliberate (`imap.example.org` and `dav.example.org`), but at a
  hoster that gives customers subdomains of its own mail domain without a public-suffix entry,
  another customer's subdomain counts as trusted once a discovery redirect points there. _Fix:_ none
  planned; a CalDAV/CardDAV address typed in by hand avoids discovery altogether.

- **CC-4 · The Microsoft loopback redirect names `localhost`, the listener only binds `127.0.0.1`** —
  `oauth.rs` (`redirect_host: "localhost"`, `TcpListener::bind(("127.0.0.1", 0))`). A browser may try
  `[::1]` first; another account on the same computer that binds `[::1]` on the same port receives the
  code. PKCE makes the code useless to it, so the effect is a failed sign-in. _Fix:_ also bind `[::1]`
  on the same port (best effort), or register and use `http://127.0.0.1`.
- **CC-5 · Setup shows the name from the domain's autoconfig file, not the servers it names** —
  `features/accounts/AccountSetup.tsx` ("found {providerName}"). The file comes from whoever runs the
  domain's website and may call itself "Microsoft 365" while it names a server of its own for the
  password. Like Thunderbird, UwUMail trusts that file; unlike Thunderbird, it doesn't show the servers.
  _Fix:_ show the IMAP host next to the name when the answer came from the domain's own file.
- **CS-4 · The native "can run programs" question has "Open anyway" as its default button** — as in the
  shell report; `lib.rs` `confirm_dangerous`, `desktop.rs`/`ios.rs` `confirm`. _Fix:_ the safe answer
  first, only `Custom(ok)` counts as yes.
- **UP-1 · After an update, the relaunched app keeps the setup's `TMPDIR` and
  `APPIMAGE_EXTRACT_AND_RUN`** — `updates.rs` `hand_over` sets both for the setup AppImage; the setup's
  `system_unix::command` removes the AppImage variables but not these two before it starts UwUMail
  again. The relaunched app then points `TMPDIR` at the updates folder, which it deletes on start. No
  shared folder is involved, so no attack; temporary files of that session fail. _Fix:_ pass the old
  `TMPDIR` along and restore it (and drop `APPIMAGE_EXTRACT_AND_RUN`) in the setup's `command()`.
- **EG-2 · `uwuimg:` passes a UwUMail server's content type through unchanged** — `engine.rs`
  `mail_image`, `jmap.rs` `remote_image`, `src-tauri/src/lib.rs` `remote_picture`. A server could answer
  `text/html`; the response also carries `Access-Control-Allow-Origin: *`. Nothing can navigate a frame
  or window to `uwuimg:` (`frame-src` and the sandboxed reader don't allow it), so there is no way to
  run it. _Fix:_ decide the type from the bytes as for pictures fetched here, and add
  `Content-Security-Policy: default-src 'none'` to the response.
- **EG-3 · Pictures from a UwUMail server are read whole, without a size limit** — `jmap.rs`
  `get_from_server` (`response.bytes()`); the local path stops at 10 MB. The C-14 class, from a server
  the account already trusts. _Fix:_ read in chunks up to the same limit.
- **EG-4 · The BIMI lookup for sender pictures bypasses the privacy proxy** — `pictures.rs` asks the
  device's resolver for `default._bimi.<domain>`. It tells the sender's DNS that someone at this
  resolver looks at mail from that domain, once per domain, not per reader. _Fix:_ skip BIMI while a
  proxy is set, or resolve over DNS-over-HTTPS through it.

### Informational

- **CC-6 · An autoconfig answer may pass through a plain-HTTP redirect** — `fetch_config` checks that
  the *final* address is HTTPS; a hop in between may be plain HTTP. It needs an HTTPS server that
  redirects to HTTP first. _Fix:_ a redirect policy that stops on any non-HTTPS hop.
- **CS-5 · The picture fetch checks the host by name only** — unchanged from the shell report and I6.
  Since a33860b the engine fetches every allowed remote picture, but before that the web view fetched the
  same addresses itself, with cookies; the engine refuses IP addresses and local names, so nothing got
  worse. The module comment claimed more than that and was corrected (cleanup, 7a4d783).
- **CS-6, CS-7, CS-8** — as in the shell report (`pkexec` by `PATH` and a swappable package before the
  root install; `main` APKs carry the release certificate; composer signatures inserted uncleaned). Not
  changed.
- **CS-9 · Any job of a release run can still replace another job's artifact before signing** — the
  artifact service lets every job of a run delete and re-upload an artifact by name
  (`upload-artifact`'s `overwrite`). CS-1's fix stops a build from smuggling files into its own
  artifact; replacing another job's whole artifact before `sign` downloads it is not covered. After
  signing a swap fails the signature check in `publish`, and the APK is checked again there. _Fix:_
  hash each file in the job that built it, pass the hashes as job outputs (outputs can't be changed by
  other jobs; this needs the matrix split into one job per platform) and compare before signing.
- **EG-5 · With a UwUMail server among the accounts, every account's senders go to it for pictures** —
  `engine.rs` `picture_server`. By design (the server fetches, the sender never sees the device), but the
  server of one account learns whom the other accounts hear from. Worth a sentence in the settings.
- **CC-11 · A JMAP session may name its API endpoints on another site** — `Session::parse` only
  refuses plain HTTP endpoints for an HTTPS session; the login then goes to whatever `apiUrl`,
  `downloadUrl` and `uploadUrl` name. The session comes from the server the mailbox signs in to,
  which has the password already, so this gives nothing new away. _Fix (hardening):_ require the
  endpoints on the session's site, as `get_from_server` does for pictures.
- **EG-6 · The proxy's login is kept and shown in plain text** — stored with the other local settings
  (not synced), shown in a normal text field; an `http://` proxy gets it unencrypted. Same-user or
  shoulder-surfing only.

### What held up

- **Where tokens go after the fix.** Tokens are only ever sent over IMAP and SMTP (`credential`), both
  checked; STARTTLS fails closed on both (IMAP errors when the server refuses it, lettre's
  `starttls_relay` requires TLS); certificates are checked by the system (Mozilla's roots on Android).
  PKCE, `state` and the app-link checks (L2, AL4) hold.
- **`uwuimg:`** — only reachable from the app's own pages; the reader frame's CSP allows it only once
  pictures are allowed for the mail, and without that allows no remote source at all. The request names
  an account and an `http(s)` address; the engine's own fetch refuses IP addresses, local names and
  logins in the URL, follows at most five redirects and re-checks each, reads at most 10 MB, sends a
  generic user agent and no referrer, and answers with a type decided from the bytes. A UwUMail server
  is only asked on the account's own site (`may_send_credentials`), with the account's own login.
- **Privacy proxy** — fails closed: requests wait up to 15 s for the app to name the proxy and then
  fail, a proxy that is set but down fails the request (no direct fallback), a stored address the
  engine refuses leaves pictures off. Setting a proxy turns off reqwest's system-proxy detection for
  those clients. The setting is not synced. Mail, calendars and updates don't use it.
- **CSP change** — the app page's `img-src` lost `https:` and `http:`; only `uwuimg:` was added. A
  tightening: quoted mail in the composer can't load remote pictures even if the cleaner missed one.
- **Update-check switch** — the loop waits until the app has said whether to check, so a stored "off"
  holds from the start; "Check now" still works; not a synced setting, so no server can switch updates
  off.

## Clean-ups done

- The CSP no longer allows the `uwuaddon:` frame source, which no code registers (9830e43).
- `pnpm release` no longer pushes feeds to the archived `UwUMail-Releases` repository (aa707f0).
- The mail-picture module says what its host check covers (7a4d783).

Not done: removing the unused JS dependencies (lockfile churn while another branch changes the
frontend), sharing `german()` with `background.rs` and merging the two `confirm` functions (both in
`src-tauri/src/lib.rs`, also changed by that branch; the second belongs with CS-4).

## What was run

`cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`
(Windows, `--test-threads=1`; the GreenMail/Stalwart integration tests skip without their servers and
run in CI), `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test` (two component tests timed out once while cargo was building next to them and passed on their own), `node --test
"scripts/*.test.mjs"`, and a type check of the macOS quarantine code for `aarch64-apple-darwin`.

For the second part (CC-7, CC-8) `cargo fmt --check` and `cargo clippy --workspace --all-targets --
-D warnings` ran here, which compiles the new tests; running them had to be left to CI, because the
shared disk had fallen below the limit for local builds.

## What could not be tested

- macOS (quarantine attribute, Gatekeeper, `.terminal`/`.fileloc` behaviour) — no Mac here.
- Android and iOS with a screen reader and a hardware keyboard — no device; the component test covers
  `inert` and the shortcuts.
- The release workflows — they only run for a tag; the file checks run as script tests.
- Real Microsoft and Google sign-ins and forged DNS — not contacted; reviewed and unit-tested.
