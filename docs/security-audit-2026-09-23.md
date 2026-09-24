# Security audit — UwUMail client, 23 September 2026

A focused pass after the [September audit](security-audit-2026-09.md), on four areas: how account setup
decides where OAuth tokens and passwords go (server discovery together with the Microsoft and Google
sign-in), the app shells, release pipeline and updater (the review of `apps/desktop`, `apps/setup`,
`scripts/` and `.github/workflows/` at 502bb93), the Linux updater's AppImage hand-over, and the code
merged since 502bb93 by the egress work (a33860b: the `uwuimg:` picture scheme, the privacy proxy, the
CSP change and the update-check switch). JMAP discovery and the CalDAV password rules are left for a
second pass after the contacts branch is merged.

Done with Claude, like the passes before; not an independent firm. It leaves out step-by-step exploits.
To report something new see [SECURITY.md](../SECURITY.md).

## Summary

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| CC-1 | Medium | Discovery could send a Microsoft or Google sign-in token to a server that only looks like the provider's | fixed in 16050b4 |
| CC-2 | Medium | Forged SRV records could point setup at any server, which then receives the password | fixed in 16050b4 |
| CC-3 | Low | A local program could still hold up or end an OAuth sign-in (L2 only partly held) | fixed in f92a5b3 |
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
| CC-6 | Informational | An autoconfig answer may pass through a plain-HTTP redirect as long as it ends on HTTPS | listed |
| CS-5 | Informational | `fetch_mail_image`/`uwuimg:` check the host by name only (I6) | listed, comment corrected |
| CS-6 | Informational | `.deb`/`.rpm` self-update: `pkexec` by `PATH`, file checked before root installs it | listed |
| CS-7 | Informational | Android: every push to `main` is signed with the release key | listed |
| CS-8 | Informational | The composer inserts stored signature HTML without cleaning it | listed |
| CS-9 | Informational | Any job of a release run can still replace another job's artifact before signing | listed |
| EG-5 | Informational | With a UwUMail server among the accounts, every account's senders go to it for pictures | listed |
| EG-6 | Informational | The proxy's login is kept and shown in plain text | listed |

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

### Low findings

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

## What could not be tested

- macOS (quarantine attribute, Gatekeeper, `.terminal`/`.fileloc` behaviour) — no Mac here.
- Android and iOS with a screen reader and a hardware keyboard — no device; the component test covers
  `inert` and the shortcuts.
- The release workflows — they only run for a tag; the file checks run as script tests.
- Real Microsoft and Google sign-ins and forged DNS — not contacted; reviewed and unit-tested.
