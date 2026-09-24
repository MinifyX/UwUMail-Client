// Publishes the UwUMail version in tauri.conf.json for Windows, from this PC. Normally
// the release workflow does this for a pushed tag; this is the way when GitHub can't.
//
//   pnpm release              build and sign the setup, check it, publish it
//   pnpm release --no-build   publish the setup already in target/release
//
// Needs a clean tree whose HEAD carries the pushed tag v<version>,
// release-notes/<version>.json, the GitHub CLI signed in with write access and the
// update signing key: TAURI_SIGNING_PRIVATE_KEY + TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
// or a folder with uwumail-update.key and PASSWORT.txt in UWUMAIL_UPDATE_KEY_DIR
// (default: Documents\UwUMail-Update-Schluessel).
//
// Creates the GitHub release with the setup under its release name, UwUMail-windows-x64-setup.exe,
// and SHA256SUMS.txt (no APK: that only comes from the Android workflow; no Linux packages, so no
// AUR update either, see scripts/aur.mjs), and updates the Windows feeds on the `updates` branch.
// The signature is made for the versioned name installed apps expect (UwUMail-Setup-<version>.exe,
// see scripts/release-feeds.mjs).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FEED_BRANCH, REPOSITORY, checkSignature, releaseFeeds, signedName, updateAsset } from "./release-feeds.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (args, cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const fail = (message) => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

let token; // GitHub token for the API, looked up once
const build = !process.argv.includes("--no-build");
const conf = JSON.parse(readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
const version = conf.version;
const tag = `v${version}`;
const setupName = updateAsset("windows-x86_64");
const setup = join(root, "target", "release", setupName);
const signatureFile = join(root, "target", "release", `${signedName("windows-x86_64", version)}.sig`);

console.log(`\n▸ Checking UwUMail ${version}`);
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) fail(`Unexpected version ${version}`);
if (git(["status", "--porcelain", "--untracked-files=no"])) fail("The working tree has uncommitted changes.");
const head = git(["rev-parse", "HEAD"]);
let tagged = "";
try {
  tagged = git(["rev-parse", `${tag}^{commit}`]);
} catch {
  fail(`Tag ${tag} is missing. Tag the release commit and push the tag first.`);
}
if (tagged !== head) fail(`HEAD isn't ${tag}. Check out the tag first.`);
const pushed = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).split(/\s/)[0];
if (pushed !== git(["rev-parse", `refs/tags/${tag}`])) fail(`Push ${tag} first.`);
if (!ghToken()) fail("Sign in to the GitHub CLI first (gh auth login).");
if (await github(`releases/tags/${tag}`)) fail(`${tag} is already released.`);
const notesFile = join(root, "release-notes", `${version}.json`);
if (!existsSync(notesFile)) fail(`release-notes/${version}.json is missing.`);
const notes = JSON.parse(readFileSync(notesFile, "utf8"));
if (typeof notes.de !== "string" || typeof notes.en !== "string") fail("The release notes need de and en.");

if (build) {
  const env = { ...process.env, ...signingKey() };
  console.log("\n▸ Building and signing the setup");
  execFileSync(process.execPath, [join(root, "scripts", "build-setup.mjs")], { cwd: root, stdio: "inherit", env });
} else if (!existsSync(setup)) {
  fail(`${setup} is missing. Run without --no-build.`);
} else if (statSync(setup).mtimeMs < Number(git(["log", "-1", "--format=%ct"])) * 1000) {
  fail("The setup in target/release is older than the release commit. Run without --no-build.");
}

console.log("\n▸ Checking the signature against the updater key");
if (!existsSync(signatureFile)) fail(`${signatureFile} is missing: the setup wasn't signed.`);
const signature = readFileSync(signatureFile, "utf8").trim();
try {
  checkSignature(readFileSync(setup), signature, conf.plugins.updater.pubkey, signedName("windows-x86_64", version));
} catch (error) {
  fail(error.message);
}
console.log("  ✓ matches tauri.conf.json");

const work = mkdtempSync(join(tmpdir(), "uwumail-release-"));
try {
  console.log(`\n▸ Creating the release on ${REPOSITORY}`);
  const notesPath = join(work, "notes.md");
  writeFileSync(notesPath, `## Deutsch\n\n${notes.de}\n\n## English\n\n${notes.en}\n`);
  const sums = join(work, "SHA256SUMS.txt");
  writeFileSync(sums, `${createHash("sha256").update(readFileSync(setup)).digest("hex")}  ${setupName}\n`);
  const channel = version.includes("-") ? "--prerelease" : "--latest";
  execFileSync(
    "gh",
    [
      "release",
      "create",
      tag,
      setup,
      sums,
      "--repo",
      REPOSITORY,
      "--verify-tag",
      "--title",
      `UwUMail ${version}`,
      "--notes-file",
      notesPath,
      channel,
    ],
    { stdio: "inherit" },
  );

  const feeds = releaseFeeds({ version, notes, updates: { "windows-x86_64": { name: setupName, signature } } });
  const publishFeeds = (repository, branch, message) => {
    const dir = join(work, repository.replace("/", "-"));
    git(["clone", "-q", "--depth", "1", "--branch", branch, `https://github.com/${repository}.git`, dir], work);
    for (const [name, feed] of Object.entries(feeds)) {
      writeFileSync(join(dir, name), `${JSON.stringify(feed, null, 2)}\n`);
    }
    git(["add", "--", ...Object.keys(feeds)], dir);
    git(["-c", "user.name=UwUMail Release", "commit", "-qm", message], dir);
    execFileSync("git", ["push", "-q", "origin", `HEAD:${branch}`], { cwd: dir, stdio: "inherit" });
  };
  console.log(`\n▸ Updating ${Object.keys(feeds).join(", ")} on ${FEED_BRANCH}`);
  publishFeeds(REPOSITORY, FEED_BRANCH, `UwUMail ${version}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("\n▸ Checking what's online");
const release = await github(`releases/tags/${tag}`);
const asset = release?.assets?.find((a) => a.name === setupName);
if (!asset || asset.state !== "uploaded") fail("The release has no setup.");
if (asset.size !== statSync(setup).size) fail("The published setup has a different size.");
const feedName = version.includes("-") ? "beta.json" : "stable.json";
const file = await github(`contents/${feedName}?ref=${FEED_BRANCH}`);
const update = file && JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
const platform = update?.platforms?.["windows-x86_64"];
if (update?.version !== version || platform?.signature !== signature) fail(`${feedName} wasn't updated.`);
if (platform.url !== asset.browser_download_url) fail(`${feedName} points elsewhere.`);
console.log(`\n✧ UwUMail ${version} is out: ${asset.browser_download_url}`);
console.log(`  ${feedName} updated${version.includes("-") ? " (Beta channel)" : ""}; no APK in this release`);

/** The update signing key from the environment or the key folder. */
function signingKey() {
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) return {};
  const folder = process.env.UWUMAIL_UPDATE_KEY_DIR || join(homedir(), "Documents", "UwUMail-Update-Schluessel");
  const key = join(folder, "uwumail-update.key");
  if (!existsSync(key)) {
    fail("No signing key: set TAURI_SIGNING_PRIVATE_KEY(_PASSWORD) or UWUMAIL_UPDATE_KEY_DIR.");
  }
  const password = join(folder, "PASSWORT.txt");
  return {
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(key, "utf8").trim(),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: existsSync(password) ? readFileSync(password, "utf8").trim() : "",
  };
}

async function github(path) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "uwumail-release" };
  token ??= process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ghToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${path}`, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`);
  return response.json();
}

function ghToken() {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
