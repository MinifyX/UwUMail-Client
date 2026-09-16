// Builds UwUMail-Setup-<version>.exe: the app, packed into UwUMail's own installer.
//
//   pnpm build:setup
//
// With TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD) set, the setup is also signed
// for the updater, which writes UwUMail-Setup-<version>.exe.sig next to it.

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, env = {}) => execSync(command, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });

// Keep the update-signing key out of the app build. Only `tauri signer sign` needs it; the builds
// below run thousands of third-party build scripts (Cargo build.rs, npm) that would otherwise see it
// in their environment. This mirrors the Android build, which signs in a separate step for the same
// reason. Captured here and removed from the environment, then handed only to the signing command.
const signingKey = process.env.TAURI_SIGNING_PRIVATE_KEY;
const signingPassword = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "";
delete process.env.TAURI_SIGNING_PRIVATE_KEY;
delete process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;

if (process.platform !== "win32") {
  console.error("The UwUMail setup is a Windows program; build it on Windows.");
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
const release = join(root, "target", "release");

// Safety net against a future refactor: the builds must never run with the signing key in reach.
if (process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  throw new Error("The update-signing key must be removed from the environment before building.");
}

console.log(`\n▸ Building UwUMail ${version}`);
run("pnpm --filter @uwumail/desktop tauri build --no-bundle");
const app = join(release, "uwumail-desktop.exe");
if (!existsSync(app)) throw new Error(`Missing ${app}`);

console.log("\n▸ Packing it into the setup");
run("pnpm --filter @uwumail/setup tauri build --no-bundle", { UWUMAIL_SETUP_PAYLOAD: app });

const setup = join(release, `UwUMail-Setup-${version}.exe`);
copyFileSync(join(release, "uwumail-setup.exe"), setup);

if (signingKey) {
  console.log("\n▸ Signing for the updater");
  run(`pnpm --filter @uwumail/desktop exec tauri signer sign "${setup}"`, {
    TAURI_SIGNING_PRIVATE_KEY: signingKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signingPassword,
  });
}

console.log(`\n✧ ${setup}`);
