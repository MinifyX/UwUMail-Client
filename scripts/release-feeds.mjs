// Writes the update feeds installed apps look for on the `updates` branch:
//
//   node scripts/release-feeds.mjs <version> <out-dir> [--setup <exe>] [--update <platform>=<file> ...] [--apk <apk>]
//
// --setup is the Windows setup (windows-x86_64). --update adds another desktop system under
// Tauri's platform key: darwin-aarch64, darwin-x86_64 or linux-x86_64. Every setup needs its
// updater signature (.sig) next to it. Versions with a suffix (-beta.1) only go into the Beta
// feeds, plain versions into Stable and Beta.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "MinifyX/UwUMail-Client";
export const FEED_BRANCH = "updates";
/** The platform keys Tauri's updater looks up (`<os>-<arch>`), as UwUMail builds them. */
export const PLATFORMS = ["windows-x86_64", "darwin-aarch64", "darwin-x86_64", "linux-x86_64"];

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

/** A setup file and its updater signature from the .sig next to it. */
const signed = (path) => ({ name: basename(path), signature: readFileSync(`${path}.sig`, "utf8").trim() });

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
