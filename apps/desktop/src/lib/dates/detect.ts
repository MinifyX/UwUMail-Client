/**
 * Which of the dates in a mail are appointments worth offering, what they are called, where they
 * happen, and how sure the finder is. Keeps false alarms down: order and phone numbers, prices,
 * a document's own date ("Rechnungsdatum"), the mail's own date and anything long past.
 */

import { addDays, dateOf, diffDays, withClock, type WallTime } from "@/lib/calendarDates";
import { findDates, type Clock, type FoundDate } from "./parse";
import { EVENT_CUES } from "./words";

export type EventSource = "text" | "image" | "ai";

export interface DetectedEvent {
  /** The time range, which also tells the same event found twice apart: `start|end`. */
  key: string;
  /** Where in the searched text; `to` exclusive. */
  from: number;
  to: number;
  text: string;
  start: WallTime;
  /** Exclusive, like the calendar: an all-day event ends at midnight after its last day. */
  end: WallTime;
  allDay: boolean;
  /** The mail named an end (a range or an end time) rather than the finder assuming one. */
  endKnown: boolean;
  timeZone: string | null;
  /** 0..1 */
  confidence: number;
  /** Empty when nothing fits; the reader then says "Termin". */
  title: string;
  location: string | null;
  /** The sentence the date stands in. */
  quote: string;
  /** Over before the mail arrived. */
  past: boolean;
  /** Day and month could be the other way round. */
  ambiguous: boolean;
  weekdayMismatch: boolean;
  source: EventSource;
  description?: string | null;
  url?: string | null;
  /** The assistant confirmed and refined this text hit. */
  refined?: boolean;
}

export interface DetectOptions {
  /** When the mail arrived, as a wall time where the reader is. */
  reference: WallTime;
  subject: string;
  /** The reader's locale (navigator.language), for 10/12 in English mails. */
  locale: string;
  /** Text ranges not to look at: quoted replies, signatures, legal footers. */
  excluded?: readonly (readonly [number, number])[];
  source?: EventSource;
  /** At most this many, the likeliest first in text order. */
  max?: number;
}

/** Below this, a hit is not shown at all. */
export const MIN_CONFIDENCE = 0.35;
const DEFAULT_MAX = 20;

const DE_WORDS =
  /(?<![\p{L}])(und|der|die|das|nicht|mit|für|ist|wir|ich|uhr|vom|bis|dein|deine|ihr|ihre|eine|einen|auf|wird|sind|auch|oder|noch)(?![\p{L}])/giu;
const EN_WORDS =
  /(?<![\p{L}])(the|and|with|for|is|we|you|your|on|at|of|to|this|that|will|are|our|from|be|have|by)(?![\p{L}])/giu;

export function guessLanguage(text: string): "de" | "en" | null {
  const sample = text.slice(0, 5000);
  const de = sample.match(DE_WORDS)?.length ?? 0;
  const en = sample.match(EN_WORDS)?.length ?? 0;
  if (de === 0 && en === 0) return null;
  return de >= en ? "de" : "en";
}

/** Month first only in American English; a German mail or a British reader means day first. */
export function slashOrderFor(language: "de" | "en" | null, locale: string): "MD" | "DM" {
  if (language === "de") return "DM";
  const tag = locale.toLowerCase();
  if (/^en-(gb|ie|au|nz|in|za)/.test(tag)) return "DM";
  if (language === "en") return "MD";
  return tag === "en" || tag.startsWith("en-us") ? "MD" : "DM";
}

/** A number label right before: "Bestellnr. 12.10.2026" is not a date, nor "Tel. 01/12/34". */
const NUMBER_LABEL =
  /(?<![\p{L}])(bestell\p{L}*|auftrag\p{L}*|order|rechnungs?\p{L}*|invoice|kunden\p{L}*|customer|konto|account|iban|bic|artikel\p{L}*|sku|tracking|sendungs?\p{L}*|referenz|ref|ticket|nr|no|nummer|number|tel|telefon|phone|fon|fax|mobil|handy|version|v|release|build|kapitel|chapter|seite|page|abschnitt|section|plz|zip|id|§)\s{0,2}[.:#]{0,2}\s{0,3}$/iu;
/** A document's own date is no appointment. */
const DATE_LABEL =
  /(?<![\p{L}])((?:rechnungs|bestell|beleg|buchungs|leistungs|ausstellungs|geburts|druck|erstellungs|versand|auftrags|kauf|zahlungseingangs)datum|invoice date|order date|purchase date|date of birth|birthday|geboren|born|issued(?: on)?|statement date|stand|as of|gesendet|sent|erstellt(?: am)?|created(?: on)?|updated(?: on)?|aktualisiert(?: am)?|zuletzt|last|gekauft(?: am)?|bestellt(?: am)?|bezahlt(?: am)?|paid(?: on)?|ordered(?: on)?|seit|since|gestern|yesterday|(?:bestellung|rechnung|auftrag|schreiben|brief|nachricht|e-mail|mail|lieferschein|vertrag|kündigung|order|invoice|letter) vom)\s{0,2}:?\s{0,3}$/iu;
const CURRENCY_NEAR = /^\s{0,2}(€|eur|usd|\$|£|chf)|(€|\$|£)\s{0,2}$/iu;

const STOP_EDGE = new Set(
  (
    "am um vom von bis ab zum zur den dem der die das des ist sind wird werden findet statt beginnt startet läuft endet gilt " +
    "jeweils ca circa bereits schon noch nur und oder on at from to until till the is are will be starts start begins " +
    "runs ends takes place happens held a an this next kommenden nächsten diesen im in bei for of"
  ).split(/\s+/),
);
const LEADING_WORDS =
  /^(der|die|das|dem|den|des|ein|eine|einen|the|a|an|our|unser|unsere|unseren|unserem|your|dein|deine|ihr|ihre)\s+/iu;
const NOT_A_TITLE =
  /(?<![\p{L}])(ich|du|wir|ihr|uns|euch|mich|dich|mir|dir|i|you|we|us|me|they|them|he|she|er|es|man|lass|let's|lets|kannst|können|könnt|could|can|please|bitte|hast|habe|haben|have|has|hi|hallo|hey|liebe|lieber|dear|danke|thanks|thank)(?![\p{L}])/iu;
const GREETING = /^(hallo|hi|hey|liebe|lieber|dear|moin|servus|guten|good|sehr geehrte)/iu;
const TITLE_LABEL = /^\s*(was|what|titel|title|event|veranstaltung|anlass|thema|topic)\s*:\s*(.{2,120})$/iu;
const PLACE_LABEL =
  /^\s*(ort|wo|location|where|venue|adresse|address|treffpunkt|place|veranstaltungsort|raum|room)\s*:\s*(.{2,160})$/iu;
const PLACE_AFTER =
  /^[\s,]{0,3}(?:im|in der|in dem|in|at the|at|bei|beim|auf dem|auf der|an der|am)\s+((?:\p{Lu}[\p{L}\p{N}'’&.-]*)(?:\s+(?:\p{Lu}[\p{L}\p{N}'’&.-]*|\d+[a-z]?|an der|am|in|der|of|the|de|&)){0,5})/u;
/** The same, anywhere in a sentence: "liest Leni im Café Lindenblüte". */
/**
 * A place anywhere in the sentence: "liest Leni im Café Lindenblüte". Only the surer words: German
 * writes every noun with a capital, so "in", "bei" or "am" would take "bei Fragen" for a place.
 */
const PLACE_IN =
  /(?<![\p{L}])(?:im|in der|in dem|at the|at)\s+((?:\p{Lu}[\p{L}\p{N}'’&.-]*)(?:\s+(?:\p{Lu}[\p{L}\p{N}'’&.-]*|\d+[a-z]?|an der|am|in|der|of|the|de|&)){0,5})/gu;
/** "im Anhang", "in der Regel", "at the Moment" … look like places and aren't. */
const NOT_A_PLACE =
  /^(anhang|anlage|voraus|vorfeld|rahmen|namen|auftrag|allgemeinen|übrigen|laufe|nachgang|moment|detail|details|einzelnen|grunde|sinne|prinzip|zuge|falle|regel|zwischenzeit|nähe|lage|zukunft|vergangenheit|woche|mail|e-mail|nachricht|betreff|kalender|shop|newsletter|kundenkonto|konto|browser|internet|app|team|jahr|monat|januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|january|february|march|may|june|july|october|december|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|monday|tuesday|wednesday|thursday|friday|saturday|sunday|end|moment|latest|earliest|least|same|time|beginning|start)$/iu;
const REPLY_PREFIX = /^\s*((re|aw|wg|fwd?|fw|antw|tr|sv|vs)\s*(\[\d+\])?\s*:\s*)+/iu;
const MAX_TITLE = 80;

function lineBounds(text: string, from: number, to: number): [number, number] {
  const start = text.lastIndexOf("\n", from - 1) + 1;
  const newline = text.indexOf("\n", to);
  return [start, newline < 0 ? text.length : newline];
}

/** The sentence around a hit, inside its line. A dot after a digit belongs to a date, not the sentence. */
function sentenceBounds(text: string, from: number, to: number): [number, number] {
  const [lineStart, lineEnd] = lineBounds(text, from, to);
  let start = lineStart;
  for (let index = from - 1; index > lineStart; index--) {
    if (/[.!?]/.test(text[index - 1]!) && /\s/.test(text[index]!) && !/\d/.test(text[index - 2] ?? "")) {
      start = index;
      break;
    }
  }
  let end = lineEnd;
  for (let index = to; index < lineEnd; index++) {
    const char = text[index]!;
    if (
      /[.!?]/.test(char) &&
      (index + 1 >= lineEnd || /\s/.test(text[index + 1]!)) &&
      !/\d/.test(text[index - 1] ?? "")
    ) {
      end = index + 1;
      break;
    }
  }
  return [start, end];
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Drops joining words and punctuation at both ends: "Prime Day deals vom" → "Prime Day deals". */
function trimEdges(text: string): string {
  const parts = words(text.replace(/[„“"«»()[\]]/g, " "));
  const clean = (word: string) => word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  while (parts.length > 0 && (STOP_EDGE.has(clean(parts[0]!)) || clean(parts[0]!) === "")) parts.shift();
  while (parts.length > 0 && (STOP_EDGE.has(clean(parts[parts.length - 1]!)) || clean(parts[parts.length - 1]!) === ""))
    parts.pop();
  return parts
    .join(" ")
    .replace(/^[^\p{L}\p{N}]+|[\s,:;–—-]+$/gu, "")
    .replace(LEADING_WORDS, "")
    .trim();
}

function asTitle(candidate: string): string | null {
  const text = trimEdges(candidate);
  const count = words(text).length;
  if (count === 0 || count > 8 || text.length < 3 || !/\p{L}{2}/u.test(text) || NOT_A_TITLE.test(text)) return null;
  // A poster's "HERBSTFEST" reads as "Herbstfest" in a calendar.
  const shouting = text === text.toUpperCase() && /\p{Lu}{3}/u.test(text);
  const cased = shouting
    ? text.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, edge: string, letter: string) => edge + letter.toUpperCase())
    : text;
  const chars = Array.from(cased);
  const title =
    chars.length > MAX_TITLE
      ? `${chars
          .slice(0, MAX_TITLE - 1)
          .join("")
          .trimEnd()}…`
      : cased;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** The subject without "Re:" and without the dates in it: "Spieleabend am Freitag?" → "Spieleabend". */
export function subjectTitle(subject: string, reference: WallTime, locale: string): string {
  let text = subject.replace(REPLY_PREFIX, "");
  const found = findDates(text, { reference, slashOrder: slashOrderFor(guessLanguage(text), locale) });
  for (const hit of [...found].sort((a, b) => b.from - a.from)) {
    text = `${text.slice(0, hit.from)} ${text.slice(hit.to)}`;
  }
  // "am" before a removed weekday, "?" at the end.
  return trimEdges(text.replace(/[?!]+\s*$/u, ""));
}

function nearbyLines(text: string, from: number, to: number, count: number): { before: string[]; after: string[] } {
  const [start, end] = lineBounds(text, from, to);
  const before = text
    .slice(Math.max(0, start - 600), Math.max(0, start - 1))
    .split("\n")
    .slice(-count);
  const after = text
    .slice(end + 1, end + 600)
    .split("\n")
    .slice(0, count);
  return { before, after };
}

function titleFor(text: string, hit: FoundDate, subject: string): string {
  const [start, end] = sentenceBounds(text, hit.from, hit.to);
  const { before, after } = nearbyLines(text, hit.from, hit.to, 4);
  for (const line of [...before].reverse().concat(after)) {
    const label = TITLE_LABEL.exec(line);
    if (label) {
      const title = asTitle(label[2]!);
      if (title) return title;
    }
  }
  const left = asTitle(text.slice(start, hit.from));
  if (left) return left;
  // What follows only names the thing when it starts like a name ("… Sommerfest im Park").
  const rightText = text.slice(hit.to, end).replace(PLACE_AFTER, " ");
  const right = /^[\s,:–—-]*(\p{Lu}|\d)/u.test(rightText) ? asTitle(rightText) : null;
  if (right) return right;
  // A short line just above: the heading of the block the date stands in.
  for (const line of [...before].reverse().slice(0, 2)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/[,:]$/.test(trimmed) || GREETING.test(trimmed)) break;
    const heading = asTitle(trimmed);
    if (heading && trimmed.length <= 60) return heading;
    break;
  }
  return subject;
}

function locationFor(text: string, hit: FoundDate): string | null {
  const { before, after } = nearbyLines(text, hit.from, hit.to, 4);
  const [start, end] = lineBounds(text, hit.from, hit.to);
  for (const line of [text.slice(start, end), ...after, ...[...before].reverse()]) {
    const label = PLACE_LABEL.exec(line);
    if (label) return label[2]!.trim().replace(/[.;,]+$/, "");
  }
  const [sentenceStart, sentenceEnd] = sentenceBounds(text, hit.from, hit.to);
  const place = PLACE_AFTER.exec(text.slice(hit.to, sentenceEnd));
  if (place) return place[1]!.trim().replace(/[.,;:]+$/, "");
  // Elsewhere in the sentence, as long as it isn't one of the phrases that only look like a place.
  const sentence = `${text.slice(sentenceStart, hit.from)} ${text.slice(hit.to, sentenceEnd)}`;
  for (const match of sentence.matchAll(PLACE_IN)) {
    const name = match[1]!.trim().replace(/[.,;:]+$/, "");
    if (!NOT_A_PLACE.test(name.split(/\s+/)[0]!)) return name;
  }
  return null;
}

function quoteFor(text: string, hit: FoundDate): string {
  const [start, end] = sentenceBounds(text, hit.from, hit.to);
  let quote = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (quote.length > 240) {
    const at = Math.max(0, hit.from - start - 100);
    quote = `${at > 0 ? "…" : ""}${text
      .slice(start + at, start + at + 230)
      .replace(/\s+/g, " ")
      .trim()}…`;
  }
  return quote;
}

const clockText = (clock: Clock) => `${String(clock.h).padStart(2, "0")}:${String(clock.min).padStart(2, "0")}`;

function wallTimes(hit: FoundDate): { start: WallTime; end: WallTime; allDay: boolean; endKnown: boolean } {
  const lastDay = hit.endDate ?? hit.startDate;
  if (!hit.startTime) {
    return {
      start: `${hit.startDate}T00:00:00`,
      end: `${addDays(lastDay, 1)}T00:00:00`,
      allDay: true,
      endKnown: hit.endDate !== null,
    };
  }
  const start = withClock(hit.startDate, clockText(hit.startTime));
  if (hit.endTime) {
    let end = withClock(lastDay, clockText(hit.endTime));
    // "22–2 Uhr" goes past midnight.
    if (end <= start) end = withClock(addDays(lastDay, 1), clockText(hit.endTime));
    return { start, end, allDay: false, endKnown: true };
  }
  if (hit.endDate) {
    const end = withClock(hit.endDate, clockText(hit.startTime));
    return { start, end, allDay: false, endKnown: true };
  }
  const [hours, minutes] = [hit.startTime.h + 1, hit.startTime.min];
  const end =
    hours >= 24
      ? withClock(addDays(hit.startDate, 1), clockText({ h: hours - 24, min: minutes }))
      : withClock(hit.startDate, clockText({ h: hours, min: minutes }));
  return { start, end, allDay: false, endKnown: false };
}

const BASE: Record<FoundDate["kind"], number> = {
  iso: 0.85,
  textual: 0.8,
  numeric: 0.7,
  numericWeak: 0.5,
  slash: 0.7,
  slashWeak: 0.45,
  relativeDay: 0.7,
  weekday: 0.5,
};

function confidenceOf(hit: FoundDate, line: string): number {
  let score = BASE[hit.kind];
  if (hit.kind === "numeric" && hit.yearGiven) score += 0.05;
  if (hit.startTime) score += 0.1;
  if (hit.endDate || hit.endTime) score += 0.05;
  if (EVENT_CUES.test(line)) score += 0.1;
  if (hit.ambiguous) score -= 0.15;
  if (hit.weekdayMismatch) score -= 0.35;
  return Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
}

function overlaps(from: number, to: number, ranges: readonly (readonly [number, number])[]) {
  return ranges.some(([start, end]) => from < end && to > start);
}

const NUMBER_KINDS = new Set<FoundDate["kind"]>(["numeric", "numericWeak", "slash", "slashWeak", "iso"]);

/** The appointments a text offers, in text order, the same one only once. */
export function detectEvents(text: string, options: DetectOptions): DetectedEvent[] {
  const language = guessLanguage(text);
  const found = findDates(text, { reference: options.reference, slashOrder: slashOrderFor(language, options.locale) });
  const referenceDay = dateOf(options.reference);
  const subject = subjectTitle(options.subject, options.reference, options.locale);
  const byKey = new Map<string, DetectedEvent>();
  for (const hit of found) {
    if (options.excluded && overlaps(hit.from, hit.to, options.excluded)) continue;
    const [lineStart, lineEnd] = lineBounds(text, hit.from, hit.to);
    const before = text.slice(Math.max(lineStart, hit.from - 40), hit.from);
    const after = text.slice(hit.to, Math.min(lineEnd, hit.to + 8));
    if (isNumberKind(hit) && (NUMBER_LABEL.test(before) || CURRENCY_NEAR.test(after) || CURRENCY_NEAR.test(before)))
      continue;
    if (DATE_LABEL.test(before)) continue;
    // The mail's own date, as newsletters print it at the top.
    if (!hit.startTime && !hit.endDate && hit.startDate === referenceDay && hit.kind !== "relativeDay") continue;
    if (diffDays(referenceDay, hit.startDate) > 2 * 366) continue;
    const times = wallTimes(hit);
    const confidence = confidenceOf(hit, text.slice(lineStart, lineEnd));
    if (confidence < MIN_CONFIDENCE) continue;
    const key = `${times.start}|${times.end}`;
    const known = byKey.get(key);
    if (known && known.confidence >= confidence) continue;
    byKey.set(key, {
      key,
      from: hit.from,
      to: hit.to,
      text: text.slice(hit.from, hit.to),
      ...times,
      timeZone: hit.timeZone,
      confidence,
      title: titleFor(text, hit, subject),
      location: locationFor(text, hit),
      quote: quoteFor(text, hit),
      past: times.allDay ? dateOf(times.end) <= referenceDay : times.end <= options.reference,
      ambiguous: hit.ambiguous,
      weekdayMismatch: hit.weekdayMismatch,
      source: options.source ?? "text",
    });
  }
  const events = [...byKey.values()].sort((a, b) => a.from - b.from);
  const max = options.max ?? DEFAULT_MAX;
  if (events.length <= max) return events;
  // Too many: the likeliest ones, still in text order.
  const keep = new Set([...events].sort((a, b) => b.confidence - a.confidence).slice(0, max));
  return events.filter((event) => keep.has(event));
}

function isNumberKind(hit: FoundDate): boolean {
  return NUMBER_KINDS.has(hit.kind);
}
