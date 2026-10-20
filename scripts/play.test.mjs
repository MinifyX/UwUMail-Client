import assert from "node:assert/strict";
import { test } from "node:test";

import { NOTES_LIMIT, releaseNotes, versionCode } from "./play.mjs";

test("Play's versionCode sits above the APKs of its version and below the next one", () => {
  assert.equal(versionCode("0.11.0-beta.4", 7), 110_050_007);
  assert.equal(versionCode("0.11.0", 8), 110_050_008);
  // android.yml: 0.11.0, run 119 → 110 000 119
  assert.ok(versionCode("0.11.0-beta.4", 1) > 110_000_119);
  assert.ok(versionCode("0.11.0", 49_999) < 110_100_000);
  assert.ok(versionCode("1.0.0", 1) > versionCode("0.99.99", 49_999));
  assert.throws(() => versionCode("0.11.0", 0));
  assert.throws(() => versionCode("0.11.0", 50_000));
  assert.throws(() => versionCode("0.100.0", 1));
  assert.throws(() => versionCode("3.0.0", 1));
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
