#!/usr/bin/env bash
# Starts the simulator build and checks the basics: UwUMail comes up, the mail
# engine starts, the web view draws its first screen and nothing crashes.
# Screenshots and logs land in $2.
#
# Usage: scripts/ios-smoke.sh <UwUMail.app> [output folder]
set -uo pipefail

app="$1"
out="${2:-smoke}"
bundle="app.uwumail"
mkdir -p "$out"
failed=0

fail() {
  echo "::error::$1"
  failed=1
}

# The newest iPhone the runner has a runtime for.
device=$(xcrun simctl list devices available -j | node -e '
  let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
    const { devices } = JSON.parse(raw);
    const version = (key) => (key.match(/iOS-(\d+)-(\d+)/) ?? []).slice(1).map(Number);
    const runtimes = Object.keys(devices)
      .filter((key) => key.includes("iOS") && devices[key].some((d) => d.name.includes("iPhone")))
      .sort((a, b) => {
        const [aMajor = 0, aMinor = 0] = version(a);
        const [bMajor = 0, bMinor = 0] = version(b);
        return aMajor - bMajor || aMinor - bMinor;
      });
    const runtime = runtimes.at(-1);
    if (!runtime) { console.error("no iOS runtime with an iPhone"); process.exit(1); }
    const phone = devices[runtime].find((d) => d.name.includes("iPhone"));
    console.error(`${phone.name} on ${runtime}`);
    console.log(phone.udid);
  });
')
[ -n "$device" ] || { fail "No iPhone simulator on this runner"; exit 1; }

xcrun simctl boot "$device" 2>/dev/null
xcrun simctl bootstatus "$device" -b > /dev/null
xcrun simctl install "$device" "$app" || { fail "Install failed"; exit 1; }
trap 'xcrun simctl shutdown "$device" 2>/dev/null' EXIT

# Everything UwUMail prints goes to the system log; there is no terminal to
# hand it to (--console-pty needs a TTY, which CI has not).
xcrun simctl spawn "$device" log stream --style compact --predicate 'processImagePath CONTAINS "UwUMail"' \
  > "$out/console.txt" 2>&1 &
logger=$!
trap 'kill "$logger" 2>/dev/null; xcrun simctl shutdown "$device" 2>/dev/null' EXIT

xcrun simctl launch "$device" "$bundle" > "$out/launch.txt" 2>&1 || { fail "UwUMail didn't start"; exit 1; }

# The first start unpacks the web view, sets up the database and draws Nyu.
container=$(xcrun simctl get_app_container "$device" "$bundle" data 2>/dev/null)
for _ in $(seq 1 30); do
  sleep 2
  [ -n "$container" ] && [ -n "$(find "$container" -name uwumail.db 2>/dev/null)" ] && break
done
xcrun simctl io "$device" screenshot "$out/1-start.png" > /dev/null 2>&1

# The engine opened its database: it is running, not just linked in.
if [ -n "$container" ] && [ -n "$(find "$container" -name uwumail.db 2>/dev/null)" ]; then
  echo "The mail engine opened its database"
else
  fail "The mail engine didn't start (no uwumail.db in the app's data)"
fi

[ -s "$out/1-start.png" ] || fail "No screenshot of the running app"

# The web view ran and its JavaScript stored the settings: WebKit left its data
# behind. A warning, not a failure — it is a hint, not a promise.
if [ -n "$container" ] && [ -n "$(find "$container" -path '*WebKit*' -type f 2>/dev/null | head -n 1)" ]; then
  echo "The web view left its data behind"
else
  echo "::warning::No WebKit data — the web view may not have drawn anything (see the screenshot)"
fi

# Still alive after the start, not quietly gone.
# Simulator apps are processes of the Mac; newer runtimes don't list them in the
# simulator's launchctl any more, so either place counts.
if xcrun simctl spawn "$device" launchctl list 2>/dev/null | grep -q "$bundle" \
  || pgrep -f "/$(basename "$app")/" > /dev/null; then
  echo "UwUMail is still running"
else
  fail "UwUMail isn't running any more"
fi

if grep -Ei "panicked at|fatal error|Abort trap" "$out/console.txt" > "$out/crashes.txt" 2>/dev/null; then
  fail "Crash in the log, see crashes.txt"
  cat "$out/crashes.txt"
fi

# Dark mode, for the eyes and for the screenshot in the artifact.
xcrun simctl ui "$device" appearance dark > /dev/null 2>&1
sleep 4
xcrun simctl io "$device" screenshot "$out/2-dark.png" > /dev/null 2>&1

cp ~/Library/Logs/DiagnosticReports/*.ips "$out/" 2>/dev/null
tail -n 200 "$out/console.txt" > "$out/uwumail-log.txt" 2>/dev/null

exit $failed
