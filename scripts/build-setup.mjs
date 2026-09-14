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

if (process.platform !== "win32") {
  console.error("The UwUMail setup is a Windows program; build it on Windows.");
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
const release = join(root, "target", "release");

console.log(`\n▸ Building UwUMail ${version}`);
run("pnpm --filter @uwumail/desktop tauri build --no-bundle");
const app = join(release, "uwumail-desktop.exe");
if (!existsSync(app)) throw new Error(`Missing ${app}`);

console.log("\n▸ Packing it into the setup");
run("pnpm --filter @uwumail/setup tauri build --no-bundle", { UWUMAIL_SETUP_PAYLOAD: app });

const setup = join(release, `UwUMail-Setup-${version}.exe`);
copyFileSync(join(release, "uwumail-setup.exe"), setup);

if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
  console.log("\n▸ Signing for the updater");
  run(`pnpm --filter @uwumail/desktop exec tauri signer sign "${setup}"`);
}

console.log(`\n✧ ${setup}`);
