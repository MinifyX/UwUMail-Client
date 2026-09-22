// Builds UwUMail for this system, under the names the release publishes:
//
//   pnpm build:setup                                  Windows x64: UwUMail-windows-x64-setup.exe
//   pnpm build:setup --target aarch64-pc-windows-msvc Windows on ARM: UwUMail-windows-arm64-setup.exe
//   pnpm build:setup                                  macOS: one universal setup (Apple chip and Intel)
//   pnpm build:setup                                  Linux x64 or arm64: packages, portable folder
//
// Without --target, Windows builds for the PC it runs on (an ARM PC makes the ARM setup).
// Windows writes into target/release, as it always did. macOS and Linux write into target/setup:
//
//   UwUMail-macos-universal.dmg              the setup app to download
//   UwUMail-update-macos-universal           the same setup program on its own, for updates
//   UwUMail-linux-<x64|arm64>.deb / .rpm     Tauri's packages, installed system-wide
//   UwUMail-linux-<x64|arm64>-portable.tar.gz  the unpacked AppImage in a folder, runs in place
//   UwUMail-update-linux-x64.AppImage        the per-user Linux setup (x64 only), which UwUMail
//                                            installed by it downloads for its updates
//
// On Windows and macOS the download is UwUMail's own setup with the app packed inside. On Linux
// new installs come from the .deb/.rpm (or the AUR, built from the .deb); the setup AppImage is
// only still built so that copies it installed before keep updating.
//
// Nothing is signed by Apple (there is no developer account): both app bundles get an ad-hoc
// signature, which Apple chips need to run them at all.
//
// With TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD) set, whatever the updater downloads is also
// signed for it: a copy under the versioned name installed apps expect in the signature
// (scripts/release-feeds.mjs) gets signed, which leaves `<versioned name>.sig` next to the file.

import { execFileSync, execSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { signedName, updateAsset } from "./release-feeds.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, env = {}) => execSync(command, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
/** Runs a program with its arguments as they are, no shell in between. */
const exec = (file, args, options = {}) =>
  execFileSync(file, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
    env: { ...process.env, ...options.env },
  });

// Keep the update-signing key out of the app build. Only `tauri signer sign` needs it; the builds
// below run thousands of third-party build scripts (Cargo build.rs, npm) that would otherwise see it
// in their environment. This mirrors the Android build, which signs in a separate step for the same
// reason. Captured here and removed from the environment, then handed only to the signing command.
const signingKey = process.env.TAURI_SIGNING_PRIVATE_KEY;
const signingPassword = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "";
delete process.env.TAURI_SIGNING_PRIVATE_KEY;
delete process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;

const { version } = JSON.parse(readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
const targetDir = process.env.CARGO_TARGET_DIR || join(root, "target");
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};

// Safety net against a future refactor: the builds must never run with the signing key in reach.
if (process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  throw new Error("The update-signing key must be removed from the environment before building.");
}

/**
 * Signs `file` (under its release name) for the updater of each platform key: a copy under the
 * name that platform's installed apps expect in the signature is signed and removed again, which
 * leaves `<that name>.sig` next to the file.
 */
function signForUpdater(file, ...platforms) {
  if (!signingKey) return;
  for (const platform of platforms) {
    const copy = join(dirname(file), signedName(platform, version));
    console.log(`\n▸ Signing ${file} for the updater (${platform}, as ${signedName(platform, version)})`);
    copyFileSync(file, copy);
    const env = { TAURI_SIGNING_PRIVATE_KEY: signingKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signingPassword };
    try {
      // pnpm is a .cmd on Windows, so it goes through the shell there, as the builds do.
      if (process.platform === "win32") run(`pnpm --filter @uwumail/desktop exec tauri signer sign "${copy}"`, env);
      else exec("pnpm", ["--filter", "@uwumail/desktop", "exec", "tauri", "signer", "sign", copy], { env });
    } finally {
      rmSync(copy, { force: true });
    }
  }
}

/** Windows targets, the platform key their updater looks up and the release file. */
const WINDOWS_TARGETS = { "x86_64-pc-windows-msvc": "windows-x86_64", "aarch64-pc-windows-msvc": "windows-aarch64" };

function buildWindows() {
  const explicit = option("--target");
  const target = explicit ?? (process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc");
  const platform = WINDOWS_TARGETS[target];
  if (!platform) {
    throw new Error(`Unknown Windows target ${target}; use one of ${Object.keys(WINDOWS_TARGETS).join(", ")}`);
  }
  // Cargo puts a build for an explicit --target into a folder of its own.
  const built = explicit ? join(targetDir, target, "release") : join(targetDir, "release");
  // pnpm is a .cmd on Windows, so these go through the shell; the target is one of the names above.
  const targetArg = explicit ? ` --target ${target}` : "";
  console.log(`\n▸ Building UwUMail ${version} for ${target}`);
  run(`pnpm --filter @uwumail/desktop tauri build --no-bundle${targetArg}`);
  const app = join(built, "uwumail-desktop.exe");
  if (!existsSync(app)) throw new Error(`Missing ${app}`);

  console.log("\n▸ Packing it into the setup");
  run(`pnpm --filter @uwumail/setup tauri build --no-bundle${targetArg}`, { UWUMAIL_SETUP_PAYLOAD: app });

  // Every Windows setup lands in target/release, as it always did.
  const release = join(targetDir, "release");
  mkdirSync(release, { recursive: true });
  const setup = join(release, updateAsset(platform));
  copyFileSync(join(built, "uwumail-setup.exe"), setup);

  signForUpdater(setup, platform);
  console.log(`\n✧ ${setup}`);
}

/** Signs an app bundle ad hoc ("-" = no certificate) and checks the result. */
function adHocSign(path, identifier) {
  const args = ["--force", "--sign", "-", "--timestamp=none"];
  if (identifier) args.push("--identifier", identifier);
  exec("codesign", [...args, path]);
  exec("codesign", ["--verify", "--strict", "--verbose=2", path]);
}

/** One build for both kinds of Mac: Tauri builds each and joins them with lipo. */
const MAC_TARGET = "universal-apple-darwin";

function buildMac() {
  const target = option("--target") ?? MAC_TARGET;
  if (target !== MAC_TARGET) throw new Error(`The macOS setup is built as ${MAC_TARGET} only, not ${target}`);
  const bundles = join(targetDir, target, "release", "bundle", "macos");
  const out = join(targetDir, "setup");
  mkdirSync(out, { recursive: true });

  console.log(`\n▸ Building UwUMail ${version} for ${target}`);
  rmSync(join(bundles, "UwUMail.app"), { recursive: true, force: true });
  exec("pnpm", ["--filter", "@uwumail/desktop", "tauri", "build", "--bundles", "app", "--target", target]);
  const app = join(bundles, "UwUMail.app");
  if (!existsSync(app)) throw new Error(`Missing ${app}`);
  adHocSign(app);

  console.log("\n▸ Packing it into the setup");
  rmSync(join(bundles, "UwUMail Setup.app"), { recursive: true, force: true });
  exec("pnpm", ["--filter", "@uwumail/setup", "tauri", "build", "--bundles", "app", "--target", target], {
    env: { UWUMAIL_SETUP_PAYLOAD: app },
  });
  const setupApp = join(bundles, "UwUMail Setup.app");
  if (!existsSync(setupApp)) throw new Error(`Missing ${setupApp}`);
  adHocSign(setupApp);

  // The updater downloads the setup program on its own: one file, checked as a whole. The same
  // universal program serves both kinds of Mac.
  const program = readdirSync(join(setupApp, "Contents", "MacOS"))[0];
  const update = join(out, updateAsset("darwin-aarch64"));
  rmSync(update, { force: true });
  copyFileSync(join(setupApp, "Contents", "MacOS", program), update);
  adHocSign(update, "app.uwumail.setup");

  console.log("\n▸ Making the disk image");
  const stage = join(out, "dmg-universal");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
  exec("ditto", [setupApp, join(stage, "UwUMail Setup.app")]);
  const dmg = join(out, "UwUMail-macos-universal.dmg");
  rmSync(dmg, { force: true });
  exec("hdiutil", ["create", "-volname", "UwUMail Setup", "-srcfolder", stage, "-format", "UDZO", "-ov", dmg]);
  rmSync(stage, { recursive: true, force: true });

  // Installed apps on Apple chips and on Intel each expect their own name in the signature.
  signForUpdater(update, "darwin-aarch64", "darwin-x86_64");
  console.log(`\n✧ ${dmg}\n✧ ${update}`);
}

/** Linux processors: the name in the release files and the one Tauri's updater uses. */
const LINUX_ARCHES = { x64: { label: "x64", arch: "x86_64" }, arm64: { label: "arm64", arch: "aarch64" } };

/**
 * Tauri names the .deb/.rpm package after the product, in kebab case, which would turn "UwUMail"
 * into "uw-u-mail". Built as "uwumail" instead; the menu entry still says UwUMail. The package
 * name is what UwUMail asks dpkg and rpm about before updating itself (`PACKAGE` in updates.rs).
 */
const PACKAGE_CONFIG = {
  productName: "uwumail",
  bundle: {
    linux: {
      deb: { desktopTemplate: join(root, "apps/desktop/src-tauri/linux/uwumail.desktop"), section: "mail" },
      rpm: { desktopTemplate: join(root, "apps/desktop/src-tauri/linux/uwumail.desktop") },
    },
  },
};

/** How to start the portable folder; it sits next to AppRun. */
const PORTABLE_LAUNCHER = `#!/bin/sh
# Starts UwUMail from this folder. AppRun finds the libraries next to itself, so it is started by
# its real path, also when this script is reached through a link.
here="$(dirname "$(readlink -f "$0")")"
exec "$here/AppRun" "$@"
`;

const PORTABLE_README = `UwUMail ${version}, portable

Runs from this folder without installing anything. Start it with

    ./UwUMail/uwumail

(or ./UwUMail/AppRun). The folder can live anywhere, a USB stick too; mail
and settings are kept in your home folder like for an installed UwUMail.

This copy does not update itself. For updates, download the newest
UwUMail-linux-<x64|arm64>-portable.tar.gz again, or install the .deb/.rpm
(or uwumail-bin from the AUR), which update themselves:
https://github.com/MinifyX/UwUMail-Client/releases/latest
`;

function buildLinux() {
  const linux = LINUX_ARCHES[process.arch];
  if (!linux) throw new Error(`There's no UwUMail for Linux on ${process.arch}.`);
  const bundleRoot = join(targetDir, "release", "bundle");
  const out = join(targetDir, "setup");
  mkdirSync(out, { recursive: true });

  console.log(`\n▸ Building UwUMail ${version} (AppImage)`);
  rmSync(bundleRoot, { recursive: true, force: true });
  exec("pnpm", ["--filter", "@uwumail/desktop", "tauri", "build", "--bundles", "appimage"]);
  const appImageDir = join(bundleRoot, "appimage");
  const appImage = readdirSync(appImageDir).find((name) => name.endsWith(".AppImage"));
  if (!appImage) throw new Error(`No AppImage in ${appImageDir}`);

  // Unpacked, so the app runs without FUSE, for the setup and the portable folder alike.
  console.log("\n▸ Unpacking the AppImage");
  const work = join(out, "appdir");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work);
  exec(join(appImageDir, appImage), ["--appimage-extract"], { cwd: work, stdio: ["ignore", "ignore", "inherit"] });
  const appDir = join(work, "squashfs-root");
  if (!existsSync(join(appDir, "AppRun"))) throw new Error(`The unpacked AppImage has no AppRun: ${appDir}`);

  if (linux.label === "x64") {
    // Only for the copies the per-user setup installed before: they update through it.
    console.log("\n▸ Packing it into the setup");
    rmSync(appImageDir, { recursive: true, force: true });
    exec("pnpm", ["--filter", "@uwumail/setup", "tauri", "build", "--bundles", "appimage"], {
      env: { UWUMAIL_SETUP_PAYLOAD: appDir },
    });
    const setupImage = readdirSync(appImageDir).find((name) => name.endsWith(".AppImage"));
    if (!setupImage) throw new Error(`No setup AppImage in ${appImageDir}`);
    const setup = join(out, updateAsset("linux-x86_64"));
    rmSync(setup, { force: true });
    copyFileSync(join(appImageDir, setupImage), setup);
    signForUpdater(setup, "linux-x86_64");
  }

  // One folder UwUMail/ that runs in place. tar, not zip, so modes and links stay.
  console.log("\n▸ Packing the portable folder");
  const stage = join(out, "portable");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
  exec("mv", [appDir, join(stage, "UwUMail")]);
  writeFileSync(join(stage, "UwUMail", "uwumail"), PORTABLE_LAUNCHER);
  chmodSync(join(stage, "UwUMail", "uwumail"), 0o755);
  writeFileSync(join(stage, "UwUMail", "README.txt"), PORTABLE_README);
  const portable = join(out, `UwUMail-linux-${linux.label}-portable.tar.gz`);
  rmSync(portable, { force: true });
  exec("tar", ["--owner=0", "--group=0", "--numeric-owner", "-czf", portable, "-C", stage, "UwUMail"]);
  rmSync(stage, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });

  console.log(`\n▸ Building the .deb and .rpm`);
  exec("pnpm", [
    "--filter",
    "@uwumail/desktop",
    "tauri",
    "build",
    "--bundles",
    "deb,rpm",
    "--config",
    JSON.stringify(PACKAGE_CONFIG),
  ]);
  const packages = [];
  for (const kind of ["deb", "rpm"]) {
    const dir = join(bundleRoot, kind);
    const built = readdirSync(dir).filter((name) => name.endsWith(`.${kind}`));
    if (built.length !== 1) throw new Error(`Expected one .${kind} in ${dir}, found: ${built.join(", ")}`);
    const file = join(out, `UwUMail-linux-${linux.label}.${kind}`);
    rmSync(file, { force: true });
    copyFileSync(join(dir, built[0]), file);
    signForUpdater(file, `linux-${linux.arch}-${kind}`);
    packages.push(file);
  }

  console.log(`\n✧ ${[...packages, portable].join("\n✧ ")}`);
}

if (process.platform === "win32") buildWindows();
else if (process.platform === "darwin") buildMac();
else if (process.platform === "linux") buildLinux();
else {
  console.error(`There's no UwUMail setup for ${process.platform}.`);
  process.exit(1);
}
