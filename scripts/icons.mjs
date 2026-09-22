// Regenerates the desktop icons (taskbar, window, tray, Linux menus) from the taskbar symbol:
//
//   node scripts/icons.mjs
//
// The taskbar gets Nyu without the tile: brand/uwumail-taskbar-icon.svg, upright, on a transparent
// background. Up to 24 px the ICO and the tray use brand/uwumail-taskbar-icon-small.svg instead,
// with thicker outlines and no blush or inner ears, which otherwise turn to mush at that size.
// The macOS icon.icns and the Square*/StoreLogo tiles keep the app icon; regenerate those with
// `pnpm tauri icon ../../brand/uwumail-app-icon.svg` and copy back only the files you need.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const icons = join(desktop, "src-tauri/icons");
const DESKTOP_FILES = ["icon.ico", "icon.png", "32x32.png", "64x64.png", "128x128.png", "128x128@2x.png"];
/** ICO sizes drawn from the small symbol. */
const SMALL = new Set([16, 24]);

function render(svg) {
  const out = mkdtempSync(join(tmpdir(), "uwumail-icons-"));
  execFileSync("pnpm", ["tauri", "icon", join(root, "brand", svg), "-o", out], {
    cwd: desktop,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return out;
}

/** ICO entries by size: { size → image bytes }. A width byte of 0 means 256. */
function readIco(path) {
  const buf = readFileSync(path);
  const entries = new Map();
  for (let i = 0; i < buf.readUInt16LE(4); i++) {
    const at = 6 + i * 16;
    const size = buf[at] || 256;
    entries.set(size, buf.subarray(buf.readUInt32LE(at + 12), buf.readUInt32LE(at + 12) + buf.readUInt32LE(at + 8)));
  }
  return entries;
}

function writeIco(path, entries) {
  const sizes = [...entries.keys()].sort((a, b) => a - b);
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const at = 6 + i * 16;
    header[at] = header[at + 1] = size % 256;
    header.writeUInt16LE(1, at + 4); // planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(entries.get(size).length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += entries.get(size).length;
  });
  writeFileSync(path, Buffer.concat([header, ...sizes.map((size) => entries.get(size))]));
}

const large = render("uwumail-taskbar-icon.svg");
const small = render("uwumail-taskbar-icon-small.svg");
try {
  for (const file of DESKTOP_FILES) copyFileSync(join(large, file), join(icons, file));
  const ico = readIco(join(large, "icon.ico"));
  for (const [size, image] of readIco(join(small, "icon.ico"))) if (SMALL.has(size)) ico.set(size, image);
  writeIco(join(icons, "icon.ico"), ico);
  copyFileSync(join(small, "32x32.png"), join(icons, "tray.png"));
} finally {
  rmSync(large, { recursive: true, force: true });
  rmSync(small, { recursive: true, force: true });
}
