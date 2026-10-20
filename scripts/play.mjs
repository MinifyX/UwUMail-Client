// Google Play, from CI and from a terminal: the App Bundle of a release into a
// test track, and what the tracks hold.
//
//   node scripts/play.mjs version-code [--apk] <run number>
//       The versionCode of the version in tauri.conf.json, for the Play build
//       (play.yml's run number) or with --apk for the GitHub APK (android.yml's):
//       10⁹ + major·10⁸ + minor·10⁶ + patch·10⁴ + n, n = 8000 + run for Play,
//       1…7999 for the APK. So a Play build is always newer than every GitHub
//       APK of the same version and older than every build of the next one.
//   node scripts/play.mjs upload <app.aab>
//       Uploads the bundle and rolls it out in PLAY_TRACK (default internal)
//       with PLAY_STATUS (default completed), the release notes of the version
//       (release-notes/<version>.json) as "What's new" in the store listing's
//       German and English languages. A versionCode that isn't above every one
//       Play has seen fails before the upload. While the app itself is still a
//       draft in the Play Console, Google takes only draft releases: the release
//       is then made as a draft, with a notice.
//   node scripts/play.mjs tracks
//       Every track with its releases, versionCodes and status.
//
// The service account's key comes from the environment: PLAY_SERVICE_ACCOUNT_JSON
// (the JSON itself) or PLAY_SERVICE_ACCOUNT_PATH (the file). The account needs
// the app's "Release to testing tracks" permission in the Play Console. Nothing
// here prints the key. docs/play-store.md.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

export const PACKAGE = "app.uwumail";
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const UPLOAD = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`;
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
/** Play's limit for "What's new", per language. */
export const NOTES_LIMIT = 500;
/**
 * Every versionCode starts here: above everything the old scheme (major·10⁹ + minor·10⁷ +
 * patch·10⁵ + run, up to 0.11.0-beta.4 → 110 050 002 on Play) ever gave out, so codes never sink.
 */
const BASE = 1_000_000_000;
/** Codes per version (patch step); the last part `n` of a code stays below it. */
const SLOT = 10_000;
/** The APK's n (android.yml) stays below this, the Play build's starts at it. */
export const PLAY_OFFSET = 8_000;
/** Play's limit for versionCodes (below Android's int maximum). */
const PLAY_LIMIT = 2_100_000_000;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

/**
 * The versionCode of build `run` of `version` ("0.11.0-beta.4" counts as 0.11.0): the Play
 * build's (play.yml run numbers 1…1999) or with `apk` the GitHub APK's (android.yml run numbers,
 * which wrap after 7999 so CI never stops on them).
 */
export function versionCode(version, run, { apk = false } = {}) {
  const [major, minor, patch] = version.split("-")[0].split(".").map(Number);
  const number = Number(run);
  if (![major, minor, patch, number].every(Number.isInteger) || number < 1)
    throw new Error(`No versionCode for version ${version}, run ${run}`);
  if (minor > 99 || patch > 99) throw new Error(`Version ${version}: minor and patch go up to 99`);
  if (!apk && number >= SLOT - PLAY_OFFSET)
    throw new Error(`play.yml run ${run}: Play builds have run numbers up to ${SLOT - PLAY_OFFSET - 1}`);
  const n = apk ? ((number - 1) % (PLAY_OFFSET - 1)) + 1 : PLAY_OFFSET + number;
  const code = BASE + major * 1e8 + minor * 1e6 + patch * 1e4 + n;
  if (code > PLAY_LIMIT) throw new Error(`versionCode ${code} is above Play's limit`);
  return code;
}

/**
 * "What's new" for the listing's languages (`de-DE`, `en-US`, …) from the release notes
 * ({ de, en }): each language gets the notes of its first part, cut to Play's limit at a line
 * break. Languages without notes are left out.
 */
export function releaseNotes(notes, languages) {
  const out = [];
  for (const language of languages) {
    let text = notes[language.split("-")[0]]?.trim();
    if (!text) continue;
    if (text.length > NOTES_LIMIT) {
      const cut = text.slice(0, NOTES_LIMIT - 2);
      const line = cut.lastIndexOf("\n");
      text = `${(line > 0 ? cut.slice(0, line) : cut).trimEnd()}\n…`;
    }
    out.push({ language, text });
  }
  return out;
}

function serviceAccount() {
  const { PLAY_SERVICE_ACCOUNT_JSON: json, PLAY_SERVICE_ACCOUNT_PATH: path } = process.env;
  if (!json && !path) fail("PLAY_SERVICE_ACCOUNT_JSON or PLAY_SERVICE_ACCOUNT_PATH has to be set.");
  try {
    const account = JSON.parse(json || readFileSync(path, "utf8"));
    if (account.client_email && account.private_key) return account;
  } catch {
    // reported below, without the content
  }
  fail("The service account key isn't a service account's JSON key (client_email, private_key).");
}

async function token() {
  const account = serviceAccount();
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: account.client_email,
    scope: SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 30 * 60,
  })}`;
  const signature = createSign("RSA-SHA256").update(head).sign(account.private_key, "base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${head}.${signature}`,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token)
    fail(`Google's token endpoint: ${response.status} ${body.error ?? ""} ${body.error_description ?? ""}`);
  return body.access_token;
}

class PlayError extends Error {}

let bearer;
async function api(method, url, body, contentType = "application/json") {
  bearer ??= await token();
  const response = await fetch(url.startsWith("https:") ? url : API + url, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": contentType },
    body: body === undefined ? undefined : contentType === "application/json" ? JSON.stringify(body) : body,
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).error.message;
    } catch {
      // not JSON: the text as it came
    }
    if (response.status === 404 && url === "/edits")
      detail += ` — is there an app ${PACKAGE} in the Play Console, with a first bundle uploaded by hand, and may the service account see it?`;
    throw new PlayError(`${method} ${url.split("?")[0]}: ${response.status} ${detail}`);
  }
  return text ? JSON.parse(text) : null;
}

async function edit(work) {
  const { id } = await api("POST", "/edits");
  try {
    return await work(`/edits/${id}`, id);
  } catch (error) {
    await api("DELETE", `/edits/${id}`).catch(() => {});
    throw error;
  }
}

function version() {
  return JSON.parse(readFileSync(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url))).version;
}

async function upload(file) {
  if (!file) fail("Usage: node scripts/play.mjs upload <app.aab>");
  const track = process.env.PLAY_TRACK || "internal";
  const status = process.env.PLAY_STATUS || "completed";
  const name = version();
  const notes = JSON.parse(readFileSync(new URL(`../release-notes/${name}.json`, import.meta.url)));
  const bundle = readFileSync(file);

  await edit(async (path, id) => {
    // Every versionCode Play knows, in any track or none: the new one has to be above them all.
    const [{ bundles = [] }, { apks = [] }, { listings = [] }] = await Promise.all([
      api("GET", `${path}/bundles`),
      api("GET", `${path}/apks`),
      api("GET", `${path}/listings`),
    ]);
    const highest = Math.max(0, ...bundles.map((b) => b.versionCode), ...apks.map((a) => a.versionCode));

    const uploaded = await api(
      "POST",
      `${UPLOAD}/edits/${id}/bundles?uploadType=media`,
      bundle,
      "application/octet-stream",
    );
    console.log(`Uploaded ${file}: versionCode ${uploaded.versionCode}, sha256 ${uploaded.sha256}`);
    if (uploaded.versionCode <= highest)
      throw new PlayError(`versionCode ${uploaded.versionCode} isn't above ${highest}, the highest Play has.`);

    const release = (status) => ({
      track,
      releases: [
        {
          name: `${name} (${uploaded.versionCode})`,
          versionCodes: [String(uploaded.versionCode)],
          status,
          releaseNotes: releaseNotes(
            notes,
            listings.map((l) => l.language),
          ),
        },
      ],
    });
    try {
      await api("PUT", `${path}/tracks/${track}`, release(status));
      await api("POST", `${path}:commit`);
      console.log(`${name} (${uploaded.versionCode}) is in ${track}, ${status}.`);
    } catch (error) {
      if (status === "draft" || !/draft app/i.test(error.message)) throw error;
      console.log(`::notice::The app is still a draft in the Play Console: ${name} goes into ${track} as a draft.`);
      await api("PUT", `${path}/tracks/${track}`, release("draft"));
      await api("POST", `${path}:commit`);
      console.log(`${name} (${uploaded.versionCode}) is in ${track}, draft.`);
    }
  });
}

async function tracks() {
  await edit(async (path) => {
    const { tracks = [] } = await api("GET", `${path}/tracks`);
    for (const track of tracks) {
      console.log(track.track);
      for (const release of track.releases ?? [])
        console.log(`  ${release.name ?? "?"}  [${(release.versionCodes ?? []).join(", ")}]  ${release.status}`);
    }
    if (!tracks.length) console.log("No tracks yet.");
    // Only looked: nothing to commit.
    await api("DELETE", path);
  });
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "version-code") {
      const apk = args[0] === "--apk";
      console.log(versionCode(version(), args[apk ? 1 : 0], { apk }));
    } else if (command === "upload") await upload(args[0]);
    else if (command === "tracks") await tracks();
    else fail("Usage: node scripts/play.mjs version-code [--apk] <run> | upload <app.aab> | tracks");
  } catch (error) {
    fail(error.message);
  }
}
