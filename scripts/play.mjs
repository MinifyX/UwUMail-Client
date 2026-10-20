// Google Play, from CI and from a terminal: the App Bundle of a release into a
// test track, and what the tracks hold.
//
//   node scripts/play.mjs version-code
//       The versionCode of the version in tauri.conf.json, the same for the Play
//       build and the GitHub APK: major·10⁶ + minor·10⁴ + patch·10² + beta
//       number, 99 for the final release (0.11.0-beta.4 → 110004, 0.11.0 →
//       110099). No run number: a re-build of a version has the same code.
//   node scripts/play.mjs upload <app.aab>
//       Uploads the bundle and rolls it out in PLAY_TRACK (default internal)
//       with PLAY_STATUS (default completed), the release notes of the version
//       (release-notes/<version>.json) as "What's new" in the store listing's
//       German and English languages. A versionCode that isn't above every one
//       in Play's tracks fails before the upload (bump the version). While the app itself is still a
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
/** The code's last two digits for a final release, above every beta (1…98). */
const FINAL = 99;
/** Play's limit for versionCodes (below Android's int maximum). */
const PLAY_LIMIT = 2_100_000_000;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

/**
 * The versionCode of `version`: major·10⁶ + minor·10⁴ + patch·10² + beta number, 99 for the
 * final release ("0.11.0-beta.4" → 110004, "0.11.0" → 110099). Minor, patch and beta go up to 98.
 */
export function versionCode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(String(version));
  if (!match) throw new Error(`No versionCode for version ${version}: only x.y.z and x.y.z-beta.N`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const beta = match[4] === undefined ? FINAL : Number(match[4]);
  if (minor > 98 || patch > 98 || beta < 1 || (match[4] !== undefined && beta >= FINAL))
    throw new Error(`Version ${version}: minor and patch go up to 98, betas from 1 to 98`);
  const code = major * 1e6 + minor * 1e4 + patch * 1e2 + beta;
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
    // The versionCodes released in any track (the bundle library may hold discarded drafts with
    // other codes; only released ones count): the new one has to be above them all.
    const code = versionCode(name);
    const [{ tracks = [] }, { listings = [] }] = await Promise.all([
      api("GET", `${path}/tracks`),
      api("GET", `${path}/listings`),
    ]);
    const released = tracks.flatMap((t) => (t.releases ?? []).flatMap((r) => (r.versionCodes ?? []).map(Number)));
    const highest = Math.max(0, ...released);
    if (released.includes(code))
      throw new PlayError(`versionCode ${code} (${name}) is already in Play: bump the version for a new upload.`);
    if (code < highest)
      throw new PlayError(`versionCode ${code} (${name}) isn't above ${highest}, the highest in Play's tracks.`);

    let uploaded;
    try {
      uploaded = await api(
        "POST",
        `${UPLOAD}/edits/${id}/bundles?uploadType=media`,
        bundle,
        "application/octet-stream",
      );
    } catch (error) {
      if (/already been used/i.test(error.message))
        throw new PlayError(
          `versionCode ${code} (${name}) was uploaded to Play before: bump the version. ${error.message}`,
        );
      throw error;
    }
    console.log(`Uploaded ${file}: versionCode ${uploaded.versionCode}, sha256 ${uploaded.sha256}`);
    if (uploaded.versionCode !== code)
      throw new PlayError(`The bundle has versionCode ${uploaded.versionCode}, ${name} needs ${code}.`);

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
    if (command === "version-code") console.log(versionCode(version()));
    else if (command === "upload") await upload(args[0]);
    else if (command === "tracks") await tracks();
    else fail("Usage: node scripts/play.mjs version-code | upload <app.aab> | tracks");
  } catch (error) {
    fail(error.message);
  }
}
