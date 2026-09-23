import { describe, expect, it } from "vitest";
import type { Recurrence } from "@/backend/types";
import { expandRecurrence, weekdayOf } from "./recurrence";

const rule = (patch: Partial<Recurrence>): Recurrence => ({
  frequency: "weekly",
  interval: 1,
  byDay: null,
  until: null,
  count: null,
  ...patch,
});

describe("expandRecurrence", () => {
  it("repeats weekly on the start's weekday", () => {
    expect(expandRecurrence("2026-09-01T18:30:00", 60, rule({}), "2026-09-01T00:00:00", "2026-09-30T00:00:00")).toEqual(
      [
        "2026-09-01T18:30:00",
        "2026-09-08T18:30:00",
        "2026-09-15T18:30:00",
        "2026-09-22T18:30:00",
        "2026-09-29T18:30:00",
      ],
    );
  });

  it("repeats on several weekdays, every other week, from Monday-based weeks", () => {
    // Starts on a Wednesday: the Monday of that first week is before the start and doesn't count.
    expect(
      expandRecurrence(
        "2026-09-02T09:00:00",
        30,
        rule({ interval: 2, byDay: ["mo", "we"] }),
        "2026-09-01T00:00:00",
        "2026-10-01T00:00:00",
      ),
    ).toEqual([
      "2026-09-02T09:00:00",
      "2026-09-14T09:00:00",
      "2026-09-16T09:00:00",
      "2026-09-28T09:00:00",
      "2026-09-30T09:00:00",
    ]);
  });

  it("stops after count occurrences, counted from the very first", () => {
    expect(
      expandRecurrence(
        "2026-09-01T08:00:00",
        15,
        rule({ frequency: "daily", count: 3 }),
        "2026-09-02T00:00:00",
        "2026-09-30T00:00:00",
      ),
    ).toEqual(["2026-09-02T08:00:00", "2026-09-03T08:00:00"]);
  });

  it("includes the whole until day", () => {
    expect(
      expandRecurrence(
        "2026-09-01T23:00:00",
        30,
        rule({ frequency: "daily", interval: 3, until: "2026-09-07" }),
        "2026-09-01T00:00:00",
        "2026-09-30T00:00:00",
      ),
    ).toEqual(["2026-09-01T23:00:00", "2026-09-04T23:00:00", "2026-09-07T23:00:00"]);
  });

  it("skips months without the day instead of moving it", () => {
    expect(
      expandRecurrence(
        "2026-01-31T10:00:00",
        60,
        rule({ frequency: "monthly" }),
        "2026-01-01T00:00:00",
        "2026-06-01T00:00:00",
      ),
    ).toEqual(["2026-01-31T10:00:00", "2026-03-31T10:00:00", "2026-05-31T10:00:00"]);
    expect(
      expandRecurrence(
        "2028-02-29T00:00:00",
        1440,
        rule({ frequency: "yearly" }),
        "2028-01-01T00:00:00",
        "2033-01-01T00:00:00",
      ),
    ).toEqual(["2028-02-29T00:00:00", "2032-02-29T00:00:00"]);
  });

  it("keeps an occurrence that started before the range but still runs into it", () => {
    expect(
      expandRecurrence(
        "2026-09-20T23:00:00",
        120,
        rule({ frequency: "daily" }),
        "2026-09-21T00:00:00",
        "2026-09-22T00:00:00",
      ),
    ).toEqual(["2026-09-20T23:00:00", "2026-09-21T23:00:00"]);
  });

  it("names weekdays like the rule does", () => {
    expect(weekdayOf("2026-09-23")).toBe("we");
    expect(weekdayOf("2026-09-27")).toBe("su");
  });
});
