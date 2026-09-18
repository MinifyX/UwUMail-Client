#!/usr/bin/env bash
# Builds UwUMail for the iPhone and for the simulator, and packs the iPhone app
# into an .ipa.
#
# Nothing here is signed: UwUMail has no Apple developer account. Tauri hands
# the finished app to Xcode's exporter, which wants a certificate and stops —
# by then the app itself is built, and that unsigned app is what goes into the
# .ipa. A sideloading tool signs it with your own Apple ID on the way to the
# phone, see docs/ios.md.
#
# Usage: scripts/ios-build.sh <version> [output folder]
set -euo pipefail

version="$1"
out="${2:-out}"
gen="apps/desktop/src-tauri/gen/apple"

echo "--- tools ---"
command -v pnpm node cargo rustup
rustup target list --installed | grep apple-ios || true

# `tauri ios build` folds Info.ios.plist in on its own, but only into the app it
# exports; the generated project keeps its own copy, so the keys go in here too.
extra="apps/desktop/src-tauri/Info.ios.plist"
generated=$(find "$gen" -maxdepth 2 -name Info.plist | head -n 1)
if [ -f "$extra" ] && [ -n "$generated" ]; then
  /usr/libexec/PlistBuddy -c "Merge $extra" "$generated"
  echo "Merged $extra into $generated"
fi

# Where Xcode leaves the app, wherever Tauri told it to build.
find_app() {
  find "$HOME/Library/Developer/Xcode/DerivedData" "$gen/build" -type d -name '*.app' -path "*$1*" 2>/dev/null |
    head -n 1
}

mkdir -p "$out"

# The simulator build the smoke test starts afterwards.
pnpm tauri ios build --ci --target aarch64-sim
sim=$(find_app release-iphonesimulator)
test -n "$sim" || { echo "::error::The simulator build produced no app"; exit 1; }
rm -rf "$out/simulator"
mkdir -p "$out/simulator"
cp -R "$sim" "$out/simulator/"

# The iPhone itself. Exporting needs a certificate, so this is expected to stop
# short of an .ipa — the app it built on the way is the one we want.
pnpm tauri ios build --ci --target aarch64 ||
  echo "::notice::Tauri couldn't export a signed app, as expected; packing the unsigned one"
app=$(find_app release-iphoneos)
test -n "$app" || { echo "::error::The iPhone build produced no app"; exit 1; }
rm -rf "$RUNNER_TEMP/Payload"
mkdir -p "$RUNNER_TEMP/Payload"
cp -R "$app" "$RUNNER_TEMP/Payload/"
(cd "$RUNNER_TEMP" && zip -qry "unsigned.ipa" Payload)
mv "$RUNNER_TEMP/unsigned.ipa" "$out/UwUMail-$version-unsigned.ipa"
rm -rf "$RUNNER_TEMP/Payload"

# What ended up inside, so a missing Info.plist key shows in the log.
echo "--- Info.plist of $app ---"
plutil -p "$app/Info.plist" |
  grep -E "CFBundleIdentifier|CFBundleShortVersionString|CFBundleVersion|MinimumOSVersion|NSFaceIDUsageDescription|UIFileSharingEnabled|UIBackgroundModes" || true
ls -la "$out"
