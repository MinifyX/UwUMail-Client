<p align="center">
  <img src="brand/uwumail-app-icon.svg" width="112" alt="UwUMail logo" />
</p>

<h1 align="center">UwUMail</h1>

<p align="center">
  The mail client I build for myself, because every other one annoyed me. (◕‿◕✿)<br/>
  IMAP · SMTP · JMAP · Windows · macOS · Linux · Android · iOS
</p>

---

## Why this exists

I'm building UwUMail for myself. Every mail client and self-hosted mail server I
tried annoyed me in one way or another, so I started building my own, the way I
want it. The server half lives in
[UwUMail Server](https://github.com/MinifyX/UwUMail-Server).

- **Just for fun.** No company, no team, no schedule, no promises. I work on it
  when I have time and feel like it, so don't expect steady development, and
  don't be surprised by long breaks.
- **Written with AI.** Almost all of the code is written with Claude, because
  I'm honestly not a great programmer. Not your thing? No hard feelings, just
  pick something else.
- **Use it, fork it, do what you want with it.** The license only asks one
  thing: if you pass on a changed version, its source stays open too.
- **No support.** Issues and pull requests are okay, but I might answer late or
  not at all, and I mostly build what I need myself.

## What it is

UwUMail is an open-source mail app that works with any IMAP/SMTP mailbox and
speaks JMAP with servers that offer it (tested with Stalwart and UwUMail
Server). It's what I wanted from a mail client:

- **Simple or Pro.** Switch between a calm two-column layout and a dense
  three-column layout with keyboard shortcuts, any time.
- **All your mailboxes.** Add as many accounts as you like and read them in one
  unified inbox. Setup needs only your address and password.
- **Fast and offline.** Mail is cached locally with full-text search in
  milliseconds.
- **Private by default.** No telemetry, remote images blocked until you allow
  them, passwords stored in your operating system's keychain.
- **Playful.** UwUMail talks to you with a wink by default. Prefer it plain?
  Settings → Tone → Neutral.
- **Extensible, one day.** Addons are meant to add things like snooze, PGP,
  templates, calendars or AI helpers, and to touch only what you allowed. The
  SDK exists, the addon host doesn't yet.

> **Status:** beta. It works, but expect rough edges and things that change.
> The [roadmap](docs/roadmap.md) shows what's done and what I'd like to do next.

## Download

Everything is on the
[releases page](https://github.com/MinifyX/UwUMail-Client/releases). I mostly
use it on Windows and Android; the other builds are tested automatically on
GitHub's machines, not by me every day.

| System | File |
| --- | --- |
| Windows (x64) | `UwUMail-windows-x64-setup.exe` |
| Windows on ARM | `UwUMail-windows-arm64-setup.exe` |
| macOS (Intel & Apple chip) | `UwUMail-macos-universal.dmg` |
| Ubuntu / Debian | `UwUMail-linux-x64.deb` · ARM: `UwUMail-linux-arm64.deb` |
| Fedora / openSUSE | `UwUMail-linux-x64.rpm` · ARM: `UwUMail-linux-arm64.rpm` |
| Arch Linux | AUR: `yay -S uwumail-bin` |
| Linux portable | `UwUMail-linux-x64-portable.tar.gz` · ARM: `UwUMail-linux-arm64-portable.tar.gz` |
| Android | `UwUMail-android.apk` |
| iPhone | `UwUMail-ios.ipa`, sideload only |

The names stay the same from release to release, so
`https://github.com/MinifyX/UwUMail-Client/releases/latest/download/<file>`
always gets the newest one.

On Windows and macOS the setup installs just for you, without an
administrator password, and UwUMail keeps itself up to date after that. On
Linux the .deb and .rpm install for everyone and update themselves too (asking
for the administrator password); the AUR package updates with pacman, and the
portable folder doesn't update at all. The Mac build isn't signed by Apple, so
macOS wants one extra click the first time. That, the Linux details and how to
uninstall are in [docs/install.md](docs/install.md). The iPhone build is unsigned and has to be
sideloaded; how that works, and what iOS doesn't allow, is in
[docs/ios.md](docs/ios.md).

## Project layout

| Path | What lives there |
| --- | --- |
| `apps/desktop` | The Tauri 2 app for desktop, Android and iOS (React UI + Rust shell) |
| `apps/setup` | UwUMail's own installer, updater and uninstaller for Windows, macOS and Linux |
| `crates/uwumail-core` | Mail engine: accounts, IMAP and JMAP sync, sending, local store, search |
| `crates/uwumail-android` | Android side of the engine: background service, keystore, notifications |
| `packages/addon-sdk` | `@uwumail/addon-sdk` — types and runtime for addon authors (MIT) |
| `addons/` | Official example addons |
| `brand/` | Logo and icon sources |
| `docs/` | Vision, architecture, addon API, design system |
| `release-notes/` | "What's new" texts per version |

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

- [Vision](docs/vision.md) — what I want UwUMail to be and what it will never do
- [Installing](docs/install.md) — the setup on each system, first start on a Mac, updates, uninstalling
- [Architecture](docs/architecture.md) — how the pieces fit together
- [Addons](docs/addons.md) — manifest, permissions and the addon API
- [Design](docs/design.md) — colors, type, tone of voice
- [Roadmap](docs/roadmap.md) — my wish list, without dates
- [Contributing](CONTRIBUTING.md) — worth a look before you open an issue or a pull request
- [Security](SECURITY.md)

## License

UwUMail is free software under the [GNU GPL v3.0](LICENSE): use it, change it,
fork it, share it. If you pass on a changed version, its source has to stay
open too. The addon SDK in `packages/addon-sdk` is
[MIT-licensed](packages/addon-sdk/LICENSE), so addon authors can pick any
license they like.
