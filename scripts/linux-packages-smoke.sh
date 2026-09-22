#!/usr/bin/env bash
# Tries the Linux packages on a throwaway Ubuntu runner: installs the .deb system-wide with apt,
# starts UwUMail from it and removes it again; checks what the .rpm declares (no rpm-based system
# here); unpacks the portable folder and starts UwUMail from it. The per-user setup AppImage has
# scripts/desktop-smoke.sh.
#
# Usage: scripts/linux-packages-smoke.sh <folder with the release files> <version> <evidence folder>
#
# Wants UwUMail-linux-<x64|arm64>.deb, .rpm and -portable.tar.gz for this runner's processor.
# Installs into /usr with sudo: only run it on a runner that is thrown away.
set -euo pipefail

files="$(cd "$1" && pwd)"
version="$2"
mkdir -p "$3"
evidence="$(cd "$3" && pwd)"

step() { echo; echo "▸ $*"; }
fail() { echo "::error::$*"; exit 1; }
check() { if ! eval "$1"; then fail "$2"; fi; echo "  ✓ $2"; }

case "$(uname -m)" in
  x86_64) label=x64 deb_arch=amd64 rpm_arch=x86_64 ;;
  aarch64) label=arm64 deb_arch=arm64 rpm_arch=aarch64 ;;
  *) fail "No UwUMail packages for $(uname -m)" ;;
esac
deb="$files/UwUMail-linux-$label.deb"
rpm="$files/UwUMail-linux-$label.rpm"
portable="$files/UwUMail-linux-$label-portable.tar.gz"
for file in "$deb" "$rpm" "$portable"; do test -f "$file" || fail "Missing $file"; done

# A home folder of our own for starting UwUMail, so nothing of the runner's user is touched.
export HOME="$(mktemp -d "${RUNNER_TEMP:-/tmp}/uwumail-home.XXXXXX")"
unset XDG_DATA_HOME XDG_CONFIG_HOME XDG_CACHE_HOME
data="$HOME/.local/share/app.uwumail.desktop"
# A session bus for the single-instance check, and a screen for the window.
gui() { dbus-run-session -- xvfb-run -a -s "-screen 0 1280x800x24" "$@"; }
# Whether a program runs from this file or folder (its name on the command line is short).
running_from() { local p; for p in /proc/[0-9]*; do [[ "$(readlink "$p/exe" 2>/dev/null)" == "$1"* ]] && return 0; done; return 1; }
stop_from() { local p; for p in /proc/[0-9]*; do [[ "$(readlink "$p/exe" 2>/dev/null)" == "$1"* ]] && kill "${p#/proc/}" 2>/dev/null; done; sleep 2; }

# Starts something in the background for a while and checks that it is still up.
still_running_after() {
  local seconds="$1" name="$2" log="$3"; shift 3
  "$@" >"$log" 2>&1 &
  local pid=$!
  sleep "$seconds"
  if ! kill -0 "$pid" 2>/dev/null; then
    cat "$log"
    fail "$name stopped within $seconds seconds"
  fi
  echo "  ✓ $name runs"
}

step "The .deb"
check '[ "$(dpkg-deb -f "$deb" Package)" = uwumail ]' "the package is called uwumail"
check '[ "$(dpkg-deb -f "$deb" Version)" = "$version" ]' "it is version $version"
check '[ "$(dpkg-deb -f "$deb" Architecture)" = "$deb_arch" ]' "it is built for $deb_arch"
check 'dpkg-deb -f "$deb" Depends | grep -q libwebkit2gtk-4.1-0' "it depends on WebKitGTK 4.1"
sudo apt-get install -y "$deb" > "$evidence/apt-install.log"
check '[ -x /usr/bin/uwumail-desktop ]' "UwUMail is in /usr/bin"
# What UwUMail asks before it updates itself through dpkg (owned_by_dpkg in updates.rs).
check 'grep -qx /usr/bin/uwumail-desktop /var/lib/dpkg/info/uwumail.list' "dpkg owns /usr/bin/uwumail-desktop"
entry=/usr/share/applications/uwumail.desktop
check 'desktop-file-validate "$entry"' "the menu entry is valid"
check 'grep -qx "Name=UwUMail" "$entry"' "the menu says UwUMail"
check 'grep -q "^MimeType=x-scheme-handler/mailto;" "$entry" && grep -q "^Exec=uwumail-desktop %u" "$entry"' "the menu entry takes mailto: links"
check 'ls /usr/share/icons/hicolor/*/apps/uwumail-desktop.png >/dev/null' "the icon is installed"

step "UwUMail starts from the .deb"
still_running_after 25 "UwUMail" "$evidence/deb-app.log" gui /usr/bin/uwumail-desktop
check '[ -d "$data" ]' "UwUMail created its data folder"
stop_from /usr/bin/uwumail-desktop

step "The .deb comes off again"
sudo apt-get remove -y uwumail > "$evidence/apt-remove.log"
check '[ ! -e /usr/bin/uwumail-desktop ] && [ ! -e "$entry" ]' "UwUMail is gone"

step "The .rpm"
command -v rpm >/dev/null || sudo apt-get install -y rpm > /dev/null
check '[ "$(rpm -qp --queryformat "%{NAME} %{VERSION} %{ARCH}" "$rpm" 2>/dev/null)" = "uwumail $version $rpm_arch" ]' "the package is uwumail $version for $rpm_arch"
rpm -qpl "$rpm" 2>/dev/null > "$evidence/rpm-files.txt"
check 'grep -qx /usr/bin/uwumail-desktop "$evidence/rpm-files.txt"' "it installs /usr/bin/uwumail-desktop"
check 'grep -qx /usr/share/applications/uwumail.desktop "$evidence/rpm-files.txt"' "it brings the menu entry"
check 'rpm -qpR "$rpm" 2>/dev/null | grep -q "libwebkit2gtk-4.1.so.0"' "it requires WebKitGTK 4.1"

step "The portable folder"
check '[ -z "$(tar -tzf "$portable" | grep -v "^UwUMail/")" ]' "everything is inside one folder UwUMail/"
mkdir "$HOME/portable"
tar -xzf "$portable" -C "$HOME/portable"
app="$HOME/portable/UwUMail"
check '[ -x "$app/AppRun" ] && [ -x "$app/uwumail" ] && [ -f "$app/README.txt" ]' "AppRun, the uwumail launcher and README.txt are there"
check '[ -z "$(find "$app" -perm -o+w -not -type l)" ]' "nothing in it is writable for others"
rm -rf "$data"
still_running_after 25 "UwUMail from the portable folder" "$evidence/portable-app.log" gui "$app/uwumail"
check 'running_from "$app/"' "UwUMail runs from the folder"
check '[ -d "$data" ]' "UwUMail created its data folder"
stop_from "$app/"

echo
echo "✧ The Linux packages work on $(uname -m)"
