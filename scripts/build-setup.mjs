// Builds UwUMail's setup for this system: the app, packed into UwUMail's own installer.
//
//   pnpm build:setup                                  Windows x64: UwUMail-Setup-<version>.exe
//   pnpm build:setup --target aarch64-pc-windows-msvc Windows on ARM: UwUMail-Setup-<version>-arm64.exe
//   pnpm build:setup --target aarch64-apple-darwin    macOS (Apple chip), or x86_64-apple-darwin (Intel)
//   pnpm build:setup                                  Linux: UwUMail-Setup-<version>-x86_64.AppImage
//
// Without --target, Windows builds for the PC it runs on (an ARM PC makes the -arm64 setup).
// Windows writes into target/release, as it always did. macOS and Linux write into target/setup:
//
//   UwUMail-Setup-<version>-macos-apple-silicon.dmg   the setup app to download (…-macos-intel.dmg)
//   UwUMail-Update-<version>-macos-apple-silicon      the same setup program on its own, for updates
//   UwUMail-Setup-<version>-x86_64.AppImage           Linux setup, also used for updates
//
// Nothing is signed by Apple (there is no developer account): both app bundles get an ad-hoc
// signature, which Apple chips need to run them at all.
//
// With TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD) set, whatever the updater downloads is also
// signed for it, which writes a .sig next to the file.

import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function signForUpdater(file) {
  if (!signingKey) return;
  console.log(`\n▸ Signing ${file} for the updater`);
  exec("pnpm", ["--filter", "@uwumail/desktop", "exec", "tauri", "signer", "sign", file], {
    env: { TAURI_SIGNING_PRIVATE_KEY: signingKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signingPassword },
  });
}

/** Windows targets and what their setup's name ends with; x64 keeps the name it always had. */
const WINDOWS_SUFFIXES = { "x86_64-pc-windows-msvc": "", "aarch64-pc-windows-msvc": "-arm64" };

function buildWindows() {
  const explicit = option("--target");
  const target = explicit ?? (process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc");
  const suffix = WINDOWS_SUFFIXES[target];
  if (suffix === undefined) {
    throw new Error(`Unknown Windows target ${target}; use one of ${Object.keys(WINDOWS_SUFFIXES).join(", ")}`);
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
  const setup = join(release, `UwUMail-Setup-${version}${suffix}.exe`);
  copyFileSync(join(built, "uwumail-setup.exe"), setup);

  if (signingKey) {
    console.log("\n▸ Signing for the updater");
    run(`pnpm --filter @uwumail/desktop exec tauri signer sign "${setup}"`, {
      TAURI_SIGNING_PRIVATE_KEY: signingKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signingPassword,
    });
  }
  console.log(`\n✧ ${setup}`);
}

/** Signs an app bundle ad hoc ("-" = no certificate) and checks the result. */
function adHocSign(path, identifier) {
  const args = ["--force", "--sign", "-", "--timestamp=none"];
  if (identifier) args.push("--identifier", identifier);
  exec("codesign", [...args, path]);
  exec("codesign", ["--verify", "--strict", "--verbose=2", path]);
}

const MAC_LABELS = { "aarch64-apple-darwin": "apple-silicon", "x86_64-apple-darwin": "intel" };

function buildMac() {
  const target = option("--target") ?? (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin");
  const label = MAC_LABELS[target];
  if (!label) throw new Error(`Unknown macOS target ${target}; use one of ${Object.keys(MAC_LABELS).join(", ")}`);
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

  // The updater downloads the setup program on its own: one file, checked as a whole.
  const program = readdirSync(join(setupApp, "Contents", "MacOS"))[0];
  const update = join(out, `UwUMail-Update-${version}-macos-${label}`);
  rmSync(update, { force: true });
  copyFileSync(join(setupApp, "Contents", "MacOS", program), update);
  adHocSign(update, "app.uwumail.setup");

  console.log("\n▸ Making the disk image");
  const stage = join(out, `dmg-${label}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
  exec("ditto", [setupApp, join(stage, "UwUMail Setup.app")]);
  const dmg = join(out, `UwUMail-Setup-${version}-macos-${label}.dmg`);
  rmSync(dmg, { force: true });
  exec("hdiutil", ["create", "-volname", "UwUMail Setup", "-srcfolder", stage, "-format", "UDZO", "-ov", dmg]);
  rmSync(stage, { recursive: true, force: true });

  signForUpdater(update);
  console.log(`\n✧ ${dmg}\n✧ ${update}`);
}

function buildLinux() {
  if (process.arch !== "x64") throw new Error("The Linux setup is built for x86_64 only.");
  const bundles = join(targetDir, "release", "bundle", "appimage");
  const out = join(targetDir, "setup");
  mkdirSync(out, { recursive: true });

  console.log(`\n▸ Building UwUMail ${version}`);
  rmSync(bundles, { recursive: true, force: true });
  exec("pnpm", ["--filter", "@uwumail/desktop", "tauri", "build", "--bundles", "appimage"]);
  const appImage = readdirSync(bundles).find((name) => name.endsWith(".AppImage"));
  if (!appImage) throw new Error(`No AppImage in ${bundles}`);

  // Unpacked, so the installed app runs without FUSE. The setup keeps modes and links.
  console.log("\n▸ Unpacking the AppImage");
  const work = join(out, "appdir");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work);
  exec(join(bundles, appImage), ["--appimage-extract"], { cwd: work, stdio: ["ignore", "ignore", "inherit"] });
  const appDir = join(work, "squashfs-root");
  if (!existsSync(join(appDir, "AppRun"))) throw new Error(`The unpacked AppImage has no AppRun: ${appDir}`);

  console.log("\n▸ Packing it into the setup");
  rmSync(bundles, { recursive: true, force: true });
  exec("pnpm", ["--filter", "@uwumail/setup", "tauri", "build", "--bundles", "appimage"], {
    env: { UWUMAIL_SETUP_PAYLOAD: appDir },
  });
  const setupImage = readdirSync(bundles).find((name) => name.endsWith(".AppImage"));
  if (!setupImage) throw new Error(`No setup AppImage in ${bundles}`);
  const setup = join(out, `UwUMail-Setup-${version}-x86_64.AppImage`);
  rmSync(setup, { force: true });
  copyFileSync(join(bundles, setupImage), setup);
  rmSync(work, { recursive: true, force: true });

  signForUpdater(setup);
  console.log(`\n✧ ${setup}`);
}

if (process.platform === "win32") buildWindows();
else if (process.platform === "darwin") buildMac();
else if (process.platform === "linux") buildLinux();
else {
  console.error(`There's no UwUMail setup for ${process.platform}.`);
  process.exit(1);
}
