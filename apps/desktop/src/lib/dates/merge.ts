/**
 * The appointments of one mail from all three places together: the rules on its text, the rules on
 * the text in its pictures, and (only when the person asked for it) the assistant's reading. The
 * same appointment found twice shows once, with the best of what each side knew.
 */

import { dateOf, diffMinutes, isWallTime, type WallTime } from "@/lib/calendarDates";
import type { AssistEvent } from "@/backend/types";
import type { DetectedEvent } from "./detect";

/** "2026-10-06T00:00" or with seconds, as the assistant may write it; null when it's no wall time. */
function wall(value: string): WallTime | null {
  const full = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value.slice(0, 19);
  return isWallTime(full) ? full : null;
}

/** Bounds on what the assistant hands over, however it answered. */
const MAX_TITLE = 500;
const MAX_FIELD = 2000;
const MAX_URL = 2048;

/** Cut by characters, so nothing multi-byte is split. */
function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join("") : value;
}

/** Only an `https` address counts; anything else (javascript:, http:, data:) is dropped. */
export function safeUrl(value: string | null | undefined): string | null {
  if (!value || value.length > MAX_URL) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** An appointment the assistant read, in the finder's shape. It has no place in the text. */
export function fromAssist(event: AssistEvent, reference: WallTime): DetectedEvent | null {
  const start = wall(event.start);
  const end = wall(event.end);
  if (!start || !end || end < start) return null;
  const allDay = event.allDay;
  return {
    key: `${start}|${end}`,
    from: -1,
    to: -1,
    text: clip(event.quote, MAX_FIELD),
    start,
    end,
    allDay,
    endKnown: true,
    timeZone: event.timeZone,
    confidence: Math.min(1, Math.max(0, event.confidence)),
    title: clip(event.title.trim(), MAX_TITLE),
    location: event.location ? clip(event.location, MAX_TITLE) : null,
    quote: clip(event.quote, MAX_FIELD),
    past: allDay ? dateOf(end) <= dateOf(reference) : end <= reference,
    ambiguous: false,
    weekdayMismatch: false,
    source: "ai",
    description: event.description ? clip(event.description, MAX_FIELD) : null,
    url: safeUrl(event.url),
  };
}

/**
 * Two finds of the same appointment: the same first day, and the same start time unless one of
 * them only knows the day.
 */
export function sameAppointment(a: DetectedEvent, b: DetectedEvent): boolean {
  if (dateOf(a.start) !== dateOf(b.start)) return false;
  return a.allDay || b.allDay || a.start === b.start;
}

type Times = Pick<DetectedEvent, "key" | "start" | "end" | "allDay" | "endKnown" | "timeZone" | "past">;

const timesOf = (event: DetectedEvent): Times => ({
  key: event.key,
  start: event.start,
  end: event.end,
  allDay: event.allDay,
  endKnown: event.endKnown,
  timeZone: event.timeZone,
  past: event.past,
});

const days = (event: DetectedEvent) => diffMinutes(event.start, event.end) / 1440;

/**
 * Whose times count when two finds are the same appointment. Times always beat a bare day,
 * whichever side found them: "zwischen 10:00 und 12:00" never turns into an all-day event because
 * the other side only saw the date, and a time the other side read is never thrown away for a day.
 * Otherwise `preferred` (the assistant) wins, but keeps an end the rules read when it only
 * assumed one (an hour) or knows fewer days.
 */
function pickTimes(known: DetectedEvent, preferred: DetectedEvent): Times {
  if (known.allDay !== preferred.allDay) return timesOf(known.allDay ? preferred : known);
  if (known.allDay) {
    return known.endKnown && days(known) > days(preferred) ? timesOf(known) : timesOf(preferred);
  }
  if (
    known.start === preferred.start &&
    known.endKnown &&
    known.end !== preferred.end &&
    diffMinutes(preferred.start, preferred.end) === 60
  ) {
    return { ...timesOf(preferred), key: known.key, end: known.end, past: known.past };
  }
  return timesOf(preferred);
}

/**
 * Everything found, the same appointment once, in the order it happens. A text hit keeps its place
 * in the text (for the underline); the assistant's reading refines it: its title and place win,
 * and its times unless they know less than the text's (see pickTimes). Picture hits only add what
 * the text lacks, a time included.
 */
export function mergeEvents(
  text: readonly DetectedEvent[],
  image: readonly DetectedEvent[],
  ai: readonly DetectedEvent[],
): DetectedEvent[] {
  const merged: DetectedEvent[] = text.map((event) => ({ ...event }));
  for (const event of image) {
    const index = merged.findIndex((known) => sameAppointment(known, event));
    if (index < 0) merged.push({ ...event });
    else if (merged[index]!.allDay && !event.allDay) merged[index] = { ...merged[index]!, ...timesOf(event) };
  }
  for (const event of ai) {
    const index = merged.findIndex((known) => sameAppointment(known, event) && !known.refined);
    if (index < 0) {
      merged.push({ ...event });
      continue;
    }
    const known = merged[index]!;
    const times = pickTimes(known, event);
    merged[index] = {
      ...known,
      ...times,
      timeZone: times.timeZone ?? known.timeZone ?? event.timeZone,
      title: event.title || known.title,
      location: event.location ?? known.location,
      description: event.description ?? known.description ?? null,
      url: event.url ?? known.url ?? null,
      confidence: Math.max(known.confidence, event.confidence),
      // The assistant read the whole sentence: what looked doubtful is settled.
      ambiguous: false,
      weekdayMismatch: false,
      refined: true,
    };
  }
  return merged.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : 1));
}
