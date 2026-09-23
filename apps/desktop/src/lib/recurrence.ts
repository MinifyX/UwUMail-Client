/**
 * Expanding the recurrences the event editor can describe (see Recurrence in backend/types),
 * following RFC 5545: weeks start on Monday, and a monthly or yearly date that doesn't exist in
 * a month (the 31st, February 29) is skipped there, not moved.
 */

import type { Recurrence, Weekday } from "@/backend/types";
import {
  addDays,
  addMonths,
  dateOf,
  daysInMonth,
  diffMinutes,
  startOfWeek,
  weekday,
  type DateKey,
  type WallTime,
} from "./calendarDates";

/** In the order a week runs through them (Monday first). */
export const WEEKDAYS: readonly Weekday[] = ["mo", "tu", "we", "th", "fr", "sa", "su"];

/** "su" for Sunday … like Date.getDay. */
export function weekdayOf(date: DateKey): Weekday {
  return (["su", "mo", "tu", "we", "th", "fr", "sa"] as const)[weekday(date)]!;
}

/** Enough for years of daily events; a rule that never ends stops being looked at after that. */
const MAX_STEPS = 20_000;

function* candidates(start: WallTime, rule: Recurrence): Generator<WallTime> {
  const time = start.slice(10);
  const first = dateOf(start);
  const interval = Math.max(1, Math.floor(rule.interval));
  const day = Number(first.slice(8, 10));
  for (let step = 0; step < MAX_STEPS; step += 1) {
    switch (rule.frequency) {
      case "daily":
        yield addDays(first, step * interval) + time;
        break;
      case "weekly": {
        const days = rule.byDay?.length ? rule.byDay : [weekdayOf(first)];
        const week = addDays(startOfWeek(first, 1), step * 7 * interval);
        for (const weekdayName of WEEKDAYS) {
          if (!days.includes(weekdayName)) continue;
          const date = addDays(week, WEEKDAYS.indexOf(weekdayName));
          if (date >= first) yield date + time;
        }
        break;
      }
      case "monthly": {
        const month = addMonths(`${first.slice(0, 7)}-01`, step * interval);
        const year = Number(month.slice(0, 4));
        if (day <= daysInMonth(year, Number(month.slice(5, 7)))) yield `${month.slice(0, 8)}${first.slice(8)}${time}`;
        break;
      }
      case "yearly": {
        const year = Number(first.slice(0, 4)) + step * interval;
        const month = Number(first.slice(5, 7));
        if (day <= daysInMonth(year, month)) yield `${String(year).padStart(4, "0")}${first.slice(4)}${time}`;
        break;
      }
    }
  }
}

/**
 * The starts of every occurrence that overlaps [from, to): the event's own start counts as the
 * first one, `count` counts from there, `until` is a date and includes that whole day.
 */
export function expandRecurrence(
  start: WallTime,
  durationMinutes: number,
  rule: Recurrence,
  from: WallTime,
  to: WallTime,
): WallTime[] {
  const found: WallTime[] = [];
  let seen = 0;
  for (const occurrence of candidates(start, rule)) {
    if (occurrence >= to) break;
    if (rule.until && dateOf(occurrence) > rule.until) break;
    seen += 1;
    if (rule.count !== null && seen > rule.count) break;
    if (diffMinutes(from, occurrence) + Math.max(durationMinutes, 1) > 0) found.push(occurrence);
  }
  return found;
}
