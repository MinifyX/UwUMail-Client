// Publishes the UwUMail version in tauri.conf.json for Windows, from this PC. Normally
// the release workflow does this for a pushed tag; this is the way when GitHub can't.
//
//   pnpm release              build and sign the setup, check it, publish it
//   pnpm release --no-build   publish the setup already in target/release
//
// Needs a clean tree whose HEAD carries the pushed tag v<version>,
// release-notes/<version>.json, push access to MinifyX/UwUMail-Releases and the
// update signing key: TAURI_SIGNING_PRIVATE_KEY + TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
// or a folder with uwumail-update.key and PASSWORT.txt in UWUMAIL_UPDATE_KEY_DIR
// (default: Documents\UwUMail-Update-Schluessel).
//
// The setup goes to a short-lived branch incoming/v<version> there; that repo's
// publish workflow turns it into a release and updates the update feeds.

import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASES = "MinifyX/UwUMail-Releases";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (args, cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const fail = (message) => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

let token; // GitHub token for polling, looked up once
const build = !process.argv.includes("--no-build");
const conf = JSON.parse(readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
const version = conf.version;
const tag = `v${version}`;
const setup = join(root, "target", "release", `UwUMail-Setup-${version}.exe`);

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
if (git(["ls-remote", "--tags", `https://github.com/${RELEASES}.git`, `refs/tags/${tag}`])) {
  fail(`${tag} is already published on ${RELEASES}.`);
}
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
if (!existsSync(`${setup}.sig`)) fail(`${setup}.sig is missing: the setup wasn't signed.`);
const signature = readFileSync(`${setup}.sig`, "utf8").trim();
checkSignature(readFileSync(setup), signature, conf.plugins.updater.pubkey);
console.log("  ✓ matches tauri.conf.json");

console.log(`\n▸ Handing it to ${RELEASES}`);
const prerelease = version.includes("-");
const work = mkdtempSync(join(tmpdir(), "uwumail-release-"));
try {
  git(["init", "-q"], work);
  // GitHub only runs workflows that exist in the pushed commit, so the branch builds on main.
  git(["fetch", "-q", "--depth", "1", `https://github.com/${RELEASES}.git`, "main"], work);
  git(["checkout", "-q", "-b", `incoming/${tag}`, "FETCH_HEAD"], work);
  copyFileSync(setup, join(work, `UwUMail-Setup-${version}.exe`));
  copyFileSync(`${setup}.sig`, join(work, `UwUMail-Setup-${version}.exe.sig`));
  writeFileSync(join(work, "release.json"), JSON.stringify({ version, prerelease, notes }, null, 2));
  git(["add", `UwUMail-Setup-${version}.exe`, `UwUMail-Setup-${version}.exe.sig`, "release.json"], work);
  git(["-c", "user.name=UwUMail Release", "commit", "-qm", `UwUMail ${version}`], work);
  execFileSync(
    "git",
    ["push", "-q", "--force", `https://github.com/${RELEASES}.git`, `HEAD:refs/heads/incoming/${tag}`],
    {
      cwd: work,
      stdio: "inherit",
    },
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("\n▸ Waiting for the release and the update feed");
const feed = prerelease ? "beta.json" : "stable.json";
const published = await waitFor(async () => {
  const release = await github(`releases/tags/${tag}`);
  const asset = release?.assets?.find((a) => a.name === `UwUMail-Setup-${version}.exe`);
  if (!asset || asset.state !== "uploaded") return null;
  const file = await github(`contents/${feed}?ref=main`);
  if (!file) return null;
  const update = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  return update.version === version ? { asset, update } : null;
});
if (!published) fail(`Nothing published after 10 minutes: see https://github.com/${RELEASES}/actions`);
if (published.asset.size !== statSync(setup).size) fail("The published setup has a different size.");
const platform = published.update.platforms["windows-x86_64"];
if (platform.signature !== signature) fail(`${feed} carries a different signature.`);
if (!platform.url.endsWith(`/releases/download/${tag}/UwUMail-Setup-${version}.exe`)) fail(`${feed} points elsewhere.`);
console.log(`\n✧ UwUMail ${version} is out: ${published.asset.browser_download_url}`);
console.log(`  ${feed} updated${prerelease ? " (Beta channel)" : ""}`);

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

/** Verifies a Tauri updater signature (base64 minisign) the way installed apps do. */
function checkSignature(file, signatureBase64, pubkeyBase64) {
  const lines = (text) => Buffer.from(text, "base64").toString("utf8").split(/\r?\n/);
  const pub = Buffer.from(lines(pubkeyBase64)[1], "base64");
  const [, signatureLine, trustedLine, globalLine] = lines(signatureBase64);
  const sig = Buffer.from(signatureLine, "base64");
  if (pub.length !== 42 || sig.length !== 74) fail("Malformed key or signature.");
  if (!sig.subarray(2, 10).equals(pub.subarray(2, 10))) fail("The setup was signed with a different key.");
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: pub.subarray(10).toString("base64url") },
    format: "jwk",
  });
  const algorithm = sig.subarray(0, 2).toString("latin1");
  const signed = algorithm === "ED" ? createHash("blake2b512").update(file).digest() : file;
  if (!verify(null, signed, key, sig.subarray(10))) fail("The signature doesn't match the setup.");
  const trusted = Buffer.from(trustedLine.replace(/^trusted comment: /, ""), "utf8");
  if (!verify(null, Buffer.concat([sig.subarray(10), trusted]), key, Buffer.from(globalLine, "base64"))) {
    fail("The signature's trusted comment doesn't verify.");
  }
}

async function github(path) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "uwumail-release" };
  token ??= process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ghToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${RELEASES}/${path}`, { headers });
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

async function waitFor(check) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  return null;
}
