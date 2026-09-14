<p align="center">
  <img src="brand/uwumail-app-icon.svg" width="112" alt="UwUMail logo" />
</p>

<h1 align="center">UwUMail</h1>

<p align="center">
  The cute, modern mail client for everyone. (◕‿◕✿)<br/>
  IMAP · SMTP · JMAP · Addons · Windows · macOS · Linux
</p>

---

UwUMail is an open-source desktop mail client that works with any IMAP/SMTP
mailbox, and speaks JMAP with servers that offer it (Fastmail, Stalwart,
Cyrus). It is built for people who want it simple, for people who want
everything in one place, and for everyone in between:

- **Simple or Pro.** Switch between a calm two-column layout and a dense
  three-column layout with keyboard shortcuts, any time.
- **All your mailboxes.** Add as many accounts as you like and read them in one
  unified inbox. Setup needs only your address and password (or a Microsoft /
  Google sign-in).
- **Fast and offline.** Mail is cached locally with full-text search in
  milliseconds.
- **Private by default.** No telemetry, remote images blocked until you allow
  them, passwords stored in your operating system's keychain.
- **Extensible.** Addons add features — snooze, PGP, templates, calendars, AI
  helpers — and can only touch what you allowed them to.
- **Playful.** UwUMail talks to you with a wink by default. Prefer it plain?
  Settings → Tone → Neutral.

> **Status:** early development, not yet usable for daily mail. See the
> [roadmap](docs/roadmap.md).

## Project layout

| Path | What lives there |
| --- | --- |
| `apps/desktop` | The Tauri 2 desktop app (React UI + Rust shell) |
| `crates/uwumail-core` | Mail engine: accounts, IMAP and JMAP sync, sending, local store, search |
| `packages/addon-sdk` | `@uwumail/addon-sdk` — types and runtime for addon authors (MIT) |
| `addons/` | Official example addons |
| `brand/` | Logo and icon sources |
| `docs/` | Vision, architecture, addon API, design system |

## Development

Requirements:

- Node.js 24 and pnpm 11 (`corepack enable`)
- Rust stable (via [rustup](https://rustup.rs))
- Platform prerequisites for Tauri: see
  [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)
  (Windows: Visual Studio C++ Build Tools and WebView2)

```bash
pnpm install
pnpm tauri dev        # desktop app with the real mail engine
pnpm dev              # UI only, in the browser, with demo data
```

Checks:

```bash
pnpm typecheck && pnpm lint && pnpm test
cargo fmt --check && cargo clippy --all-targets && cargo test
```

Integration tests talk to a local test mail server:

```bash
docker compose -f dev/mailserver.compose.yml up -d
```

## Documentation

- [Vision](docs/vision.md) — who UwUMail is for and what it will never do
- [Architecture](docs/architecture.md) — how the pieces fit together
- [Addons](docs/addons.md) — manifest, permissions and the addon API
- [Design](docs/design.md) — colors, type, tone of voice
- [Roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md)

## License

UwUMail is free software under the [GNU GPL v3.0](LICENSE).
The addon SDK in `packages/addon-sdk` is [MIT-licensed](packages/addon-sdk/LICENSE),
so addon authors can pick any license they like.
