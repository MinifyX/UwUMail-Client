import { describe, expect, it } from "vitest";
import {
  ageOn,
  birthdayTitle,
  dateIn,
  daysBetweenDates,
  foldName,
  formatDay,
  nextTime,
  normalizeReminders,
  parseDay,
  partialDay,
  sameReminders,
  yearsIn,
} from "./birthdays";

describe("parseDay", () => {
  it("reads days with and without a year", () => {
    expect(parseDay("1996-04-12")).toEqual({ year: 1996, month: 4, day: 12 });
    expect(parseDay("--04-12")).toEqual({ year: null, month: 4, day: 12 });
    expect(formatDay(parseDay("--04-12")!)).toBe("--04-12");
    expect(formatDay({ year: 812, month: 1, day: 2 })).toBe("0812-01-02");
  });

  it("refuses days that don't exist", () => {
    expect(parseDay("2023-02-29")).toBeNull();
    expect(parseDay("2024-02-29")).not.toBeNull();
    expect(parseDay("--02-29")).not.toBeNull();
    expect(parseDay("1996-04-31")).toBeNull();
    expect(parseDay("0000-04-12")).toBeNull();
    expect(parseDay("1996-13-01")).toBeNull();
    expect(parseDay("12.04.1996")).toBeNull();
    expect(parseDay(null)).toBeNull();
    expect(partialDay(10000, 1, 1)).toBeNull();
  });
});

describe("ages", () => {
  const max = parseDay("1996-04-12")!;

  it("counts the years of each occurrence", () => {
    expect(yearsIn(max, 2026)).toBe(30);
    expect(yearsIn(max, 1996)).toBe(0);
    expect(yearsIn(max, 1990)).toBeNull();
    expect(yearsIn(parseDay("--04-12")!, 2026)).toBeNull();
  });

  it("knows the age on a day and the next birthday", () => {
    expect(ageOn(max, "2026-04-11")).toBe(29);
    expect(ageOn(max, "2026-04-12")).toBe(30);
    expect(nextTime(max, "2026-04-12")).toEqual({ date: "2026-04-12", age: 30, inDays: 0 });
    expect(nextTime(max, "2026-04-13")).toEqual({ date: "2027-04-12", age: 31, inDays: 364 });
    expect(nextTime(parseDay("--12-31")!, "2026-12-30")).toEqual({ date: "2026-12-31", age: null, inDays: 1 });
  });

  it("puts 29 February on the 28th in other years", () => {
    const leap = parseDay("2000-02-29")!;
    expect(dateIn(leap, 2024)).toBe("2024-02-29");
    expect(dateIn(leap, 2025)).toBe("2025-02-28");
    expect(dateIn(leap, 2100)).toBe("2100-02-28");
    expect(ageOn(leap, "2025-02-28")).toBe(25);
    expect(ageOn(leap, "2025-02-27")).toBe(24);
    expect(nextTime(parseDay("--02-29")!, "2026-03-01").date).toBe("2027-02-28");
  });

  it("copes with extreme years", () => {
    const old = parseDay("0812-06-01")!;
    expect(yearsIn(old, 2026)).toBe(1214);
    expect(dateIn(old, 2026)).toBe("2026-06-01");
    const future = parseDay("9999-12-31")!;
    expect(ageOn(future, "2026-01-01")).toBeNull();
  });

  it("lists every occurrence in a window, none before the year it happened", () => {
    expect(daysBetweenDates(max, "2025-01-01", "2027-01-01")).toEqual([
      { date: "2025-04-12", years: 29 },
      { date: "2026-04-12", years: 30 },
    ]);
    expect(daysBetweenDates(parseDay("2030-01-01")!, "2026-01-01", "2027-01-01")).toEqual([]);
    expect(daysBetweenDates(parseDay("--12-31")!, "2026-12-01", "2027-01-01")).toEqual([
      { date: "2026-12-31", years: null },
    ]);
  });
});

describe("reminders", () => {
  it("compares without order or doubles", () => {
    const day = { daysBefore: 0, time: "09:00" };
    const week = { daysBefore: 7, time: "09:00" };
    expect(normalizeReminders([week, day, week])).toEqual([day, week]);
    expect(sameReminders([week, day], [day, week])).toBe(true);
    expect(sameReminders([day], [week])).toBe(false);
  });
});

describe("foldName", () => {
  it("compares names by characters, umlauts either way", () => {
    expect(foldName("Jürgen Müller")).toBe("juergen mueller");
    expect(foldName("Jürgen Müller", false)).toBe("jurgen muller");
    expect(foldName("Jürgen")).toBe("juergen");
    expect(foldName("STRAẞE Groß")).toBe("strasse gross");
    expect(foldName("Zoë O'Neil-Øster")).toBe("zoe o neil øster");
    expect(foldName("  🎂 Åsa  ")).toBe("asa");
  });
});

describe("birthdayTitle", () => {
  const max = { contactId: "a:k1", kind: "birth" as const, label: null, name: "Max Muster", year: 1996, age: 30 };

  it("writes titles like the server, in the UI's language", () => {
    expect(birthdayTitle(max, "de")).toBe("Max Muster (30)");
    expect(birthdayTitle({ ...max, age: null }, "en")).toBe("Max Muster");
    expect(birthdayTitle({ ...max, kind: "wedding", age: 5 }, "de")).toBe("Hochzeitstag von Max Muster (5 Jahre)");
    expect(birthdayTitle({ ...max, kind: "wedding", age: 1 }, "en")).toBe("Wedding anniversary of Max Muster (1 year)");
    expect(birthdayTitle({ ...max, kind: "other", label: "Kennenlerntag", age: null }, "de-DE")).toBe(
      "Kennenlerntag von Max Muster",
    );
    expect(birthdayTitle({ ...max, kind: "other", age: 2 }, "en")).toBe("Anniversary of Max Muster (2 years)");
  });
});
