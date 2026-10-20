import assert from "node:assert/strict";
import { test } from "node:test";

import { NOTES_LIMIT, releaseNotes, versionCode } from "./play.mjs";

test("the versionCode follows the version, betas below the final release", () => {
  assert.equal(versionCode("0.11.0-beta.4"), 110_004);
  assert.equal(versionCode("0.11.0"), 110_099);
  assert.equal(versionCode("1.2.3"), 1_020_399);
  assert.equal(versionCode("9.98.98"), 9_989_899);
  assert.ok(versionCode("0.11.0-beta.98") < versionCode("0.11.0"));
  assert.ok(versionCode("0.11.0") < versionCode("0.11.1-beta.1"));
  assert.ok(versionCode("0.98.98") < versionCode("1.0.0-beta.1"));
  for (const bad of [
    "0.11.0-beta.0",
    "0.11.0-beta.99",
    "0.99.0",
    "0.1.99",
    "0.11.0-rc.1",
    "0.11",
    "v0.11.0",
    "0.11.0-beta",
  ])
    assert.throws(() => versionCode(bad), undefined, bad);
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
