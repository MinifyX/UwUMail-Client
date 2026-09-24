// Takes the files of each build artifact into the release folder, and only those:
//
//   node scripts/release-files.mjs --names <build>          the files a desktop build packs, one per line
//   node scripts/release-files.mjs <unpacked-dir> <files-dir> <version> <artifact>...
//
// The release workflow downloads each artifact it needs by its exact name into a folder of its own
// (<unpacked-dir>/<artifact>/, the desktop builds' tars unpacked there), and this copies exactly the
// files that artifact is meant to hold into <files-dir>. Anything else fails the release: another
// artifact than the ones named, a file an artifact shouldn't carry, one that is missing, a link or
// folder instead of a file, or a name that is already there. Every build runs thousands of
// third-party build scripts; one of them must not be able to slip another system's setup, the APK
// or a signature into its own artifact and have it signed for the updater or published.

import { chmodSync, constants, copyFileSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { APK_ASSET, PLATFORMS, signedName, updateAsset } from "./release-feeds.mjs";

/** The files each macOS and Linux build packs into its artifact (a tar), under their release names. */
export const DESKTOP_BUILD_FILES = {
  "desktop-macos-universal": ["UwUMail-macos-universal.dmg", updateAsset("darwin-aarch64")],
  "desktop-linux-x64": [
    updateAsset("linux-x86_64-deb"),
    updateAsset("linux-x86_64-rpm"),
    "UwUMail-linux-x64-portable.tar.gz",
    updateAsset("linux-x86_64"),
  ],
  "desktop-linux-arm64": [
    updateAsset("linux-aarch64-deb"),
    updateAsset("linux-aarch64-rpm"),
    "UwUMail-linux-arm64-portable.tar.gz",
  ],
};

/** Every artifact a release takes files from, with the files each one carries. */
export const releaseArtifacts = (version) => ({
  "release-windows": [updateAsset("windows-x86_64")],
  "desktop-windows-arm64": [updateAsset("windows-aarch64")],
  ...DESKTOP_BUILD_FILES,
  "release-signatures": PLATFORMS.map((platform) => `${signedName(platform, version)}.sig`),
  "release-android": [APK_ASSET],
  "release-ios": ["UwUMail-ios.ipa"],
});

/** Copies the files of `artifacts` from `<unpacked>/<artifact>/` into `files`, checking everything first. */
export function collectReleaseFiles(unpacked, files, version, artifacts) {
  const known = releaseArtifacts(version);
  const unknown = artifacts.filter((artifact) => !known[artifact]);
  if (unknown.length > 0) throw new Error(`Unknown artifacts: ${unknown.join(", ")}`);
  const found = readdirSync(unpacked).sort();
  const expected = [...artifacts].sort();
  if (found.join("\n") !== expected.join("\n")) {
    throw new Error(`Expected the artifacts ${expected.join(", ")}, found ${found.join(", ") || "none"}`);
  }
  const copies = [];
  for (const artifact of artifacts) {
    const names = known[artifact];
    const dir = join(unpacked, artifact);
    const inside = readdirSync(dir).sort();
    const extra = inside.filter((name) => !names.includes(name));
    const missing = names.filter((name) => !inside.includes(name));
    if (extra.length > 0) throw new Error(`${artifact} carries files it shouldn't: ${extra.join(", ")}`);
    if (missing.length > 0) throw new Error(`${artifact} lacks ${missing.join(", ")}`);
    for (const name of names) {
      const stat = lstatSync(join(dir, name));
      if (!stat.isFile()) throw new Error(`${artifact}: ${name} isn't a plain file`);
      if (existsSync(join(files, name)) || copies.some((copy) => copy.name === name)) {
        throw new Error(`${name} from ${artifact} is already in the release`);
      }
      copies.push({ artifact, name, source: join(dir, name), mode: stat.mode });
    }
  }
  for (const { artifact, name, source, mode } of copies) {
    // COPYFILE_EXCL: a name that is already in the release folder stays as it is, whatever happens.
    copyFileSync(source, join(files, name), constants.COPYFILE_EXCL);
    // The update programs have to stay executable.
    chmodSync(join(files, name), mode & 0o755);
    console.log(`${artifact}: ${name}`);
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--names") {
    const names = DESKTOP_BUILD_FILES[process.argv[3]];
    if (!names) throw new Error(`Unknown desktop build ${process.argv[3]}`);
    console.log(names.join("\n"));
    process.exit(0);
  }
  const [unpacked, files, version, ...artifacts] = process.argv.slice(2);
  if (!unpacked || !files || !version || artifacts.length === 0) {
    console.error(
      "Usage: node scripts/release-files.mjs <unpacked-dir> <files-dir> <version> <artifact>... | --names <build>",
    );
    process.exit(1);
  }
  collectReleaseFiles(unpacked, files, version, artifacts);
}
