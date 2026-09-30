// node --test "scripts/*.test.mjs"

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

import { artifactDigest } from "./artifact-digest.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "artifact-digest.mjs");
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "artifact-digest-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (path, content) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
  return join(root, path);
};

test("the uploaded files and the downloaded folder give the same digest", () => {
  const a = write("build/out/a.sig", "one");
  const b = write("build/out/b.sig", "two");
  write("download/b.sig", "two");
  write("download/a.sig", "one");
  assert.equal(artifactDigest([b, a]), artifactDigest([join(root, "download")]));
});

test("a changed, added, missing or renamed file changes the digest", () => {
  write("x/setup.exe", "setup");
  const digest = artifactDigest([join(root, "x")]);
  write("x/setup.exe", "other");
  assert.notEqual(artifactDigest([join(root, "x")]), digest);
  write("x/setup.exe", "setup");
  write("x/extra.exe", "");
  assert.notEqual(artifactDigest([join(root, "x")]), digest);
  rmSync(join(root, "x/extra.exe"));
  assert.equal(artifactDigest([join(root, "x")]), digest);
  rmSync(join(root, "x/setup.exe"));
  write("x/setup2.exe", "setup");
  assert.notEqual(artifactDigest([join(root, "x")]), digest);
});

test("files in subfolders count by their relative path", () => {
  write("x/sub/f", "1");
  write("y/f", "1");
  assert.notEqual(artifactDigest([join(root, "x")]), artifactDigest([join(root, "y")]));
});

test("links, empty folders and duplicate names fail", () => {
  const file = write("x/f", "1");
  symlinkSync(file, join(root, "x/link"));
  assert.throws(() => artifactDigest([join(root, "x")]), /isn't a plain file/);
  mkdirSync(join(root, "empty"));
  assert.throws(() => artifactDigest([join(root, "empty")]), /No files/);
  const other = write("y/f", "2");
  assert.throws(() => artifactDigest([file, other]), /twice/);
});

test("--check passes only for the right digest and refuses an empty one", () => {
  const file = write("f", "1");
  const digest = artifactDigest([file]);
  execFileSync(process.execPath, [SCRIPT, "--check", digest, file], { stdio: "pipe" });
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--check", "0".repeat(64), file], { stdio: "pipe" }));
  // A job output that never got set arrives as an empty string.
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--check", "", file], { stdio: "pipe" }));
});

test("for one file it is what `sha256sum <name> | sha256sum` prints", (t) => {
  const file = write("dir/UwUMail-android.apk", "apk bytes");
  let expected;
  try {
    expected = execFileSync("sh", ["-c", "sha256sum UwUMail-android.apk | sha256sum"], {
      cwd: join(root, "dir"),
      encoding: "utf8",
    }).split(" ")[0];
  } catch {
    t.skip("no sha256sum here");
    return;
  }
  assert.equal(artifactDigest([file]), expected);
  assert.equal(artifactDigest([join(root, "dir")]), expected);
});
