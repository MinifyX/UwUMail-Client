/**
 * Birthdays and anniversaries as contacts keep them: a day of the year, with the year when it is
 * known ("1996-04-12", "--04-12"). The same rules as the server's birthdays calendar
 * (docs/birthdays.md there): 29 February falls on 28 February in years without one, and the age
 * counts from that day on.
 */

import type { BirthdayReminder, CalendarOccurrence, OccurrenceBirthday } from "@/backend/types";

/** A day of the year, with the year when it is known. */
export interface PartialDay {
  year: number | null;
  month: number;
  day: number;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days of a month; without a year February may have its 29th. */
export function monthLength(month: number, year: number | null): number {
  if (month === 2) return year === null || isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** "1996-04-12" or "--04-12" read; null for anything else, or a day that doesn't exist. */
export function parseDay(value: string | null | undefined): PartialDay | null {
  const match = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const year = match[1] === "-" ? null : Number(match[1]);
  return partialDay(year, Number(match[2]), Number(match[3]));
}

/** A day that exists, or null (31 April, 29 February 2023, year 0). */
export function partialDay(year: number | null, month: number, day: number): PartialDay | null {
  if (year !== null && (!Number.isInteger(year) || year < 1 || year > 9999)) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > monthLength(month, year)) return null;
  return { year, month, day };
}

/** The way contacts keep it: "1996-04-12" or "--04-12". */
export function formatDay(date: PartialDay): string {
  return `${date.year === null ? "-" : pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

/** Month and day it falls on in `year`: 29 February is the 28th in a year without one. */
export function dayIn(date: PartialDay, year: number): { month: number; day: number } {
  return date.month === 2 && date.day === 29 && !isLeapYear(year)
    ? { month: 2, day: 28 }
    : { month: date.month, day: date.day };
}

/** How many years it is in `year`: the age on a birthday. Null without a year or before it. */
export function yearsIn(date: PartialDay, year: number): number | null {
  if (date.year === null || year < date.year) return null;
  return year - date.year;
}

/** "YYYY-MM-DD" of the day in `year`. */
export function dateIn(date: PartialDay, year: number): string {
  const { month, day } = dayIn(date, year);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/**
 * The next time it comes, from `today` ("YYYY-MM-DD") on: today itself counts. With the age it
 * turns then (null without a year), and in how many days.
 */
export function nextTime(date: PartialDay, today: string): { date: string; age: number | null; inDays: number } {
  const year = Number(today.slice(0, 4));
  let when = dateIn(date, year);
  let then = year;
  if (when < today) {
    then = year + 1;
    when = dateIn(date, then);
  }
  return { date: when, age: yearsIn(date, then), inDays: daysBetween(today, when) };
}

/** The age someone has on `today`; null without a year. */
export function ageOn(date: PartialDay, today: string): number | null {
  const year = Number(today.slice(0, 4));
  const had = dateIn(date, year) <= today;
  const age = yearsIn(date, had ? year : year - 1);
  return age === null || age < 0 ? null : age;
}

function daysBetween(from: string, to: string): number {
  const ms = (key: string) => {
    const date = new Date(0);
    date.setUTCFullYear(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
    return date.getTime();
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** The reminders the editor offers; others a phone set stay as they are. */
export const REMINDER_PRESETS: readonly BirthdayReminder[] = [
  { daysBefore: 0, time: "09:00" },
  { daysBefore: 1, time: "09:00" },
  { daysBefore: 7, time: "09:00" },
];

export const sameReminder = (a: BirthdayReminder, b: BirthdayReminder) =>
  a.daysBefore === b.daysBefore && a.time === b.time;

/** Reminders in the order the server keeps them, each once. */
export function normalizeReminders(list: readonly BirthdayReminder[]): BirthdayReminder[] {
  const sorted = [...list].sort((a, b) => a.daysBefore - b.daysBefore || a.time.localeCompare(b.time));
  return sorted.filter((reminder, index) => index === 0 || !sameReminder(reminder, sorted[index - 1]!));
}

export function sameReminders(a: readonly BirthdayReminder[], b: readonly BirthdayReminder[]): boolean {
  const x = normalizeReminders(a);
  const y = normalizeReminders(b);
  return x.length === y.length && x.every((reminder, index) => sameReminder(reminder, y[index]!));
}

/** Every day it falls on in [from, to) ("YYYY-MM-DD", `to` exclusive), with the years then. */
export function daysBetweenDates(date: PartialDay, from: string, to: string): { date: string; years: number | null }[] {
  const found: { date: string; years: number | null }[] = [];
  const first = Number(from.slice(0, 4));
  const last = Number(to.slice(0, 4));
  for (let year = first; year <= last; year++) {
    // Before the year it happened, there is nothing yet.
    if (date.year !== null && year < date.year) continue;
    const when = dateIn(date, year);
    if (when >= from && when < to) found.push({ date: when, years: yearsIn(date, year) });
  }
  return found;
}

/**
 * What names are compared by, character by character: lower case, umlauts spelled out (or plain
 * with `spellOut` false), ß as ss, other accents gone, anything but letters and digits a space.
 */
export function foldName(name: string, spellOut = true): string {
  // Composed first, so "u" with a combining diaeresis is "ü" too.
  const lower = name.normalize("NFC").toLowerCase();
  const spelled = spellOut ? lower.replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue") : lower;
  return spelled
    .replaceAll("ß", "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The title of a birthdays calendar occurrence in the UI's language, as the server writes it:
 * "Max Muster (30)", "Hochzeitstag von Max Muster (5 Jahre)"; the plain name in the first year
 * and without a year. The engine's own birthdays calendar (for mailboxes whose server has none)
 * and the server's both get it, so titles follow the app's language.
 */
export function birthdayTitle(birthday: OccurrenceBirthday, language: string): string {
  const de = language.toLowerCase().startsWith("de");
  const { name, label, age } = birthday;
  if (birthday.kind === "birth") return age === null ? name : `${name} (${age})`;
  const what =
    birthday.kind === "wedding"
      ? de
        ? `Hochzeitstag von ${name}`
        : `Wedding anniversary of ${name}`
      : label
        ? de
          ? `${label} von ${name}`
          : `${label} of ${name}`
        : de
          ? `Jahrestag von ${name}`
          : `Anniversary of ${name}`;
  if (age === null) return what;
  if (de) return `${what} (${age} ${age === 1 ? "Jahr" : "Jahre"})`;
  return `${what} (${age} ${age === 1 ? "year" : "years"})`;
}

/** Occurrences with the titles of their birthdays in the UI's language; others as they are. */
export function localizeBirthdays(occurrences: CalendarOccurrence[], language: string): CalendarOccurrence[] {
  return occurrences.map((occurrence) =>
    occurrence.birthday ? { ...occurrence, title: birthdayTitle(occurrence.birthday, language) } : occurrence,
  );
}
