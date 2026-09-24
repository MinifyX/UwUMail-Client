import type { ContactCard } from "@/lib/attachments";
import type { ContactInput, ContactPostal, ContactRecord } from "@/backend/types";
import type { ContactDraft } from "./state";

const collator = () => new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Contacts in the order of their names, the way a phone lists them. */
export function sortContacts(contacts: ContactRecord[]): ContactRecord[] {
  const compare = collator().compare;
  return [...contacts].sort((a, b) => compare(a.displayName, b.displayName) || a.id.localeCompare(b.id));
}

/** The letter a contact is listed under; everything that doesn't start with a letter is "#". */
export function letterOf(contact: ContactRecord): string {
  const first = contact.displayName.trim().charAt(0).toLocaleUpperCase();
  return /\p{L}/u.test(first) ? first.normalize("NFD").charAt(0) : "#";
}

/** Every word has to be somewhere in the name, company, addresses, numbers or note. */
export function matchesSearch(contact: ContactRecord, search: string): boolean {
  const words = search.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    contact.displayName,
    contact.organization,
    contact.title,
    ...contact.emails.map((email) => email.address),
    ...contact.phones.map((phone) => phone.number),
    ...contact.phones.map((phone) => phone.number.replace(/[^\d+]/g, "")),
    contact.note,
  ]
    .join("\n")
    .toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The line under a contact's name in the list. */
export function subtitleOf(contact: ContactRecord): string {
  if (contact.organization && contact.organization !== contact.displayName) return contact.organization;
  return contact.emails[0]?.address ?? contact.phones[0]?.number ?? "";
}

/** "12. April 1996", or "30. September" when the year isn't known. */
export function formatBirthday(birthday: string, locale: string): string {
  const match = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(birthday);
  if (!match) return birthday;
  const [, year, month, day] = match;
  const withYear = year !== "-";
  const date = new Date(Date.UTC(withYear ? Number(year) : 2000, Number(month) - 1, Number(day)));
  return date.toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

/** An address as the lines on an envelope. */
export function addressLines(postal: ContactPostal): string[] {
  return [
    postal.street,
    [postal.postcode, postal.locality].filter(Boolean).join(" "),
    postal.region,
    postal.country,
  ].filter((line) => line.trim() !== "");
}

/** What the editor starts with. */
export function inputFrom(contact: ContactRecord | null, bookId: string, draft?: ContactDraft): ContactInput {
  if (contact) {
    return {
      addressBookId: contact.addressBookId,
      given: contact.given,
      surname: contact.surname,
      organization: contact.organization,
      title: contact.title,
      emails: contact.emails.map((email) => ({ ...email })),
      phones: contact.phones.map((phone) => ({ ...phone })),
      addresses: contact.addresses.map((postal) => ({ ...postal })),
      birthday: contact.birthday,
      birthdayChanged: false,
      note: contact.note,
    };
  }
  return {
    addressBookId: bookId,
    given: draft?.given ?? "",
    surname: draft?.surname ?? "",
    organization: draft?.organization ?? "",
    title: draft?.title ?? "",
    emails: (draft?.emails ?? []).map((address) => ({ id: "", address, kind: "other" })),
    phones: (draft?.phones ?? []).map((number) => ({ id: "", number, kind: "other" })),
    addresses: [],
    birthday: null,
    birthdayChanged: false,
    note: draft?.note ?? "",
  };
}

/** A person's name split the way cards keep it: the last word is the surname. */
export function splitName(name: string): { given: string; surname: string } {
  const trimmed = name.trim().replace(/\s+/g, " ");
  const space = trimmed.lastIndexOf(" ");
  return space < 0
    ? { given: trimmed, surname: "" }
    : { given: trimmed.slice(0, space), surname: trimmed.slice(space + 1) };
}

/** Whether the editor has anything that names the contact. */
export function hasName(input: ContactInput): boolean {
  return [input.given, input.surname, input.organization, ...input.emails.map((email) => email.address)].some(
    (value) => value.trim() !== "",
  );
}

/** The contact that has an address, if any; addresses are compared without case. */
export function contactWithEmail(contacts: ContactRecord[], email: string): ContactRecord | undefined {
  const wanted = email.trim().toLowerCase();
  return contacts.find((contact) => contact.emails.some((entry) => entry.address.toLowerCase() === wanted));
}

/** A new contact from a mail's sender; a "name" that is only the address again is left out. */
export function draftFromSender(name: string | undefined, email: string): ContactDraft {
  const cleaned = (name ?? "").replace(/^["']|["']$/g, "").trim();
  const usable = cleaned !== "" && !cleaned.includes("@");
  return { ...(usable ? splitName(cleaned) : {}), emails: [email] };
}

/** A new contact from a vCard someone sent, with what the preview could read from it. */
export function draftFromCard(card: ContactCard): ContactDraft {
  return {
    ...splitName(card.name),
    organization: card.organization,
    title: card.title,
    emails: card.emails,
    phones: card.phones,
  };
}
