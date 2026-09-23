import { describe, expect, it } from "vitest";
import {
  addDays,
  addMinutes,
  addMonths,
  convertWall,
  diffDays,
  diffMinutes,
  formatDuration,
  minutesOfDay,
  monthWeeks,
  parseDuration,
  startOfWeek,
  weekStartFor,
  weekday,
  withClock,
  zonedToUtc,
  zonedWall,
} from "./calendarDates";

describe("wall time arithmetic", () => {
  it("adds days across month, year and leap day borders", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("keeps 24 hours in a day even where the clocks change", () => {
    // The last Sunday of March: no 02:00 in Berlin, but wall times don't care.
    expect(addMinutes("2026-03-29T01:30:00", 60)).toBe("2026-03-29T02:30:00");
    expect(diffMinutes("2026-03-28T12:00:00", "2026-03-29T12:00:00")).toBe(1440);
    expect(diffDays("2026-03-28", "2026-04-02")).toBe(5);
  });

  it("clamps the day when a month is shorter", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
    expect(addMonths("2026-01-15", -2)).toBe("2025-11-15");
  });

  it("knows weekdays and week starts", () => {
    expect(weekday("2026-09-23")).toBe(3); // a Wednesday
    expect(startOfWeek("2026-09-23", 1)).toBe("2026-09-21");
    expect(startOfWeek("2026-09-23", 0)).toBe("2026-09-20");
    expect(startOfWeek("2026-09-21", 1)).toBe("2026-09-21");
  });

  it("lays out a month in whole weeks", () => {
    const weeks = monthWeeks("2026-09-23", 1);
    expect(weeks).toHaveLength(5);
    expect(weeks[0]![0]).toBe("2026-08-31");
    expect(weeks[4]![6]).toBe("2026-10-04");
    // February 2027 starts on a Monday and has exactly four weeks.
    expect(monthWeeks("2027-02-10", 1)).toHaveLength(4);
  });

  it("reads and builds clock times", () => {
    expect(minutesOfDay("2026-09-23T13:45:00")).toBe(825);
    expect(withClock("2026-09-23", "08:05")).toBe("2026-09-23T08:05:00");
  });
});

describe("time zones", () => {
  it("shows an instant on the clock of a zone", () => {
    expect(zonedWall("2026-07-01T10:00:00Z", "Europe/Berlin")).toBe("2026-07-01T12:00:00");
    expect(zonedWall("2026-12-01T10:00:00Z", "Europe/Berlin")).toBe("2026-12-01T11:00:00");
    expect(zonedWall("2026-07-01T10:00:00Z", "America/New_York")).toBe("2026-07-01T06:00:00");
  });

  it("finds the instant for a zone's wall time, summer and winter", () => {
    expect(new Date(zonedToUtc("2026-07-01T12:00:00", "Europe/Berlin")).toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(new Date(zonedToUtc("2026-12-01T11:00:00", "Europe/Berlin")).toISOString()).toBe("2026-12-01T10:00:00.000Z");
  });

  it("moves a time the spring change skips to after the gap", () => {
    expect(zonedWall(zonedToUtc("2026-03-29T02:30:00", "Europe/Berlin"), "Europe/Berlin")).toBe("2026-03-29T03:30:00");
  });

  it("converts wall times between zones", () => {
    expect(convertWall("2026-09-23T09:00:00", "America/New_York", "Europe/Berlin")).toBe("2026-09-23T15:00:00");
    expect(convertWall("2026-09-23T09:00:00", "Europe/Berlin", "Europe/Berlin")).toBe("2026-09-23T09:00:00");
  });
});

describe("durations", () => {
  it("reads JSCalendar durations", () => {
    expect(parseDuration("PT1H30M")).toEqual({ days: 0, seconds: 5400 });
    expect(parseDuration("P1D")).toEqual({ days: 1, seconds: 0 });
    expect(parseDuration("P1W")).toEqual({ days: 7, seconds: 0 });
    expect(parseDuration("P1DT2H")).toEqual({ days: 1, seconds: 7200 });
    expect(parseDuration("PT0S")).toEqual({ days: 0, seconds: 0 });
    expect(parseDuration("1H")).toBeNull();
    expect(parseDuration("P")).toBeNull();
    expect(parseDuration("PT")).toBeNull();
  });

  it("writes them back", () => {
    expect(formatDuration({ days: 0, seconds: 5400 })).toBe("PT1H30M");
    expect(formatDuration({ days: 2, seconds: 0 })).toBe("P2D");
    expect(formatDuration({ days: 0, seconds: 90000 })).toBe("PT25H");
    expect(formatDuration({ days: 0, seconds: 0 })).toBe("PT0S");
  });
});

describe("weekStartFor", () => {
  it("starts German weeks on Monday and US English ones on Sunday", () => {
    expect(weekStartFor("de")).toBe(1);
    expect(weekStartFor("de-AT")).toBe(1);
    expect(weekStartFor("en-US")).toBe(0);
    expect(weekStartFor("en")).toBe(0);
  });
});
