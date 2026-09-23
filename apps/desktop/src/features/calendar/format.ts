import type { CSSProperties } from "react";
import type { CalendarInfo, CalendarOccurrence, Recurrence } from "@/backend/types";
import { i18n } from "@/i18n";
import { addDays, dateOf, wallMs, weekStartFor, type DateKey, type WallTime } from "@/lib/calendarDates";
import { WEEKDAYS } from "@/lib/recurrence";

/** The calendar's pink, for calendars and events without a colour of their own. */
export const DEFAULT_COLOR = "#ff4d8d";

/** Colours offered for calendars: the app's account colours and two calmer ones. */
export const CALENDAR_COLORS = ["#ff4d8d", "#8b5cf6", "#0ea5e9", "#10b981", "#f59e0b", "#f97360", "#64748b", "#a16207"];

/** The language tag dates are written in: German, or the browser's English (US, UK …). */
export function calendarLocale(): string {
  if (i18n.language === "de") return "de-DE";
  return navigator.languages?.find((tag) => tag.toLowerCase().startsWith("en")) ?? "en-US";
}

export function weekStart(): number {
  return weekStartFor(calendarLocale());
}

/** Wall times are formatted as if they were UTC, so no zone shifts them on the way. */
function format(wall: WallTime | DateKey, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(calendarLocale(), { ...options, timeZone: "UTC" }).format(new Date(wallMs(wall)));
}

export function formatTime(wall: WallTime): string {
  return format(wall, { hour: "numeric", minute: "2-digit" });
}

/** "14:00" or "2 PM" for the hour lines, whichever the locale writes. */
export function formatHour(hour: number): string {
  const wall = `2000-01-01T${String(hour).padStart(2, "0")}:00:00`;
  const twelveHours = new Intl.DateTimeFormat(calendarLocale(), { hour: "numeric" }).resolvedOptions().hour12;
  return format(wall, twelveHours ? { hour: "numeric" } : { hour: "2-digit", minute: "2-digit" });
}

export function formatWeekdayShort(date: DateKey): string {
  return format(date, { weekday: "short" });
}

export function formatWeekdayNarrow(date: DateKey): string {
  return format(date, { weekday: "narrow" });
}

export function formatDayLong(date: DateKey): string {
  return format(date, { weekday: "long", day: "numeric", month: "long" });
}

export function formatDateMedium(date: DateKey): string {
  return format(date, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

export function formatMonthTitle(date: DateKey): string {
  return format(date, { month: "long", year: "numeric" });
}

/** The toolbar's title for what is on screen. */
export function formatRangeTitle(first: DateKey, last: DateKey): string {
  if (first === last) return format(first, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const formatter = new Intl.DateTimeFormat(calendarLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return formatter.formatRange(new Date(wallMs(first)), new Date(wallMs(last)));
}

/** "Tue, 22 Sep, 18:30 – 19:30", "Fri, 25 Sep – Sun, 27 Sep" for all-day ones. */
export function formatWhen(occurrence: Pick<CalendarOccurrence, "start" | "end" | "allDay">): string {
  const { start, end, allDay } = occurrence;
  if (allDay) {
    const last = addDays(dateOf(end), -1);
    const first = dateOf(start);
    return last <= first ? formatDateMedium(first) : `${formatDateMedium(first)} – ${formatDateMedium(last)}`;
  }
  if (dateOf(start) === dateOf(end) || end === `${dateOf(end)}T00:00:00`) {
    return `${formatDateMedium(dateOf(start))}, ${formatTime(start)} – ${formatTime(end)}`;
  }
  return `${formatDateMedium(dateOf(start))}, ${formatTime(start)} – ${formatDateMedium(dateOf(end))}, ${formatTime(end)}`;
}

/** "Every 2 weeks on Tue, Thu, until 31 Dec 2026". */
export function describeRecurrence(
  recurrence: Recurrence,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  let text = t(`calendar.repeat.every.${recurrence.frequency}`, { count: recurrence.interval });
  if (recurrence.frequency === "weekly" && recurrence.byDay?.length) {
    // 2026-09-21 is a Monday: WEEKDAYS index i is that week's day i.
    const days = WEEKDAYS.filter((day) => recurrence.byDay!.includes(day)).map((day) =>
      formatWeekdayShort(addDays("2026-09-21", WEEKDAYS.indexOf(day))),
    );
    text += ` ${t("calendar.repeat.onDays", { days: days.join(", ") })}`;
  }
  if (recurrence.until) text += `, ${t("calendar.repeat.until", { date: formatDateMedium(recurrence.until) })}`;
  else if (recurrence.count) text += `, ${t("calendar.repeat.times", { count: recurrence.count })}`;
  return text;
}

export function eventColor(occurrence: CalendarOccurrence, calendars: CalendarInfo[]): string {
  return (
    occurrence.color ?? calendars.find((calendar) => calendar.id === occurrence.calendarId)?.color ?? DEFAULT_COLOR
  );
}

/** A tint of the event's colour that works on light and dark surfaces alike. */
export function eventStyle(color: string): CSSProperties {
  return { "--event": color } as CSSProperties;
}

export const EVENT_TINT =
  "bg-[color-mix(in_srgb,var(--event)_20%,var(--uwu-surface))] hover:bg-[color-mix(in_srgb,var(--event)_30%,var(--uwu-surface))]";
