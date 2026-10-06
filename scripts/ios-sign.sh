#!/usr/bin/env bash
# Signs the unsigned iPhone build (scripts/ios-build.sh) for the App Store and
# packs it into an .ipa App Store Connect takes.
#
# The build itself stays unsigned and holds no secret; this runs afterwards, on
# a runner that built nothing (ios.yml, job `testflight`). The same split as the
# Mac App Store build (scripts/build-mas.mjs --sign). docs/app-store.md.
#
# What changes on the way: CFBundleVersion becomes the build number
# (BUILD_NUMBER) — App Store Connect refuses one it has seen for this version —
# and the privacy manifest is put in if the build left it out.
#
# Usage: scripts/ios-sign.sh <unsigned.ipa> <profiles folder> <signed.ipa>
#   The profiles folder holds app.uwumail.mobileprovision
#   (node scripts/asc.mjs profiles ios …).
# Environment: APPLE_TEAM_ID, APPLE_SIGNING_IDENTITY (the "Apple Distribution"
# certificate, in a keychain codesign can reach), BUILD_NUMBER.
set -euo pipefail

ipa="$1"
profiles="$2"
signed="$3"
team="${APPLE_TEAM_ID:?APPLE_TEAM_ID is not set}"
identity="${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY is not set}"
build="${BUILD_NUMBER:?BUILD_NUMBER is not set}"
src="$(cd "$(dirname "$0")/.." && pwd)/apps/desktop/src-tauri"
id="app.uwumail"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
unzip -q "$ipa" -d "$work"
app=$(find "$work/Payload" -maxdepth 1 -name '*.app' | head -n 1)
test -n "$app" || { echo "::error::No app in $ipa"; exit 1; }

info="$app/Info.plist"
actual=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$info")
[ "$actual" = "$id" ] || { echo "::error::The app is $actual, not $id"; exit 1; }
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build" "$info"
# The background refresh must be declared, or iOS ends the app the moment it registers it.
/usr/libexec/PlistBuddy -c "Print :BGTaskSchedulerPermittedIdentifiers" "$info" >/dev/null ||
  { echo "::error::BGTaskSchedulerPermittedIdentifiers is missing"; exit 1; }
test -f "$app/PrivacyInfo.xcprivacy" || cp "$src/apple/PrivacyInfo.xcprivacy" "$app/"

# The entitlements: what the profile allows, each named in full. No App Group, no Keychain
# sharing, no push: notifications are local and the Keychain items are the app's own.
cat >"$work/app.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>application-identifier</key><string>$team.$id</string>
<key>com.apple.developer.team-identifier</key><string>$team</string>
<key>keychain-access-groups</key><array><string>$team.$id</string></array>
<key>get-task-allow</key><false/>
<key>beta-reports-active</key><true/>
</dict></plist>
PLIST
plutil -lint "$work/app.plist" >/dev/null

cp "$profiles/$id.mobileprovision" "$app/embedded.mobileprovision"

# Inside out: whatever code the app carries besides its own program, then the app, whose
# signature seals the rest.
sign() { codesign --force --timestamp=none --generate-entitlement-der --sign "$identity" "$@"; }
find "$app" \( -name '*.framework' -o -name '*.dylib' \) -print0 |
  while IFS= read -r -d '' nested; do sign "$nested"; done
sign --entitlements "$work/app.plist" "$app"

codesign --verify --deep --strict --verbose=2 "$app"
echo "--- entitlements of $(basename "$app") ---"
codesign -d --entitlements - --xml "$app" | plutil -p - 2>/dev/null || true
plutil -p "$info" | grep -E 'CFBundleIdentifier|CFBundleShortVersionString|CFBundleVersion|MinimumOSVersion|UIDeviceFamily' || true

mkdir -p "$(dirname "$signed")"
rm -f "$signed"
(cd "$work" && zip -qry signed.ipa Payload)
mv "$work/signed.ipa" "$signed"
echo "Signed: $signed"
