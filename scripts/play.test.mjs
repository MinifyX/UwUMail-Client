import assert from "node:assert/strict";
import { test } from "node:test";

import { NOTES_LIMIT, releaseNotes, versionCode } from "./play.mjs";

test("Play's versionCode sits above the APKs of its version and below the next one", () => {
  assert.equal(versionCode("0.11.0-beta.4", 7), 1_011_008_007);
  assert.equal(versionCode("0.11.0", 8), 1_011_008_008);
  assert.equal(versionCode("0.11.0", 122, { apk: true }), 1_011_000_122);
  assert.equal(versionCode("1.0.0", 1), 1_100_008_001);
  assert.equal(versionCode("9.99.99", 1_999), 1_999_999_999);
  // Above everything the old scheme gave out (Play: 0.11.0-beta.4 → 110 050 002).
  assert.ok(versionCode("0.11.0", 1, { apk: true }) > 110_050_002);
  assert.ok(versionCode("0.11.0", 1) > versionCode("0.11.0", 7_999, { apk: true }));
  assert.ok(versionCode("0.11.1", 1, { apk: true }) > versionCode("0.11.0", 1_999));
  assert.ok(versionCode("0.12.0", 1, { apk: true }) > versionCode("0.11.99", 1_999));
  assert.ok(versionCode("1.0.0", 1, { apk: true }) > versionCode("0.99.99", 1_999));
  // android.yml's run numbers wrap instead of running into the Play builds.
  assert.equal(versionCode("0.11.0", 8_000, { apk: true }), 1_011_000_001);
  assert.ok(versionCode("10.99.99", 1_999) <= 2_100_000_000);
  assert.throws(() => versionCode("0.11.0", 0));
  assert.throws(() => versionCode("0.11.0", 2_000));
  assert.throws(() => versionCode("0.100.0", 1));
  assert.throws(() => versionCode("11.0.0", 1));
});

test("release notes go to the listing's languages, cut to Play's limit at a line", () => {
  const long = Array.from({ length: 40 }, (_, i) => `- Punkt ${i} mit etwas Text`).join("\n");
  const notes = releaseNotes({ de: long, en: "- Short\n" }, ["de-DE", "en-US", "en-GB", "fr-FR"]);
  assert.deepEqual(
    notes.map((n) => n.language),
    ["de-DE", "en-US", "en-GB"],
  );
  assert.ok(notes[0].text.length <= NOTES_LIMIT);
  assert.match(notes[0].text, /Text\n…$/);
  assert.equal(notes[1].text, "- Short");
});
