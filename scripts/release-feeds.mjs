// Writes the update feeds installed apps look for on the `updates` branch:
//
//   node scripts/release-feeds.mjs <version> <out-dir> [--desktop <dir>] [--apk <apk>]
//   node scripts/release-feeds.mjs --names <version>
//
// Release files carry stable names without the version (UwUMail-windows-x64-setup.exe), so the
// website can link to the latest one forever. Installed apps, however, only take an update whose
// signature names the versioned file they expect (`file:UwUMail-Setup-0.4.0.exe`, see
// `release_file_name` in apps/desktop/src-tauri/src/updates.rs), which is what keeps an altered feed
// from passing off an older setup as a newer one. The signature covers the bytes and that name, not
// the download address, so each file is signed as a copy under its versioned name and published
// under its stable one; the feed points at the stable one.
//
// --desktop is a folder with every desktop update file under its release name and, next to them,
// the signature of each under its versioned name (`UwUMail-Setup-<version>.exe.sig`, ...). --names
// prints `<platform key> <release file> <versioned name>` per line, for the job that signs.
// Versions with a suffix (-beta.1) only go into the Beta feeds, plain versions into Stable and
// Beta. Every signature is checked against the updater key in tauri.conf.json and must name the
// versioned file, as installed apps require.

import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "MinifyX/UwUMail-Client";
export const FEED_BRANCH = "updates";
/**
 * The platform keys Tauri's updater looks up, as UwUMail builds them. It tries
 * `<os>-<arch>-<bundle>` first and then `<os>-<arch>`: a UwUMail from the .deb or .rpm finds its
 * package, the one the setup installed (an unpacked AppImage on Linux) the setup.
 */
export const PLATFORMS = [
  "windows-x86_64",
  "windows-aarch64",
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
  "linux-x86_64-deb",
  "linux-aarch64-deb",
  "linux-x86_64-rpm",
  "linux-aarch64-rpm",
];

/** The release file each platform's updater downloads. Both Mac keys get the one universal program. */
export const updateAsset = (platform) =>
  ({
    "windows-x86_64": "UwUMail-windows-x64-setup.exe",
    "windows-aarch64": "UwUMail-windows-arm64-setup.exe",
    "darwin-aarch64": "UwUMail-update-macos-universal",
    "darwin-x86_64": "UwUMail-update-macos-universal",
    "linux-x86_64": "UwUMail-update-linux-x64.AppImage",
    "linux-x86_64-deb": "UwUMail-linux-x64.deb",
    "linux-aarch64-deb": "UwUMail-linux-arm64.deb",
    "linux-x86_64-rpm": "UwUMail-linux-x64.rpm",
    "linux-aarch64-rpm": "UwUMail-linux-arm64.rpm",
  })[platform];

/**
 * The name the signature of `version`'s update file must carry, as installed apps expect it
 * (`release_file_name` in apps/desktop/src-tauri/src/updates.rs). The first five are what every
 * released UwUMail expects and must never change.
 */
export const signedName = (platform, version) =>
  ({
    "windows-x86_64": `UwUMail-Setup-${version}.exe`,
    "windows-aarch64": `UwUMail-Setup-${version}-arm64.exe`,
    "darwin-aarch64": `UwUMail-Update-${version}-macos-apple-silicon`,
    "darwin-x86_64": `UwUMail-Update-${version}-macos-intel`,
    "linux-x86_64": `UwUMail-Setup-${version}-x86_64.AppImage`,
    "linux-x86_64-deb": `UwUMail-${version}-linux-x86_64.deb`,
    "linux-aarch64-deb": `UwUMail-${version}-linux-aarch64.deb`,
    "linux-x86_64-rpm": `UwUMail-${version}-linux-x86_64.rpm`,
    "linux-aarch64-rpm": `UwUMail-${version}-linux-aarch64.rpm`,
  })[platform];

/** The APK's release file; the Android app checks it by its SHA-256 from the feed, not by name. */
export const APK_ASSET = "UwUMail-android.apk";

export const downloadUrl = (version, name) => `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`;

/**
 * Feed file name → content, for desktop update files ({ "<platform>": { name, signature } }, `name`
 * being the release file) and/or an APK ({ name, sha256 }).
 */
export function releaseFeeds({ version, notes, updates = {}, apk, date = new Date() }) {
  const channels = version.includes("-") ? ["beta"] : ["stable", "beta"];
  const desktop = { ...updates };
  for (const platform of Object.keys(desktop)) {
    if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform ${platform}`);
    if (!desktop[platform].signature) throw new Error(`The update for ${platform} isn't signed`);
    if (desktop[platform].name !== updateAsset(platform)) {
      throw new Error(`${desktop[platform].name} isn't the release file for ${platform}`);
    }
  }
  if (apk && apk.name !== APK_ASSET) throw new Error(`${apk.name} isn't the release name of the APK (${APK_ASSET})`);
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

/**
 * The update file for `platform` in `dir` under its release name, with the signature of its
 * versioned copy (`<dir>/<versioned name>.sig`), checked against the updater key.
 */
export const signedUpdate = (dir, platform, version) => {
  const path = join(dir, updateAsset(platform));
  const signaturePath = join(dir, `${signedName(platform, version)}.sig`);
  if (!existsSync(path)) throw new Error(`${path} is missing`);
  if (!existsSync(signaturePath)) throw new Error(`${signaturePath} is missing: ${basename(path)} wasn't signed`);
  const signature = readFileSync(signaturePath, "utf8").trim();
  checkSignature(readFileSync(path), signature, updaterPubkey(), signedName(platform, version));
  return { name: basename(path), signature };
};

if (import.meta.main) {
  if (process.argv[2] === "--names") {
    const version = process.argv[3];
    if (!version) throw new Error("--names wants a version");
    for (const platform of PLATFORMS)
      console.log(`${platform} ${updateAsset(platform)} ${signedName(platform, version)}`);
    process.exit(0);
  }
  const [version, out] = process.argv.slice(2);
  const option = (name) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : undefined;
  };
  if (!version || !out) {
    console.error("Usage: node scripts/release-feeds.mjs <version> <out-dir> [--desktop <dir>] [--apk <apk>]");
    process.exit(1);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const notes = JSON.parse(readFileSync(join(root, "release-notes", `${version}.json`), "utf8"));
  const desktopDir = option("--desktop");
  const apkPath = option("--apk");
  // All or nothing: a release that leaves out a system would leave its installs behind unnoticed.
  const updates = desktopDir
    ? Object.fromEntries(PLATFORMS.map((platform) => [platform, signedUpdate(desktopDir, platform, version)]))
    : {};
  const feeds = releaseFeeds({
    version,
    notes,
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
