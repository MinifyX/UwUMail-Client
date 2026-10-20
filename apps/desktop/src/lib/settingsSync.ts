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

import { CURRENCY_CHOICES, NYU_ANIMATIONS, UNDO_SEND_CHOICES, type FolderRef, type Settings } from "@/state/settings";

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
  "darkImages",
  "senderPictures",
  "undoSendSeconds",
  "linkConfirm",
] as const;
export type SyncedChoice = (typeof SYNCED_CHOICES)[number];

/**
 * Choices whose key isn't spelled like the setting, e.g. a feature's own namespace: the setting,
 * and its key on the server.
 */
export const KEYED_CHOICES = {
  assistCurrency: "assist.currency",
  assistRefineEvents: "assist.refineEvents",
  detectEvents: "mail.detectEvents",
  nyuAnimations: "nyu.animations",
} as const;
export type KeyedChoice = keyof typeof KEYED_CHOICES;

/** Lists that are one key per entry. */
export const SYNCED_LISTS = ["trustedSenders", "senderAppearance", "linkDomains"] as const;
export type SyncedList = (typeof SYNCED_LISTS)[number];

/**
 * How mailboxes and folders are arranged: the setting, and its key on the server. Mailboxes go by
 * their address (`unified.hidden:<address>`), folders by a `FolderRef` under an id derived from
 * it (`folderRefId`), so every device arrives at the same keys. `accounts.order` is one key
 * holding the addresses in order; without it, mailboxes keep their usual order.
 */
export const ARRANGEMENT = {
  unifiedHidden: "unified.hidden",
  unifiedFolders: "unified.folders",
  accountsOrder: "accounts.order",
  favoriteFolders: "folders.favorite",
  hiddenFolders: "folders.hidden",
} as const;
export type ArrangementField = keyof typeof ARRANGEMENT;
const FOLDER_LISTS = ["unifiedFolders", "favoriteFolders", "hiddenFolders"] as const;
type FolderList = (typeof FOLDER_LISTS)[number];

/** Everything that follows the account. The rest of the settings stays on this device. */
export type SyncedSettings = Pick<Settings, SyncedChoice | KeyedChoice | SyncedList | ArrangementField>;
export const SYNCED_FIELDS: readonly (keyof SyncedSettings)[] = [
  ...SYNCED_CHOICES,
  ...(Object.keys(KEYED_CHOICES) as KeyedChoice[]),
  ...SYNCED_LISTS,
  ...(Object.keys(ARRANGEMENT) as ArrangementField[]),
];

/** The setting a key of `KEYED_CHOICES` stands for; the key itself for every other choice. */
function fieldOf(key: string): keyof SyncedSettings {
  const keyed = Object.entries(KEYED_CHOICES).find(([, name]) => name === key);
  return (keyed ? keyed[0] : key) as keyof SyncedSettings;
}

export const SIGNATURE_PREFIX = "signature:";
/** The largest value the server keeps (`maxValueSize`), measured as JSON. */
export const MAX_VALUE_BYTES = 262_144;

const oneOf =
  (...allowed: unknown[]) =>
  (value: unknown) =>
    allowed.includes(value);
const isBoolean = (value: unknown) => typeof value === "boolean";

const CHOICES: Record<SyncedChoice | (typeof KEYED_CHOICES)[KeyedChoice], (value: unknown) => boolean> = {
  theme: oneOf("system", "light", "dark"),
  tone: oneOf("playful", "neutral"),
  language: oneOf("system", "de", "en"),
  conversations: isBoolean,
  remoteImages: oneOf("ask", "always"),
  mailAppearance: oneOf("auto", "light", "dark"),
  darkImages: isBoolean,
  senderPictures: isBoolean,
  undoSendSeconds: oneOf(...UNDO_SEND_CHOICES),
  linkConfirm: isBoolean,
  "assist.currency": oneOf(...CURRENCY_CHOICES),
  "assist.refineEvents": isBoolean,
  "mail.detectEvents": isBoolean,
  "nyu.animations": oneOf(...NYU_ANIMATIONS),
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

const FOLDER_MAX = 1024;
const ORDER_MAX = 200;

/** `{account, folder}`: a mailbox's address and a folder path in it ("/" between levels). */
export function isFolderRef(value: unknown): value is FolderRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (
    Object.keys(ref).length === 2 &&
    typeof ref.account === "string" &&
    isSyncableAddress(ref.account) &&
    typeof ref.folder === "string" &&
    ref.folder.length > 0 &&
    [...ref.folder].length <= FOLDER_MAX &&
    !hasControl(ref.folder)
  );
}

/** Mailbox addresses in order: lower case, each once, at most 200. */
function isAccountOrder(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= ORDER_MAX &&
    new Set(value).size === value.length &&
    value.every((entry) => typeof entry === "string" && isSyncableAddress(entry))
  );
}

/** SHA-256 of a text's UTF-8 bytes, hex. Synchronous, so keys can be made anywhere. */
function sha256Hex(text: string): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ];
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, k] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, k].forEach((value, i) => (h[i] = (h[i]! + value) | 0));
  }
  return h.map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
}

/** The id of a folder's keys: the same on every device (16 hex digits of SHA-256 of address, newline, path). */
export function folderRefId(ref: FolderRef): string {
  return sha256Hex(`${ref.account}\n${ref.folder}`).slice(0, 16);
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
  if (Object.hasOwn(CHOICES, key)) return CHOICES[key as keyof typeof CHOICES](value);
  if (key === ARRANGEMENT.accountsOrder) return isAccountOrder(value);
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
    case ARRANGEMENT.unifiedHidden:
      return value === true && isSyncableAddress(entry);
    case ARRANGEMENT.unifiedFolders:
    case ARRANGEMENT.favoriteFolders:
    case ARRANGEMENT.hiddenFolders:
      return /^[A-Za-z0-9_-]{1,64}$/.test(entry) && isFolderRef(value);
    default:
      return false;
  }
}

/** Choices are one key each; the server may miss them, but they are never removed. */
export function isChoiceKey(key: string): boolean {
  return Object.hasOwn(CHOICES, key);
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
  for (const [field, key] of Object.entries(KEYED_CHOICES)) values[key] = settings[field as KeyedChoice];
  for (const entry of settings.trustedSenders) values[`trustedSenders:${entry}`] = true;
  for (const [address, look] of Object.entries(settings.senderAppearance)) values[`senderAppearance:${address}`] = look;
  for (const domain of settings.linkDomains) values[`linkDomains:${domain}`] = true;
  for (const address of settings.unifiedHidden) values[`${ARRANGEMENT.unifiedHidden}:${address}`] = true;
  for (const field of FOLDER_LISTS) {
    for (const ref of settings[field]) values[`${ARRANGEMENT[field]}:${folderRefId(ref)}`] = ref;
  }
  if (settings.accountsOrder.length > 0) values[ARRANGEMENT.accountsOrder] = settings.accountsOrder;
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
  let hidden: Set<string> | null = null;
  const folders: Partial<Record<FolderList, Map<string, FolderRef>>> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && !isSyncable(key, value)) continue;
    if (key === ARRANGEMENT.accountsOrder) {
      changed.accountsOrder = value === null ? [] : (value as string[]);
      continue;
    }
    if (isChoiceKey(key)) {
      // A choice is never removed, only changed.
      const field = fieldOf(key);
      if (value !== null && settings[field] !== value) {
        Object.assign(changed, { [field]: value });
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
    } else if (list === ARRANGEMENT.unifiedHidden) {
      hidden ??= new Set(settings.unifiedHidden);
      if (value === null) hidden.delete(entry);
      else hidden.add(entry);
    } else {
      const field = FOLDER_LISTS.find((each) => ARRANGEMENT[each] === list);
      if (!field) continue;
      const refs = (folders[field] ??= new Map(settings[field].map((ref) => [folderRefId(ref), ref])));
      if (value === null) refs.delete(entry);
      else refs.set(entry, value as FolderRef);
    }
  }
  if (hidden) changed.unifiedHidden = [...hidden];
  for (const field of FOLDER_LISTS) {
    const refs = folders[field];
    if (refs) changed[field] = [...refs.values()];
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
