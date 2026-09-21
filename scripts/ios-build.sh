#!/usr/bin/env bash
# Builds UwUMail for the simulator and for the iPhone, and packs the iPhone app
# into an .ipa.
#
# Nothing here is signed: UwUMail has no Apple developer account, and Xcode
# refuses to build for a real iPhone without one ("requires a development
# team"). So signing is switched off in the generated project before the build.
# A sideloading tool signs the .ipa with your own Apple ID on the way to the
# phone, see docs/ios.md.
#
# Both builds go through Tauri. They have to: the "Build Rust Code" phase in the
# Xcode project asks the surrounding `tauri ios build` process for its options
# over a local socket, and without it the phase dies with "Abort trap: 6".
#
# Usage: scripts/ios-build.sh <version> [output folder]
set -euo pipefail

version="$1"
out="${2:-out}"
gen="apps/desktop/src-tauri/gen/apple"

echo "--- tools ---"
command -v pnpm node cargo rustup xcodegen
rustup target list --installed | grep apple-ios || true

# `tauri ios build` folds Info.ios.plist into the app it exports, which is a
# step we never reach; the generated project keeps its own copy, so the keys go
# in here. Runs again after xcodegen, which rewrites that file.
merge_info_plist() {
  local extra="apps/desktop/src-tauri/Info.ios.plist" generated
  generated=$(find "$gen" -maxdepth 2 -name Info.plist | head -n 1)
  if [ -f "$extra" ] && [ -n "$generated" ]; then
    /usr/libexec/PlistBuddy -c "Merge $extra" "$generated"
    echo "Merged $extra into $generated"
  fi
}

# Signing off, and a copy of what the Rust build phase prints — Xcode throws
# that away, and it is the only place that says why a build died.
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const text = fs.readFileSync(file, "utf8");
  let patched = text.replace(
    "        ENABLE_BITCODE: false",
    [
      "        ENABLE_BITCODE: false",
      "        CODE_SIGNING_ALLOWED: NO",
      "        CODE_SIGNING_REQUIRED: NO",
      "        CODE_SIGN_IDENTITY: \"\"",
      "        CODE_SIGN_ENTITLEMENTS: \"\"",
    ].join("\n"),
  );
  if (patched === text) console.error("::warning::Could not switch signing off in project.yml");
  const before = patched;
  patched = patched.replace(
    /(- script: )(pnpm tauri ios xcode-script[^\n]*)/,
    (_, head, command) =>
      `${head}${command} > "$SRCROOT/rust-build.log" 2>&1; status=$?; cat "$SRCROOT/rust-build.log"; exit $status`,
  );
  if (patched === before) console.error("::warning::Could not find the Rust build phase in project.yml");
  fs.writeFileSync(file, patched);
' "$gen/project.yml"
(cd "$gen" && xcodegen generate)
merge_info_plist

mkdir -p "$out"

show_rust_log() {
  echo "--- what the Rust build phase printed ---"
  cat "$gen/rust-build.log" 2>/dev/null || echo "(no log written)"
}

# The simulator build, which the smoke test starts afterwards.
pnpm tauri ios build --ci --target aarch64-sim || { show_rust_log; exit 1; }
sim=$(find "$gen/build" -type d -name '*.app' -path '*sim*' 2>/dev/null | head -n 1)
test -n "$sim" || { echo "::error::The simulator build produced no app"; exit 1; }
rm -rf "$out/simulator"
mkdir -p "$out/simulator"
cp -R "$sim" "$out/simulator/"
echo "Simulator app: $sim"

# The iPhone itself. Exporting an .ipa is Xcode's job and needs a certificate,
# so Tauri is expected to stop at that step — the app is finished by then.
pnpm tauri ios build --ci --target aarch64 ||
  echo "::notice::Tauri stopped before exporting a signed app, as expected"
app=$(find "$gen/build" -type d -name '*.app' -not -path '*sim*' 2>/dev/null | head -n 1)
if [ -z "$app" ]; then
  show_rust_log
  echo "::error::The iPhone build produced no app"
  exit 1
fi
echo "iPhone app: $app"
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
