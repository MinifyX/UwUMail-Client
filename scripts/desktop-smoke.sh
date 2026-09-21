#!/usr/bin/env bash
# Puts a freshly built macOS or Linux setup through its paces, in a throwaway
# home folder: install, start UwUMail, update over the running app, refuse an
# older version, uninstall. Also opens the setup window for a moment.
#
# Usage: scripts/desktop-smoke.sh <folder with the setup files> <version> <evidence folder>
#
# macOS wants UwUMail-Setup-<version>-macos-<arch>.dmg and UwUMail-Update-<version>-macos-<arch>;
# Linux wants UwUMail-Setup-<version>-x86_64.AppImage.
set -euo pipefail

files="$(cd "$1" && pwd)"
version="$2"
mkdir -p "$3"
evidence="$(cd "$3" && pwd)"
os="$(uname -s)"

step() { echo; echo "▸ $*"; }
fail() { echo "::error::$*"; exit 1; }
check() { if ! eval "$1"; then fail "$2"; fi; echo "  ✓ $2"; }

# A home folder of our own, so nothing of the runner's user is touched.
export HOME="$(mktemp -d "${RUNNER_TEMP:-/tmp}/uwumail-home.XXXXXX")"
unset XDG_DATA_HOME XDG_CONFIG_HOME XDG_CACHE_HOME
mkdir -p "$HOME/tmp"
echo "Home for this test: $HOME"

# Runs a command, but not for longer than the given seconds (macOS has no `timeout`).
limit() { local seconds="$1"; shift; perl -e 'alarm shift; exec @ARGV' "$seconds" "$@"; }

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
  echo "  ✓ $name runs" >&2
  echo "$pid"
}

if [ "$os" = "Darwin" ]; then
  arch_label=$([ "$(uname -m)" = "arm64" ] && echo apple-silicon || echo intel)
  dmg="$files/UwUMail-Setup-$version-macos-$arch_label.dmg"
  update="$files/UwUMail-Update-$version-macos-$arch_label"
  app="$HOME/Applications/UwUMail.app"
  agent="$HOME/Library/LaunchAgents/app.uwumail.autostart.plist"
  state="$HOME/Library/Application Support/app.uwumail.setup/setup.json"
  data="$HOME/Library/Application Support/app.uwumail.desktop"
  test -f "$dmg" || fail "Missing $dmg"
  test -f "$update" || fail "Missing $update"

  step "The disk image"
  mount="$(mktemp -d)"
  hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$dmg" >/dev/null
  trap 'hdiutil detach "$mount" -force >/dev/null 2>&1 || true' EXIT
  setup_app="$mount/UwUMail Setup.app"
  check '[ -d "$setup_app" ]' "the image holds UwUMail Setup.app"
  check 'codesign --verify --strict "$setup_app"' "the setup app carries a valid (ad-hoc) signature"
  setup="$(find "$setup_app/Contents/MacOS" -type f -perm -u+x | head -n 1)"
  check 'lipo -archs "$setup" | grep -qw "$(uname -m)"' "the setup is built for $(uname -m)"
  check 'codesign --verify --strict "$update"' "the update program carries a valid signature"
  check 'lipo -archs "$update" | grep -qw "$(uname -m)"' "the update program is built for $(uname -m)"

  step "Silent install from the disk image"
  limit 300 "$setup" --silent --autostart --default-mail-app
  check '[ -f "$app/Contents/Info.plist" ]' "UwUMail.app is in ~/Applications"
  check 'codesign --verify --strict "$app"' "UwUMail.app keeps its signature after unpacking"
  check '! xattr -p com.apple.quarantine "$app" >/dev/null 2>&1' "UwUMail.app carries no quarantine flag"
  check 'plutil -lint "$agent" >/dev/null' "the LaunchAgent is a valid plist"
  check 'grep -q -- "--autostart" "$agent"' "the LaunchAgent starts UwUMail hidden"
  check '[ "$(stat -f %Lp "$agent")" = 644 ]' "the LaunchAgent is writable only by the user"
  check '[ -z "$(find "$app" -perm -o+w)" ]' "nothing in the app is writable for others"
  check 'grep -q "\"version\": \"$version\"" "$state"' "the setup remembers version $version"
  check '/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0" "$app/Contents/Info.plist" | grep -qx mailto' "UwUMail declares mailto: links"
  program="$app/Contents/MacOS/$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$app/Contents/Info.plist")"

  step "UwUMail starts"
  still_running_after 20 "UwUMail" "$evidence/app.log" "$program" >/dev/null
  screencapture -x "$evidence/app.png" 2>/dev/null || true
  check '[ -d "$data" ]' "UwUMail created its data folder"

  step "Update over the running app"
  limit 300 "$update" --silent --update
  check '! pgrep -f "$app/Contents/MacOS/" >/dev/null' "the setup closed the running UwUMail"
  check 'codesign --verify --strict "$app"' "the updated app is intact"

  step "An older setup is refused"
  sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"99.0.0\"/" "$state"
  if limit 120 "$update" --silent --update; then fail "an older update replaced a newer UwUMail"; fi
  echo "  ✓ refused"
  check '[ -f "$app/Contents/Info.plist" ]' "UwUMail is still there"

  step "The setup window opens"
  still_running_after 12 "the setup window" "$evidence/setup.log" "$setup" >/dev/null
  screencapture -x "$evidence/setup.png" 2>/dev/null || true
  pkill -f "$setup_app/Contents/MacOS/" || true

  step "Uninstall"
  limit 120 "$update" --silent --uninstall --delete-data
  check '[ ! -e "$app" ]' "UwUMail.app is gone"
  check '[ ! -e "$agent" ]' "the LaunchAgent is gone"
  check '[ ! -e "$state" ]' "the setup's record is gone"
  check '[ ! -e "$data" ]' "mail data is deleted on request"
else
  setup="$files/UwUMail-Setup-$version-x86_64.AppImage"
  test -f "$setup" || fail "Missing $setup"
  chmod +x "$setup"
  base="$HOME/.local/share/uwumail"
  app="$base/app"
  entry="$HOME/.local/share/applications/uwumail.desktop"
  autostart="$HOME/.config/autostart/uwumail.desktop"
  data="$HOME/.local/share/app.uwumail.desktop"
  # No FUSE on the runner (nor on every desktop): the AppImage unpacks itself, into our own folder.
  export APPIMAGE_EXTRACT_AND_RUN=1 TMPDIR="$HOME/tmp"
  # A session bus for the single-instance check, and a screen for the windows.
  gui() { dbus-run-session -- xvfb-run -a -s "-screen 0 1280x800x24" "$@"; }

  step "Silent install"
  limit 300 "$setup" --silent --autostart --default-mail-app
  check '[ -x "$app/AppRun" ]' "the app is unpacked in ~/.local/share/uwumail/app"
  check '[ "$(stat -c %a "$base")" = 700 ]' "~/.local/share/uwumail is private"
  check '[ -z "$(find "$app" -perm -o+w -not -type l)" ]' "nothing in the app is writable for others"
  check '[ "$(readlink "$HOME/.local/bin/uwumail")" = "$app/AppRun" ]' "~/.local/bin/uwumail points at the app"
  check 'desktop-file-validate "$entry"' "the menu entry is valid"
  check 'grep -q "^MimeType=x-scheme-handler/mailto;" "$entry"' "the menu entry takes mailto: links"
  check 'desktop-file-validate "$autostart" && grep -q -- "--autostart" "$autostart"' "the autostart entry is valid"
  check 'ls "$HOME"/.local/share/icons/hicolor/*/apps/uwumail.png >/dev/null' "the icon is installed"
  check 'grep -q "^x-scheme-handler/mailto=uwumail.desktop;" "$HOME/.config/mimeapps.list"' "UwUMail is the mailto: handler"
  if command -v xdg-mime >/dev/null; then
    check '[ "$(xdg-mime query default x-scheme-handler/mailto)" = uwumail.desktop ]' "xdg-mime agrees"
  fi
  check 'grep -q "\"version\": \"$version\"" "$base/setup.json"' "the setup remembers version $version"
  echo "--- AppRun ---"; head -c 2000 "$app/AppRun" | cat -v | head -n 30

  step "UwUMail starts (through ~/.local/bin/uwumail)"
  still_running_after 25 "UwUMail" "$evidence/app.log" gui "$HOME/.local/bin/uwumail" >/dev/null
  check 'pgrep -f "$app/" >/dev/null' "UwUMail runs from the installed folder"
  check '[ -d "$data" ]' "UwUMail created its data folder"

  step "Update over the running app"
  limit 300 "$setup" --silent --update
  check '! pgrep -f "$app/" >/dev/null' "the setup closed the running UwUMail"
  check '[ -x "$app/AppRun" ]' "the updated app is in place"
  check '[ -z "$(find "$base" -maxdepth 1 -name ".app.*")" ]' "no leftovers next to the app"

  step "An older setup is refused"
  sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"99.0.0\"/" "$base/setup.json"
  if limit 120 "$setup" --silent --update; then fail "an older update replaced a newer UwUMail"; fi
  echo "  ✓ refused"
  check '[ -x "$app/AppRun" ]' "UwUMail is still there"

  step "The setup window opens"
  still_running_after 15 "the setup window" "$evidence/setup.log" gui "$setup" >/dev/null

  step "Uninstall"
  pkill -f "uwumail-setup" || true
  limit 120 "$setup" --silent --uninstall --delete-data
  check '[ ! -e "$base" ]' "~/.local/share/uwumail is gone"
  check '[ ! -e "$entry" ] && [ ! -e "$autostart" ]' "menu and autostart entries are gone"
  check '[ ! -e "$HOME/.local/bin/uwumail" ]' "~/.local/bin/uwumail is gone"
  check '! grep -q uwumail "$HOME/.config/mimeapps.list"' "mailto: is handed back"
  check '[ -z "$(ls "$HOME"/.local/share/icons/hicolor/*/apps/uwumail.png 2>/dev/null)" ]' "the icon is gone"
  check '[ ! -e "$data" ]' "mail data is deleted on request"
fi

echo
echo "✧ The setup works on $os ($(uname -m))"
