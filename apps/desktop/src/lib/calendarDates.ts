/**
 * Date math for the calendar, without a date library.
 *
 * The calendar works in wall times: "YYYY-MM-DDTHH:mm:ss" as a clock on the wall in one time
 * zone shows it, and dates "YYYY-MM-DD". Arithmetic on them runs on UTC timestamps, where every
 * day has 24 hours, so adding a day never trips over a daylight saving change. Only the
 * conversion between an instant and a zone's wall time asks Intl, which knows the zones.
 */

/** "YYYY-MM-DDTHH:mm:ss" */
export type WallTime = string;
/** "YYYY-MM-DD" */
export type DateKey = string;

export const MINUTES_PER_DAY = 24 * 60;
const MINUTE = 60_000;
const DAY = MINUTES_PER_DAY * MINUTE;

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/;

/** The wall time as if it were UTC: a number to calculate with, not a real instant. */
export function wallMs(wall: WallTime | DateKey): number {
  const match = WALL.exec(wall);
  if (!match) return Number.NaN;
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  date.setUTCHours(Number(h), Number(mi), Number(s), 0);
  return date.getTime();
}

export function fromWallMs(ms: number): WallTime {
  const date = new Date(ms);
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

export function isWallTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value) && !Number.isNaN(wallMs(value));
}

export function dateOf(wall: WallTime): DateKey {
  return wall.slice(0, 10);
}

export function atMidnight(date: DateKey): WallTime {
  return `${date}T00:00:00`;
}

/** "HH:mm" of a wall time. */
export function clockOf(wall: WallTime): string {
  return wall.slice(11, 16);
}

/** A date and "HH:mm" put together. */
export function withClock(date: DateKey, clock: string): WallTime {
  return `${date}T${clock.slice(0, 5)}:00`;
}

export function addMinutes(wall: WallTime, minutes: number): WallTime {
  return fromWallMs(wallMs(wall) + minutes * MINUTE);
}

export function addDays(date: DateKey, days: number): DateKey {
  return dateOf(fromWallMs(wallMs(date) + days * DAY));
}

/** Minutes from `a` to `b`. */
export function diffMinutes(a: WallTime, b: WallTime): number {
  return Math.round((wallMs(b) - wallMs(a)) / MINUTE);
}

/** Days from `a` to `b`. */
export function diffDays(a: DateKey, b: DateKey): number {
  return Math.round((wallMs(b) - wallMs(a)) / DAY);
}

export function minutesOfDay(wall: WallTime): number {
  return Math.round((wallMs(wall) - wallMs(dateOf(wall))) / MINUTE);
}

export function atMinutes(date: DateKey, minutes: number): WallTime {
  return fromWallMs(wallMs(date) + minutes * MINUTE);
}

/** 0 is Sunday, like Date.getDay. */
export function weekday(date: DateKey): number {
  return new Date(wallMs(date)).getUTCDay();
}

/** The first day of the week `date` lies in; `weekStart` 0 is Sunday, 1 Monday. */
export function startOfWeek(date: DateKey, weekStart: number): DateKey {
  return addDays(date, -((weekday(date) - weekStart + 7) % 7));
}

export function startOfMonth(date: DateKey): DateKey {
  return `${date.slice(0, 7)}-01`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The same day `months` later, or the month's last day where that day doesn't exist. */
export function addMonths(date: DateKey, months: number): DateKey {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1 + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const day = Math.min(Number(date.slice(8, 10)), daysInMonth(targetYear, targetMonth + 1));
  return `${pad(targetYear, 4)}-${pad(targetMonth + 1)}-${pad(day)}`;
}

/** The weeks a month view shows: whole weeks from the one holding the 1st to the one holding the last day. */
export function monthWeeks(date: DateKey, weekStart: number): DateKey[][] {
  const first = startOfMonth(date);
  const last = addDays(addMonths(first, 1), -1);
  const weeks: DateKey[][] = [];
  for (let day = startOfWeek(first, weekStart); day <= last; day = addDays(day, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, index) => addDays(day, index)));
  }
  return weeks;
}

/** The device's wall time for a Date. */
export function localWall(date: Date = new Date()): WallTime {
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export function todayKey(now: Date = new Date()): DateKey {
  return dateOf(localWall(now));
}

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
  } catch {
    return "Etc/UTC";
  }
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatters.set(zone, formatter);
  }
  return formatter;
}

/** What a clock in `zone` shows at the instant `utc` (milliseconds or an ISO string). */
export function zonedWall(utc: number | string, zone: string): WallTime {
  const instant = typeof utc === "number" ? utc : Date.parse(utc);
  const parts: Record<string, string> = {};
  for (const part of zoneFormatter(zone).formatToParts(new Date(instant))) parts[part.type] = part.value;
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${pad(Number(parts.year), 4)}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}`;
}

/**
 * The instant a clock in `zone` shows `wall`. A time skipped by a daylight saving change counts
 * as the same time after the gap (02:30 becomes 03:30); of a time that happens twice, one of them.
 */
export function zonedToUtc(wall: WallTime, zone: string): number {
  const guess = wallMs(wall);
  const offsetAt = (instant: number) => wallMs(zonedWall(instant, zone)) - instant;
  const first = offsetAt(guess);
  const second = offsetAt(guess - first);
  return guess - (second === first ? first : second);
}

/** The same instant, as a clock in another zone shows it. */
export function convertWall(wall: WallTime, from: string, to: string): WallTime {
  return from === to ? wall : zonedWall(zonedToUtc(wall, from), to);
}

/** A JSCalendar / ISO 8601 duration: whole days (nominal) and seconds (exact). */
export interface Duration {
  days: number;
  seconds: number;
}

export function parseDuration(text: string | null | undefined): Duration | null {
  const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text ?? "");
  if (!match || text === "P" || text?.endsWith("T")) return null;
  const [, weeks = "0", days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return {
    days: Number(weeks) * 7 + Number(days),
    seconds: Number(hours) * 3600 + Number(minutes) * 60 + Math.round(Number(seconds)),
  };
}

export function formatDuration({ days, seconds }: Duration): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const time = `${hours ? `${hours}H` : ""}${minutes ? `${minutes}M` : ""}${rest ? `${rest}S` : ""}`;
  if (!days && !time) return "PT0S";
  return `P${days ? `${days}D` : ""}${time ? `T${time}` : ""}`;
}

/**
 * The first day of the week for a language: Monday for German, otherwise what the locale says
 * (Sunday for US English), Monday when the browser can't tell.
 */
export function weekStartFor(language: string): number {
  if (language.toLowerCase().startsWith("de")) return 1;
  try {
    const locale = new Intl.Locale(language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay;
    if (firstDay !== undefined) return firstDay % 7;
  } catch {
    // An unknown tag falls through to the guess below.
  }
  return /^en(-US)?$/i.test(language) ? 0 : 1;
}
