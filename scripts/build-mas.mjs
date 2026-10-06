// Builds UwUMail for the Mac App Store: one universal app (Apple chip and Intel)
// in the sandbox, signed into the installer package App Store Connect takes.
// docs/app-store.md.
//
//   node scripts/build-mas.mjs            build, unsigned, and check it
//   node scripts/build-mas.mjs --sign <UwUMail.app>
//                                         sign an app this script built
//                                         (elsewhere) and package it
//
// The build is the app without its updater (`--no-default-features --features
// store`, src-tauri/Cargo.toml) with tauri.mas.conf.json merged over
// tauri.conf.json: bundle ID app.uwumail — the iPhone app's, so both are one
// app in App Store Connect —, the privacy manifest, the Info.plist keys of
// Info.mas.plist, no update feed. Tauri builds both halves and joins them, the
// way scripts/build-setup.mjs builds the disk image's app (in the same folders,
// so CI shares that build's Cargo cache). Nothing is signed here.
//
// Signing (`--sign`), all from the environment:
//
//   APPLE_SIGNING_IDENTITY     the "Apple Distribution" certificate (name or SHA-1)
//   APPLE_INSTALLER_IDENTITY   the "Mac Installer Distribution" certificate
//   APPLE_TEAM_ID              the team ID
//   MAS_PROFILES               folder with app.uwumail.provisionprofile
//                              (node scripts/asc.mjs profiles macos …)
//   MAS_BUILD_NUMBER           CFBundleVersion; must grow with every upload
//
// What comes out: target/universal-apple-darwin/release/bundle/macos/UwUMail.app,
// and with --sign target/release/UwUMail-<version>-<build>-mas-universal.pkg.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const tauriDir = join(root, "apps/desktop/src-tauri");
const BUNDLE_ID = "app.uwumail";
const TARGET = "universal-apple-darwin";

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function run(command, args, env = {}) {
  execFileSync(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
}

let options;
try {
  ({ values: options } = parseArgs({ options: { sign: { type: "string" } } }));
} catch (error) {
  fail(`${error.message}\n  Usage: node scripts/build-mas.mjs [--sign <UwUMail.app>]`);
}
if (process.platform !== "darwin") fail("The Mac App Store build needs a Mac.");

// The update-signing key has no business near this build: it has no updater,
// and the build runs every build script in the dependency tree.
delete process.env.TAURI_SIGNING_PRIVATE_KEY;
delete process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;

const conf = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"));
/** App Store Connect wants three numbers: 0.10.0-beta.2 goes up as 0.10.0. */
const marketingVersion = conf.version.replace(/[-+].*$/, "");
const env = process.env;
const scratch = mkdtempSync(join(tmpdir(), "uwumail-mas-"));

try {
  if (options.sign) sign(resolve(options.sign));
  else check(build());
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

function build() {
  // What differs per build, as a file: quoting JSON on a command line is different in every shell.
  const overrides = join(scratch, "tauri.mas.build.json");
  writeFileSync(overrides, JSON.stringify({ version: marketingVersion }));
  const bundle = join(root, "target", TARGET, "release", "bundle", "macos", `${conf.productName}.app`);
  rmSync(bundle, { recursive: true, force: true });

  console.log(`\n▸ UwUMail ${marketingVersion} for the Mac App Store (${TARGET})`);
  run("pnpm", [
    "--filter",
    "@uwumail/desktop",
    "tauri",
    "build",
    "--bundles",
    "app",
    "--target",
    TARGET,
    "--config",
    join(tauriDir, "tauri.mas.conf.json"),
    "--config",
    overrides,
    "--features",
    "store",
    "--",
    "--no-default-features",
  ]);
  if (!existsSync(bundle)) fail(`The build left no ${bundle}.`);
  return bundle;
}

function plist(file, key) {
  try {
    return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** What App Store Connect or App Review would otherwise be the first to notice. */
function check(app) {
  const contents = join(app, "Contents");
  const info = join(contents, "Info.plist");
  const [exe] = readdirSync(join(contents, "MacOS"));
  const archs = execFileSync("lipo", ["-archs", join(contents, "MacOS", exe)], { encoding: "utf8" })
    .trim()
    .split(/\s+/);
  if (!archs.includes("arm64") || !archs.includes("x86_64"))
    fail(`${exe} carries ${archs.join(" ")}, not arm64 and x86_64.`);

  const expect = {
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleShortVersionString: marketingVersion,
    LSApplicationCategoryType: "public.app-category.productivity",
    ITSAppUsesNonExemptEncryption: "false",
    "CFBundleURLTypes:0:CFBundleURLSchemes:0": "mailto",
  };
  for (const [key, value] of Object.entries(expect)) {
    if (plist(info, key) !== value) fail(`Info.plist: ${key} is ${plist(info, key)}, not ${value}.`);
  }
  if (!plist(info, "LSMinimumSystemVersion")) fail("Info.plist has no LSMinimumSystemVersion.");
  if (!existsSync(join(contents, "Resources", "PrivacyInfo.xcprivacy"))) fail("The privacy manifest is missing.");

  // The updater must be gone, not merely unused: its feed in the program would be a way to
  // update outside the store as far as App Review can tell (guideline 2.5.2).
  const binary = readFileSync(join(contents, "MacOS", exe));
  for (const leftover of ["raw.githubusercontent.com/MinifyX/UwUMail-Client/updates", "pkexec"]) {
    if (binary.includes(leftover))
      fail(`"${leftover}" is still in the program: was it built with --no-default-features?`);
  }
  console.log(`  ${exe}: ${archs.join(" ")}, ${BUNDLE_ID} ${marketingVersion}, no updater`);
}

function sign(app) {
  for (const name of [
    "APPLE_SIGNING_IDENTITY",
    "APPLE_INSTALLER_IDENTITY",
    "APPLE_TEAM_ID",
    "MAS_PROFILES",
    "MAS_BUILD_NUMBER",
  ]) {
    if (!env[name]) fail(`--sign needs ${name}.`);
  }
  if (!/^\d+(\.\d+){0,2}$/.test(env.MAS_BUILD_NUMBER))
    fail(`MAS_BUILD_NUMBER "${env.MAS_BUILD_NUMBER}" is not one to three numbers.`);
  const team = env.APPLE_TEAM_ID;
  check(app);

  const contents = join(app, "Contents");
  const info = join(contents, "Info.plist");
  run("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleVersion ${env.MAS_BUILD_NUMBER}`, info]);

  // The profile inside, the entitlements completed with the team.
  copyFileSync(join(env.MAS_PROFILES, `${BUNDLE_ID}.provisionprofile`), join(contents, "embedded.provisionprofile"));
  const entitlements = join(scratch, `${BUNDLE_ID}.entitlements`);
  copyFileSync(join(tauriDir, "macos", "Entitlements.mas.plist"), entitlements);
  for (const [key, value] of [
    ["com.apple.application-identifier", `${team}.${BUNDLE_ID}`],
    ["com.apple.developer.team-identifier", team],
  ]) {
    run("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, entitlements]);
  }

  console.log("\n▸ Signing");
  run("codesign", [
    "--force",
    "--timestamp",
    "--options",
    "runtime",
    "--entitlements",
    entitlements,
    "--sign",
    env.APPLE_SIGNING_IDENTITY,
    app,
  ]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  run("codesign", ["-d", "--entitlements", "-", "--xml", app]);
  console.log();

  console.log("\n▸ Packaging");
  const out = join(root, "target", "release");
  mkdirSync(out, { recursive: true });
  const pkg = join(out, `UwUMail-${marketingVersion}-${env.MAS_BUILD_NUMBER}-mas-universal.pkg`);
  rmSync(pkg, { force: true });
  run("productbuild", ["--component", app, "/Applications", "--sign", env.APPLE_INSTALLER_IDENTITY, pkg]);
  run("pkgutil", ["--check-signature", pkg]);
  console.log(`\n✧ ${pkg}`);
}
