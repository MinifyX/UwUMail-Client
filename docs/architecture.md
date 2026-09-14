# Architecture

```
┌──────────────────────────── UwUMail desktop app ─────────────────────────────┐
│                                                                              │
│  WebView (React UI)                           Rust process (Tauri shell)     │
│  ┌────────────────────────────┐   commands    ┌───────────────────────────┐  │
│  │ Layouts: Simple / Pro      │ ────────────▶ │ apps/desktop/src-tauri    │  │
│  │ Mail, compose, settings    │ ◀──────────── │  commands.rs, events      │  │
│  │ Addon host                 │    events     └────────────┬──────────────┘  │
│  │  ┌──────────┐ ┌──────────┐ │                            │                 │
│  │  │ addon A  │ │ addon B  │ │ postMessage RPC            ▼                 │
│  │  │ sandbox  │ │ sandbox  │ │ (permission-checked) ┌───────────────────┐   │
│  │  └──────────┘ └──────────┘ │                      │ crates/uwumail-core│  │
│  └────────────────────────────┘                      │  accounts, sync,  │   │
│                                                      │  smtp, store, fts │   │
│                                                      └──┬──────────┬─────┘   │
└─────────────────────────────────────────────────────────┼──────────┼─────────┘
                                                          │          │
                                   OS keychain ◀──────────┘          ▼
                                   (passwords, tokens)        IMAP / SMTP servers
```

## Components

### `crates/uwumail-core` — the mail engine

Plain Rust library without any Tauri dependency, so it can be tested on its own
and reused (CLI, future sync server).

| Module | Responsibility |
| --- | --- |
| `autoconfig` | Find server settings from an address: Thunderbird ISPDB, the domain's own autoconfig, RFC 6186 SRV records, MX-based provider lookup, then educated guesses |
| `secrets` | Store passwords and OAuth refresh tokens in the OS keychain (`keyring`) |
| `oauth` | Authorization code flow with PKCE and a loopback redirect for Microsoft and Google |
| `imap` | Connect (TLS / STARTTLS), authenticate (LOGIN / XOAUTH2), list folders with special-use detection, sync, IDLE |
| `sync` | Per-account task: incremental header sync (CONDSTORE when available, otherwise UIDNEXT + flag window), body prefetch, change events |
| `smtp` | Send through submission (465 TLS / 587 STARTTLS), then store in the Sent folder |
| `mime` | Parse with `mail-parser`, build with `mail-builder`, sanitize HTML with `ammonia` |
| `threading` | Conversation grouping (Message-ID / In-Reply-To / References, Gmail thread IDs when present) |
| `store` | SQLite (WAL) with migrations and an FTS5 index for instant search |
| `contacts` | Address book fed by sent and received mail, later CardDAV |

The IMAP server is always the source of truth. The local store is a cache that
can be deleted at any time and rebuilt.

### `apps/desktop/src-tauri` — the shell

Thin layer that owns the app lifecycle: windows, tray, notifications, updater,
and the command/event bridge. Each Tauri command maps to one core function.
Long-running work (sync, IDLE) lives in core tasks that push events such as
`mail:changed` and `account:status` to the UI.

### `apps/desktop/src` — the UI

React 19, Vite, Tailwind CSS 4, TypeScript.

- `backend/` — one `Backend` interface with two implementations:
  `TauriBackend` (real engine) and `DemoBackend` (in-memory sample data).
  `pnpm dev` runs the UI in a normal browser on demo data, which keeps UI
  work fast and makes screenshots reproducible.
- `state/` — UI state (zustand) and persisted settings.
- `i18n/` — English and German strings. The tone setting is an i18next
  *context*: `inbox.empty_playful` overrides `inbox.empty` while the playful
  tone is active, and falls back to the neutral string otherwise.
- `features/` — mail list, reader, composer, onboarding, settings, addons.
- `addons/` — the addon host (sandbox frames, RPC, permission checks).

### Mail rendering

Message HTML is sanitized in Rust, then displayed in an `<iframe sandbox>`
without script permissions and with a CSP that blocks all remote content.
"Load remote images" re-renders with images allowed for that message or sender.

### Addons

See [addons.md](addons.md). In short: each addon runs in its own sandboxed
iframe with an opaque origin and no access to Tauri. It talks to the host over
`postMessage`; the host checks every call against the permissions the user
granted and forwards allowed calls to the backend. Network access goes through
the host too, limited to the hosts in the manifest.

## Data locations

| Data | Where |
| --- | --- |
| Mail cache, contacts, addon storage | `<app data>/uwumail.db` |
| Installed addons | `<app data>/addons/<addon id>/` |
| Passwords, OAuth refresh tokens | OS keychain, service `UwUMail` |
| UI settings | `<app data>/settings.json` |

`<app data>` is `%APPDATA%\UwUMail` on Windows,
`~/Library/Application Support/UwUMail` on macOS, `~/.local/share/uwumail` on Linux.

## Build and release

- Every push: typecheck, lint, unit tests, `cargo clippy`, `cargo test`
  (including integration tests against a GreenMail container).
- Every push to `main`: installers for Windows and Linux as workflow artifacts.
- Tags `vX.Y.Z`: installers for Windows, macOS and Linux on a GitHub release
  plus the updater manifest.
