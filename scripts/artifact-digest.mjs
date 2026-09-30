// A fingerprint of the files an artifact holds, so a release can tell that nothing replaced it:
//
//   node scripts/artifact-digest.mjs <path>...                    prints the digest
//   node scripts/artifact-digest.mjs --check <digest> <path>...   fails unless it matches
//
// The job that builds an artifact prints the digest of the files it uploads and hands it on as a
// job output; the jobs that sign and publish compute it again over the folder they downloaded the
// artifact into and compare. Any job of a run can delete and re-upload another job's artifact by
// name, but none can change another job's outputs.
//
// A file counts under its own name, a folder with every file inside it under its path relative to
// that folder (as upload-artifact stores a single file, and as download-artifact unpacks). The
// digest is the SHA-256 of `<sha256>  <name>` lines sorted by name, like a sorted SHA256SUMS, so
// for a single file it is also `sha256sum <name> | sha256sum` (the release's android and ios jobs,
// which have no checkout, compute it that way).

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

/** `name → sha256` of every file under `paths`; links and duplicate names fail. */
export function fileHashes(paths) {
  const hashes = new Map();
  const add = (file, name) => {
    if (!lstatSync(file).isFile()) throw new Error(`${file} isn't a plain file`);
    if (hashes.has(name)) throw new Error(`${name} is there twice`);
    hashes.set(name, createHash("sha256").update(readFileSync(file)).digest("hex"));
  };
  for (const path of paths) {
    if (lstatSync(path).isDirectory()) {
      const walk = (dir) => {
        for (const entry of readdirSync(dir)) {
          const file = join(dir, entry);
          if (lstatSync(file).isDirectory()) walk(file);
          else add(file, relative(path, file).split(sep).join("/"));
        }
      };
      walk(path);
    } else {
      add(path, basename(path));
    }
  }
  return hashes;
}

/** The digest over every file under `paths`. */
export function artifactDigest(paths) {
  const hashes = fileHashes(paths);
  if (hashes.size === 0) throw new Error(`No files in ${paths.join(", ")}`);
  const lines = [...hashes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, sha]) => `${sha}  ${name}\n`);
  return createHash("sha256").update(lines.join("")).digest("hex");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--check") {
    const [, expected, ...paths] = args;
    if (!/^[0-9a-f]{64}$/.test(expected ?? "") || paths.length === 0) {
      console.error(`Expected a digest from the job that built ${paths.join(", ") || "it"}, got '${expected ?? ""}'`);
      process.exit(1);
    }
    const actual = artifactDigest(paths);
    if (actual !== expected) {
      console.error(`${paths.join(", ")} isn't what its job built: ${actual}, expected ${expected}`);
      process.exit(1);
    }
    console.log(`✓ ${paths.join(", ")}: ${actual}`);
  } else {
    if (args.length === 0) {
      console.error("Usage: node scripts/artifact-digest.mjs [--check <digest>] <path>...");
      process.exit(1);
    }
    console.log(artifactDigest(args));
  }
}
