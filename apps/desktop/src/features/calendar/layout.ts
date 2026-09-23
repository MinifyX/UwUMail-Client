import type { CalendarOccurrence } from "@/backend/types";
import { MINUTES_PER_DAY, addDays, atMidnight, dateOf, diffDays, diffMinutes, type DateKey } from "@/lib/calendarDates";

/** An event in the all-day row: all-day events, and timed ones of a day or longer. */
export function isAllDayRow(occurrence: CalendarOccurrence): boolean {
  return occurrence.allDay || diffMinutes(occurrence.start, occurrence.end) >= MINUTES_PER_DAY;
}

/** The days an occurrence shows on (its end is exclusive). */
export function daysOf(occurrence: CalendarOccurrence): DateKey[] {
  const first = dateOf(occurrence.start);
  const endDate = dateOf(occurrence.end);
  // Something ending at midnight doesn't show on the day after.
  const last =
    occurrence.end === atMidnight(endDate) && occurrence.end > occurrence.start ? addDays(endDate, -1) : endDate;
  const count = Math.max(1, diffDays(first, last) + 1);
  return Array.from({ length: count }, (_, index) => addDays(first, index));
}

/** A timed occurrence's piece on one day: minutes from midnight, cut at the day's edges. */
export interface DayPiece {
  occurrence: CalendarOccurrence;
  top: number;
  bottom: number;
  /** Cut off at the start or the end of the day. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface PlacedPiece extends DayPiece {
  column: number;
  columns: number;
}

export function piecesOn(day: DateKey, occurrences: CalendarOccurrence[]): DayPiece[] {
  const midnight = atMidnight(day);
  return (
    occurrences
      .filter((occurrence) => !isAllDayRow(occurrence))
      .map((occurrence) => ({
        occurrence,
        start: diffMinutes(midnight, occurrence.start),
        end: diffMinutes(midnight, occurrence.end),
      }))
      // Zero-length events still show, as a short block where they start.
      .filter(({ start, end }) => start < MINUTES_PER_DAY && (end > 0 || (start === end && start >= 0)))
      .map(({ occurrence, start, end }) => ({
        occurrence,
        top: Math.max(0, start),
        bottom: Math.min(MINUTES_PER_DAY, Math.max(end, start + 15)),
        continuesBefore: start < 0,
        continuesAfter: end > MINUTES_PER_DAY,
      }))
  );
}

/**
 * Side by side where they overlap: each group of events that overlap one another shares the
 * width, and every event takes the first column that is free at its start.
 */
export function layoutDay(pieces: DayPiece[]): PlacedPiece[] {
  const sorted = [...pieces].sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  const placed: PlacedPiece[] = [];
  let group: PlacedPiece[] = [];
  let groupEnd = -1;
  let columnEnds: number[] = [];
  const closeGroup = () => {
    for (const piece of group) piece.columns = columnEnds.length;
    group = [];
    columnEnds = [];
  };
  for (const piece of sorted) {
    if (piece.top >= groupEnd) {
      closeGroup();
      groupEnd = -1;
    }
    let column = columnEnds.findIndex((end) => end <= piece.top);
    if (column < 0) {
      column = columnEnds.length;
      columnEnds.push(piece.bottom);
    } else {
      columnEnds[column] = piece.bottom;
    }
    const entry: PlacedPiece = { ...piece, column, columns: 1 };
    group.push(entry);
    placed.push(entry);
    groupEnd = Math.max(groupEnd, piece.bottom);
  }
  closeGroup();
  return placed;
}

/** All-day row lanes for a week: each event gets the lowest lane free on all of its days. */
export interface Bar {
  occurrence: CalendarOccurrence;
  /** Index of the first and last visible day. */
  from: number;
  to: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export function layoutBars(days: DateKey[], occurrences: CalendarOccurrence[]): Bar[] {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return [];
  const bars: Bar[] = [];
  const lanes: number[][] = [];
  const candidates = occurrences
    .filter(isAllDayRow)
    .map((occurrence) => ({ occurrence, span: daysOf(occurrence) }))
    .filter(({ span }) => span[span.length - 1]! >= first && span[0]! <= last)
    .sort((a, b) => a.span[0]!.localeCompare(b.span[0]!) || b.span.length - a.span.length);
  for (const { occurrence, span } of candidates) {
    const from = Math.max(0, diffDays(first, span[0]!));
    const to = Math.min(days.length - 1, diffDays(first, span[span.length - 1]!));
    let lane = lanes.findIndex((taken) => taken.every((day) => day < from || day > to));
    if (lane < 0) {
      lane = lanes.length;
      lanes.push([]);
    }
    for (let day = from; day <= to; day += 1) lanes[lane]!.push(day);
    bars.push({
      occurrence,
      from,
      to,
      lane,
      continuesBefore: span[0]! < first,
      continuesAfter: span[span.length - 1]! > last,
    });
  }
  return bars;
}
