import { describe, expect, it } from "vitest";
import type { CalendarOccurrence } from "@/backend/types";
import { daysOf, layoutBars, layoutDay, piecesOn } from "./layout";

const occurrence = (id: string, start: string, end: string, allDay = false): CalendarOccurrence => ({
  id,
  eventId: id,
  accountId: "a",
  calendarId: "c",
  title: id,
  description: "",
  location: "",
  allDay,
  start,
  end,
  timeZone: null,
  recurrence: null,
  recurrenceEditable: true,
  recurrenceId: null,
  readOnly: false,
  color: null,
});

describe("daysOf", () => {
  it("doesn't show an event ending at midnight on the next day", () => {
    expect(daysOf(occurrence("a", "2026-09-25T00:00:00", "2026-09-27T00:00:00", true))).toEqual([
      "2026-09-25",
      "2026-09-26",
    ]);
    expect(daysOf(occurrence("b", "2026-09-25T22:00:00", "2026-09-26T02:00:00"))).toEqual(["2026-09-25", "2026-09-26"]);
  });
});

describe("piecesOn", () => {
  it("cuts an event that crosses midnight at the day's edges", () => {
    const night = occurrence("n", "2026-09-25T22:00:00", "2026-09-26T02:00:00");
    expect(piecesOn("2026-09-25", [night])).toMatchObject([
      { top: 1320, bottom: 1440, continuesBefore: false, continuesAfter: true },
    ]);
    expect(piecesOn("2026-09-26", [night])).toMatchObject([
      { top: 0, bottom: 120, continuesBefore: true, continuesAfter: false },
    ]);
    expect(piecesOn("2026-09-27", [night])).toEqual([]);
  });

  it("gives short events room to be clicked and leaves all-day ones to the all-day row", () => {
    expect(piecesOn("2026-09-25", [occurrence("s", "2026-09-25T09:00:00", "2026-09-25T09:05:00")])[0]!.bottom).toBe(
      555,
    );
    expect(piecesOn("2026-09-25", [occurrence("d", "2026-09-25T00:00:00", "2026-09-26T00:00:00", true)])).toEqual([]);
  });
});

describe("layoutDay", () => {
  it("puts overlapping events side by side and lets later ones reuse a free column", () => {
    const pieces = piecesOn("2026-09-25", [
      occurrence("a", "2026-09-25T10:00:00", "2026-09-25T11:00:00"),
      occurrence("b", "2026-09-25T10:30:00", "2026-09-25T12:00:00"),
      occurrence("c", "2026-09-25T11:00:00", "2026-09-25T11:30:00"),
      occurrence("d", "2026-09-25T14:00:00", "2026-09-25T15:00:00"),
    ]);
    const placed = Object.fromEntries(
      layoutDay(pieces).map((piece) => [piece.occurrence.id, [piece.column, piece.columns]]),
    );
    expect(placed).toEqual({ a: [0, 2], b: [1, 2], c: [0, 2], d: [0, 1] });
  });
});

describe("layoutBars", () => {
  it("stacks all-day events in lanes and marks where they run past the week", () => {
    const days = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];
    const bars = layoutBars(days, [
      occurrence("trip", "2026-09-19T00:00:00", "2026-09-23T00:00:00", true),
      occurrence("fair", "2026-09-22T00:00:00", "2026-09-24T00:00:00", true),
      occurrence("party", "2026-09-26T00:00:00", "2026-09-29T00:00:00", true),
      occurrence("call", "2026-09-22T10:00:00", "2026-09-22T11:00:00"),
    ]);
    expect(
      bars.map(({ occurrence: o, from, to, lane, continuesBefore, continuesAfter }) => [
        o.id,
        from,
        to,
        lane,
        continuesBefore,
        continuesAfter,
      ]),
    ).toEqual([
      ["trip", 0, 1, 0, true, false],
      ["fair", 1, 2, 1, false, false],
      ["party", 5, 6, 0, false, true],
    ]);
  });
});
