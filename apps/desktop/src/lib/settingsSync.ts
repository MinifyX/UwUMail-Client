/**
 * Settings that follow the account: how this app's settings map onto the server's settings
 * extension (`urn:uwumail:jmap:settings`), which values the server takes, and how its copy and
 * this device's copy come together.
 *
 * The same file lives in UwUMail-Webmail and in the UwUMail app. Keep both identical.
 *
 * The server keeps a flat map of keys to JSON values. Choices are one key each (`theme`); lists
 * are one key per entry (`trustedSenders:@shop.example`), so two devices adding to a list at the
 * same time never overwrite each other. Removing an entry sets its key to `null`.
 */

import { UNDO_SEND_CHOICES, type Settings } from "@/state/settings";

/** Keys and their values, as the server holds them. */
export type SettingsValues = Record<string, unknown>;
/** Keys to set; `null` removes one. */
export type SettingsPatch = Record<string, unknown>;

/** Choices that are one key each, spelled like the setting. */
export const SYNCED_CHOICES = [
  "theme",
  "tone",
  "language",
  "conversations",
  "remoteImages",
  "mailAppearance",
  "senderPictures",
  "undoSendSeconds",
  "linkConfirm",
] as const;
export type SyncedChoice = (typeof SYNCED_CHOICES)[number];

/** Lists that are one key per entry. */
export const SYNCED_LISTS = ["trustedSenders", "senderAppearance", "linkDomains"] as const;
export type SyncedList = (typeof SYNCED_LISTS)[number];

/** Everything that follows the account. The rest of the settings stays on this device. */
export type SyncedSettings = Pick<Settings, SyncedChoice | SyncedList>;
export const SYNCED_FIELDS: readonly (keyof SyncedSettings)[] = [...SYNCED_CHOICES, ...SYNCED_LISTS];

export const SIGNATURE_PREFIX = "signature:";
/** The largest value the server keeps (`maxValueSize`), measured as JSON. */
export const MAX_VALUE_BYTES = 262_144;

const oneOf =
  (...allowed: unknown[]) =>
  (value: unknown) =>
    allowed.includes(value);
const isBoolean = (value: unknown) => typeof value === "boolean";

const CHOICES: Record<SyncedChoice, (value: unknown) => boolean> = {
  theme: oneOf("system", "light", "dark"),
  tone: oneOf("playful", "neutral"),
  language: oneOf("system", "de", "en"),
  conversations: isBoolean,
  remoteImages: oneOf("ask", "always"),
  mailAppearance: oneOf("auto", "light", "dark"),
  senderPictures: isBoolean,
  undoSendSeconds: oneOf(...UNDO_SEND_CHOICES),
  linkConfirm: isBoolean,
};

const ENTRY_MAX = 254;
const HOST_MAX = 253;

/** A lower-case ASCII host name (IDNs in punycode), as links point at it. */
function isAsciiHost(host: string): boolean {
  return (
    host.length > 0 &&
    host.length <= HOST_MAX &&
    host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}

/** The domain of a mail address: two labels at least, lower case; letters of any script. */
function isMailDomain(domain: string): boolean {
  return (
    [...domain].length <= HOST_MAX &&
    domain.includes(".") &&
    domain.split(".").every((label) => {
      const chars = [...label];
      return (
        chars.length > 0 &&
        chars.length <= 63 &&
        !label.startsWith("-") &&
        !label.endsWith("-") &&
        chars.every((c) => c === "-" || /^[a-z0-9]$/.test(c) || (/^[\p{L}\p{N}]$/u.test(c) && c === c.toLowerCase()))
      );
    })
  );
}

/** Control characters (U+0000 to U+001F and U+007F). */
function hasControl(text: string): boolean {
  return [...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
}

/** A lower-case mail address `local@domain.tld`, the way the server checks it. */
export function isSyncableAddress(entry: string): boolean {
  const at = entry.indexOf("@");
  if (at <= 0 || [...entry].length > ENTRY_MAX) return false;
  const local = entry.slice(0, at);
  return (
    [...local].length <= 64 &&
    !/[@\s]/.test(local) &&
    !hasControl(local) &&
    local === local.toLowerCase() &&
    isMailDomain(entry.slice(at + 1))
  );
}

function isSignatureValue(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const known = ["email", "name", "html", "forNew", "forReplies"];
  if (Object.keys(entry).some((key) => !known.includes(key))) return false;
  return (
    typeof entry.email === "string" &&
    (entry.email === "" || isSyncableAddress(entry.email.toLowerCase())) &&
    typeof entry.name === "string" &&
    [...entry.name].length <= 100 &&
    !hasControl(entry.name) &&
    typeof entry.html === "string" &&
    typeof entry.forNew === "boolean" &&
    typeof entry.forReplies === "boolean"
  );
}

/** Bytes a value takes on the server, as UTF-8 JSON. */
export function valueBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Whether the server takes this key with this value. Everything it would refuse stays on this
 * device: one refused key fails the whole write, so it must never be sent.
 */
export function isSyncable(key: string, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (valueBytes(value) > MAX_VALUE_BYTES) return false;
  if (key in CHOICES) return CHOICES[key as SyncedChoice](value);
  const colon = key.indexOf(":");
  if (colon < 0) return false;
  const entry = key.slice(colon + 1);
  switch (key.slice(0, colon)) {
    case "trustedSenders":
      return value === true && (entry.startsWith("@") ? isMailDomain(entry.slice(1)) : isSyncableAddress(entry));
    case "senderAppearance":
      return (value === "light" || value === "dark") && isSyncableAddress(entry);
    case "linkDomains":
      return value === true && isAsciiHost(entry);
    case "signature":
      return /^[A-Za-z0-9_-]{1,64}$/.test(entry) && isSignatureValue(value);
    default:
      return false;
  }
}

/** Choices are one key each; the server may miss them, but they are never removed. */
export function isChoiceKey(key: string): boolean {
  return key in CHOICES;
}

export function isSignatureKey(key: string): boolean {
  return key.startsWith(SIGNATURE_PREFIX);
}

/** Only what the server would take; anything else (another version's keys, broken values) is left out. */
export function syncableValues(values: SettingsValues): SettingsValues {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => isSyncable(key, value)));
}

/** The synced settings as keys. Entries the server wouldn't take stay out: they are this device's. */
export function settingsToValues(settings: SyncedSettings): SettingsValues {
  const values: SettingsValues = {};
  for (const key of SYNCED_CHOICES) values[key] = settings[key];
  for (const entry of settings.trustedSenders) values[`trustedSenders:${entry}`] = true;
  for (const [address, look] of Object.entries(settings.senderAppearance)) values[`senderAppearance:${address}`] = look;
  for (const domain of settings.linkDomains) values[`linkDomains:${domain}`] = true;
  return syncableValues(values);
}

/**
 * The settings with `patch` applied, as the fields that changed. Signature keys and anything
 * the server wouldn't take are skipped; entries that never travel stay as they are.
 */
export function applyToSettings(settings: SyncedSettings, patch: SettingsPatch): Partial<SyncedSettings> {
  const changed: Partial<SyncedSettings> = {};
  let trusted: Set<string> | null = null;
  let domains: Set<string> | null = null;
  let looks: Record<string, "light" | "dark"> | null = null;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && !isSyncable(key, value)) continue;
    if (isChoiceKey(key)) {
      // A choice is never removed, only changed.
      if (value !== null && settings[key as SyncedChoice] !== value) {
        Object.assign(changed, { [key]: value });
      }
      continue;
    }
    const colon = key.indexOf(":");
    const list = key.slice(0, colon);
    const entry = key.slice(colon + 1);
    if (list === "trustedSenders") {
      trusted ??= new Set(settings.trustedSenders);
      if (value === null) trusted.delete(entry);
      else trusted.add(entry);
    } else if (list === "linkDomains") {
      domains ??= new Set(settings.linkDomains);
      if (value === null) domains.delete(entry);
      else domains.add(entry);
    } else if (list === "senderAppearance") {
      looks ??= { ...settings.senderAppearance };
      if (value === null) delete looks[entry];
      else looks[entry] = value as "light" | "dark";
    }
  }
  if (trusted) changed.trustedSenders = [...trusted];
  if (domains) changed.linkDomains = [...domains];
  if (looks) changed.senderAppearance = looks;
  return changed;
}

/** Same JSON value, key order aside. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length && keys.every((key) => key in right && sameValue(left[key], right[key]))
  );
}

/** The patch that turns `before` into `after`. */
export function diffValues(before: SettingsValues, after: SettingsValues): SettingsPatch {
  const patch: SettingsPatch = {};
  for (const [key, value] of Object.entries(after)) {
    if (!(key in before) || !sameValue(before[key], value)) patch[key] = value;
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) patch[key] = null;
  }
  return patch;
}

export function applyPatch(values: SettingsValues, patch: SettingsPatch): SettingsValues {
  const next = { ...values };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

export interface MergeInput {
  /** What the server holds, already passed through `syncableValues`. */
  server: SettingsValues;
  /** What this device holds, as keys. */
  local: SettingsValues;
  /** Changes made here that haven't reached the server yet. */
  pending: SettingsPatch;
  /**
   * The first merge with this account: lists become the union of both sides. Later, an entry
   * this device has and the server doesn't was removed on another device.
   */
  firstSync: boolean;
  /** Keys neither side touches, e.g. one the server refused. */
  keep?: ReadonlySet<string>;
}

export interface MergeResult {
  /** Changes for this device; `null` removes. */
  apply: SettingsPatch;
  /** What still has to go to the server. */
  pending: SettingsPatch;
}

/**
 * Brings the server's copy and this device's together, key by key:
 *
 * - a key changed here and not sent yet wins, and stays pending;
 * - otherwise the server's value wins;
 * - a choice the server doesn't have is sent there;
 * - a list entry the server doesn't have is sent there on the first merge (union), and removed
 *   here later on (another device removed it).
 */
export function mergeWithServer({ server, local, pending, firstSync, keep }: MergeInput): MergeResult {
  const apply: SettingsPatch = {};
  const stillPending: SettingsPatch = {};
  const keys = new Set([...Object.keys(server), ...Object.keys(local), ...Object.keys(pending)]);
  for (const key of keys) {
    if (keep?.has(key)) continue;
    const there = key in server ? server[key] : null;
    if (key in pending) {
      if (!sameValue(pending[key], there)) stillPending[key] = pending[key];
      continue;
    }
    const here = key in local ? local[key] : null;
    if (there !== null) {
      if (!sameValue(here, there)) apply[key] = there;
    } else if (here !== null) {
      if (isChoiceKey(key) || firstSync) stillPending[key] = here;
      else apply[key] = null;
    }
  }
  return { apply, pending: stillPending };
}
