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

| Severity | New | Fixed | Accepted / open |
| --- | --- | --- | --- |
| High | 0 | — | 0 |
| Medium | 1 | 0 | 1 open (R-1) |
| Low | 1 | 0 | 1 open (C-1) |
| Informational | 1 | — | 1 (C-2) |

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

### R-1 — The desktop update-signing key is exposed to third-party build scripts *(Medium, open)*

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

This is the desktop counterpart of the Android **AM4** finding, which was fixed by building the APK
unsigned and signing it in a separate step. On Android the signing key is only ever visible to
`apksigner`; on Windows the updater key is visible to the whole build. The window is smaller than it
looks — `pnpm install` runs in its own step *without* the key, so npm lifecycle scripts don't see it
— but Cargo `build.rs` scripts of every dependency run during `pnpm build:setup`, with the key in
their environment.

### C-1 — Quoted mail keeps layout styles in the composer *(Low, open)*

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

### C-2 — The desktop app does not restrict runtime DLL loading *(Informational)*

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

1. **R-1** — take the update-signing key out of the desktop build, as AM4 did for Android. This is
   the one that protects every future user, so do it before the next signed release.
2. **C-1** — strip layout styles from quoted mail (or sandbox the quote).
3. **C-2** — restrict runtime DLL loading in the desktop app too.
4. Re-run this audit when the addon host ships (I11) and when server-side drafts / multiple
   identities land.

## What could not be tested, and why

- **macOS and Linux packages** are workflow artifacts only, unsigned and without auto-update; not
  exercised here.
- **Real OAuth providers** (Microsoft, Google) were not contacted — out of scope by the rules. The
  flow was reviewed statically and against the redirect/PKCE/state logic.
- **A signed release build** was not produced (no signing key on this machine); R-1 is from code
  review, not from a built artifact.
- **The Android app** was reviewed from source; no APK was built or run on a device/emulator in this
  pass (the CI emulator smoke test still runs on every push).
