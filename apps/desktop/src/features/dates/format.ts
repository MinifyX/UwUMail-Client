import { addDays, dateOf, type WallTime } from "@/lib/calendarDates";
import type { DetectedEvent } from "@/lib/dates";

/** A wall time as a Date on this device's clock, only for formatting. */
function asDate(wall: WallTime): Date {
  const [date, clock = "00:00"] = wall.split("T");
  const [y, m, d] = date!.split("-").map(Number);
  const [h, min] = clock.split(":").map(Number);
  return new Date(y!, m! - 1, d!, h ?? 0, min ?? 0);
}

type Range = { formatRange?: (start: Date, end: Date) => string };

function range(format: Intl.DateTimeFormat, start: Date, end: Date): string {
  const ranged = format as Intl.DateTimeFormat & Range;
  return ranged.formatRange ? ranged.formatRange(start, end) : `${format.format(start)} – ${format.format(end)}`;
}

/**
 * When an appointment is, short: "6.–9. Okt.", "Fr., 17. Okt., 19:30–20:30", "Oct 6 – 9". The year
 * only when it isn't this one; an end only when the mail named one.
 */
export function whenLabel(
  event: Pick<DetectedEvent, "start" | "end" | "allDay" | "endKnown">,
  locale: string,
  now: Date = new Date(),
): string {
  const start = asDate(event.start);
  const year = start.getFullYear() !== now.getFullYear() ? ({ year: "numeric" } as const) : {};
  if (event.allDay) {
    const last = asDate(addDays(dateOf(event.end), -1));
    if (last <= start) {
      return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", ...year }).format(
        start,
      );
    }
    const lastYear = last.getFullYear() !== now.getFullYear() ? ({ year: "numeric" } as const) : {};
    return range(
      new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", ...year, ...lastYear }),
      start,
      last,
    );
  }
  const format = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...year,
  });
  return event.endKnown ? range(format, start, asDate(event.end)) : format.format(start);
}

/** The same day the other way round, for "10/12" read as 10 December: "or 12 October?" */
export function swappedDay(event: Pick<DetectedEvent, "start">, locale: string): string | null {
  const [y, m, d] = dateOf(event.start).split("-").map(Number);
  if (!y || !m || !d || d > 12 || d === m) return null;
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(
    new Date(y, d - 1, m),
  );
}
