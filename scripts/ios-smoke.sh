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
xcrun simctl bootstatus "$device" -b || { fail "The simulator didn't boot"; exit 1; }
xcrun simctl install "$device" "$app" || { fail "Install failed"; exit 1; }

# --console-pty keeps running as long as UwUMail does, so it goes to the background.
xcrun simctl launch --console-pty "$device" "$bundle" > "$out/console.txt" 2>&1 &
console=$!
trap 'kill "$console" 2>/dev/null; xcrun simctl shutdown "$device" 2>/dev/null' EXIT

# The first start unpacks the web view, sets up the database and draws Nyu.
for _ in $(seq 1 30); do
  sleep 2
  grep -q "UwUMail: ui ready" "$out/console.txt" && break
done
xcrun simctl io "$device" screenshot "$out/1-start.png" > /dev/null 2>&1

grep -q "UwUMail: engine running" "$out/console.txt" || fail "The mail engine didn't start (see console.txt)"
grep -q "UwUMail: ui ready" "$out/console.txt" || fail "The web view never drew its first screen (see console.txt)"

# Still alive after the start, not quietly gone.
xcrun simctl spawn "$device" launchctl list 2>/dev/null | grep -q "$bundle" || fail "UwUMail isn't running any more"

if grep -Ei "panicked at|fatal error|Abort trap|Crash" "$out/console.txt" > "$out/crashes.txt"; then
  fail "Crash in the log, see crashes.txt"
  cat "$out/crashes.txt"
fi

# Dark mode, for the eyes and for the screenshot Lorin gets in the artifact.
xcrun simctl ui "$device" appearance dark > /dev/null 2>&1
sleep 4
xcrun simctl io "$device" screenshot "$out/2-dark.png" > /dev/null 2>&1

cp ~/Library/Logs/DiagnosticReports/*.ips "$out/" 2>/dev/null
tail -n 200 "$out/console.txt" > "$out/uwumail-log.txt"

exit $failed
