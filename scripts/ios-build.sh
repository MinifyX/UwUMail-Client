#!/usr/bin/env bash
# Builds UwUMail for the iPhone and for the simulator from the Xcode project
# `tauri ios init` generated, and packs the app into an .ipa.
#
# Nothing here is signed: UwUMail has no Apple developer account, so the IPA
# carries no certificate and iOS won't install it as it is. A sideloading tool
# (Sideloadly, AltStore) signs it with your own Apple ID on the way to the
# phone — see docs/ios-sideload.md.
#
# Usage: scripts/ios-build.sh <version> [output folder]
set -euo pipefail

version="$1"
out="${2:-out}"
gen="apps/desktop/src-tauri/gen/apple"

project=$(find "$gen" -maxdepth 1 -name '*.xcodeproj' | head -n 1)
test -n "$project" || { echo "::error::No Xcode project in $gen — did 'tauri ios init' run?"; exit 1; }

list=$(xcodebuild -list -json -project "$project")
echo "$list"
# cargo-mobile2 names the schemes "<app>_iOS" and lowercases the configurations.
scheme=$(node -e 'const l=JSON.parse(process.argv[1]).project;
  const s=l.schemes.find(n=>/_iOS$/.test(n))??l.schemes[0];
  if(!s){console.error("no scheme");process.exit(1)}console.log(s)' "$list")
configuration=$(node -e 'const l=JSON.parse(process.argv[1]).project;
  const c=l.configurations.find(n=>/^release$/i.test(n))??l.configurations[0];
  console.log(c)' "$list")
echo "Building scheme $scheme ($configuration)"

mkdir -p "$out"

# Xcode keeps what a script build phase printed in its own compressed log, not
# in the output above; without this a failing Rust build says nothing at all.
dump_script_log() {
  local derived="$1" log
  log=$(ls -t "$derived"/Logs/Build/*.xcactivitylog 2>/dev/null | head -n 1)
  [ -n "$log" ] || return 0
  echo "--- what the build phases printed ---"
  gunzip -c "$log" | tr '\r' '\n' | strings | tail -n 200
}

build() {
  local sdk="$1" destination="$2" derived="$3"
  xcodebuild build \
    -project "$project" \
    -scheme "$scheme" \
    -configuration "$configuration" \
    -sdk "$sdk" \
    -destination "$destination" \
    -derivedDataPath "$derived" \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY="" \
    CODE_SIGN_ENTITLEMENTS="" \
    ENABLE_USER_SCRIPT_SANDBOXING=NO ||
    { dump_script_log "$derived"; return 1; }
}

echo "--- tools ---"
command -v pnpm node cargo rustup
rustup target list --installed

# The iPhone itself: arm64, packed as an .ipa the way iOS expects it.
build iphoneos 'generic/platform=iOS' "$RUNNER_TEMP/ios-device"
app=$(find "$RUNNER_TEMP/ios-device/Build/Products" -maxdepth 2 -name '*.app' | head -n 1)
test -n "$app" || { echo "::error::The iPhone build produced no app"; exit 1; }
rm -rf "$RUNNER_TEMP/Payload"
mkdir -p "$RUNNER_TEMP/Payload"
cp -R "$app" "$RUNNER_TEMP/Payload/"
(cd "$RUNNER_TEMP" && zip -qry "unsigned.ipa" Payload)
mv "$RUNNER_TEMP/unsigned.ipa" "$out/UwUMail-$version-unsigned.ipa"
rm -rf "$RUNNER_TEMP/Payload"

# The simulator build the smoke test starts afterwards.
build iphonesimulator 'generic/platform=iOS Simulator' "$RUNNER_TEMP/ios-sim"
sim=$(find "$RUNNER_TEMP/ios-sim/Build/Products" -maxdepth 2 -name '*.app' | head -n 1)
test -n "$sim" || { echo "::error::The simulator build produced no app"; exit 1; }
rm -rf "$out/simulator"
mkdir -p "$out/simulator"
cp -R "$sim" "$out/simulator/"

# What ended up inside, so a missing Info.plist key shows in the log.
plist="$app/Info.plist"
echo "--- Info.plist ---"
plutil -p "$plist" | grep -E "CFBundleIdentifier|CFBundleShortVersionString|CFBundleVersion|MinimumOSVersion|NSFaceIDUsageDescription|UIFileSharingEnabled|UIBackgroundModes" || true
ls -la "$out"
