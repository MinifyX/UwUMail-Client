/**
 * Turning contact cards (JSContact, RFC 9553) into the shapes the contacts view works with, and
 * back. The engine hands out every card as JSContact: as a UwUMail server sends it over JMAP
 * Contacts (RFC 9610), or converted from a CardDAV vCard. Kept like the webmail's
 * src/backend/jmap/contacts.ts, without the JMAP address book parts the engine does itself.
 *
 * The editor shows a part of a card. Saving sends a patch of just that part, and entries the
 * editor knows (an email, a phone number) keep what it doesn't show, like labels and preferences,
 * so a card a phone made over CardDAV comes back with everything it had.
 */

import type { ContactEmail, ContactInput, ContactKind, ContactPhone, ContactPostal, ContactRecord } from "./types";

type Json = Record<string, unknown>;

/** A card with the app's ids in `id` and `addressBookIds`. */
export interface JmapCard extends Json {
  id: string;
  addressBookIds?: Record<string, boolean>;
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const entries = (value: unknown): [string, Json][] =>
  isObject(value) ? Object.entries(value).filter((entry): entry is [string, Json] => isObject(entry[1])) : [];

// ------------------------------------------------------------------------------------------------
// Reading

function kindOf(entry: Json): ContactKind {
  const contexts = isObject(entry.contexts) ? entry.contexts : {};
  if (contexts.work === true) return "work";
  if (contexts.private === true) return "home";
  return "other";
}

function phoneKindOf(entry: Json): ContactPhone["kind"] {
  const features = isObject(entry.features) ? entry.features : {};
  return features.mobile === true ? "mobile" : kindOf(entry);
}

/** Address component kinds that make up the street line, in JSContact's words. */
const STREET_KINDS = new Set([
  "name",
  "number",
  "block",
  "building",
  "floor",
  "apartment",
  "room",
  "extension",
  "direction",
  "subdistrict",
  "district",
  "postOfficeBox",
]);

function components(value: unknown): { kind: string; value: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isObject)
    .map((part) => ({ kind: text(part.kind), value: text(part.value) }))
    .filter((part) => part.kind !== "separator" && part.value !== "");
}

function toPostal(id: string, entry: Json): ContactPostal {
  const parts = components(entry.components);
  const of = (kind: string) =>
    parts
      .filter((part) => part.kind === kind)
      .map((part) => part.value)
      .join(" ");
  const street = parts
    .filter((part) => STREET_KINDS.has(part.kind))
    .map((part) => part.value)
    .join(" ");
  return {
    id,
    // Without components, the whole address is in `full`.
    street: parts.length === 0 ? text(entry.full) : street,
    postcode: of("postcode"),
    locality: of("locality"),
    region: of("region"),
    country: of("country"),
    kind: kindOf(entry),
  };
}

function two(value: unknown): string {
  return typeof value === "number" ? String(value).padStart(2, "0") : "";
}

function birthdayOf(card: Json): { key: string; date: string } | null {
  for (const [key, entry] of entries(card.anniversaries)) {
    if (entry.kind !== "birth" || !isObject(entry.date)) continue;
    const date = entry.date;
    if (typeof date.utc === "string") return { key, date: date.utc.slice(0, 10) };
    if (typeof date.month !== "number" || typeof date.day !== "number") continue;
    const year = typeof date.year === "number" ? String(date.year).padStart(4, "0") : "-";
    return { key, date: `${year}-${two(date.month)}-${two(date.day)}` };
  }
  return null;
}

function firstText(map: unknown, field: string): { key: string; value: string } | null {
  const first = entries(map)[0];
  return first ? { key: first[0], value: text(first[1][field]) } : null;
}

/** Given and surname of a card; a card with only a full name has it split at its last space. */
function nameParts(card: Json): { given: string; surname: string; full: string } {
  const name = isObject(card.name) ? card.name : {};
  const parts = components(name.components);
  const of = (kind: string) =>
    parts
      .filter((part) => part.kind === kind)
      .map((part) => part.value)
      .join(" ");
  const full = text(name.full).trim();
  if (parts.length === 0 && full) {
    const space = full.lastIndexOf(" ");
    return space < 0
      ? { given: full, surname: "", full }
      : { given: full.slice(0, space), surname: full.slice(space + 1), full };
  }
  return { given: of("given"), surname: of("surname"), full };
}

function photoOf(card: Json): string | null {
  for (const [, entry] of entries(card.media)) {
    const uri = text(entry.uri);
    // Only pictures inside the card: a link elsewhere would tell that site who looks at the contact.
    if (entry.kind === "photo" && /^data:image\//i.test(uri)) return uri;
  }
  return null;
}

export function toContactRecord(card: JmapCard, accountId: string): ContactRecord {
  const { given, surname, full } = nameParts(card);
  const organization = firstText(card.organizations, "name")?.value ?? "";
  const emails: ContactEmail[] = entries(card.emails).map(([id, entry]) => ({
    id,
    address: text(entry.address),
    kind: kindOf(entry),
  }));
  const displayName = full || [given, surname].filter(Boolean).join(" ") || organization || emails[0]?.address || "";
  return {
    id: card.id,
    accountId,
    addressBookId: Object.keys(card.addressBookIds ?? {}).find((id) => card.addressBookIds?.[id]) ?? "",
    displayName,
    given,
    surname,
    organization,
    title: firstText(card.titles, "name")?.value ?? "",
    emails,
    phones: entries(card.phones).map(([id, entry]) => ({ id, number: text(entry.number), kind: phoneKindOf(entry) })),
    addresses: entries(card.addresses).map(([id, entry]) => toPostal(id, entry)),
    birthday: birthdayOf(card)?.date ?? null,
    note: firstText(card.notes, "note")?.value ?? "",
    photo: photoOf(card),
    isGroup: card.kind === "group",
  };
}

// ------------------------------------------------------------------------------------------------
// Writing

function contextsFor(kind: ContactKind): Json | undefined {
  if (kind === "work") return { work: true };
  if (kind === "home") return { private: true };
  return undefined;
}

/** An entry with a new kind; what else it had stays. */
function withKind(entry: Json, kind: ContactKind): Json {
  const next = { ...entry };
  const contexts = contextsFor(kind);
  if (contexts) next.contexts = contexts;
  else delete next.contexts;
  return next;
}

function freeKey(taken: Set<string>, prefix: string): string {
  for (let n = 1; ; n++) {
    const key = `${prefix}${n}`;
    if (!taken.has(key)) {
      taken.add(key);
      return key;
    }
  }
}

/** A map of entries from the editor's list: known ones from the card with the changes, new ones fresh. */
function entryMap<T extends { id: string }>(
  original: unknown,
  list: T[],
  prefix: string,
  keep: (item: T) => boolean,
  change: (entry: Json | null, item: T) => Json,
): Json | null {
  const before = new Map(entries(original));
  const taken = new Set(before.keys());
  const out: Json = {};
  for (const item of list.filter(keep)) {
    const existing = item.id ? before.get(item.id) : undefined;
    const key = existing ? item.id : freeKey(taken, prefix);
    out[key] = change(existing ?? null, item);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function emailEntries(original: unknown, list: ContactEmail[]): Json | null {
  return entryMap(
    original,
    list,
    "e",
    (email) => email.address.trim() !== "",
    (entry, email) => {
      const base = entry ?? {};
      const next = kindOf(base) === email.kind && entry ? { ...base } : withKind(base, email.kind);
      next.address = email.address.trim();
      return next;
    },
  );
}

function phoneEntries(original: unknown, list: ContactPhone[]): Json | null {
  return entryMap(
    original,
    list,
    "p",
    (phone) => phone.number.trim() !== "",
    (entry, phone) => {
      const base = entry ?? {};
      let next: Json = { ...base };
      if (!entry || phoneKindOf(base) !== phone.kind) {
        const features = isObject(base.features) ? { ...base.features } : {};
        if (phone.kind === "mobile") {
          next.features = { ...features, mobile: true };
        } else {
          delete features.mobile;
          if (Object.keys(features).length > 0) next.features = features;
          else delete next.features;
          next = withKind(next, phone.kind);
        }
      }
      next.number = phone.number.trim();
      return next;
    },
  );
}

function postalEntries(original: unknown, list: ContactPostal[]): Json | null {
  const before = new Map(entries(original));
  return entryMap(
    original,
    list,
    "a",
    (postal) => [postal.street, postal.postcode, postal.locality, postal.region, postal.country].some((v) => v.trim()),
    (entry, postal) => {
      if (!entry)
        return { ...(contextsFor(postal.kind) ? { contexts: contextsFor(postal.kind) } : {}), ...parts(postal) };
      const was = toPostal(postal.id, before.get(postal.id) ?? entry);
      const same = (["street", "postcode", "locality", "region", "country"] as const).every(
        (field) => was[field] === postal[field].trim(),
      );
      const next = was.kind === postal.kind ? { ...entry } : withKind(entry, postal.kind);
      if (same) return next;
      delete next.full;
      delete next.isOrdered;
      delete next.defaultSeparator;
      return { ...next, ...parts(postal) };
    },
  );
}

function parts(postal: ContactPostal): Json {
  const list = [
    ["name", postal.street],
    ["postcode", postal.postcode],
    ["locality", postal.locality],
    ["region", postal.region],
    ["country", postal.country],
  ]
    .map(([kind, value]) => ({ kind: kind!, value: value!.trim() }))
    .filter((part) => part.value !== "");
  return { components: list };
}

/** The order name components are written in when the editor makes the name anew. */
const NAME_ORDER = ["title", "given", "given2", "surname", "surname2", "generation", "credential"];

function nameFor(original: unknown, given: string, surname: string, fallback: string): Json {
  const name = isObject(original) ? { ...original } : {};
  const kept = (Array.isArray(name.components) ? name.components : [])
    .filter(isObject)
    .filter((part) => part.kind !== "given" && part.kind !== "surname" && part.kind !== "separator");
  const added = [
    ...(given ? [{ kind: "given", value: given }] : []),
    ...(surname ? [{ kind: "surname", value: surname }] : []),
  ];
  const rank = (kind: unknown) => {
    const index = NAME_ORDER.indexOf(text(kind));
    return index < 0 ? NAME_ORDER.length : index;
  };
  const list = [...kept, ...added].sort((a, b) => rank(a.kind) - rank(b.kind));
  delete name.isOrdered;
  delete name.defaultSeparator;
  if (list.length > 0) name.components = list;
  else delete name.components;
  // vCard needs a full name (FN); it follows the parts, or what else names the contact.
  name.full =
    list
      .map((part) => text(part.value))
      .filter(Boolean)
      .join(" ") || fallback;
  return name;
}

function birthdayDate(date: string): Json | null {
  const match = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [, year, month, day] = match;
  return {
    "@type": "PartialDate",
    ...(year !== "-" ? { year: Number(year) } : {}),
    month: Number(month),
    day: Number(day),
  };
}

/** A single text entry (organization, title, note): changed in place, added or removed. */
function singleText(patch: Json, card: Json, property: string, field: string, value: string, prefix: string) {
  const first = firstText(card[property], field);
  const wanted = value.trim();
  if ((first?.value ?? "") === wanted) return;
  if (first && wanted) patch[`${property}/${first.key}/${field}`] = wanted;
  else if (first) patch[`${property}/${first.key}`] = null;
  else if (isObject(card[property])) patch[`${property}/${prefix}1`] = { [field]: wanted };
  else patch[property] = { [`${prefix}1`]: { [field]: wanted } };
}

/** What names a contact when it has no name: its organization or its first address. */
function fallbackName(input: ContactInput): string {
  return input.organization.trim() || input.emails.find((e) => e.address.trim())?.address.trim() || "";
}

/** A new card from the editor. */
export function cardFromInput(input: ContactInput): Json {
  const given = input.given.trim();
  const surname = input.surname.trim();
  const card: Json = {
    "@type": "Card",
    version: "1.0",
    kind: "individual",
    addressBookIds: { [input.addressBookId]: true },
    name: nameFor(null, given, surname, fallbackName(input)),
  };
  const patch: Json = {};
  singleText(patch, {}, "organizations", "name", input.organization, "o");
  singleText(patch, {}, "titles", "name", input.title, "t");
  singleText(patch, {}, "notes", "note", input.note, "n");
  Object.assign(card, patch);
  const emails = emailEntries(null, input.emails);
  const phones = phoneEntries(null, input.phones);
  const addresses = postalEntries(null, input.addresses);
  if (emails) card.emails = emails;
  if (phones) card.phones = phones;
  if (addresses) card.addresses = addresses;
  const birthday = input.birthday ? birthdayDate(input.birthday) : null;
  if (birthday) card.anniversaries = { b1: { kind: "birth", date: birthday } };
  return card;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The patch that turns `card` into what the editor saved; only what changed is in it. */
export function patchFromInput(card: JmapCard, input: ContactInput): Json {
  const before = toContactRecord(card, "");
  const patch: Json = {};
  const given = input.given.trim();
  const surname = input.surname.trim();
  if (given !== before.given || surname !== before.surname) {
    patch.name = nameFor(card.name, given, surname, fallbackName(input));
  }
  singleText(patch, card, "organizations", "name", input.organization, "o");
  singleText(patch, card, "titles", "name", input.title, "t");
  singleText(patch, card, "notes", "note", input.note, "n");
  for (const [property, next] of [
    ["emails", emailEntries(card.emails, input.emails)],
    ["phones", phoneEntries(card.phones, input.phones)],
    ["addresses", postalEntries(card.addresses, input.addresses)],
  ] as const) {
    if (!same(next, isObject(card[property]) && Object.keys(card[property]).length > 0 ? card[property] : null)) {
      patch[property] = next;
    }
  }
  if (input.birthdayChanged && input.birthday !== before.birthday) {
    const current = birthdayOf(card);
    const date = input.birthday ? birthdayDate(input.birthday) : null;
    if (current && date) patch[`anniversaries/${current.key}/date`] = date;
    else if (current) patch[`anniversaries/${current.key}`] = null;
    else if (date && isObject(card.anniversaries)) {
      const key = freeKey(new Set(Object.keys(card.anniversaries)), "b");
      patch[`anniversaries/${key}`] = { kind: "birth", date };
    } else if (date) patch.anniversaries = { b1: { kind: "birth", date } };
  }
  if (input.addressBookId && input.addressBookId !== before.addressBookId) {
    patch.addressBookIds = { [input.addressBookId]: true };
  }
  return patch;
}
