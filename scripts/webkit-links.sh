#!/usr/bin/env bash
# Runs scripts/webkit-links.mjs in the Playwright image against the built demo (see there).
# Screenshots of a failure land in target/.
set -euo pipefail
cd "$(dirname "$0")/.."
version=1.63.0
mkdir -p target
docker run --rm -v uwumail-playwright:/pw -v "$PWD:/w:ro" -v "$PWD/target:/out" \
  "mcr.microsoft.com/playwright:v$version-noble" bash -c "
    [ -d /pw/node_modules/playwright ] || npm i --prefix /pw --no-save --silent playwright@$version >/dev/null
    mkdir -p /run/links && cd /run/links && ln -s /pw/node_modules node_modules && cp /w/scripts/webkit-links.mjs .
    status=0; node webkit-links.mjs /w/apps/desktop/dist || status=\$?
    for f in *.png; do [ -e \"\$f\" ] && cp \"\$f\" /out/ && chown $(id -u):$(id -g) \"/out/\$f\"; done
    exit \$status"
