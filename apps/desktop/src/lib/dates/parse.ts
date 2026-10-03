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
  "(?<![\\p{L}\\d./_-])((?:19|20)\\d{2})-(0[1-9]|1[0-2])-(3[01]|[12]\\d|0[1-9])(?:[T ]([01]\\d|2[0-3]):([0-5]\\d)(?::[0-5]\\d(?:\\.\\d{1,6})?)?(Z)?)?(?![\\d-])",
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
/** "zwischen Mi. 22. und Do. 23. Januar": the first day of a range written with "und". */
const BETWEEN_DAY_BEFORE = pattern(
  `(?<![\\p{L}])(?:zwischen|zw\\.|between)\\s{1,3}(?:${WEEKDAY_ANY}\\.?,?\\s{1,3})?${DAY}(?:\\.|st|nd|rd|th)?\\s{1,3}(?:und|and)\\s{1,3}(?:${WEEKDAY_ANY}\\.?,?\\s{1,3})?$`,
  "iu",
);
/** Words that make a weak date ("am 17.10") count. */
const CUE_BEFORE =
  /(?<![\p{L}])(am|vom|bis|ab|zum|seit|den|dem|on|from|until|till|by|due|wann|when|datum|date|termin)\s{0,2}:?\s{1,3}$/iu;
const RANGE_BETWEEN = pattern(`^${DASH}$`, "iu");
/** "zwischen Fr. 31. Januar und Fr. 7. Februar": "und" joins two dates only after "zwischen". */
const RANGE_AND = /^\s{1,3}(?:und|and)\s{1,3}$/iu;
const BETWEEN_BEFORE = /(?<![\p{L}])(?:zwischen|zw\.|between)\s{1,3}$/iu;

const REL_DAY = pattern(
  `${LB}(übermorgen|uebermorgen|morgen|heute|today|tonight|tomorrow|(?:the\\s{1,3})?day\\s{1,3}after\\s{1,3}tomorrow)${RB}(?:\\s{1,3}(abend|abends|früh|morgen|vormittag|nachmittag|mittag|nacht|evening|morning|afternoon|night))?`,
);
const REL_WEEKDAY = pattern(
  `${LB}(?:(?:am|on)\\s{1,3}(?=nächst|naechst|kommend|next|coming))?(?:(nächsten|nächste|nächster|naechsten|kommenden|kommende|diesen|dieser|diese|am|next|this\\s{1,3}coming|this|coming|on)\\s{1,3})?${WEEKDAY_FULL}${RB}(?:\\s{1,3}(abend|abends|früh|morgen|vormittag|nachmittag|mittag|nacht|evening|morning|afternoon|night))?`,
);
/** Where "morgen" is the morning or a greeting, or a weekday means every week or the past. */
const REL_BLOCKED_BEFORE =
  /(?<![\p{L}])(guten|good|am|jeden|jede|every|each|den|dem|von|seit|since|gestern|vorgestern|letzten|letzte|vergangenen|last|past|previous|black|cyber|giving|holy)\s{1,3}$/iu;
const EVENING_WORDS = /^(abend|abends|nachmittag|nacht|evening|afternoon|night|tonight)$/i;

// Times, read at one position (sticky).
const T_AMPM = /(1[0-2]|0?[1-9])(?:[:.]([0-5]\d))?\s?([ap])\.?\s?m\.?(?!\p{L})/iuy;
const T_H24 = /([01]?\d|2[0-3])(?:[:.]([0-5]\d))?\s?(?:uhr|h)(?!\p{L})/iuy;
const T_COLON = /([01]?\d|2[0-3]):([0-5]\d)(?!\d|:\d)/uy;
const T_WORD = /(noon|midday|midnight|mitternacht)(?!\p{L})/iuy;
/** "10.00" without "Uhr": a time only in a range or after "um", "von", "zwischen" … like a lone hour. */
const T_DOTTED =
  /([01]?\d|2[0-3])\.([0-5]\d)(?![\d.,]|\s?(?:%|€|\$|eur|usd|chf|kg|km|mb|gb|cm|mm|m(?!\p{L})|l(?!\p{L})|v(?!\p{L})|prozent))/iuy;
const T_BARE =
  /([01]?\d|2[0-3])(?![\d:.,]|\s?(?:%|€|\$|eur|min|std|stunden|hours?|tage?|days?|jahre?|years?|personen|people|leute|x(?!\p{L})|mal|times|euro|dollar|punkte|points|stück|pcs|°|\/))/iuy;
const T_DASH = /\s{0,3}(?:[-–—‐‑]|bis|to|until|till)\s{0,3}/iuy;
/** After "zwischen"/"between", "und"/"and" ends the range too. */
const T_DASH_BETWEEN = /\s{0,3}(?:[-–—‐‑]|bis|to|until|till|und|and)\s{0,3}/iuy;
/** German hours as words, for "halb drei", "Viertel nach zehn", "elf Uhr". */
const HOUR_WORDS: Record<string, number> = {
  eins: 1,
  ein: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  fünf: 5,
  fuenf: 5,
  sechs: 6,
  sieben: 7,
  acht: 8,
  neun: 9,
  zehn: 10,
  elf: 11,
  zwölf: 12,
  zwoelf: 12,
};
const HOUR_WORD = "(zwölf|zwoelf|sieben|sechs|fünf|fuenf|eins|zwei|drei|vier|acht|neun|zehn|elf|ein|1[0-2]|0?[1-9])";
/** "halb drei", "Viertel nach zehn", "Viertel vor acht", "dreiviertel acht". */
const T_GERMAN = new RegExp(
  `(?:(halb)|(viertel\\s{1,2}nach)|(viertel\\s{1,2}vor|dreiviertel|drei\\s?viertel))\\s{1,2}${HOUR_WORD}(?:\\s{0,2}uhr)?(?!\\p{L})`,
  "iuy",
);
/** "drei Uhr", "elf Uhr". */
const T_HOUR_WORD = new RegExp(
  `(zwölf|zwoelf|sieben|sechs|fünf|fuenf|eins|zwei|drei|vier|acht|neun|zehn|elf|ein)\\s{1,2}uhr(?!\\p{L})`,
  "iuy",
);
/** Words after a time that say which half of the day: "drei Uhr nachmittags", "8 Uhr morgens". */
const T_DAYPART =
  /\s{0,2}(nachmittags|abends|nachts|morgens|vormittags|früh|mittags|in\s{1,2}the\s{1,2}(?:morning|afternoon|evening)|at\s{1,2}night)(?!\p{L})/iuy;
/** The academic quarter: "14 Uhr c.t." starts at 14:15, "s.t." on the hour. */
const T_ACADEMIC = /\s{0,2}([cs])\.\s?t\.?(?!\p{L})/iuy;
const T_ZONE = /\s{0,2}\(?(MESZ|MEZ|CEST|CET|UTC|GMT|BST|EST|EDT|ET|CST|CDT|CT|MST|MDT|PST|PDT|PT)\)?(?!\p{L})/uy;
/**
 * What may stand between a date and its time: a label on the next line, the time alone on the next
 * line ("Samstag, 17. Oktober<br>10:00 – 16:00 Uhr"), or a comma and a word. Groups 1 and 2: a word
 * that lets a bare hour count.
 */
const TIME_AFTER =
  /(?:[ \t]{0,3}\n\s{0,3}(uhrzeit|zeitfenster|lieferzeitfenster|zeitraum|zeit|time|time slot|beginn|start|einlass|doors)[ \t]{0,2}:[ \t]{0,3}(?:(?:um|ab|von|zwischen|zw\.|from|at|between)[ \t]{1,3})?|[ \t]{0,3}\n[ \t]{0,3}(?=\d{1,2}(?:[:.]\d{2}|\s?(?:uhr|[ap]\.?m)))|[ \t]{0,3}\n[ \t]{0,3}(zwischen|zw\.|between|von|from|ab|um|at)[ \t]{1,3}(?=\d)|[ \t]{0,3}[,|·•@/–—-]?[ \t]{0,3}(?:(um|ab|at|from|von|gegen|jeweils|zwischen|zw\.|between|in der zeit (?:von|zwischen)|ca\.?|circa|starting at|beginning at|beginnt um|beginn(?:t)?|starts? at|starts?|einlass(?: ab| um)?|doors(?: open)?(?: at)?)[: \t]{1,3})?)/iuy;
const TIME_BEFORE_GAP = /^\s{0,3},?\s{0,3}(?:(?:am|on|den|dem|,)\s{1,3}){0,2}$/iu;
const BARE_OK_BEFORE = /(?<![\p{L}])(um|at|ab|gegen|von|from|zwischen|zw\.|between|ca\.?|circa)\s{1,3}$/iu;
/** Right before a time: "zwischen 10 und 12". */
const BETWEEN_AT = /(?<![\p{L}])(?:zwischen|zw\.|between)\s{1,3}$/iu;

interface ClockHit {
  clock: Clock;
  end: number;
  meridiem: "a" | "p" | null;
  bare: boolean;
  /** Said in words ("halb drei"): the hour may mean the afternoon. */
  spoken?: boolean;
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
  match = exec(T_GERMAN, text, at);
  if (match) {
    const named = HOUR_WORDS[match[4]!.toLowerCase()] ?? Number(match[4]);
    // "halb drei" is half past two; without "morgens" an afternoon, as appointments mostly are.
    let hour = match[1] || match[3] ? named - 1 : named;
    if (hour === 0) hour = 12;
    const min = match[1] ? 30 : match[2] ? 15 : 45;
    return { clock: { h: hour, min }, end: at + match[0].length, meridiem: null, bare: false, spoken: true };
  }
  match = exec(T_HOUR_WORD, text, at);
  if (match) {
    return {
      clock: { h: HOUR_WORDS[match[1]!.toLowerCase()]!, min: 0 },
      end: at + match[0].length,
      meridiem: null,
      bare: false,
      spoken: true,
    };
  }
  match = exec(T_WORD, text, at);
  if (match) {
    const midnight = /^(midnight|mitternacht)$/i.test(match[1]!);
    return { clock: { h: midnight ? 0 : 12, min: 0 }, end: at + match[0].length, meridiem: null, bare: false };
  }
  if (!allowBare) return null;
  match = exec(T_DOTTED, text, at);
  if (match) {
    return {
      clock: { h: Number(match[1]), min: Number(match[2]) },
      end: at + match[0].length,
      meridiem: null,
      bare: true,
    };
  }
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

/** "nachmittags", "abends" … after a time: where it falls in the day. Null when none follows. */
function daypartAt(text: string, at: number): { length: number; later: boolean | null } | null {
  const match = exec(T_DAYPART, text, at);
  if (!match) return null;
  const word = match[1]!.toLowerCase().replace(/\s+/g, " ");
  const later = /^(nachmittags|abends|nachts|in the afternoon|in the evening|at night)$/.test(word)
    ? true
    : /^(morgens|vormittags|früh|in the morning)$/.test(word)
      ? false
      : null;
  return { length: match[0].length, later };
}

function toAfternoon(clock: Clock): Clock {
  return clock.h < 12 ? { h: clock.h + 12, min: clock.min } : clock;
}

/**
 * "19:30", "14–16 Uhr", "3-5pm", "von 14 bis 16 Uhr" (from the number on), "zwischen 10 und 12",
 * "halb drei", "14 Uhr c.t.", with a zone.
 */
export function timeRangeAt(text: string, at: number, bareOk: boolean): TimeRange | null {
  const between = BETWEEN_AT.test(text.slice(Math.max(0, at - 12), at));
  const first = clockAt(text, at, true);
  if (!first) return null;
  let end = first.end;
  let second: ClockHit | null = null;
  const dash = exec(between ? T_DASH_BETWEEN : T_DASH, text, end);
  if (dash && dash[0].length > 0) {
    // "von 10 bis 12", "zwischen 10 und 12": a second lone number counts once the first was asked for.
    second = clockAt(text, end + dash[0].length, !first.bare || bareOk || between);
    // "10 bis 12 Minuten" is no time at all.
    if (second && first.bare && second.bare && !(bareOk || between)) second = null;
  }
  if (second) end = second.end;
  if (first.bare && !second && !bareOk) return null;
  let start = { ...first.clock };
  let last = second ? { ...second.clock } : null;
  if (second && first.meridiem === null && second.meridiem === "p" && start.h < 12) {
    // "3-5pm", "11-1pm": the first end takes the afternoon when it still comes first.
    if (start.h + 12 <= second.clock.h) start.h += 12;
  }
  const academic = exec(T_ACADEMIC, text, end);
  if (academic) {
    if (academic[1]!.toLowerCase() === "c") {
      const minutes = start.h * 60 + start.min + 15;
      start = { h: Math.floor(minutes / 60) % 24, min: minutes % 60 };
    }
    end += academic[0].length;
  }
  const daypart = daypartAt(text, end);
  if (daypart) end += daypart.length;
  const spoken = first.spoken || second?.spoken;
  if (daypart?.later === true && first.meridiem === null) {
    // "um 7 Uhr abends", "11 Uhr nachts" (but "2 Uhr nachts" stays at night).
    const night = /nacht|night/i.test(text.slice(end - daypart.length, end));
    if (!(night && start.h < 5)) start = toAfternoon(start);
    if (last && second?.meridiem === null && last.h < 12 && last.h + 12 > start.h) last = toAfternoon(last);
  } else if (spoken && daypart?.later !== false && first.meridiem === null && start.h >= 1 && start.h <= 7) {
    // "halb drei", "Viertel vor acht": spoken hours up to seven are the afternoon or evening.
    start = toAfternoon(start);
    if (last && last.h < 12 && last.h + 12 > start.h) last = toAfternoon(last);
  }
  let timeZone: string | null = null;
  const zone = exec(T_ZONE, text, end);
  if (zone) {
    timeZone = ZONES[zone[1]!] ?? null;
    end += zone[0].length;
  }
  return { from: at, to: end, start, end: last, timeZone, bare: first.bare && !second };
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
      const wide = text.slice(Math.max(previousEnd, expr.from - 44), expr.from);
      const between = BETWEEN_DAY_BEFORE.exec(wide);
      const before = text.slice(Math.max(previousEnd, expr.from - 16), expr.from);
      const match = between ? null : DAY_BEFORE.exec(before);
      if (between) {
        const day = Number(between[2]);
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
          expr.from -= wide.length - between.index;
          expr.supported = true;
          continue;
        }
      }
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
    const limit = exprs[index + 1]?.from ?? text.length;
    if (expr.startTime) {
      // An ISO date brings its own start: "2026-10-03 10:00–12:00", "2026-09-29 07:14 UTC".
      const tail = exec(T_DASH, text, expr.to);
      const second = tail && tail[0].length > 0 ? clockAt(text, expr.to + tail[0].length, false) : null;
      if (second && second.end <= limit) {
        expr.endTime = second.clock;
        expr.to = second.end;
      }
      const zone = exec(T_ZONE, text, expr.to);
      if (zone && expr.to + zone[0].length <= limit) {
        expr.timeZone = ZONES[zone[1]!] ?? expr.timeZone;
        expr.to += zone[0].length;
      }
      continue;
    }
    const gap = exec(TIME_AFTER, text, expr.to);
    const at = expr.to + (gap?.[0].length ?? 0);
    if (at < limit) {
      const bareOk = !!gap?.[1] || !!gap?.[2] || !!gap?.[3];
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
      const keyword = /(?<![\p{L}])(um|at|ab|gegen|von|from|zwischen|zw\.|between)\s{1,3}$/iu.exec(
        text.slice(previousEnd, before.from),
      );
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
      (RANGE_BETWEEN.test(text.slice(last.to, expr.from)) ||
        (RANGE_AND.test(text.slice(last.to, expr.from)) &&
          BETWEEN_BEFORE.test(text.slice(Math.max(0, last.from - 12), last.from))))
    ) {
      last.end = expr.start;
      last.to = expr.to;
      last.supported ||= expr.supported;
      // "Fri, Aug 28 7:00 PM – Sat, Aug 29 2:00 AM CEST": the zone at the end counts for both.
      last.timeZone ??= expr.timeZone;
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
    // "on Monday" alone is mostly news ("Apple said on Monday"); with a time it's a plan.
    expr.supported = modifier !== "" && modifier !== "on";
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
