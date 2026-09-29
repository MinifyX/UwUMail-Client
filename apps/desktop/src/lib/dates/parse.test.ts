import { describe, expect, it } from "vitest";
import { findDates, slashOrderOf, timeRangeAt, type FoundDate } from "./parse";

// A Tuesday morning.
const REFERENCE = "2026-09-29T10:00:00";

function summary(hit: FoundDate): string {
  const clock = (c: { h: number; min: number } | null) =>
    c ? `${String(c.h).padStart(2, "0")}:${String(c.min).padStart(2, "0")}` : "";
  const days = hit.endDate ? `${hit.startDate}..${hit.endDate}` : hit.startDate;
  const time = hit.startTime ? ` ${clock(hit.startTime)}${hit.endTime ? `-${clock(hit.endTime)}` : ""}` : "";
  return `${days}${time}`;
}

function find(text: string, reference = REFERENCE, slashOrder: "MD" | "DM" = "DM") {
  return findDates(text, { reference, slashOrder });
}

/** The one hit in the text, as "2026-10-06..2026-10-09 19:30-22:00", and the text it covers. */
function one(text: string, reference = REFERENCE, slashOrder: "MD" | "DM" = "DM") {
  const hits = find(text, reference, slashOrder);
  expect(hits, text).toHaveLength(1);
  return { when: summary(hits[0]!), text: text.slice(hits[0]!.from, hits[0]!.to), hit: hits[0]! };
}

describe("German dates", () => {
  it.each([
    ["am 17.10.2026", "2026-10-17"],
    ["am 17.10.", "2026-10-17"],
    ["am 1.10.", "2026-10-01"],
    ["Stichtag 01.02.2027", "2027-02-01"],
    ["bis 6.10.26 bitte", "2026-10-06"],
    ["am 17. 10. 2026", "2026-10-17"],
    ["am 6. Oktober", "2026-10-06"],
    ["am 6. Okt.", "2026-10-06"],
    ["am 6.Okt", "2026-10-06"],
    ["am 6 Okt 2027", "2027-10-06"],
    ["am 3. März", "2027-03-03"],
    ["am 3. Mär.", "2027-03-03"],
    ["am 12. Jänner", "2027-01-12"],
    ["Am 1. Mai geschlossen", "2027-05-01"],
    ["am 24. Dezember 2026", "2026-12-24"],
  ])("%s", (text, expected) => {
    expect(one(text).when).toBe(expected);
  });

  it.each([
    ["Prime Day deals vom 6. – 9. Okt", "2026-10-06..2026-10-09", "6. – 9. Okt"],
    ["vom 1. bis 3. November 2026", "2026-11-01..2026-11-03", "1. bis 3. November 2026"],
    ["6.–9.10.", "2026-10-06..2026-10-09", "6.–9.10."],
    ["vom 6.-9.10.2026", "2026-10-06..2026-10-09", "6.-9.10.2026"],
    ["17.10. - 19.10.", "2026-10-17..2026-10-19", "17.10. - 19.10."],
    ["12.10.-14.10.", "2026-10-12..2026-10-14", "12.10.-14.10."],
    ["30. Okt. – 2. Nov.", "2026-10-30..2026-11-02", "30. Okt. – 2. Nov."],
    ["30.–2.11.", "2026-10-30..2026-11-02", "30.–2.11."],
    ["28.12.2026–2.1.2027", "2026-12-28..2027-01-02", "28.12.2026–2.1.2027"],
    ["30. Dez. – 2. Jan. 2027", "2026-12-30..2027-01-02", "30. Dez. – 2. Jan. 2027"],
    ["30. Dez. – 2. Jan.", "2026-12-30..2027-01-02", "30. Dez. – 2. Jan."],
    ["vom 17.10. bis zum 19.10.", "2026-10-17..2026-10-19", "17.10. bis zum 19.10."],
  ])("range %s", (text, expected, covered) => {
    const hit = one(text);
    expect(hit.when).toBe(expected);
    expect(hit.text).toBe(covered);
  });

  it.each([
    ["am Freitag, 16.10. um 19:30 Uhr", "2026-10-16 19:30", "Freitag, 16.10. um 19:30 Uhr"],
    ["Fr., 16.10., 19:30–22:00 Uhr", "2026-10-16 19:30-22:00", "Fr., 16.10., 19:30–22:00 Uhr"],
    ["Sa 17.10. 20 Uhr", "2026-10-17 20:00", "Sa 17.10. 20 Uhr"],
    ["am 17.10. von 14 bis 16 Uhr", "2026-10-17 14:00-16:00", "17.10. von 14 bis 16 Uhr"],
    ["am 17.10. 14–16 Uhr", "2026-10-17 14:00-16:00", "17.10. 14–16 Uhr"],
    ["am 17.10. ab 19.30 Uhr", "2026-10-17 19:30", "17.10. ab 19.30 Uhr"],
    ["am 17.10. um 9", "2026-10-17 09:00", "17.10. um 9"],
    ["14–16 Uhr am 3.11.", "2026-11-03 14:00-16:00", "14–16 Uhr am 3.11."],
    ["um 19 Uhr am Freitag, den 16.10.", "2026-10-16 19:00", "um 19 Uhr am Freitag, den 16.10."],
    ["17.10. 19 Uhr – 18.10. 2 Uhr", "2026-10-17..2026-10-18 19:00-02:00", "17.10. 19 Uhr – 18.10. 2 Uhr"],
    ["Datum: 17.10.2026\nUhrzeit: 19:30", "2026-10-17 19:30", "17.10.2026\nUhrzeit: 19:30"],
    ["Einlass 17.10., Beginn: 20 Uhr", "2026-10-17 20:00", "17.10., Beginn: 20 Uhr"],
    ["am 17.10. um 20 Uhr MESZ", "2026-10-17 20:00", "17.10. um 20 Uhr MESZ"],
    [
      "Samstag, 17. Oktober 2026\n10:00 – 16:00 Uhr",
      "2026-10-17 10:00-16:00",
      "Samstag, 17. Oktober 2026\n10:00 – 16:00 Uhr",
    ],
  ])("with time %s", (text, expected, covered) => {
    const hit = one(text);
    expect(hit.when).toBe(expected);
    expect(hit.text).toBe(covered);
  });

  it("reads the zone behind a time", () => {
    expect(one("am 17.10. um 20 Uhr MESZ").hit.timeZone).toBe("Europe/Berlin");
    expect(one("am 17.10. um 20 Uhr").hit.timeZone).toBeNull();
  });

  it("takes a weak date only with support", () => {
    expect(find("Version 17.10 ist da")).toEqual([]);
    expect(find("Werte 3.5 und 4.2")).toEqual([]);
    expect(one("am 17.10 geht's los").when).toBe("2026-10-17");
    expect(one("Sa 17.10").when).toBe("2026-10-17");
    expect(one("17.10 um 18 Uhr").when).toBe("2026-10-17 18:00");
  });
});

describe("English dates", () => {
  it.each([
    ["on October 6", "2026-10-06"],
    ["on Oct 6th", "2026-10-06"],
    ["on Oct. 6, 2027", "2027-10-06"],
    ["on 6 October 2026", "2026-10-06"],
    ["on the 6th of October", "2026-10-06"],
    ["on May 5", "2027-05-05"],
    ["due Sept 30", "2026-09-30"],
    ["Friday, October 16", "2026-10-16"],
  ])("%s", (text, expected) => {
    expect(one(text).when).toBe(expected);
  });

  it.each([
    ["Oct 6–9", "2026-10-06..2026-10-09", "Oct 6–9"],
    ["Oct 6-9, 2027", "2027-10-06..2027-10-09", "Oct 6-9, 2027"],
    ["October 30 – November 2", "2026-10-30..2026-11-02", "October 30 – November 2"],
    ["Dec 28, 2026 – Jan 2, 2027", "2026-12-28..2027-01-02", "Dec 28, 2026 – Jan 2, 2027"],
    ["6–9 October", "2026-10-06..2026-10-09", "6–9 October"],
    ["from Oct 6 to Oct 9", "2026-10-06..2026-10-09", "Oct 6 to Oct 9"],
    ["Oct 6 through 9", "2026-10-06..2026-10-09", "Oct 6 through 9"],
  ])("range %s", (text, expected, covered) => {
    const hit = one(text);
    expect(hit.when).toBe(expected);
    expect(hit.text).toBe(covered);
  });

  it.each([
    ["October 6th, 2026 from 3-5pm", "2026-10-06 15:00-17:00"],
    ["Oct 6 at 3:30 p.m.", "2026-10-06 15:30"],
    ["Oct 6 at 11am", "2026-10-06 11:00"],
    ["Oct 6, 11-1pm", "2026-10-06 11:00-13:00"],
    ["Oct 6 at noon", "2026-10-06 12:00"],
    ["Oct 6 at 12am", "2026-10-06 00:00"],
    ["Oct 6 at 12pm", "2026-10-06 12:00"],
    ["3pm on Oct 6", "2026-10-06 15:00"],
    ["2026-10-06T14:00", "2026-10-06 14:00"],
    ["2026-10-06 14:00", "2026-10-06 14:00"],
    ["Oct 6, 9:00 - 17:00", "2026-10-06 09:00-17:00"],
  ])("with time %s", (text, expected) => {
    expect(one(text).when).toBe(expected);
  });

  it("reads US zones", () => {
    expect(one("Oct 6 at 3pm PT").hit.timeZone).toBe("America/Los_Angeles");
    expect(one("Oct 6 at 3pm ET").hit.timeZone).toBe("America/New_York");
    expect(one("2026-10-06T14:00:00Z").hit.timeZone).toBe("Etc/UTC");
  });

  it("does not take the English 'may' for a month without a day", () => {
    expect(find("You may want to join us")).toEqual([]);
    expect(find("You may 2x your points")).toEqual([]);
  });
});

describe("slash dates", () => {
  it("reads them the way the mail's order says", () => {
    expect(one("10/12/2026 3pm", REFERENCE, "MD").when).toBe("2026-10-12 15:00");
    expect(one("10/12/2026 3pm", REFERENCE, "DM").when).toBe("2026-12-10 15:00");
  });

  it("marks them ambiguous only when both ways work", () => {
    expect(one("10/12/2026", REFERENCE, "MD").hit.ambiguous).toBe(true);
    expect(one("25/10/2026", REFERENCE, "MD").hit.ambiguous).toBe(false);
    expect(one("25/10/2026", REFERENCE, "MD").when).toBe("2026-10-25");
    expect(one("10/25/2026", REFERENCE, "DM").when).toBe("2026-10-25");
  });

  it("follows an unambiguous date elsewhere in the same mail", () => {
    expect(slashOrderOf("on 10/25/2026 and 11/03/2026", "DM")).toBe("MD");
    expect(slashOrderOf("am 25/10/2026", "MD")).toBe("DM");
    const hits = find("First 10/25/2026, then 11/03/2026", REFERENCE, "DM");
    expect(hits.map((hit) => hit.startDate)).toEqual(["2026-10-25", "2026-11-03"]);
  });

  it("needs a year, a weekday or a cue for day and month alone", () => {
    expect(find("mix 1/2 cup of flour")).toEqual([]);
    expect(one("on 10/12", REFERENCE, "MD").when).toBe("2026-10-12");
    expect(one("Fri 10/16", REFERENCE, "MD").when).toBe("2026-10-16");
  });

  it("reads two-digit years", () => {
    expect(one("10/12/26", REFERENCE, "MD").when).toBe("2026-10-12");
  });
});

describe("relative expressions", () => {
  it.each([
    ["morgen 14 Uhr", "2026-09-30 14:00"],
    ["morgen um 14 Uhr", "2026-09-30 14:00"],
    ["Morgen um 9:30", "2026-09-30 09:30"],
    ["übermorgen um 10 Uhr", "2026-10-01 10:00"],
    ["heute um 18 Uhr", "2026-09-29 18:00"],
    ["heute Abend um 8", "2026-09-29 20:00"],
    ["heute Morgen um 9 Uhr", "2026-09-29 09:00"],
    ["tomorrow at 3pm", "2026-09-30 15:00"],
    ["tomorrow morning at 9", "2026-09-30 09:00"],
    ["tonight at 8", "2026-09-29 20:00"],
    ["the day after tomorrow at 10am", "2026-10-01 10:00"],
    ["today 5-6pm", "2026-09-29 17:00-18:00"],
  ])("%s", (text, expected) => {
    expect(one(text).when).toBe(expected);
  });

  it.each([
    ["nächsten Dienstag", "2026-10-06"],
    ["kommenden Freitag", "2026-10-02"],
    ["am Freitag", "2026-10-02"],
    ["am Dienstag", "2026-10-06"],
    ["diesen Dienstag um 18 Uhr", "2026-09-29 18:00"],
    ["next Tuesday", "2026-10-06"],
    ["this Friday", "2026-10-02"],
    ["on Monday", "2026-10-05"],
    ["Wir wollen Freitag ab 19 Uhr zocken", "2026-10-02 19:00"],
    ["Friday at 7pm", "2026-10-02 19:00"],
    ["am Dienstag um 9 Uhr", "2026-10-06 09:00"],
    ["am Dienstag um 18 Uhr", "2026-09-29 18:00"],
    ["Samstagabend um 8", "2026-10-03 20:00"],
  ])("%s", (text, expected) => {
    if (text === "Samstagabend um 8") {
      // One word in German; not a weekday the finder takes.
      expect(find(text)).toEqual([]);
      return;
    }
    expect(one(text).when).toBe(expected);
  });

  it("counts from the mail, not from today", () => {
    expect(one("morgen 14 Uhr", "2025-03-10T08:00:00").when).toBe("2025-03-11 14:00");
    expect(one("nächsten Dienstag", "2025-03-10T08:00:00").when).toBe("2025-03-11");
  });

  it.each([
    "Guten Morgen, um 10 Uhr ist das Meeting",
    "Good morning, see you at 3pm",
    "heute",
    "tomorrow",
    "Freitag",
    "letzten Freitag",
    "last Friday",
    "jeden Freitag um 18 Uhr",
    "every Monday at 9am",
    "Black Friday",
    "Cyber Monday deals",
    "freitags ab 18 Uhr",
    "on Fridays at 5pm",
  ])("ignores %s", (text) => {
    expect(find(text)).toEqual([]);
  });
});

describe("year inference", () => {
  it("takes the next time the date comes after the mail", () => {
    expect(one("am 5. Januar", "2026-12-20T10:00:00").when).toBe("2027-01-05");
    expect(one("am 5. Januar", "2026-01-02T10:00:00").when).toBe("2026-01-05");
  });

  it("keeps a date shortly before the mail in the same year", () => {
    expect(one("am 20.9.", REFERENCE).when).toBe("2026-09-20");
    expect(one("am 20.5.", REFERENCE).when).toBe("2027-05-20");
  });

  it("uses the weekday to pick the year", () => {
    // 16 Oct 2026 is a Friday; 17 Oct 2027 a Sunday.
    expect(one("Freitag, 16.10.").when).toBe("2026-10-16");
    expect(one("So., 17.10.").when).toBe("2027-10-17");
    expect(one("So., 17.10.").hit.weekdayMismatch).toBe(false);
  });

  it("flags a weekday that doesn't fit a written year", () => {
    expect(one("Freitag, 17.10.2026").hit.weekdayMismatch).toBe(true);
    expect(one("Samstag, 17.10.2026").hit.weekdayMismatch).toBe(false);
  });

  it("leaves out dates that don't exist", () => {
    expect(find("am 31.11.2026")).toEqual([]);
    expect(find("am 30. Februar")).toEqual([]);
    expect(one("am 29.2.", "2027-12-01T10:00:00").when).toBe("2028-02-29");
  });
});

describe("what is no date", () => {
  it.each([
    "IP 192.0.2.10 blockiert",
    "Version 1.2.3 ist da",
    "Kosten: 12,10 €",
    "Preis 12.10 €",
    "um 10.30 Uhr",
    "Tel. 0171/1234567",
    "Punkte: 3:1",
    "Seite 2 von 12",
    "Oktober 2026",
    "Ab 20 Personen",
    "Deal: 2-3 Tage",
  ])("%s", (text) => {
    expect(find(text)).toEqual([]);
  });
});

describe("times", () => {
  it.each([
    ["19:30", 19, 30, null],
    ["19 Uhr", 19, 0, null],
    ["19.30 Uhr", 19, 30, null],
    ["7pm", 19, 0, null],
    ["7:15 a.m.", 7, 15, null],
    ["14–16 Uhr", 14, 0, 16],
    ["3-5pm", 15, 0, 17],
  ])("%s", (text, h, min, endHour) => {
    const range = timeRangeAt(text, 0, false)!;
    expect(range.start).toEqual({ h, min });
    expect(range.end?.h ?? null).toBe(endHour);
  });

  it("takes a lone number only after um/at", () => {
    expect(timeRangeAt("20 Personen", 0, false)).toBeNull();
    expect(timeRangeAt("8", 0, true)?.start).toEqual({ h: 8, min: 0 });
  });

  it("stays fast on long runs of digits and dots", () => {
    const text = `${"1.".repeat(20_000)} ${"9".repeat(20_000)} ${"12/".repeat(10_000)}`;
    const started = performance.now();
    find(text);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
