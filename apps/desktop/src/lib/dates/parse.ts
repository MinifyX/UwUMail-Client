/**
 * Finds dates, times and ranges in plain text, German and English, and resolves them against the
 * day a mail arrived: "morgen 14 Uhr", "am Freitag, 17.10. um 19:30 Uhr", "Oct 6–9",
 * "vom 1. bis 3. November 2026", "10/12/2026 3pm".
 *
 * Rule-based on purpose: small, fast, predictable and without a model reading the mail. Every
 * pattern is linear (no nested quantifiers) and the text is capped, so a mail can't stall the tab.
 * Which of the hits are worth showing is decided in ./detect.
 */

import { addDays, dateOf, daysInMonth, diffDays, weekday as weekdayOfDate, type DateKey } from "@/lib/calendarDates";
import { DASH, DAY, LB, MONTH, RB, WEEKDAY_ANY, WEEKDAY_FULL, YEAR, ZONES, monthOf, weekdayOf } from "./words";

/** More than any real mail says; the rest is not looked at. */
export const MAX_TEXT = 100_000;

export interface Clock {
  h: number;
  min: number;
}

/** How a date was written. Decides how much it is trusted. */
export type DateKind =
  | "iso"
  | "textual"
  | "numeric"
  /** "17.10" without a closing dot: only with a weekday, a cue word or a time. */
  | "numericWeak"
  | "slash"
  | "slashWeak"
  /** heute, morgen, tomorrow … */
  | "relativeDay"
  /** am Freitag, nächsten Dienstag, next Tuesday … */
  | "weekday";

export interface FoundDate {
  /** Where in the text, `to` exclusive. */
  from: number;
  to: number;
  kind: DateKind;
  startDate: DateKey;
  /** The last day of a range, inclusive; null for a single day. */
  endDate: DateKey | null;
  startTime: Clock | null;
  endTime: Clock | null;
  timeZone: string | null;
  /** The year was written, not inferred. */
  yearGiven: boolean;
  /** A weekday was written that doesn't fit the date. */
  weekdayMismatch: boolean;
  /** Day and month could be either way round (10/12/2026). */
  ambiguous: boolean;
}

export interface ParseOptions {
  /** When the mail arrived, as a wall time where the reader is. Relative words count from here. */
  reference: string;
  /** How to read 10/12: month first (US) or day first. */
  slashOrder: "MD" | "DM";
}

interface DatePart {
  y: number | null;
  m: number;
  d: number;
}

type Form = "dayFirst" | "monthFirst" | "numeric" | "iso" | "slash";

interface Expr {
  from: number;
  to: number;
  kind: DateKind;
  form: Form | "relative";
  start: DatePart;
  end: DatePart | null;
  weekday: number | null;
  startTime: Clock | null;
  endTime: Clock | null;
  timeZone: string | null;
  ambiguous: boolean;
  /** A weak form found its support (weekday, cue word or time). */
  supported: boolean;
  /** For relative expressions: the resolved day. */
  resolved?: DateKey;
  evening?: boolean;
  /** "this Friday" / "diesen Freitag": on a Friday that is today. */
  thisDay?: boolean;
}

const pattern = (source: string, flags = "giu") => new RegExp(source, flags);

const TEXT_DAY_FIRST = pattern(
  `${LB}${DAY}(?:\\.|st|nd|rd|th)?\\s{0,3}(?:of\\s{1,3})?${MONTH}(?:\\s{0,3},?\\s{0,3}${YEAR})?`,
);
const TEXT_MONTH_FIRST = pattern(
  `${LB}${MONTH}\\s{0,3}${DAY}(?:st|nd|rd|th)?(?![\\p{L}\\d]|[.:]\\d)(?:\\s{0,3},?\\s{0,3}${YEAR})?`,
);
const NOT_AFTER = "(?<![\\p{L}\\d.,/:€$£#+])";
const NUMERIC = pattern(
  `${NOT_AFTER}${DAY}\\.\\s?(1[0-2]|0?[1-9])\\.(?:\\s?${YEAR}|(\\d{2})(?!\\d|\\s{0,2}(?:uhr|h${RB}|:)))?(?!\\d|[.,]\\d)`,
);
const NUMERIC_WEAK = pattern(
  `${NOT_AFTER}${DAY}\\.(1[0-2]|0?[1-9])(?![\\d.]|,\\d|\\s?(?:uhr|h${RB}|%|€|eur|usd|chf|\\$|kg|km|mb|gb|cm|mm|m${RB}|l${RB}))`,
);
const ISO = pattern(
  "(?<![\\d./-])((?:19|20)\\d{2})-(0[1-9]|1[0-2])-(3[01]|[12]\\d|0[1-9])(?:[T ]([01]\\d|2[0-3]):([0-5]\\d)(?::[0-5]\\d(?:\\.\\d{1,6})?)?(Z)?)?(?![\\d-])",
);
const SLASH = pattern("(?<![\\p{L}\\d./:-])(\\d{1,2})/(\\d{1,2})/((?:19|20)\\d{2}|\\d{2})(?![\\d/]|[.,]\\d)");
const SLASH_WEAK = pattern("(?<![\\p{L}\\d./:-])(\\d{1,2})/(\\d{1,2})(?![\\d/]|[.,]\\d|\\s?(?:%|€|\\$))");

const WEEKDAY_BEFORE = pattern(
  `${LB}${WEEKDAY_ANY}(?!\\p{L})\\.?\\s{0,2},?\\s{0,3}(?:(?:den|der|the)\\s{1,2})?$`,
  "iu",
);
const DAY_BEFORE = pattern(`(?<![\\p{L}\\p{N}.,/:])${DAY}(\\.|st|nd|rd|th)?${DASH}$`, "iu");
const DAY_AFTER = pattern(
  `^${DASH}${DAY}(?:st|nd|rd|th)?(?![\\p{L}\\d]|[.:]\\d|\\s{0,2}(?:[ap]\\.?m|uhr|h${RB}))(?:\\s{0,3},?\\s{0,3}${YEAR})?`,
  "iu",
);
/** Words that make a weak date ("am 17.10") count. */
const CUE_BEFORE =
  /(?<![\p{L}])(am|vom|bis|ab|zum|seit|den|dem|on|from|until|till|by|due|wann|when|datum|date|termin)\s{0,2}:?\s{1,3}$/iu;
const RANGE_BETWEEN = pattern(`^${DASH}$`, "iu");

const REL_DAY = pattern(
  `${LB}(übermorgen|uebermorgen|morgen|heute|today|tonight|tomorrow|(?:the\\s{1,3})?day\\s{1,3}after\\s{1,3}tomorrow)${RB}(?:\\s{1,3}(abend|abends|früh|morgen|vormittag|nachmittag|mittag|nacht|evening|morning|afternoon|night))?`,
);
const REL_WEEKDAY = pattern(
  `${LB}(?:(nächsten|nächste|nächster|naechsten|kommenden|kommende|diesen|dieser|diese|am|next|this\\s{1,3}coming|this|coming|on)\\s{1,3})?${WEEKDAY_FULL}${RB}(?:\\s{1,3}(abend|abends|früh|morgen|vormittag|nachmittag|mittag|nacht|evening|morning|afternoon|night))?`,
);
/** Where "morgen" is the morning or a greeting, or a weekday means every week or the past. */
const REL_BLOCKED_BEFORE =
  /(?<![\p{L}])(guten|good|am|jeden|jede|every|each|den|dem|von|seit|since|gestern|vorgestern|letzten|letzte|vergangenen|last|past|previous|black|cyber|giving|holy)\s{1,3}$/iu;
const EVENING_WORDS = /^(abend|abends|nachmittag|nacht|evening|afternoon|night|tonight)$/i;

// Times, read at one position (sticky).
const T_AMPM = /(1[0-2]|0?[1-9])(?::([0-5]\d))?\s?([ap])\.?\s?m\.?(?!\p{L})/iuy;
const T_H24 = /([01]?\d|2[0-3])(?:[:.]([0-5]\d))?\s?(?:uhr|h)(?!\p{L})/iuy;
const T_COLON = /([01]?\d|2[0-3]):([0-5]\d)(?!\d|:\d)/uy;
const T_WORD = /(noon|midday|midnight|mitternacht)(?!\p{L})/iuy;
const T_BARE =
  /([01]?\d|2[0-3])(?![\d:.,]|\s?(?:%|€|\$|eur|min|std|stunden|hours?|tage?|days?|jahre?|years?|personen|people|leute|x(?!\p{L})|mal|times|euro|dollar|punkte|points|stück|pcs|°|\/))/iuy;
const T_DASH = /\s{0,3}(?:[-–—‐‑]|bis|to|until|till)\s{0,3}/iuy;
const T_ZONE = /\s{0,2}\(?(MESZ|MEZ|CEST|CET|UTC|GMT|BST|EST|EDT|ET|CST|CDT|CT|MST|MDT|PST|PDT|PT)\)?(?!\p{L})/uy;
/**
 * What may stand between a date and its time: a label on the next line, the time alone on the next
 * line ("Samstag, 17. Oktober<br>10:00 – 16:00 Uhr"), or a comma and a word. Groups 1 and 2: a word
 * that lets a bare hour count.
 */
const TIME_AFTER =
  /(?:[ \t]{0,3}\n\s{0,3}(uhrzeit|zeit|time|beginn|start|einlass|doors)[ \t]{0,2}:[ \t]{0,3}|[ \t]{0,3}\n[ \t]{0,3}(?=\d{1,2}(?:[:.]\d{2}|\s?(?:uhr|[ap]\.?m)))|[ \t]{0,3}[,|·•@/–—-]?[ \t]{0,3}(?:(um|ab|at|from|von|gegen|jeweils|ca\.?|circa|starting at|beginning at|beginnt um|beginn(?:t)?|starts? at|starts?|einlass(?: ab| um)?|doors(?: open)?(?: at)?)[: \t]{1,3})?)/iuy;
const TIME_BEFORE_GAP = /^\s{0,3},?\s{0,3}(?:(?:am|on|den|dem|,)\s{1,3}){0,2}$/iu;
const BARE_OK_BEFORE = /(?<![\p{L}])(um|at|ab|gegen|von|from|ca\.?|circa)\s{1,3}$/iu;

interface ClockHit {
  clock: Clock;
  end: number;
  meridiem: "a" | "p" | null;
  bare: boolean;
}

function exec(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(text);
}

function clockAt(text: string, at: number, allowBare: boolean): ClockHit | null {
  let match = exec(T_AMPM, text, at);
  if (match) {
    const hour = Number(match[1]) % 12;
    const pm = match[3]!.toLowerCase() === "p";
    return {
      clock: { h: hour + (pm ? 12 : 0), min: Number(match[2] ?? 0) },
      end: at + match[0].length,
      meridiem: pm ? "p" : "a",
      bare: false,
    };
  }
  match = exec(T_H24, text, at) ?? exec(T_COLON, text, at);
  if (match) {
    return {
      clock: { h: Number(match[1]), min: Number(match[2] ?? 0) },
      end: at + match[0].length,
      meridiem: null,
      bare: false,
    };
  }
  match = exec(T_WORD, text, at);
  if (match) {
    const midnight = /^(midnight|mitternacht)$/i.test(match[1]!);
    return { clock: { h: midnight ? 0 : 12, min: 0 }, end: at + match[0].length, meridiem: null, bare: false };
  }
  if (!allowBare) return null;
  match = exec(T_BARE, text, at);
  if (match) return { clock: { h: Number(match[1]), min: 0 }, end: at + match[0].length, meridiem: null, bare: true };
  return null;
}

export interface TimeRange {
  from: number;
  to: number;
  start: Clock;
  end: Clock | null;
  timeZone: string | null;
  /** A lone number ("um 8"): an evening word may still move it to the afternoon. */
  bare: boolean;
}

/** "19:30", "14–16 Uhr", "3-5pm", "von 14 bis 16 Uhr" (from the number on), with a zone. */
export function timeRangeAt(text: string, at: number, bareOk: boolean): TimeRange | null {
  const first = clockAt(text, at, true);
  if (!first) return null;
  let end = first.end;
  let second: ClockHit | null = null;
  const dash = exec(T_DASH, text, end);
  if (dash && dash[0].length > 0) second = clockAt(text, end + dash[0].length, false);
  if (second) end = second.end;
  if (first.bare && !second && !bareOk) return null;
  const start = { ...first.clock };
  if (second && first.meridiem === null && second.meridiem === "p" && start.h < 12) {
    // "3-5pm", "11-1pm": the first end takes the afternoon when it still comes first.
    if (start.h + 12 <= second.clock.h) start.h += 12;
  }
  let timeZone: string | null = null;
  const zone = exec(T_ZONE, text, end);
  if (zone) {
    timeZone = ZONES[zone[1]!] ?? null;
    end += zone[0].length;
  }
  return { from: at, to: end, start, end: second?.clock ?? null, timeZone, bare: first.bare && !second };
}

function isTimeStart(text: string, index: number): boolean {
  const char = text.charCodeAt(index);
  if (char < 48 || char > 57) return false;
  if (index === 0) return true;
  return !/[\p{L}\p{N}.,:/]/u.test(text[index - 1]!);
}

/** Every time in the text that stands on its own; a lone number only after "um", "at" … */
function allTimes(text: string): TimeRange[] {
  const found: TimeRange[] = [];
  for (let index = 0; index < text.length; index++) {
    if (!isTimeStart(text, index)) continue;
    const bareOk = BARE_OK_BEFORE.test(text.slice(Math.max(0, index - 10), index));
    const range = timeRangeAt(text, index, bareOk);
    if (range) {
      found.push(range);
      index = range.to - 1;
    }
  }
  return found;
}

function dateKey(y: number, m: number, d: number): DateKey | null {
  if (m < 1 || m > 12 || d < 1 || y < 1900 || y > 2199 || d > daysInMonth(y, m)) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function fullYear(value: string | undefined): number | null {
  if (!value) return null;
  const year = Number(value);
  return value.length === 2 ? 2000 + year : year;
}

function atoms(text: string, slashOrder: "MD" | "DM"): Expr[] {
  const found: Expr[] = [];
  const add = (from: number, to: number, kind: DateKind, form: Form, part: DatePart, extra: Partial<Expr> = {}) =>
    found.push({
      from,
      to,
      kind,
      form,
      start: part,
      end: null,
      weekday: null,
      startTime: null,
      endTime: null,
      timeZone: null,
      ambiguous: false,
      supported: kind !== "numericWeak" && kind !== "slashWeak",
      ...extra,
    });
  const each = (re: RegExp, run: (match: RegExpExecArray) => void) => {
    re.lastIndex = 0;
    for (let match = re.exec(text); match; match = re.exec(text)) run(match);
  };

  each(TEXT_DAY_FIRST, (match) => {
    add(match.index, match.index + match[0].length, "textual", "dayFirst", {
      y: fullYear(match[3]),
      m: monthOf(match[2]!),
      d: Number(match[1]),
    });
  });
  each(TEXT_MONTH_FIRST, (match) => {
    add(match.index, match.index + match[0].length, "textual", "monthFirst", {
      y: fullYear(match[3]),
      m: monthOf(match[1]!),
      d: Number(match[2]),
    });
  });
  each(NUMERIC, (match) => {
    add(match.index, match.index + match[0].length, "numeric", "numeric", {
      y: fullYear(match[3] ?? match[4]),
      m: Number(match[2]),
      d: Number(match[1]),
    });
  });
  each(NUMERIC_WEAK, (match) => {
    add(match.index, match.index + match[0].length, "numericWeak", "numeric", {
      y: null,
      m: Number(match[2]),
      d: Number(match[1]),
    });
  });
  each(ISO, (match) => {
    add(
      match.index,
      match.index + match[0].length,
      "iso",
      "iso",
      { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) },
      match[4]
        ? { startTime: { h: Number(match[4]), min: Number(match[5]) }, timeZone: match[6] ? "Etc/UTC" : null }
        : {},
    );
  });
  const slash = (match: RegExpExecArray, weak: boolean) => {
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (a < 1 || b < 1 || (a > 12 && b > 12)) return;
    const monthFirst = a > 12 ? false : b > 12 ? true : slashOrder === "MD";
    add(
      match.index,
      match.index + match[0].length,
      weak ? "slashWeak" : "slash",
      "slash",
      { y: weak ? null : fullYear(match[3]), m: monthFirst ? a : b, d: monthFirst ? b : a },
      { ambiguous: a <= 12 && b <= 12 && a !== b },
    );
  };
  each(SLASH, (match) => slash(match, false));
  each(SLASH_WEAK, (match) => slash(match, true));

  // The earliest, then the longest; whatever overlaps a kept one goes.
  found.sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from));
  const kept: Expr[] = [];
  for (const expr of found) {
    const last = kept[kept.length - 1];
    if (last && expr.from < last.to) continue;
    kept.push(expr);
  }
  return kept;
}

/** Slash dates that can only be read one way tell how the others in the same mail are meant. */
export function slashOrderOf(text: string, fallback: "MD" | "DM"): "MD" | "DM" {
  SLASH.lastIndex = 0;
  for (let match = SLASH.exec(text); match; match = SLASH.exec(text)) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (a > 12 && b <= 12) return "DM";
    if (b > 12 && a <= 12) return "MD";
  }
  return fallback;
}

/** Weekday in front, a first day in front ("6.–9. Okt"), a last day behind ("Oct 6–9"). */
function extend(text: string, exprs: Expr[]) {
  for (let index = 0; index < exprs.length; index++) {
    const expr = exprs[index]!;
    const previousEnd = index > 0 ? exprs[index - 1]!.to : 0;
    if (expr.form === "dayFirst" || expr.form === "numeric") {
      const before = text.slice(Math.max(previousEnd, expr.from - 16), expr.from);
      const match = DAY_BEFORE.exec(before);
      // The German way ("6.–9.10.") needs its dot; "6–9 October" goes without.
      if (match && (expr.form === "dayFirst" || match[2] === ".")) {
        const day = Number(match[1]);
        let { y, m } = expr.start;
        if (day > expr.start.d) {
          m -= 1;
          if (m === 0) {
            m = 12;
            if (y !== null) y -= 1;
          }
        }
        if (day !== expr.start.d) {
          expr.end = expr.start;
          expr.start = { y, m, d: day };
          expr.from -= before.length - match.index;
          expr.supported = true;
        }
      }
    }
    if (expr.form === "monthFirst" && expr.start.y === null && !expr.end) {
      const next = exprs[index + 1];
      const after = text.slice(expr.to, Math.min(next ? next.from : text.length, expr.to + 24));
      const match = DAY_AFTER.exec(after);
      if (match && Number(match[1]) > expr.start.d) {
        const year = fullYear(match[2]);
        expr.end = { y: year, m: expr.start.m, d: Number(match[1]) };
        if (year !== null) expr.start = { ...expr.start, y: year };
        expr.to += match[0].length;
      }
    }
    const before = text.slice(Math.max(previousEnd, expr.from - 24), expr.from);
    const weekday = WEEKDAY_BEFORE.exec(before);
    if (weekday) {
      const day = weekdayOf(weekday[1]!);
      if (day !== null) {
        expr.weekday = day;
        expr.from -= before.length - weekday.index;
        expr.supported = true;
      }
    }
    if (!expr.supported && CUE_BEFORE.test(text.slice(Math.max(previousEnd, expr.from - 16), expr.from))) {
      expr.supported = true;
    }
  }
}

/** Puts times next to their dates: behind first ("17.10. um 19:30"), else in front ("19 Uhr am Freitag"). */
function attachTimes(text: string, exprs: Expr[], times: TimeRange[]) {
  const used = new Set<TimeRange>();
  // Times inside a date (an ISO one brings its own) don't count on their own.
  const free = times.filter((time) => !exprs.some((expr) => time.from < expr.to && time.to > expr.from));
  for (let index = 0; index < exprs.length; index++) {
    const expr = exprs[index]!;
    if (expr.startTime) continue;
    const limit = exprs[index + 1]?.from ?? text.length;
    const gap = exec(TIME_AFTER, text, expr.to);
    const at = expr.to + (gap?.[0].length ?? 0);
    if (at < limit) {
      const bareOk = !!gap?.[1] || !!gap?.[2];
      const time =
        free.find((candidate) => candidate.from === at && !used.has(candidate)) ?? timeRangeAt(text, at, bareOk);
      if (time && time.to <= limit) {
        used.add(time);
        setTime(expr, time);
        expr.to = time.to;
        continue;
      }
    }
    const previousEnd = index > 0 ? exprs[index - 1]!.to : 0;
    const before = [...free]
      .reverse()
      .find((time) => time.to <= expr.from && time.from >= previousEnd && !used.has(time));
    if (before && expr.from - before.to <= 14 && TIME_BEFORE_GAP.test(text.slice(before.to, expr.from))) {
      used.add(before);
      setTime(expr, before);
      // "um 19 Uhr am Freitag": the whole phrase is the hit.
      const keyword = /(?<![\p{L}])(um|at|ab|gegen|von|from)\s{1,3}$/iu.exec(text.slice(previousEnd, before.from));
      expr.from = keyword ? before.from - (text.slice(previousEnd, before.from).length - keyword.index) : before.from;
    }
  }
}

function setTime(expr: Expr, time: TimeRange) {
  const start = { ...time.start };
  let end = time.end ? { ...time.end } : null;
  // "heute Abend um 8", "tonight at 8": the evening, not the morning.
  if (expr.evening && time.bare && start.h < 12) start.h += 12;
  if (expr.evening && end && end.h < 12 && end.h + 12 > start.h) end = { h: end.h + 12, min: end.min };
  expr.startTime = start;
  expr.endTime = end;
  expr.timeZone = time.timeZone ?? expr.timeZone;
  expr.supported = true;
}

/** "17.10. 19 Uhr – 18.10. 2 Uhr", "30. Okt. – 2. Nov.", "Dec 28, 2026 – Jan 2, 2027". */
function mergeRanges(text: string, exprs: Expr[]): Expr[] {
  const merged: Expr[] = [];
  for (const expr of exprs) {
    const last = merged[merged.length - 1];
    if (
      last &&
      !last.end &&
      !expr.end &&
      last.form !== "relative" &&
      expr.form !== "relative" &&
      RANGE_BETWEEN.test(text.slice(last.to, expr.from))
    ) {
      last.end = expr.start;
      last.to = expr.to;
      last.supported ||= expr.supported;
      if (last.startTime && expr.startTime) last.endTime = expr.startTime;
      else if (!last.startTime && expr.startTime) {
        last.startTime = expr.startTime;
        last.endTime = expr.endTime;
      }
      continue;
    }
    merged.push(expr);
  }
  return merged;
}

function overlapsAny(from: number, to: number, exprs: Expr[]) {
  return exprs.some((expr) => from < expr.to && to > expr.from);
}

/** "morgen 14 Uhr", "tomorrow at 3pm", "am Freitag", "nächsten Dienstag um 10". */
function relatives(text: string, exprs: Expr[], reference: DateKey): Expr[] {
  const found: Expr[] = [];
  const blocked = (index: number) => REL_BLOCKED_BEFORE.test(text.slice(Math.max(0, index - 14), index));

  REL_DAY.lastIndex = 0;
  for (let match = REL_DAY.exec(text); match; match = REL_DAY.exec(text)) {
    const from = match.index;
    const to = from + match[0].length;
    if (overlapsAny(from, to, exprs) || blocked(from)) continue;
    const word = match[1]!.toLowerCase().replace(/\s+/g, " ");
    const offset =
      word === "heute" || word === "today" || word === "tonight" ? 0 : /über|ueber|after/.test(word) ? 2 : 1;
    const part = match[2]?.toLowerCase() ?? (word === "tonight" ? "tonight" : "");
    found.push(relative(from, to, "relativeDay", addDays(reference, offset), EVENING_WORDS.test(part)));
  }

  REL_WEEKDAY.lastIndex = 0;
  for (let match = REL_WEEKDAY.exec(text); match; match = REL_WEEKDAY.exec(text)) {
    const from = match.index;
    const to = from + match[0].length;
    if (overlapsAny(from, to, exprs) || blocked(from)) continue;
    const modifier = match[1]?.toLowerCase().replace(/\s+/g, " ") ?? "";
    const target = weekdayOf(match[2]!)!;
    let offset = (target - weekdayOfDate(reference) + 7) % 7;
    const next = /^(nächste|naechste|kommende|next|coming|this coming)/.test(modifier);
    const expr = relative(from, to, "weekday", reference, EVENING_WORDS.test(match[3] ?? ""));
    expr.weekday = target;
    expr.supported = modifier !== "";
    // "this Friday" on a Friday is today; "am Freitag" on a Friday usually the next one, unless
    // a time says otherwise (decided once the times are attached).
    if (offset === 0 && next) offset = 7;
    expr.resolved = addDays(reference, offset);
    expr.thisDay = /^(this|diese)/.test(modifier);
    found.push(expr);
  }
  return found.sort((a, b) => a.from - b.from);
}

function relative(from: number, to: number, kind: DateKind, day: DateKey, evening: boolean): Expr {
  return {
    from,
    to,
    kind,
    form: "relative",
    start: { y: Number(day.slice(0, 4)), m: Number(day.slice(5, 7)), d: Number(day.slice(8, 10)) },
    end: null,
    weekday: null,
    startTime: null,
    endTime: null,
    timeZone: null,
    ambiguous: false,
    supported: false,
    resolved: day,
    evening,
  };
}

/** The year a date without one most likely means: the next time it comes after the mail, give or take. */
function resolve(
  part: DatePart,
  reference: DateKey,
  weekday: number | null,
): { key: DateKey; mismatch: boolean } | null {
  if (part.y !== null) {
    const key = dateKey(part.y, part.m, part.d);
    if (!key) return null;
    return { key, mismatch: weekday !== null && weekdayOfDate(key) !== weekday };
  }
  const year = Number(reference.slice(0, 4));
  const options = [year - 1, year, year + 1, year + 2]
    .map((y) => dateKey(y, part.m, part.d))
    .filter((key): key is DateKey => key !== null);
  // Up to two months back still means this year (something that just happened or is running).
  const upcoming = options.filter((key) => diffDays(reference, key) >= -60);
  if (weekday !== null) {
    const fitting = upcoming.find((key) => weekdayOfDate(key) === weekday && diffDays(reference, key) <= 400);
    if (fitting) return { key: fitting, mismatch: false };
  }
  const key = upcoming[0];
  if (!key) return null;
  return { key, mismatch: weekday !== null && weekdayOfDate(key) !== weekday };
}

/** Every date the text mentions, resolved against the mail's arrival. Unsorted by worth. */
export function findDates(input: string, options: ParseOptions): FoundDate[] {
  const text = input.length > MAX_TEXT ? input.slice(0, MAX_TEXT) : input;
  const reference = dateOf(options.reference);
  const exprs = atoms(text, slashOrderOf(text, options.slashOrder));
  extend(text, exprs);
  const times = allTimes(text);
  const withRelatives = [...exprs, ...relatives(text, exprs, reference)].sort((a, b) => a.from - b.from);
  attachTimes(text, withRelatives, times);
  const merged = mergeRanges(text, withRelatives);

  const results: FoundDate[] = [];
  for (const expr of merged) {
    if (!expr.supported) continue;
    // A day word alone ("heute", "tomorrow") says too little; with a time it's an appointment.
    if (expr.kind === "relativeDay" && !expr.startTime) continue;
    let startDate: DateKey;
    let mismatch = false;
    if (expr.form === "relative") {
      startDate = expr.resolved!;
      // "am Freitag" written on a Friday is the next one, unless a time later that day says today.
      if (expr.kind === "weekday" && startDate === reference && !expr.thisDay && !expr.startTime) {
        startDate = addDays(reference, 7);
      } else if (expr.kind === "weekday" && startDate === reference && !expr.thisDay && expr.startTime) {
        const clock = expr.startTime.h * 60 + expr.startTime.min;
        const now = Number(options.reference.slice(11, 13)) * 60 + Number(options.reference.slice(14, 16));
        if (clock <= now) startDate = addDays(reference, 7);
      }
    } else {
      let part = expr.start;
      if (expr.end && part.y === null && expr.end.y !== null) {
        // "30. Dez. – 2. Jan. 2027": the start lies in the year before.
        const later = part.m > expr.end.m || (part.m === expr.end.m && part.d > expr.end.d);
        part = { ...part, y: expr.end.y - (later ? 1 : 0) };
      }
      const start = resolve(part, reference, expr.weekday);
      if (!start) continue;
      startDate = start.key;
      mismatch = start.mismatch;
    }
    let endDate: DateKey | null = null;
    if (expr.end) {
      const y = expr.end.y ?? Number(startDate.slice(0, 4));
      let key = dateKey(y, expr.end.m, expr.end.d);
      if (key && key < startDate && expr.end.y === null) key = dateKey(y + 1, expr.end.m, expr.end.d);
      if (!key || key < startDate || diffDays(startDate, key) > 366) continue;
      endDate = key === startDate ? null : key;
    }
    results.push({
      from: expr.from,
      to: expr.to,
      kind: expr.kind,
      startDate,
      endDate,
      startTime: expr.startTime,
      endTime: expr.endTime,
      timeZone: expr.timeZone,
      yearGiven: expr.form === "relative" || expr.start.y !== null,
      weekdayMismatch: mismatch,
      ambiguous: expr.ambiguous,
    });
  }
  return results;
}
