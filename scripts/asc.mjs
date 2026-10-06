// App Store Connect, from CI and from a terminal: the provisioning profiles the
// store builds are signed with, and the builds TestFlight has.
//
//   node scripts/asc.mjs bundle
//       Registers the bundle ID app.uwumail (iPhone, iPad and Mac: one app)
//       unless it is there. It needs no capability: notifications are local,
//       background refresh is an Info.plist key, the Keychain is the app's own.
//   node scripts/asc.mjs profiles <ios|macos> <certificate.pem> <folder>
//       The App Store profile for app.uwumail, made for that certificate,
//       written to <folder>/app.uwumail.mobileprovision (iOS) or
//       .provisionprofile (macOS). A profile that exists, is valid and names
//       the certificate is taken as it is; one that doesn't is made anew (the
//       old one of the same name deleted first). So a profile Apple
//       invalidated — the certificate renewed — heals on the next run without
//       anybody opening the developer portal. The bundle ID is registered on
//       the way if it is missing.
//   node scripts/asc.mjs builds [count]
//       The newest builds of UwUMail, iOS and macOS, with their processing state.
//
// The API key comes from the environment: ASC_KEY_ID, ASC_ISSUER_ID and
// ASC_KEY_PATH (the AuthKey_….p8 file). It needs the App Manager role or more.
// Nothing here prints the key or a profile. docs/app-store.md.

import { X509Certificate, createPrivateKey, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.appstoreconnect.apple.com";
const APP = "app.uwumail";
const BUNDLES = [APP];
const PLATFORMS = {
  ios: { type: "IOS_APP_STORE", name: "iOS", extension: "mobileprovision" },
  macos: { type: "MAC_APP_STORE", name: "macOS", extension: "provisionprofile" },
};

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function token() {
  const { ASC_KEY_ID: kid, ASC_ISSUER_ID: iss, ASC_KEY_PATH: path } = process.env;
  if (!kid || !iss || !path) fail("ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH have to be set.");
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${encode({ alg: "ES256", kid, typ: "JWT" })}.${encode({
    iss,
    iat: now,
    exp: now + 15 * 60,
    aud: "appstoreconnect-v1",
  })}`;
  const key = createPrivateKey(readFileSync(path));
  const signature = sign("sha256", Buffer.from(head), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${signature.toString("base64url")}`;
}

let bearer;
async function api(method, path, body) {
  bearer ??= token();
  const response = await fetch(path.startsWith("http") ? path : API + path, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text)
        .errors.map((e) => `${e.title}: ${e.detail}`)
        .join("; ");
    } catch {
      // not JSON: the text as it came
    }
    fail(`${method} ${path.split("?")[0]}: ${response.status} ${detail}`);
  }
  return text ? JSON.parse(text) : null;
}

const query = (params) => new URLSearchParams(params).toString();

async function findBundle(identifier) {
  const bundles = await api("GET", `/v1/bundleIds?${query({ "filter[identifier]": identifier, limit: "200" })}`);
  // The filter matches parts of identifiers too ("app.uwumail" finds "app.uwumail.desktop").
  return bundles.data.find((b) => b.attributes.identifier === identifier);
}

/** The bundle ID, registered for every platform (one app on iPhone, iPad and Mac) if missing. */
async function ensureBundle(identifier) {
  const found = await findBundle(identifier);
  if (found) {
    console.log(`Bundle ID ${identifier}: registered (${found.attributes.platform})`);
    return found;
  }
  const { data } = await api("POST", "/v1/bundleIds", {
    data: {
      type: "bundleIds",
      attributes: { identifier, name: "UwUMail", platform: "UNIVERSAL" },
    },
  });
  console.log(`Bundle ID ${identifier}: registered now (${data.attributes.platform})`);
  return data;
}

async function profiles(platform, certificatePem, folder) {
  const kind = PLATFORMS[platform];
  if (!kind || !certificatePem || !folder)
    fail("Usage: node scripts/asc.mjs profiles <ios|macos> <certificate.pem> <folder>");

  // The certificate by its serial number: the team may have more than one
  // distribution certificate (Xcode makes its own), this is the one we hold.
  const serial = new X509Certificate(readFileSync(certificatePem)).serialNumber.toUpperCase();
  const certificates = await api(
    "GET",
    `/v1/certificates?${query({ "filter[serialNumber]": serial, "fields[certificates]": "name" })}`,
  );
  const certificate = certificates.data[0];
  if (!certificate) fail(`No certificate with serial ${serial} in the team.`);
  console.log(`Certificate: ${certificate.attributes.name} (${certificate.id})`);

  mkdirSync(folder, { recursive: true });
  for (const identifier of BUNDLES) {
    const bundle = await ensureBundle(identifier);

    const name = `UwUMail ${kind.name} App Store ${identifier}`;
    const found = await api(
      "GET",
      `/v1/profiles?${query({ "filter[name]": name, include: "certificates", limit: "50" })}`,
    );
    // The name filter matches parts of names too.
    found.data = found.data.filter((p) => p.attributes.name === name);
    let profile = found.data.find(
      (p) =>
        p.attributes.profileState === "ACTIVE" &&
        p.attributes.profileType === kind.type &&
        p.relationships.certificates.data.some((c) => c.id === certificate.id),
    );
    if (!profile) {
      for (const stale of found.data) {
        console.log(`  ${name}: ${stale.attributes.profileState}, replaced`);
        await api("DELETE", `/v1/profiles/${stale.id}`);
      }
      ({ data: profile } = await api("POST", "/v1/profiles", {
        data: {
          type: "profiles",
          attributes: { name, profileType: kind.type },
          relationships: {
            bundleId: { data: { type: "bundleIds", id: bundle.id } },
            certificates: { data: [{ type: "certificates", id: certificate.id }] },
          },
        },
      }));
      console.log(`  ${name}: made`);
    }
    const file = join(folder, `${identifier}.${kind.extension}`);
    writeFileSync(file, Buffer.from(profile.attributes.profileContent, "base64"));
    console.log(`  ${identifier}: ${profile.attributes.uuid}, valid until ${profile.attributes.expirationDate}`);
  }
}

async function builds(count = "10") {
  const apps = await api("GET", `/v1/apps?${query({ "filter[bundleId]": APP })}`);
  const app = apps.data.find((a) => a.attributes.bundleId === APP);
  if (!app) fail(`No app record for ${APP} in App Store Connect.`);
  const list = await api(
    "GET",
    `/v1/builds?${query({
      "filter[app]": app.id,
      sort: "-uploadedDate",
      limit: count,
      include: "preReleaseVersion",
      "fields[builds]": "version,uploadedDate,processingState,expired,usesNonExemptEncryption,preReleaseVersion",
      "fields[preReleaseVersions]": "version,platform",
    })}`,
  );
  const versions = new Map((list.included ?? []).map((v) => [v.id, v.attributes]));
  for (const build of list.data) {
    const pre = versions.get(build.relationships?.preReleaseVersion?.data?.id) ?? {};
    const a = build.attributes;
    const encryption = a.usesNonExemptEncryption === null ? "export compliance open" : "export compliance answered";
    console.log(
      `${pre.platform ?? "?"} ${pre.version ?? "?"} (${a.version})  ${a.processingState}  ${a.uploadedDate}  ${encryption}`,
    );
  }
  if (!list.data.length) console.log("No builds yet.");
}

const [command, ...args] = process.argv.slice(2);
if (command === "bundle") await ensureBundle(APP);
else if (command === "profiles") await profiles(...args);
else if (command === "builds") await builds(...args);
else fail("Usage: node scripts/asc.mjs bundle | profiles <ios|macos> <certificate.pem> <folder> | builds [count]");
