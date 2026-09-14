# Security audit — UwUMail 0.2.0-beta.1

September 2026. Scope: the whole repository at the state of the `0.2.0-beta.1` release — the mail engine
(`crates/uwumail-core`), the desktop shell (`apps/desktop/src-tauri`), the UI (`apps/desktop/src`), the Windows
installer and updater (`apps/setup`, `updates.rs`), and the build and release pipeline including the public
`MinifyX/UwUMail-Releases` repository.

This report describes weaknesses and how they were fixed. It deliberately leaves out step-by-step reproduction.
To report a new issue, see [SECURITY.md](../SECURITY.md).

## Summary

| Severity | Found | Fixed | Accepted |
| --- | --- | --- | --- |
| High | 3 | 3 | 0 |
| Medium | 8 | 8 | 0 |
| Low | 10 | 10 | 0 |
| Informational | 11 | — | 11 |

All High, Medium and Low findings are fixed in 0.2.0-beta.1. The informational items are known limits of the
current design; they are listed with the reasoning so they can be revisited.

## Threat model

UwUMail's main attacker is **whoever sends a mail**: anyone can put arbitrary HTML, headers, attachments and links
in front of the user. Secondary attackers are **the network** (open Wi-Fi, a hostile DNS resolver), **a server
the user didn't mean to trust** (redirects, autoconfig answers, sender websites), and **the release supply chain**
(GitHub Actions, the update feed). Malware already running as the same Windows user is out of scope: it can read
the user's files and keychain regardless of UwUMail.

What an attacker wants: the account password or token, other mail, files on the computer, running code, or
confirmation that an address is read.

## How UwUMail is protected (unchanged strengths)

- **Mail HTML** is sanitized in Rust (ammonia, allow-list), then rendered in an iframe without script permission.
  Remote images are blocked until the user allows them per message or sender.
- **The app page** runs under a strict Content Security Policy (`script-src 'self'`, no `object`, no forms,
  `base-uri 'none'`) with a frozen JavaScript prototype.
- **Secrets** live in the OS keychain and are never written to the database, logs or the page's storage.
- **Tauri capabilities** limit what the page may call; file access goes through the engine, not the page.
- **TLS** certificates are always verified; there is no "accept invalid certificate" switch.
- **Updates** are signed with a minisign key that is not in the repository; the public key is compiled in.
- **OAuth** uses PKCE and a random `state`; client secrets are not treated as confidential.

## Findings

### High

**H1 — Attachment previews could run a disguised web page inside the app.** *Fixed.*
Previews load cached attachments through Tauri's asset protocol. When the file type couldn't be recognized, the
protocol served the file as a web page, and the PDF preview framed whatever it was given. An HTML file named like
a PDF could therefore run as a page inside UwUMail's window, in an origin that is allowed to read other cached
attachments.
Fix: the PDF preview first checks both the served content type and the PDF file signature and shows a plain
"not a PDF" message otherwise (`previews.tsx`, `looksLikePdf`). Images, audio and video only use elements that
never execute documents.

**H2 — "Save attachment" wrote to any path the page chose.** *Fixed.*
The save command accepted a destination path from the page. Any script that ever managed to run in the page
could have written attacker-controlled content anywhere the user can write, including the Startup folder.
Fix: the engine opens the native save dialog itself and only writes where the user picked (`save_attachment` in
`lib.rs`). The page-side dialog permission was removed from the capabilities.

**H3 — Sending mail could attach arbitrary local files.** *Fixed.*
Outgoing attachments could reference a file path. A compromised page could have mailed out any readable file,
for example browser profiles or SSH keys.
Fix: attachments are only accepted as data the user added in the composer; the path variant no longer exists
(`model.rs`, `smtp.rs`).

### Medium

**M1 — The warning for dangerous files lived only in the page.** *Fixed.*
Opening an executable attachment asked for confirmation in the UI, but the open command itself ran any file.
Fix: the engine shows a native Windows warning dialog before opening a dangerous file; the page can't skip it.
The red hint in the viewer stays.

**M2 — Quoted mail in replies and forwards bypassed the mail sandbox.** *Fixed.*
Replying put the original HTML into the composer, which is part of the app page. Styles from the mail leaked
into the app, remote tracking images loaded without asking, and HTML-to-text conversion parsed the mail in the
live document.
Fix: quoted HTML goes through a strict sanitizer (`lib/safeHtml.ts`) that removes remote content, styles, forms,
media, SVG and event handlers; plain text is produced from an inert document. The sanitized composer content is
cleaned again before sending.

**M3 — A waiting update was trusted from a user-writable file.** *Fixed.*
On start, UwUMail ran the setup named in `updates/pending.json`. Any program could have edited that file to start
something else under the "UwUMail update" label.
Fix: the setup path is fixed by version, and the release signature is verified again right before the file runs.
Each download gets one attempt (`updates.rs`).

**M4 — Update feeds could offer an older release as new.** *Fixed.*
Only the setup file is signed, not the version number in the feed. An altered feed could have announced an old,
validly signed setup as a newer version and rolled the app back.
Fix: in update mode the setup refuses to replace a newer installed version (`check_not_older` in `install.rs`).

**M5 — JMAP sign-in data could follow redirects to other servers.** *Fixed.*
Session discovery re-sent the password after redirects, including to another site or from HTTPS to HTTP, and
accepted HTTPS sessions that pointed at plain-HTTP endpoints.
Fix: credentials are only re-sent within the same site and never downgraded; an HTTPS session with non-HTTPS
endpoints is refused (`jmap.rs`, `may_send_credentials`).

**M6 — Links: nothing opened, and nothing warned about misleading ones.** *Fixed.*
The opener permission had no URL scope, so every link failed. At the same time there was no defence against the
classic phishing pattern of link text showing one address while the link goes elsewhere.
Fix: the opener is scoped to `https`, `http` and `mailto`. When the visible text names a different site than the
real target, Nyu asks first and shows both addresses; ordinary links open directly (`lib/links.ts`,
`LinkWarning.tsx`).

**M7 — DLL search order for a setup started from Downloads.** *Fixed.*
Windows looks for some DLLs next to the executable first. A setup started from the Downloads folder could load a
DLL that a website had dropped there earlier.
Fix: both executables are linked so imported system DLLs load from System32 only (`/DEPENDENTLOADFLAG`), and the
setup restricts runtime DLL loading to System32 before anything else happens.

**M8 — Release pipeline: unpinned actions, unprotected feed branch, broken hand-over.** *Fixed.*
Workflows referenced third-party actions by movable tags, the feed branch of the public releases repository could
be deleted or force-pushed, and the hand-over branch didn't contain the publishing workflow, so GitHub would never
have published a release.
Fix: every action is pinned to a full commit SHA; `main` of `UwUMail-Releases` is protected against deletion and
force-pushes by a ruleset; the hand-over branch now builds on `main`; the publishing workflow validates the
version and branch name before using them.

### Low

**L1 — Line breaks in names, subjects and message ids.** *Fixed.*
These values often come from received mail (replying copies them). A line break made the mail library panic, and
in message ids could have added header lines. Fix: header values are reduced to a single line, message ids to
their allowed characters (`smtp.rs`).

**L2 — Any local program could cancel an OAuth sign-in.** *Fixed.*
The loopback listener gave up on the first request with a wrong `state`. Fix: such requests are answered and
ignored; sign-in continues until the real redirect or the timeout (`oauth.rs`).

**L3 — The composer's "insert link" accepted script URLs.** *Fixed.* Only `https`, `http` and `mailto` targets
are accepted.

**L4 — Gaps in dangerous-file detection.** *Fixed.*
The list missed several Windows types (for example `.appref-ms`, `.settingcontent-ms`, `.library-ms`, `.xll`,
`.one`, web archives and HTML pages). Names with trailing dots or spaces and right-to-left override characters
could look harmless. Fix: extended list in engine and UI, invisible direction characters removed from displayed
names, trailing dots and spaces ignored for the check.

**L5 — The mail background wrapper was added after sanitizing.** *Fixed.* The wrapper that carries a mail's body
background is now built before sanitizing, so its attributes go through ammonia too (`mime.rs`).

**L6 — Attachment files outlived their account.** *Fixed.* Removing an account or switching its protocol now
deletes the cached attachment files of its messages (`engine.rs`).

**L7 — Sender pictures could reach into the local network.** *Fixed.*
A company website's icon links or redirects could point at `localhost`, IP addresses or local names, making
UwUMail send requests to devices on the user's network. Fix: pictures only load from HTTPS URLs with a public
domain name, redirects included (`pictures.rs`, `is_public_web_url`).

**L8 — Autoconfig accepted HTTP redirects and odd domains.** *Fixed.*
Server settings decide where the password goes, but an autoconfig answer could arrive after a redirect to plain
HTTP, and the address's domain went into lookup URLs unchecked. Fix: answers must arrive over HTTPS; the domain
must be a plain host name; the address is URL-encoded (`autoconfig.rs`).

**L9 — Unencrypted connections without a warning.** *Fixed.* Manual setup with "no encryption" or an `http://`
JMAP address still works (local test servers), but shows a clear warning that the password and mail travel
readable.

**L10 — No dependency audit.** *Fixed.* CI runs `cargo audit` and `pnpm audit --prod` on every push. The audit
found one advisory (RUSTSEC-2026-0285 in rustls), fixed by updating rustls to 0.23.45.

### Informational (accepted for now)

- **I1 — Local data isn't encrypted.** The mail cache, attachments and pictures are readable by the Windows user
  and anyone with access to the disk. Recommendation for users: device encryption (BitLocker / FileVault).
- **I2 — Keychain entries are readable by the same user.** This is how Windows Credential Manager, macOS Keychain
  and Secret Service work for unprivileged apps.
- **I3 — Executables aren't code-signed yet.** Windows SmartScreen warns on first download. Update integrity
  doesn't depend on this (minisign), but first-install integrity relies on downloading from the official
  releases page. Code signing is on the roadmap.
- **I4 — The install folder is writable by the user.** That is what installing without admin rights means; a
  same-user process could replace the executable. The same applies to the short window between verifying an
  update and starting it.
- **I5 — The update feed repository can be written by its deploy key and admins.** GitHub doesn't allow limiting
  pushes to GitHub Actions on repositories owned by a personal account. Signatures (M3) and the downgrade check
  (M4) keep a tampered feed from installing anything unsigned or older.
- **I6 — Sender pictures tell the sender's website that mail arrived.** At most once per domain per 30 days, from
  the user's IP address, not per message. A domain name that resolves to a private address isn't filtered. The
  feature can be turned off under Reading.
- **I7 — Autoconfig and MX lookups use the system resolver without DNSSEC**, and Thunderbird's ISPDB learns which
  domain is being set up. Settings come from HTTPS sources only; manual setup is always possible.
- **I8 — Notifications show sender and subject**, also on the lock screen if Windows is set to allow it.
- **I9 — Unmaintained transitive crates** (`unic-*`, `proc-macro-error`, `glib` on Linux) come in through Tauri's
  dependencies. None has a known vulnerability; they're tracked by `cargo audit` warnings.
- **I10 — The page can call every app command.** Script injection into the app page would mean full access to
  mail and sending. This is why mail content never runs in the app page (sandboxed frames, sanitizers, CSP), and
  why file access and warnings were moved into the engine (H2, H3, M1).
- **I11 — Addons aren't loaded yet.** The addon host is designed around sandboxed frames and permission checks
  ([addons.md](addons.md)); it needs its own review before it ships.

## Verification

- Unit tests for the fixes: link comparison, quoted-HTML sanitizing, credential forwarding, header line breaks,
  dangerous names, public picture URLs, autoconfig domains and update downgrades (`cargo test --workspace`,
  `pnpm test`).
- `cargo clippy -D warnings`, `cargo audit`, `pnpm audit --prod`: clean.
- The release setup was started with the DLL restrictions and went through install, update and uninstall in the
  test sandbox.
- The link warning was checked in the UI with a link whose text and target differ.

## Recommendations for later

1. Code signing for Windows and macOS (I3).
2. An opt-in encrypted local store, or at least encrypted attachment cache (I1).
3. Proxying sender pictures, or loading them only for senders the user has written to (I6).
4. A dedicated review of the addon host before it ships (I11).
5. Repeating this audit before 1.0 and after larger features (drafts on the server, multiple identities).
