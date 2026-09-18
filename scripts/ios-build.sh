#!/usr/bin/env bash
# Builds UwUMail for the simulator and for the iPhone, and packs the iPhone app
# into an .ipa.
#
# Nothing here is signed: UwUMail has no Apple developer account. Tauri's own
# build refuses to start for a real iPhone without one ("requires a development
# team"), so that half goes straight to xcodebuild with signing switched off.
# A sideloading tool signs the .ipa with your own Apple ID on the way to the
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

mkdir -p "$out"

# The simulator build, which the smoke test starts afterwards. Tauri does this
# one itself: the simulator needs no certificate.
pnpm tauri ios build --ci --target aarch64-sim
sim=$(find "$gen/build" "$HOME/Library/Developer/Xcode/DerivedData" -type d -name '*.app' -path '*sim*' 2>/dev/null | head -n 1)
test -n "$sim" || { echo "::error::The simulator build produced no app"; exit 1; }
rm -rf "$out/simulator"
mkdir -p "$out/simulator"
cp -R "$sim" "$out/simulator/"
echo "Simulator app: $sim"

# The iPhone itself. Tauri builds through the workspace it generated, and so do
# we — a plain -project build leaves FRAMEWORK_SEARCH_PATHS empty, which the
# "Build Rust Code" phase refuses to run without.
project=$(find "$gen" -maxdepth 1 -name '*.xcodeproj' | head -n 1)
workspace=$(find "$gen" -maxdepth 1 -name '*.xcworkspace' | head -n 1)
list=$(xcodebuild -list -json -project "$project")
scheme=$(node -e 'const l=JSON.parse(process.argv[1]).project;
  const s=l.schemes.find(n=>/_iOS$/.test(n))??l.schemes[0];
  if(!s){console.error("no scheme");process.exit(1)}console.log(s)' "$list")
configuration=$(node -e 'const l=JSON.parse(process.argv[1]).project;
  console.log(l.configurations.find(n=>/^release$/i.test(n))??l.configurations[0])' "$list")
if [ -n "$workspace" ]; then
  container=(-workspace "$workspace")
else
  container=(-project "$project")
fi
echo "Building $scheme ($configuration) from ${container[*]}"

derived="$RUNNER_TEMP/ios-device"
xcodebuild build \
  "${container[@]}" \
  -scheme "$scheme" \
  -configuration "$configuration" \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$derived" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGN_ENTITLEMENTS="" \
  FRAMEWORK_SEARCH_PATHS='$(inherited)' \
  HEADER_SEARCH_PATHS='$(inherited)' \
  ENABLE_USER_SCRIPT_SANDBOXING=NO ||
  {
    # Xcode keeps what a script build phase printed in its own compressed log.
    log=$(ls -t "$derived"/Logs/Build/*.xcactivitylog 2>/dev/null | head -n 1)
    [ -n "$log" ] && { echo "--- what the build phases printed ---"; gunzip -c "$log" | tr '\r' '\n' | strings | grep -v "^	export " | tail -n 120; }
    exit 1
  }

app=$(find "$derived/Build/Products" -maxdepth 2 -type d -name '*.app' | head -n 1)
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
