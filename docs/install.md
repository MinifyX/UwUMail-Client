# Installing UwUMail

Every release on the [releases page](https://github.com/MinifyX/UwUMail-Client/releases)
carries a setup for each system I build for. On Windows, macOS and Linux it is
the same little setup app with Nyu: one click, no administrator password, and
it keeps UwUMail up to date afterwards.

| System | File | Where UwUMail goes |
| --- | --- | --- |
| Windows 10/11 (x64) | `UwUMail-Setup-<version>.exe` | `%LOCALAPPDATA%\Programs\UwUMail` (changeable) |
| macOS, Apple chip (M1 and later) | `UwUMail-Setup-<version>-macos-apple-silicon.dmg` | `~/Applications/UwUMail.app` |
| macOS, Intel | `UwUMail-Setup-<version>-macos-intel.dmg` | `~/Applications/UwUMail.app` |
| Linux (x86_64) | `UwUMail-Setup-<version>-x86_64.AppImage` | `~/.local/share/uwumail` |
| Android | `UwUMail-<version>-<build>.apk` | see the Android section of the [roadmap](roadmap.md) |
| iPhone | `UwUMail-<version>-unsigned.ipa` | sideload only, see [ios.md](ios.md) |

Not sure which Mac you have? Apple menu → About This Mac: "Chip: Apple M…"
means Apple chip, "Processor: Intel" means Intel.

The `UwUMail-Update-…` files next to them are what UwUMail on a Mac downloads
for its updates; you don't need them.

## Options

"Options" in the setup shows what else it can do. Everything is off unless you
switch it on, and the next update remembers your choice.

- **Start with the computer.** UwUMail starts quietly in the tray (Windows),
  the menu bar (macOS) or in the background (Linux).
- **Default mail app.** `mailto:` links open UwUMail. How much the setup can do
  depends on the system:
  - Windows asks once in its default apps page, which the setup opens.
  - macOS may ask you to confirm, or quietly keep the old app. If Mail still
    opens, pick UwUMail in Mail › Settings › General › Default email reader.
  - Linux: the setup sets it in `~/.config/mimeapps.list` and with `xdg-mime`.
    Desktops with their own settings page may show it there too.
- **Desktop shortcut** (Windows only) and **folder** (Windows only; macOS and
  Linux have one fixed place for a user's apps).

## macOS: the first start

UwUMail has no Apple developer ID (that costs 99 $ a year, for an app I build
for myself). Both apps are signed "ad hoc", which Apple chips need to run them
at all, but not notarized. So macOS blocks the setup the first time:

1. Open the `.dmg` and double-click **UwUMail Setup**. macOS says it can't
   check the app for malicious software. Click **Done** (or **OK**).
2. Open **System Settings → Privacy & Security**, scroll down, and click
   **Open Anyway** next to "UwUMail Setup was blocked". Confirm with your
   password or Touch ID.
3. The setup opens. From here on it installs UwUMail into `~/Applications`.

Only the setup should need this. The setup unpacks UwUMail itself, so the
installed app doesn't carry the "downloaded from the internet" mark, and
neither do the updates UwUMail downloads on its own. (I check that on GitHub's
Macs; I haven't tried it on a real Mac yet.)

When autostart is on, macOS shows a note that UwUMail added a background item
(it's a LaunchAgent in `~/Library/LaunchAgents/app.uwumail.autostart.plist`).
You can switch it off in System Settings → General → Login Items.

## Linux: FUSE, or not

An AppImage usually mounts itself with FUSE. If double-clicking the setup does
nothing, or it says it needs FUSE, start it once from a terminal like this:

```bash
chmod +x UwUMail-Setup-*-x86_64.AppImage
./UwUMail-Setup-*-x86_64.AppImage --appimage-extract-and-run
```

The installed UwUMail itself is unpacked and never needs FUSE. The setup adds a
menu entry, an icon, `~/.local/bin/uwumail` (if nothing else is called that)
and, when asked for, `~/.config/autostart/uwumail.desktop`.

## Updates

UwUMail looks for a new version 20 seconds after it starts and every six hours
after that, in the Stable or Beta channel (Settings → Updates). It downloads
the new setup quietly, checks its signature against the key built into
UwUMail, and shows Nyu's hint. "Restart now" installs it right away; otherwise
it happens at the next start.

On macOS and Linux only the UwUMail the setup installed updates itself. A copy
started from somewhere else (a folder you dragged it to, a build of your own)
leaves updating to you.

The setup never replaces a newer UwUMail with an older one, even if an older
setup carries a valid signature.

## Uninstalling

- **Windows:** Settings → Apps → Installed apps → UwUMail → Uninstall.
- **macOS and Linux:** open the setup again (the one you downloaded, or the one
  from any newer release), click **Options**, then **Uninstall UwUMail**.

The setup asks whether to keep your mail and settings. If you don't keep them,
it also deletes the saved passwords: from the Windows credential store, the
macOS login keychain, or on Linux from the Secret Service when `secret-tool`
is installed.

On macOS, dragging UwUMail.app to the trash works too, but leaves the
autostart entry and your data behind.

## For scripts

The setup also works without a window:

```bash
UwUMail-Setup --silent [--autostart] [--default-mail-app]   # install or reinstall
UwUMail-Setup --silent --update                             # update, never to an older version
UwUMail-Setup --silent --uninstall [--delete-data]          # remove
```

On a Mac the program is `UwUMail Setup.app/Contents/MacOS/uwumail-setup`. The
[desktop workflow](../.github/workflows/desktop.yml) uses exactly this to test
every macOS and Linux setup on GitHub's runners
([scripts/desktop-smoke.sh](../scripts/desktop-smoke.sh)).
