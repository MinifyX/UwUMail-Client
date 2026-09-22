# Installing UwUMail

Every release on the [releases page](https://github.com/MinifyX/UwUMail-Client/releases)
carries a download for each system I build for. The names stay the same from
release to release, so
`https://github.com/MinifyX/UwUMail-Client/releases/latest/download/<file>`
always gets the newest one. On Windows and macOS it is the same little setup
app with Nyu: one click, no administrator password, and it keeps UwUMail up to
date afterwards. On Linux UwUMail comes as a package for your distribution.

| System | File | Where UwUMail goes |
| --- | --- | --- |
| Windows 10/11 (x64) | `UwUMail-windows-x64-setup.exe` | `%LOCALAPPDATA%\Programs\UwUMail` (changeable) |
| Windows 11 on ARM | `UwUMail-windows-arm64-setup.exe` | `%LOCALAPPDATA%\Programs\UwUMail` (changeable) |
| macOS (Intel & Apple chip) | `UwUMail-macos-universal.dmg` | `~/Applications/UwUMail.app` |
| Ubuntu / Debian | `UwUMail-linux-x64.deb` · ARM: `UwUMail-linux-arm64.deb` | `/usr` (for everyone) |
| Fedora / openSUSE | `UwUMail-linux-x64.rpm` · ARM: `UwUMail-linux-arm64.rpm` | `/usr` (for everyone) |
| Arch Linux | AUR: `yay -S uwumail-bin` | `/usr` (for everyone) |
| Linux portable | `UwUMail-linux-x64-portable.tar.gz` · ARM: `UwUMail-linux-arm64-portable.tar.gz` | wherever you unpack it |
| Android | `UwUMail-android.apk` | see the Android section of the [roadmap](roadmap.md) |
| iPhone | `UwUMail-ios.ipa` | sideload only (AltStore or Sideloadly), see [ios.md](ios.md) |

The Mac setup is universal: the same file for Apple chips and Intel Macs.

Not sure which Windows PC you have? Settings → System → About, "System type":
"ARM-based processor" takes the `arm64` setup, "x64-based processor" the
other one. The x64 setup also runs on an ARM PC, through Windows' emulation,
just slower; that UwUMail keeps updating itself as x64. To switch, run the
`arm64` setup over it: mail and settings stay.

Each release also lists the SHA-256 checksum of every file in
`SHA256SUMS.txt`. To check a download, compare it with what your system
prints: `sha256sum <file>` on Linux, `shasum -a 256 <file>` on macOS,
`Get-FileHash <file>` in PowerShell on Windows.

The `UwUMail-update-…` files next to them are what UwUMail downloads for its
updates on a Mac and in the older Linux install (see below); you don't need
them.

## Options

"Options" in the setup (Windows, macOS, and the old Linux setup) shows what else it can do. Everything is off unless you
switch it on, and the next update remembers your choice.

- **Start with the computer.** UwUMail starts quietly in the tray (Windows),
  the menu bar (macOS) or in the background (Linux).
- **Default mail app.** `mailto:` links open UwUMail. How much the setup can do
  depends on the system:
  - Windows asks once in its default apps page, which the setup opens.
  - macOS may ask you to confirm, or quietly keep the old app. If Mail still
    opens, pick UwUMail in Mail › Settings › General › Default email reader.
  - Linux (old setup): it sets it in `~/.config/mimeapps.list` and with `xdg-mime`.
    Desktops with their own settings page may show it there too.
- **Desktop shortcut** (Windows only) and **folder** (Windows only; macOS and
  Linux have one fixed place for a user's apps). The setup closes the folder
  it installs into to other accounts on the PC: only you, the system and
  administrators get in, also when it lies outside your user folder, say
  right under `C:\`. Drives without permissions (FAT, some network shares)
  can't do that.

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

## Linux

**Ubuntu, Debian and relatives:** install the `.deb` with your software center,
or in a terminal:

```bash
sudo apt install ./UwUMail-linux-x64.deb      # ARM: UwUMail-linux-arm64.deb
```

**Fedora, openSUSE:** `sudo dnf install ./UwUMail-linux-x64.rpm` (or
`sudo zypper install ./UwUMail-linux-x64.rpm`; ARM: `…-arm64.rpm`).

Both install UwUMail for every account on the computer, as the package
`uwumail` (the program is `/usr/bin/uwumail-desktop`, the menu entry says
UwUMail). They update themselves: when a new version is ready, "Restart now"
installs it with `pkexec`, which asks for an administrator's password. Remove
it with `sudo apt remove uwumail` or `sudo dnf remove uwumail`.

**Arch Linux:** `yay -S uwumail-bin` (or any other AUR helper). The package is
made from the `.deb` of each release. pacman keeps it up to date; UwUMail
doesn't try to update it itself.

**Portable:** unpack `UwUMail-linux-x64-portable.tar.gz` (ARM: `…-arm64-…`)
anywhere and start `./UwUMail/uwumail`. Nothing gets installed, and this copy
never updates itself; download the newest one again when you like.

**Installed with the older UwUMail setup?** Releases up to 0.3.0-beta.2 had a
setup AppImage for Linux that installed UwUMail just for you, in
`~/.local/share/uwumail`. That copy keeps updating itself as before: every
release still carries its setup as `UwUMail-update-linux-x64.AppImage`. To move
to the package, uninstall the old copy (below) and install the `.deb` or
`.rpm`; mail and settings stay where they are.

The old setup adds a menu entry, an icon, `~/.local/bin/uwumail` (if nothing
else is called that) and, when asked for, `~/.config/autostart/uwumail.desktop`.
The installed UwUMail is unpacked and never needs FUSE. The setup itself is an
AppImage, which usually mounts itself with FUSE; if it does nothing or says it
needs FUSE, start it from a terminal like this:

```bash
chmod +x UwUMail-update-linux-x64.AppImage
mkdir -p ~/.cache/uwumail-setup && chmod 700 ~/.cache/uwumail-setup
TMPDIR=~/.cache/uwumail-setup ./UwUMail-update-linux-x64.AppImage --appimage-extract-and-run
```

`--appimage-extract-and-run` unpacks the setup into the temporary folder
first. `TMPDIR` points it at a folder of your own instead of the shared
`/tmp`, where other accounts on the same computer could get in the way.

## Updates

UwUMail looks for a new version 20 seconds after it starts and every six hours
after that, in the Stable or Beta channel (Settings → Updates). It downloads
the update quietly, checks its signature against the key built into UwUMail,
and shows Nyu's hint. "Restart now" installs it right away; on Windows and
macOS (and with the old Linux setup) it otherwise happens at the next start.
A `.deb` or `.rpm` waits for "Restart now", because it asks for the
administrator password.

On macOS and Linux only a UwUMail the setup or the package manager installed
updates itself. A copy started from somewhere else (a folder you dragged it
to, the portable folder, a build of your own) leaves updating to you, and so
does the AUR package, which pacman updates.

The setup never replaces a newer UwUMail with an older one, even if an older
setup carries a valid signature. UwUMail itself only takes an update whose
signature names that version's file, so a feed can't pass off an older update
as a newer one either.

## Uninstalling

- **Windows:** Settings → Apps → Installed apps → UwUMail → Uninstall.
- **macOS, and Linux with the old setup:** open the setup again (the one you
  downloaded, or the one from any newer release: `UwUMail-macos-universal.dmg`,
  or `UwUMail-update-linux-x64.AppImage` on Linux), click **Options**, then
  **Uninstall UwUMail**.
- **Linux packages:** `sudo apt remove uwumail`, `sudo dnf remove uwumail` or
  `sudo pacman -R uwumail-bin`. Your mail and settings stay in your home folder
  (`~/.local/share/app.uwumail.desktop`); delete that folder to remove them too.

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
([scripts/desktop-smoke.sh](../scripts/desktop-smoke.sh); the Linux packages
have [scripts/linux-packages-smoke.sh](../scripts/linux-packages-smoke.sh)), and the Windows
setups for x64 and ARM ([scripts/windows-smoke.ps1](../scripts/windows-smoke.ps1),
the x64 one in the [release workflow](../.github/workflows/release.yml)). On
Windows the setup is a windowed program: in PowerShell, wait for it with
`Start-Process -Wait`.
