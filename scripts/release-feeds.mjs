// Writes the update feeds installed apps look for on the `updates` branch:
//
//   node scripts/release-feeds.mjs <version> <out-dir> [--setup <exe>] [--update <platform>=<file> ...] [--apk <apk>]
//
// --setup is the Windows x64 setup (windows-x86_64). --update adds another desktop system under
// Tauri's platform key: windows-aarch64, darwin-aarch64, darwin-x86_64 or linux-x86_64. Every setup needs its
// updater signature (.sig) next to it. Versions with a suffix (-beta.1) only go into the Beta
// feeds, plain versions into Stable and Beta. Every signature is checked against the updater key
// in tauri.conf.json and must name its own file, as installed apps require.

import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "MinifyX/UwUMail-Client";
export const FEED_BRANCH = "updates";
/** The platform keys Tauri's updater looks up (`<os>-<arch>`), as UwUMail builds them. */
export const PLATFORMS = ["windows-x86_64", "windows-aarch64", "darwin-aarch64", "darwin-x86_64", "linux-x86_64"];

/**
 * The file each platform's updater downloads for `version`, as installed apps expect it in the
 * signature (`release_file_name` in apps/desktop/src-tauri/src/updates.rs).
 */
export const setupName = (platform, version) =>
  ({
    "windows-x86_64": `UwUMail-Setup-${version}.exe`,
    "windows-aarch64": `UwUMail-Setup-${version}-arm64.exe`,
    "darwin-aarch64": `UwUMail-Update-${version}-macos-apple-silicon`,
    "darwin-x86_64": `UwUMail-Update-${version}-macos-intel`,
    "linux-x86_64": `UwUMail-Setup-${version}-x86_64.AppImage`,
  })[platform];

export const downloadUrl = (version, name) => `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`;

/**
 * Feed file name → content, for a Windows setup ({ name, signature }), setups of other systems
 * ({ "<platform>": { name, signature } }) and/or an APK ({ name, sha256 }).
 */
export function releaseFeeds({ version, notes, setup, updates = {}, apk, date = new Date() }) {
  const channels = version.includes("-") ? ["beta"] : ["stable", "beta"];
  const desktop = { ...updates };
  if (setup) desktop["windows-x86_64"] = setup;
  for (const platform of Object.keys(desktop)) {
    if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform ${platform}`);
    if (!desktop[platform].signature) throw new Error(`The setup for ${platform} isn't signed`);
    // Apps only take the file named for their system and this version; anything else fails there.
    if (desktop[platform].name !== setupName(platform, version)) {
      throw new Error(`${desktop[platform].name} isn't the ${platform} setup of ${version}`);
    }
  }
  const feeds = {};
  for (const channel of channels) {
    if (Object.keys(desktop).length > 0) {
      // Tauri's updater format; the notes stay a JSON string the app reads per language.
      // Windows comes first, as it always did; installed apps pick their own key.
      const platforms = {};
      for (const platform of PLATFORMS) {
        if (desktop[platform]) {
          platforms[platform] = {
            signature: desktop[platform].signature,
            url: downloadUrl(version, desktop[platform].name),
          };
        }
      }
      feeds[`${channel}.json`] = {
        version,
        notes: JSON.stringify(notes),
        pub_date: date.toISOString().replace(/\.\d+Z$/, "Z"),
        platforms,
      };
    }
    if (apk) {
      feeds[`android-${channel}.json`] = { version, url: downloadUrl(version, apk.name), sha256: apk.sha256, notes };
    }
  }
  return feeds;
}

/**
 * Checks a Tauri updater signature (base64 minisign) the way installed apps do: made with the key
 * `pubkeyBase64`, over exactly these bytes, and with `file:<name>` in its signed comment, which
 * is how an app knows the setup belongs to the version the feed announces. Throws otherwise.
 */
export function checkSignature(file, signatureBase64, pubkeyBase64, name) {
  const lines = (text) => Buffer.from(text, "base64").toString("utf8").split(/\r?\n/);
  const pub = Buffer.from(lines(pubkeyBase64)[1] ?? "", "base64");
  const [, signatureLine = "", trustedLine = "", globalLine = ""] = lines(signatureBase64);
  const sig = Buffer.from(signatureLine, "base64");
  if (pub.length !== 42 || sig.length !== 74) throw new Error(`${name}: malformed key or signature`);
  if (!sig.subarray(2, 10).equals(pub.subarray(2, 10))) throw new Error(`${name} was signed with a different key`);
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: pub.subarray(10).toString("base64url") },
    format: "jwk",
  });
  const algorithm = sig.subarray(0, 2).toString("latin1");
  // Installed apps only take prehashed signatures ("ED"), as `tauri signer sign` makes them.
  if (algorithm !== "ED") throw new Error(`${name}: unexpected signature algorithm ${algorithm}`);
  const signed = createHash("blake2b512").update(file).digest();
  if (!verify(null, signed, key, sig.subarray(10))) throw new Error(`The signature doesn't match ${name}`);
  if (!trustedLine.startsWith("trusted comment: ")) throw new Error(`${name}: the signature has no trusted comment`);
  const trusted = trustedLine.slice("trusted comment: ".length);
  if (
    !verify(
      null,
      Buffer.concat([sig.subarray(10), Buffer.from(trusted, "utf8")]),
      key,
      Buffer.from(globalLine, "base64"),
    )
  ) {
    throw new Error(`${name}: the signature's trusted comment doesn't verify`);
  }
  if (!trusted.split("\t").includes(`file:${name}`))
    throw new Error(`The signature was made for another file than ${name}`);
}

/** The updater key installed apps carry. */
export const updaterPubkey = () =>
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
  ).plugins.updater.pubkey;

/** A setup file and its updater signature from the .sig next to it, checked against the updater key. */
const signed = (path) => {
  const signature = readFileSync(`${path}.sig`, "utf8").trim();
  checkSignature(readFileSync(path), signature, updaterPubkey(), basename(path));
  return { name: basename(path), signature };
};

if (import.meta.main) {
  const [version, out] = process.argv.slice(2);
  const option = (name) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : undefined;
  };
  const options = (name) => process.argv.flatMap((arg, index) => (arg === name ? [process.argv[index + 1]] : []));
  if (!version || !out) {
    console.error(
      "Usage: node scripts/release-feeds.mjs <version> <out-dir> [--setup <exe>] [--update <platform>=<file> ...] [--apk <apk>]",
    );
    process.exit(1);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const notes = JSON.parse(readFileSync(join(root, "release-notes", `${version}.json`), "utf8"));
  const setupPath = option("--setup");
  const apkPath = option("--apk");
  const updates = {};
  for (const value of options("--update")) {
    const [platform, path] = [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)];
    if (!value.includes("=") || !path) throw new Error(`--update wants <platform>=<file>, got ${value}`);
    updates[platform] = signed(path);
  }
  const feeds = releaseFeeds({
    version,
    notes,
    setup: setupPath && signed(setupPath),
    updates,
    apk: apkPath && {
      name: basename(apkPath),
      sha256: createHash("sha256").update(readFileSync(apkPath)).digest("hex"),
    },
  });
  mkdirSync(out, { recursive: true });
  for (const [name, feed] of Object.entries(feeds)) {
    writeFileSync(join(out, name), `${JSON.stringify(feed, null, 2)}\n`);
    console.log(`${name}: ${feed.version}${feed.platforms ? ` (${Object.keys(feed.platforms).join(", ")})` : ""}`);
  }
}
