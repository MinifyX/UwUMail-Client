// node --test "scripts/*.test.mjs"

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { collectReleaseFiles, releaseArtifacts } from "./release-files.mjs";

const VERSION = "1.2.3";
/** What the signing job takes. */
const SIGNED = [
  "release-windows",
  "desktop-windows-arm64",
  "desktop-macos-universal",
  "desktop-linux-x64",
  "desktop-linux-arm64",
];

let root;
let unpacked;
let files;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "release-files-"));
  unpacked = join(root, "unpacked");
  files = join(root, "files");
  mkdirSync(files);
  for (const artifact of SIGNED) {
    mkdirSync(join(unpacked, artifact), { recursive: true });
    for (const name of releaseArtifacts(VERSION)[artifact])
      writeFileSync(join(unpacked, artifact, name), `${artifact}/${name}`);
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const collect = (artifacts = SIGNED) => collectReleaseFiles(unpacked, files, VERSION, artifacts);

test("takes each artifact's own files", () => {
  collect();
  const all = SIGNED.flatMap((artifact) => releaseArtifacts(VERSION)[artifact]);
  assert.deepEqual(readdirSync(files).sort(), all.sort());
  assert.equal(
    readFileSync(join(files, "UwUMail-windows-x64-setup.exe"), "utf8"),
    "release-windows/UwUMail-windows-x64-setup.exe",
  );
});

test("a Linux build can't bring along a Windows setup", () => {
  writeFileSync(join(unpacked, "desktop-linux-x64", "UwUMail-windows-x64-setup.exe"), "swapped");
  assert.throws(() => collect(), /desktop-linux-x64 carries files it shouldn't/);
  assert.deepEqual(readdirSync(files), [], "nothing copied");
});

test("one build can't bring along another one's files or a signature", () => {
  writeFileSync(join(unpacked, "desktop-macos-universal", "UwUMail-linux-x64.deb"), "swapped");
  assert.throws(() => collect(), /carries files it shouldn't/);
  rmSync(join(unpacked, "desktop-macos-universal", "UwUMail-linux-x64.deb"));
  writeFileSync(join(unpacked, "desktop-linux-arm64", `UwUMail-Setup-${VERSION}.exe.sig`), "forged");
  assert.throws(() => collect(), /carries files it shouldn't/);
});

test("a name that is already there stays as it is", () => {
  writeFileSync(join(files, "UwUMail-linux-x64.rpm"), "first");
  assert.throws(() => collect(), /already in the release/);
  assert.equal(readFileSync(join(files, "UwUMail-linux-x64.rpm"), "utf8"), "first");
});

test("only the named artifacts, all of their files, and plain files", () => {
  mkdirSync(join(unpacked, "release-evil"));
  assert.throws(() => collect(), /Expected the artifacts/);
  assert.throws(() => collect([...SIGNED, "release-evil"]), /Unknown artifacts: release-evil/);
  rmSync(join(unpacked, "release-evil"), { recursive: true });

  rmSync(join(unpacked, "desktop-linux-arm64", "UwUMail-linux-arm64.rpm"));
  assert.throws(() => collect(), /lacks UwUMail-linux-arm64.rpm/);
  mkdirSync(join(unpacked, "desktop-linux-arm64", "UwUMail-linux-arm64.rpm"));
  assert.throws(() => collect(), /isn't a plain file/);
});

test("the published release takes signatures, APK and IPA from their own artifacts", () => {
  const all = [...SIGNED, "release-signatures", "release-android", "release-ios"];
  for (const artifact of all.slice(SIGNED.length)) {
    mkdirSync(join(unpacked, artifact));
    for (const name of releaseArtifacts(VERSION)[artifact]) writeFileSync(join(unpacked, artifact, name), name);
  }
  assert.ok(releaseArtifacts(VERSION)["release-signatures"].includes(`UwUMail-Setup-${VERSION}.exe.sig`));
  collect(all);
  assert.ok(readdirSync(files).includes("UwUMail-android.apk"));
});

test("a link instead of a file fails", (t) => {
  const deb = join(unpacked, "desktop-linux-x64", "UwUMail-linux-x64.deb");
  rmSync(deb);
  try {
    symlinkSync(join(unpacked, "release-windows", "UwUMail-windows-x64-setup.exe"), deb);
  } catch {
    t.skip("no symbolic links here");
    return;
  }
  assert.throws(() => collect(), /isn't a plain file/);
});
