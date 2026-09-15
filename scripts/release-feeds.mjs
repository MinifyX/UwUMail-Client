// Writes the update feeds installed apps look for on the `updates` branch:
//
//   node scripts/release-feeds.mjs <version> <out-dir> [--setup <exe>] [--apk <apk>]
//
// The setup needs its updater signature (.sig) next to it. Versions with a suffix
// (-beta.1) only go into the Beta feeds, plain versions into Stable and Beta.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "MinifyX/UwUMail-Client";
export const FEED_BRANCH = "updates";

export const downloadUrl = (version, name) => `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`;

/** Feed file name → content, for a setup ({ name, signature }) and/or an APK ({ name, sha256 }). */
export function releaseFeeds({ version, notes, setup, apk, date = new Date() }) {
  const channels = version.includes("-") ? ["beta"] : ["stable", "beta"];
  const feeds = {};
  for (const channel of channels) {
    if (setup) {
      // Tauri's updater format; the notes stay a JSON string the app reads per language.
      feeds[`${channel}.json`] = {
        version,
        notes: JSON.stringify(notes),
        pub_date: date.toISOString().replace(/\.\d+Z$/, "Z"),
        platforms: { "windows-x86_64": { signature: setup.signature, url: downloadUrl(version, setup.name) } },
      };
    }
    if (apk) {
      feeds[`android-${channel}.json`] = { version, url: downloadUrl(version, apk.name), sha256: apk.sha256, notes };
    }
  }
  return feeds;
}

if (import.meta.main) {
  const [version, out] = process.argv.slice(2);
  const option = (name) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : undefined;
  };
  if (!version || !out) {
    console.error("Usage: node scripts/release-feeds.mjs <version> <out-dir> [--setup <exe>] [--apk <apk>]");
    process.exit(1);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const notes = JSON.parse(readFileSync(join(root, "release-notes", `${version}.json`), "utf8"));
  const setupPath = option("--setup");
  const apkPath = option("--apk");
  const feeds = releaseFeeds({
    version,
    notes,
    setup: setupPath && { name: basename(setupPath), signature: readFileSync(`${setupPath}.sig`, "utf8").trim() },
    apk: apkPath && {
      name: basename(apkPath),
      sha256: createHash("sha256").update(readFileSync(apkPath)).digest("hex"),
    },
  });
  mkdirSync(out, { recursive: true });
  for (const [name, feed] of Object.entries(feeds)) {
    writeFileSync(join(out, name), `${JSON.stringify(feed, null, 2)}\n`);
    console.log(`${name}: ${feed.version}`);
  }
}
