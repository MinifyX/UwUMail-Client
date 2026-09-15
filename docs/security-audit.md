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

---

# Addendum — the Android app and changes after 0.2.0-beta.1

September 2026, after the first Android APK. Scope: everything added since the audit above — the Android app
(`apps/desktop/src-tauri/gen/android`, the JNI bridge and engine host in `crates/uwumail-android`, `android.rs`),
the phone UI (`features/mobile`, app lock, share and `mailto:` handling), the shared TLS setup
(`uwumail_core::tls`), server search and the offline window, remote-image trust per sender, and the Android build
in CI.

## Summary

| Severity | Found | Fixed | Accepted |
| --- | --- | --- | --- |
| Medium | 4 | 4 | 0 |
| Low | 8 | 8 | 0 |
| Informational | 8 | — | 8 |

## Threat model additions

On a phone two more attackers matter: **other apps on the same phone**, which can send UwUMail shares, links and
intents, and **someone holding the unlocked phone**, which is what the optional app lock is for. A phone that is
rooted or already runs malware with elevated rights is out of scope.

## Findings

### Medium

**AM1 — The app lock could be passed through open dialogs and switched off without unlocking.** *Fixed.*
Dialogs use the browser's modal `<dialog>`, which is drawn above every other element, the lock screen included.
A dialog that was open when the lock kicked in (settings, the attachment viewer) stayed usable on top of it, and
Settings turned the lock off without asking. A native yes/no question left open in the background could also be
answered past the lock.
Fix: while locked, dialogs close and reopen after unlocking (`state/lock.ts`, `Dialog.tsx`). Turning the lock off
or choosing a longer delay asks for fingerprint, face or PIN first. Native questions count as "no" when UwUMail
goes to the background. The phone's own unlock screen no longer re-locks UwUMail when it returns.

**AM2 — Sharing to UwUMail could attach UwUMail's own private files.** *Fixed.*
UwUMail reads shared files with its own permissions. A share pointing at a `file://` path or at UwUMail's own file
provider would have put the mail cache or saved attachments into a new draft, one tap away from being sent.
Fix: only `content://` files offered by other apps are accepted (`Launch.kt`).

**AM3 — App packages from mail went straight to the installer.** *Fixed.*
APK files weren't on the dangerous list, and the type claimed in the mail decided which app opened an attachment,
so an app package could also arrive named like a PDF.
Fix: on Android, app packages (`apk`, `apks`, `apkm`, `xapk`, `aab`) from mail are never opened; they can only be
saved to Downloads, and the viewer explains why. The engine refuses them by name and by type (`check_openable`),
and Android picks the app from the file name, never from the mail's claim alone (`Files.kt`). On every platform
they are now marked as dangerous.

**AM4 — The signing key was present while third-party build code ran.** *Fixed.*
CI decoded the Android signing key before the build, so every npm, Cargo and Gradle build script could have read
it. Whoever holds the key can publish an APK that installs over UwUMail.
Fix: the APK is built unsigned; a separate step signs it with Android's own tools, removes the key right away and
checks that the certificate matches UwUMail's pinned fingerprint.

### Low

**AL1 — Notifications showed who wrote and what about, with the app lock on too.** *Fixed.* With the app lock on,
notifications only say that new mail arrived and in which mailbox. All mail notifications carry a neutral version
for secure lock screens that hide sensitive content.

**AL2 — Recents showed the last screen although the app lock was on.** *Fixed.* With the app lock on, Recents
shows an empty card (Android 13 and newer). Screenshots stay allowed.

**AL3 — "Archive" worked from the lock screen.** *Fixed.* It asks to unlock the phone first; "Mark as read" still
works directly.

**AL4 — Other apps could open UwUMail at a message of their choosing.** *Fixed.* Only UwUMail's own notifications
carry a random token that opening a message requires.

**AL5 — Shared files were copied without a size limit.** *Fixed.* Copying stops at 25 MB per file, and all shared
files together have to fit that limit too, so a share can't fill storage or memory.

**AL6 — Attachment names with line breaks could reword the warning dialog.** *Fixed.* Control characters are
removed from names for display and storage, including in the "can run programs" dialog. Names that are only dots
fall back to "attachment" on Android.

**AL7 — Line breaks in a server search could end the IMAP command.** *Fixed.* Control characters in search text
become spaces before quoting (`imap.rs`).

**AL8 — Build and update supply chain.** *Fixed.* An unused certificate-check library that Gradle fetched as
`latest.release` is gone; the Gradle distribution is pinned by checksum and CI validates the checked-in wrapper
jar; the Android update client only follows HTTPS.

### Informational (accepted for now)

- **AI1 — Certificates on Android** are checked against Mozilla's root list (`uwumail_core::tls`). Certificate
  authorities installed on the phone by the user aren't trusted, and there is no revocation check.
- **AI2 — Passwords can be decrypted while the phone is locked.** Background push needs them to reconnect. They
  are encrypted with a key in the Android Keystore; app data sits in the app sandbox under Android's file-based
  encryption and is excluded from backups and device transfers.
- **AI3 — The app lock protects the screen, not the engine.** Mail keeps syncing and notifications keep arriving;
  "Mark as read" works from a notification. The lock is only as strong as the phone's fingerprint, face or PIN.
- **AI4 — Hiding the Recents preview needs Android 13.** Older phones (Android 10–12) still show it.
- **AI5 — The WebView's IPC bridge is visible to every frame.** Tauri only accepts calls carrying the key that the
  main page gets, and mail frames can't run scripts. This matters for the addon review (I11).
- **AI6 — APKs are installed by hand for now.** Integrity of updates rests on Android's rule that an update must
  carry the same signing certificate; the key backup outside CI has to live in a password manager.
- **AI7 — Remote-image trust follows the From address,** which a sender can forge. The worst case is loaded remote
  images for that mail (tracking), not running code.
- **AI8 — Shared files UwUMail may read anyway** (for example its own saves in Downloads) can still be attached by
  another app's share. The draft shows every attachment and nothing is sent without the user.

## Verification

- New unit tests: control characters in names, app packages (engine and UI), IMAP search quoting and the share size
  budget. `cargo clippy -D warnings`, `cargo test`, `pnpm test`, `cargo audit` and `pnpm audit --prod`: clean.
- In the UI, dialogs were checked to close while locked and to come back after unlocking.
- The Android CI builds, signs and checks the certificate, and the emulator test starts the app, the background
  service, HTTPS and the relaunch after swiping UwUMail away.

## Recommendations for later

1. Trust remote images only for senders whose domain authenticated the mail (DMARC pass) (AI7).
2. An opt-in to trust user-installed certificate authorities, for self-hosted servers (AI1).
3. When background push is off, bind the Keystore key to the unlocked phone (AI2).
4. Include the Android IPC bridge in the addon host review (AI5, I11).
