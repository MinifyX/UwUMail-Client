// Writes the AUR package uwumail-bin (PKGBUILD and .SRCINFO) for a released version:
//
//   node scripts/aur.mjs <version> <out-dir> [--sums <SHA256SUMS.txt>]
//
// The package repacks the release's .deb (x86_64 and aarch64), as Tauri `-bin` packages do. The
// checksums come from the release's SHA256SUMS.txt, downloaded unless --sums names a local copy.
// The release workflow's `aur` job pushes the result to aur.archlinux.org. By hand, from a clone
// of ssh://aur@aur.archlinux.org/uwumail-bin.git:
//
//   node scripts/aur.mjs 0.4.0 ../uwumail-bin && cd ../uwumail-bin && git commit -am "UwUMail 0.4.0" && git push
//
// No dependencies, no makepkg: .SRCINFO is written here the way `makepkg --printsrcinfo` would.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { REPOSITORY } from "./release-feeds.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(root, "packaging/aur/uwumail-bin/PKGBUILD.in");
/** The release files the package takes, per Arch Linux processor name. */
export const DEBS = { x86_64: "UwUMail-linux-x64.deb", aarch64: "UwUMail-linux-arm64.deb" };

/** pacman wants no `-` in pkgver; without it a beta (0.3.0beta.2) still sorts before 0.3.0. */
export const pkgver = (version) => version.replaceAll("-", "");

/** File name → SHA-256 from `sha256sum` output (`<hash>  <name>`, or `<hash> *<name>`). */
export function parseSums(text) {
  const sums = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trim());
    if (match) sums[match[2]] = match[1].toLowerCase();
  }
  return sums;
}

/** The PKGBUILD and .SRCINFO for `version`, with the checksums of its .debs. */
export function aurFiles(version, sums, template = readFileSync(TEMPLATE, "utf8")) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`Unexpected version ${version}`);
  const sha = {};
  for (const [arch, name] of Object.entries(DEBS)) {
    if (!sums[name]) throw new Error(`SHA256SUMS lists no ${name}`);
    sha[arch] = sums[name];
  }
  const pkgbuild = template
    .replaceAll("@PKGVER@", pkgver(version))
    .replaceAll("@VERSION@", version)
    .replaceAll("@SHA256_X86_64@", sha.x86_64)
    .replaceAll("@SHA256_AARCH64@", sha.aarch64);
  if (pkgbuild.includes("@")) {
    const left = pkgbuild.split("\n").filter((line) => /@[A-Z0-9_]+@/.test(line));
    if (left.length) throw new Error(`Unfilled placeholders in the PKGBUILD: ${left.join("; ")}`);
  }

  // The values .SRCINFO repeats, read back from the PKGBUILD so the two can't disagree.
  const value = (name) => {
    const match = new RegExp(`^${name}=(.*)$`, "m").exec(pkgbuild);
    if (!match) throw new Error(`The PKGBUILD has no ${name}`);
    return match[1];
  };
  const list = (name) => [...value(name).matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
  const scalar = (name) => list(name)[0] ?? value(name);
  const expand = (text) => text.replaceAll("${pkgver}", pkgver(version));
  const lines = [
    `pkgbase = ${scalar("pkgname")}`,
    `\tpkgdesc = ${scalar("pkgdesc")}`,
    `\tpkgver = ${scalar("pkgver")}`,
    `\tpkgrel = ${scalar("pkgrel")}`,
    `\turl = ${scalar("url")}`,
    ...list("arch").map((arch) => `\tarch = ${arch}`),
    ...list("license").map((license) => `\tlicense = ${license}`),
    ...list("depends").map((dep) => `\tdepends = ${dep}`),
    ...list("provides").map((name) => `\tprovides = ${name}`),
    ...list("conflicts").map((name) => `\tconflicts = ${name}`),
    ...list("options").map((option) => `\toptions = ${option}`),
  ];
  for (const arch of list("arch")) {
    lines.push(...list(`source_${arch}`).map((source) => `\tsource_${arch} = ${expand(source)}`));
    lines.push(...list(`sha256sums_${arch}`).map((sum) => `\tsha256sums_${arch} = ${sum}`));
  }
  lines.push("", `pkgname = ${scalar("pkgname")}`, "");
  return { PKGBUILD: pkgbuild, ".SRCINFO": lines.join("\n") };
}

if (import.meta.main) {
  const [version, out] = process.argv.slice(2);
  const index = process.argv.indexOf("--sums");
  const sumsPath = index > 0 ? process.argv[index + 1] : undefined;
  if (!version || !out) {
    console.error("Usage: node scripts/aur.mjs <version> <out-dir> [--sums <SHA256SUMS.txt>]");
    process.exit(1);
  }
  let text;
  if (sumsPath) {
    text = readFileSync(sumsPath, "utf8");
  } else {
    const url = `https://github.com/${REPOSITORY}/releases/download/v${version}/SHA256SUMS.txt`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    text = await response.text();
  }
  mkdirSync(out, { recursive: true });
  for (const [name, content] of Object.entries(aurFiles(version, parseSums(text)))) {
    writeFileSync(join(out, name), content);
    console.log(`${join(out, name)}`);
  }
}
