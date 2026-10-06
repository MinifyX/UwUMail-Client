#!/usr/bin/env bash
# The signing and upload steps the App Store jobs share (ios.yml `testflight`,
# mas.yml `testflight`), on a GitHub macOS runner. docs/app-store.md.
#
#   scripts/apple-ci.sh keychain   A keychain of this job's own with the certificates from
#                                  APPLE_DISTRIBUTION_P12 and, when set, APPLE_INSTALLER_P12
#                                  (base64, password APPLE_P12_PASSWORD). Sets KEYCHAIN,
#                                  APPLE_SIGNING_IDENTITY, APPLE_INSTALLER_IDENTITY (when there)
#                                  and DISTRIBUTION_CERT (the certificate as PEM, for
#                                  scripts/asc.mjs) for the following steps.
#   scripts/apple-ci.sh api-key    The App Store Connect key from APPLE_ASC_KEY_P8 as a file
#                                  where altool looks for it. Sets ASC_KEY_PATH and
#                                  API_PRIVATE_KEYS_DIR.
#   scripts/apple-ci.sh upload <file> <ios|macos>
#                                  Uploads an .ipa or .pkg to App Store Connect, from where it
#                                  goes to TestFlight once Apple has processed it. Needs
#                                  ASC_KEY_ID and ASC_ISSUER_ID besides the key.
#   scripts/apple-ci.sh cleanup    Removes the keychain and the key, however the job ended.
set -euo pipefail

: "${RUNNER_TEMP:?runs on a GitHub runner}"
: "${GITHUB_ENV:?runs on a GitHub runner}"
keychain="$RUNNER_TEMP/uwumail-signing.keychain-db"
keys="$RUNNER_TEMP/private_keys"

case "${1:-}" in
keychain)
  password="$(openssl rand -hex 24)"
  security create-keychain -p "$password" "$keychain"
  security set-keychain-settings -lut 3600 "$keychain"
  security unlock-keychain -p "$password" "$keychain"
  # Apple's intermediate certificate, so codesign can build the chain whatever the runner has.
  curl -fsSL --retry 3 -o "$RUNNER_TEMP/wwdr.cer" https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
  security import "$RUNNER_TEMP/wwdr.cer" -k "$keychain" >/dev/null || true
  # The secret may carry a trailing newline from how it was pasted.
  p12_password="$(printf '%s' "${APPLE_P12_PASSWORD:?}" | tr -d '\r\n')"
  for name in APPLE_DISTRIBUTION_P12 APPLE_INSTALLER_P12; do
    [ -n "${!name:-}" ] || continue
    printf '%s' "${!name}" | base64 --decode >"$RUNNER_TEMP/certificate.p12"
    security import "$RUNNER_TEMP/certificate.p12" -k "$keychain" -P "$p12_password" \
      -T /usr/bin/codesign -T /usr/bin/productbuild -T /usr/bin/security >/dev/null
    rm -f "$RUNNER_TEMP/certificate.p12"
  done
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
  # shellcheck disable=SC2046 # the existing keychains, one word each
  security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')

  identities="$(security find-identity -v "$keychain")"
  echo "$identities" | grep -E '^ +[0-9]+\)' | sed -E 's/^ +[0-9]+\) [0-9A-F]+ /  /'
  app=$(echo "$identities" | grep '"Apple Distribution: ' | head -n 1 | awk '{print $2}' || true)
  [ -n "$app" ] || { echo "::error::No Apple Distribution certificate in APPLE_DISTRIBUTION_P12"; exit 1; }
  installer=$(echo "$identities" | grep -E '"(3rd Party Mac Developer Installer|Mac Installer Distribution): ' |
    head -n 1 | sed -E 's/.*"(.*)".*/\1/' || true)
  security find-certificate -c "Apple Distribution: " -p "$keychain" >"$RUNNER_TEMP/distribution.pem"
  grep -q 'BEGIN CERTIFICATE' "$RUNNER_TEMP/distribution.pem" || { echo "::error::Couldn't export the certificate"; exit 1; }
  {
    echo "KEYCHAIN=$keychain"
    echo "APPLE_SIGNING_IDENTITY=$app"
    echo "DISTRIBUTION_CERT=$RUNNER_TEMP/distribution.pem"
    [ -z "$installer" ] || echo "APPLE_INSTALLER_IDENTITY=$installer"
  } >>"$GITHUB_ENV"
  ;;
api-key)
  : "${ASC_KEY_ID:?}" "${APPLE_ASC_KEY_P8:?}"
  mkdir -p "$keys"
  chmod 700 "$keys"
  printf '%s\n' "$APPLE_ASC_KEY_P8" >"$keys/AuthKey_$ASC_KEY_ID.p8"
  chmod 600 "$keys/AuthKey_$ASC_KEY_ID.p8"
  {
    echo "ASC_KEY_PATH=$keys/AuthKey_$ASC_KEY_ID.p8"
    echo "API_PRIVATE_KEYS_DIR=$keys"
  } >>"$GITHUB_ENV"
  ;;
upload)
  file="${2:?file}"
  platform="${3:?ios or macos}"
  : "${ASC_KEY_ID:?}" "${ASC_ISSUER_ID:?}" "${API_PRIVATE_KEYS_DIR:?run api-key first}"
  xcrun altool --upload-app --file "$file" --type "$platform" \
    --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" --output-format normal
  ;;
cleanup)
  security delete-keychain "$keychain" 2>/dev/null || true
  rm -rf "$keys" "$RUNNER_TEMP/distribution.pem" "$RUNNER_TEMP/profiles" "$RUNNER_TEMP/wwdr.cer"
  ;;
*)
  echo "Usage: scripts/apple-ci.sh keychain | api-key | upload <file> <ios|macos> | cleanup" >&2
  exit 2
  ;;
esac
