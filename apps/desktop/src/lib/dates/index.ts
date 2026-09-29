/**
 * Appointments in mail: found by rules in the text a reader sees (see ./parse and ./detect),
 * never by sending the mail anywhere. The reader offers them for the calendar.
 */

import type { WallTime } from "@/lib/calendarDates";
import { detectEvents, type DetectedEvent } from "./detect";
import { collectText, markText, parseBody, type Mark } from "./dom";
import { boilerplate } from "./structure";

export { detectEvents, subjectTitle, MIN_CONFIDENCE, type DetectedEvent, type EventSource } from "./detect";
export type { Mark } from "./dom";
export { fromAssist, mergeEvents, sameAppointment } from "./merge";

const FORWARDED = /^\s*(fwd?|fw|wg|tr|vs|weitergeleitet)\s*:/iu;

/** A forwarded mail's quoted part is what it is about. */
export function isForward(subject: string): boolean {
  return FORWARDED.test(subject);
}

export interface MailContext {
  subject: string;
  /** When the mail arrived, as a wall time where the reader is. */
  reference: WallTime;
  /** navigator.language */
  locale: string;
}

/** The appointments in a mail's body HTML (already sanitized, or plain text turned into HTML). */
export function eventsInMail(html: string, context: MailContext): DetectedEvent[] {
  const forward = isForward(context.subject);
  const collected = collectText(parseBody(html), forward);
  const excluded = [...collected.excluded, ...boilerplate(collected.text, forward)];
  return detectEvents(collected.text, { ...context, excluded });
}

/** The appointments in the text read from a picture. Only its footer is left out. */
export function eventsInImageText(text: string, context: MailContext): DetectedEvent[] {
  return detectEvents(text, { ...context, excluded: boilerplate(text, false), source: "image", max: 10 });
}

/**
 * The same HTML with each hit wrapped for the reader, see dom.markText. `marks` point into the
 * text `eventsInMail` read from this very HTML, so both must see the same markup.
 */
export function markMail(html: string, subject: string, marks: readonly Mark[]): string {
  if (marks.length === 0) return html;
  const body = parseBody(html);
  // Only our own marks answer a click: a mail can't bring look-alikes.
  for (const fake of body.querySelectorAll("[data-uwu-date]")) fake.removeAttribute("data-uwu-date");
  const collected = collectText(body, isForward(subject));
  markText(body, collected, marks);
  return body.innerHTML;
}
