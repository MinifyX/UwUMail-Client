/**
 * Which little scene fits a mail that was just opened. Pure functions, so the rules are easy to
 * test and to share with the app: the caller brings the mail, the contacts and the time.
 */

import { dayIn, parseDay } from "@/lib/birthdays";
import type { CameoName } from "./cameo";
import { isLateNight, seasonalHat, type Hat } from "./hats";

// The time rules live with the hats (see hats.tsx); here they sit with the other rules too.
export { isLateNight, seasonalHat };

const pad = (value: number) => String(value).padStart(2, "0");

/** "YYYY-MM-DD" of the local day. */
export function localDay(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** What the scenes need to know about a contact. */
export interface OccasionContact {
  emails: { address: string }[];
  /** "YYYY-MM-DD" or "--MM-DD". */
  birthday: string | null;
  isGroup?: boolean;
}

/** The contact whose address this is, if any (groups don't count). */
export function contactFor<T extends OccasionContact>(contacts: readonly T[], email: string): T | null {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return null;
  return (
    contacts.find(
      (contact) => !contact.isGroup && contact.emails.some((entry) => entry.address.toLowerCase() === wanted),
    ) ?? null
  );
}

/** Whether the birthday falls on `today` ("YYYY-MM-DD"); 29 February counts on the 28th in other years. */
export function isBirthdayToday(birthday: string | null, today: string): boolean {
  const date = parseDay(birthday);
  if (!date) return false;
  const year = Number(today.slice(0, 4));
  const { month, day } = dayIn(date, year);
  return today.slice(5) === `${pad(month)}-${pad(day)}`;
}

/** Pictures attached as files (not the ones inside the text), e.g. holiday photos. */
export function photoCount(attachments: readonly { mimeType: string; inline: boolean }[]): number {
  return attachments.filter(
    (attachment) =>
      !attachment.inline &&
      attachment.mimeType.toLowerCase().startsWith("image/") &&
      // Vector drawings and icons aren't photos.
      !/svg|icon/.test(attachment.mimeType.toLowerCase()),
  ).length;
}

export interface OpenedMail {
  /** Sender of the newest message someone else wrote. */
  from: string;
  /** It was unread before it was opened: new mail. */
  unread: boolean;
  attachments: readonly { mimeType: string; inline: boolean }[];
}

/** A scene to try, with the key its cooldown counts under. */
export interface CameoChoice {
  name: CameoName;
  key: string;
  hat?: Hat;
}

/**
 * The scenes that fit, best first. The caller plays the first one that is not cooling down, so a
 * birthday greets once a day and then the mail gets the next best scene:
 * a contact's birthday (party hat) → new mail from a contact → photos → late at night → a peek.
 */
export function openCameos(mail: OpenedMail, contacts: readonly OccasionContact[], now: Date): CameoChoice[] {
  const choices: CameoChoice[] = [];
  const sender = mail.from.trim().toLowerCase();
  const contact = sender ? contactFor(contacts, sender) : null;
  const today = localDay(now);
  if (contact && isBirthdayToday(contact.birthday, today)) {
    choices.push({ name: "birthday", key: `birthday:${sender}:${today}` });
  }
  if (contact && mail.unread) choices.push({ name: "friend", key: `friend:${sender}` });
  if (photoCount(mail.attachments) > 0) choices.push({ name: "photos", key: "photos" });
  if (isLateNight(now)) choices.push({ name: "night", key: "night" });
  const hat = seasonalHat(now);
  choices.push({ name: "peek", key: "peek", ...(hat ? { hat } : {}) });
  return choices;
}
