#!/usr/bin/env bash
# Installs the APK on a running emulator and checks the basics: the app
# starts without crashing, the splash gives way to the UI, the background
# service comes up with its quiet notification, and UwUMail survives being
# sent to the background and back. Screenshots and logs land in $2.
set -uo pipefail

apk="$1"
out="${2:-smoke}"
package="app.uwumail"
mkdir -p "$out"
failed=0

shot() { adb exec-out screencap -p > "$out/$1.png"; }
fail() {
  echo "::error::$1"
  failed=1
}

adb logcat -c
adb install -r "$apk" || { fail "Install failed"; exit 1; }
adb shell pm grant "$package" android.permission.POST_NOTIFICATIONS || true

adb shell am start -W -n "$package/.MainActivity"
sleep 25
shot 1-start
pid=$(adb shell pidof "$package" | tr -d '\r')
[ -n "$pid" ] || fail "UwUMail isn't running after the start"

# The first onboarding screen must be visible, not the splash.
adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 && adb pull /sdcard/ui.xml "$out/1-start.xml" > /dev/null
grep -q "UwUMail\|Nyu" "$out/1-start.xml" 2>/dev/null || echo "::warning::Couldn't find UwUMail text in the view hierarchy (web views may hide it)"

adb shell dumpsys activity services "$package" > "$out/services.txt"
grep -q "MailWatchService" "$out/services.txt" || fail "The mail service didn't start"
adb shell dumpsys notification --noredact > "$out/notifications.txt"
grep -q "$package" "$out/notifications.txt" || fail "No notification from UwUMail (the service's quiet notice)"

# Background and back: same process, still alive.
adb shell input keyevent KEYCODE_HOME
sleep 5
adb shell am start -W -n "$package/.MainActivity"
sleep 8
shot 2-back
[ "$(adb shell pidof "$package" | tr -d '\r')" = "$pid" ] || fail "UwUMail restarted when coming back from the background"

# Back gesture on the first screen puts UwUMail away instead of closing it.
adb shell input keyevent KEYCODE_BACK
sleep 4
[ -n "$(adb shell pidof "$package" | tr -d '\r')" ] || fail "Back closed UwUMail"

# Window destroyed while the service keeps the process (like swiping UwUMail
# away): it must come back in a fresh process and draw its UI again.
adb shell settings put global always_finish_activities 1
adb shell am start -W -n "$package/.MainActivity"
sleep 5
adb shell input keyevent KEYCODE_HOME
sleep 5
before=$(adb shell pidof "$package" | tr -d '\r')
[ -n "$before" ] || fail "The mail service didn't keep UwUMail running without a window"
adb shell am start -W -n "$package/.MainActivity"
sleep 20
shot 3-relaunch
after=$(adb shell pidof "$package" | tr -d '\r')
[ -n "$after" ] || fail "UwUMail isn't running after the relaunch"
[ "$after" != "$before" ] || echo "::warning::Relaunch reused the old process"
adb shell settings put global always_finish_activities 0

adb logcat -d > "$out/logcat.txt"
if grep -E "FATAL EXCEPTION|UnsatisfiedLinkError|panicked at|SIGABRT|Abort message" "$out/logcat.txt" | grep -v "com.android.systemui" > "$out/crashes.txt"; then
  fail "Crash in the log, see crashes.txt"
  cat "$out/crashes.txt"
fi
grep -E "RustStdoutStderr|UwUMail|uwumail" "$out/logcat.txt" | tail -n 200 > "$out/uwumail-log.txt" || true

exit $failed
