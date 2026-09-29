// The demo's birthdays calendar and birthday import, doing in the browser what the UwUMail server
// does (docs/birthdays.md there) closely enough to show it: titles with the age, names read from
// event titles and matched to the demo's made-up contacts. Ported from the webmail's demo.

import { birthdayTitle, daysBetweenDates, foldName, parseDay, type PartialDay } from "@/lib/birthdays";
import type { BirthdayCandidate, BirthdayMatch, CalendarOccurrence, ContactRecord } from "./types";

type Lang = "de" | "en";

/** The birthdays calendar's occurrences in [from, to) from the contacts' dates. */
export function birthdayOccurrences(
  contacts: ContactRecord[],
  from: string,
  to: string,
  accountId: string,
  calendarId: string,
  lang: Lang,
): CalendarOccurrence[] {
  const found: CalendarOccurrence[] = [];
  for (const contact of contacts) {
    if (contact.isGroup || !contact.displayName) continue;
    for (const [kind, value] of [
      ["birth", contact.birthday],
      ["wedding", contact.anniversary ?? null],
    ] as const) {
      const date = parseDay(value);
      if (!date) continue;
      for (const { date: day, years } of daysBetweenDates(date, from.slice(0, 10), to.slice(0, 10))) {
        const next = new Date(`${day}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        const birthday = {
          contactId: contact.id,
          kind,
          label: null,
          name: contact.displayName,
          year: date.year,
          age: years !== null && years > 0 ? years : null,
        };
        found.push({
          id: `bday-${contact.id}-${kind}#${day}`,
          eventId: `bday-${contact.id}-${kind}`,
          accountId,
          calendarId,
          title: birthdayTitle(birthday, lang),
          description: "",
          location: "",
          allDay: true,
          start: `${day}T00:00:00`,
          end: `${next.toISOString().slice(0, 10)}T00:00:00`,
          timeZone: null,
          recurrence: { frequency: "yearly", interval: 1, byDay: null, until: null, count: null },
          recurrenceEditable: false,
          recurrenceId: `${day}T00:00:00`,
          readOnly: true,
          color: null,
          birthday,
        });
      }
    }
  }
  return found;
}

// ------------------------------------------------------------------------------------------------
// Finding birthday events

const WORDS = new Set(["geburtstag", "geb", "birthday", "bday", "hbd"]);
const FILLERS = new Set(["von", "vom", "hat", "of", "happy", "zum", "alles", "gute"]);
const SIGNS = /[🎂🎉🎈🎁🥳🍰🧁]/gu;

/** The name and year a birthday title gives, or null when it's no birthday title. */
export function nameFromTitle(title: string): { name: string; year: number | null } | null {
  let said = SIGNS.test(title);
  SIGNS.lastIndex = 0;
  const tokens = title.replace(SIGNS, " ").replaceAll("’", "'").split(/\s+/).filter(Boolean);
  let year: number | null = null;
  const name: string[] = [];
  for (const token of tokens) {
    const digits = token.replace(/[()*.,:;[\]-]/g, "");
    if (/^\d{4}$/.test(digits) && year === null) {
      year = Number(digits);
      continue;
    }
    const folded = foldName(token);
    if (WORDS.has(folded) || folded === "b day") {
      said = true;
      continue;
    }
    if (!folded || FILLERS.has(folded) || /^\d{1,3}$/.test(folded)) continue;
    const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, "").replace(/'s?$/i, "");
    if (word) name.push(word);
  }
  return said && name.length > 0 ? { name: name.join(" "), year } : null;
}

function namesOf(contact: ContactRecord): string[][] {
  const names = [contact.displayName, `${contact.surname} ${contact.given}`].filter((name) => name.trim());
  return names.flatMap((name) => [foldName(name).split(" "), foldName(name, false).split(" ")]);
}

/** The contacts a name may mean: the same name first, else every word of it in theirs. */
export function contactsNamed(name: string, contacts: ContactRecord[]): ContactRecord[] {
  const wanted = [foldName(name), foldName(name, false)];
  const people = contacts.filter((contact) => !contact.isGroup);
  const exact = people.filter((contact) => namesOf(contact).some((words) => wanted.includes(words.join(" "))));
  if (exact.length > 0) return exact;
  const words = wanted.map((key) => key.split(" "));
  return people.filter((contact) =>
    namesOf(contact).some((theirs) => words.some((mine) => mine.every((word) => theirs.includes(word)))),
  );
}

function sameDay(known: PartialDay, found: PartialDay): boolean {
  return known.month === found.month && known.day === found.day && (found.year === null || known.year === found.year);
}

/** How a found birthday fits the contacts it may belong to. */
export function matchOf(found: PartialDay, contacts: ContactRecord[]): BirthdayMatch {
  if (contacts.length === 0) return "unmatched";
  if (contacts.length > 1) return "ambiguous";
  const known = parseDay(contacts[0]!.birthday);
  if (!known) return "matched";
  if (sameDay(known, found)) return "known";
  if (known.month === found.month && known.day === found.day && known.year === null) return "matched";
  return "conflict";
}

/** A candidate as the server's scan lists it. */
export function candidateFor(
  event: { id: string; calendarId: string; title: string },
  birthday: string,
  name: string,
  contacts: ContactRecord[],
  mayDeleteEvent: boolean,
): BirthdayCandidate {
  const choices = contactsNamed(name, contacts).slice(0, 10);
  return {
    eventId: event.id,
    calendarId: event.calendarId,
    title: event.title,
    name,
    birthday,
    mayDeleteEvent,
    match: matchOf(parseDay(birthday)!, choices),
    contacts: choices.map((contact) => ({
      contactId: contact.id,
      name: contact.displayName,
      birthday: contact.birthday,
    })),
  };
}
