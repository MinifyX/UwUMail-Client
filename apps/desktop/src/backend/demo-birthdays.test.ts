import { describe, expect, it, vi } from "vitest";
import { birthdayTitle, parseDay } from "@/lib/birthdays";
import { birthdayOccurrences, contactsNamed, matchOf, nameFromTitle } from "./demo-birthdays";
import { DemoCalendar } from "./demo-calendar";
import type { ContactRecord } from "./types";

const person = (id: string, given: string, surname: string, birthday: string | null = null): ContactRecord => ({
  id,
  accountId: "acc",
  addressBookId: "b1",
  displayName: `${given} ${surname}`.trim(),
  given,
  surname,
  organization: "",
  title: "",
  emails: [],
  phones: [],
  addresses: [],
  birthday,
  anniversary: null,
  reminders: [],
  note: "",
  photo: null,
  isGroup: false,
});

describe("birthday titles", () => {
  it("reads the name and the year out of German and English titles", () => {
    expect(nameFromTitle("Geburtstag von Jürgen Müller")).toEqual({ name: "Jürgen Müller", year: null });
    expect(nameFromTitle("Geb. Max (*1990)")).toEqual({ name: "Max", year: 1990 });
    expect(nameFromTitle("Max hat Geburtstag")).toEqual({ name: "Max", year: null });
    expect(nameFromTitle("Mia’s Birthday!")).toEqual({ name: "Mia", year: null });
    expect(nameFromTitle("bday Noah 2001")).toEqual({ name: "Noah", year: 2001 });
    expect(nameFromTitle("🎂 Oma Hilde")).toEqual({ name: "Oma Hilde", year: null });
    // An age is no year of birth.
    expect(nameFromTitle("Geburtstag Max (30)")).toEqual({ name: "Max", year: null });
  });

  it("leaves other events alone", () => {
    expect(nameFromTitle("Zahnarzt")).toBeNull();
    expect(nameFromTitle("Geburtstagsfeier")).toBeNull();
    expect(nameFromTitle("Geburtstag")).toBeNull();
  });

  it("writes the age into each year's title", () => {
    const max = (kind: "birth" | "wedding", age: number | null) => ({
      contactId: "k1",
      kind,
      label: null,
      name: "Max Muster",
      year: 1990,
      age,
    });
    expect(birthdayTitle(max("birth", 30), "de")).toBe("Max Muster (30)");
    expect(birthdayTitle(max("birth", null), "de")).toBe("Max Muster");
    expect(birthdayTitle(max("wedding", 5), "de")).toBe("Hochzeitstag von Max Muster (5 Jahre)");
    expect(birthdayTitle(max("wedding", 1), "en")).toBe("Wedding anniversary of Max Muster (1 year)");
  });
});

describe("matching names", () => {
  const contacts = [
    person("k1", "Jürgen", "Müller", "1970-05-01"),
    person("k2", "Max", "Muster"),
    person("k3", "Max", "Mustermann"),
    person("k4", "Zoë", "Groß", "--03-02"),
  ];

  it("finds umlauts spelled out or plain, by characters", () => {
    expect(contactsNamed("Juergen Mueller", contacts).map((c) => c.id)).toEqual(["k1"]);
    expect(contactsNamed("Jurgen Muller", contacts).map((c) => c.id)).toEqual(["k1"]);
    expect(contactsNamed("Müller Jürgen", contacts).map((c) => c.id)).toEqual(["k1"]);
    expect(contactsNamed("Zoe Gross", contacts).map((c) => c.id)).toEqual(["k4"]);
    expect(contactsNamed("Max", contacts).map((c) => c.id)).toEqual(["k2", "k3"]);
    expect(contactsNamed("Max Muster", contacts).map((c) => c.id)).toEqual(["k2"]);
    expect(contactsNamed("Hilde", contacts)).toEqual([]);
  });

  it("says how a found day fits", () => {
    const [juergen, max, , zoe] = contacts;
    expect(matchOf(parseDay("1970-05-01")!, [juergen!])).toBe("known");
    expect(matchOf(parseDay("--05-01")!, [juergen!])).toBe("known");
    expect(matchOf(parseDay("1971-05-01")!, [juergen!])).toBe("conflict");
    expect(matchOf(parseDay("1990-03-02")!, [zoe!])).toBe("matched");
    expect(matchOf(parseDay("1990-03-02")!, [max!])).toBe("matched");
    expect(matchOf(parseDay("1990-03-02")!, [])).toBe("unmatched");
    expect(matchOf(parseDay("1990-03-02")!, contacts)).toBe("ambiguous");
  });
});

describe("the birthdays calendar", () => {
  it("puts 29 February on the 28th and counts the age", () => {
    const leap = [person("k1", "Lea", "Schalt", "2000-02-29")];
    const days = (from: string, to: string) =>
      birthdayOccurrences(leap, from, to, "acc", "acc:bdays", "en").map((o) => [
        o.start.slice(0, 10),
        o.title,
        o.birthday?.age,
      ]);
    expect(days("2025-01-01T00:00:00", "2025-12-31T00:00:00")).toEqual([["2025-02-28", "Lea Schalt (25)", 25]]);
    expect(days("2028-01-01T00:00:00", "2028-12-31T00:00:00")).toEqual([["2028-02-29", "Lea Schalt (28)", 28]]);
    expect(days("1999-01-01T00:00:00", "1999-12-31T00:00:00")).toEqual([]);
  });

  it("copes with dates without a year and very old ones", () => {
    const people = [person("k1", "Ohne", "Jahr", "--12-31"), person("k2", "Karl", "Groß", "0812-04-02")];
    const found = birthdayOccurrences(people, "2026-01-01T00:00:00", "2027-01-01T00:00:00", "acc", "acc:bdays", "de");
    expect(found.map((o) => [o.start, o.end, o.allDay, o.title])).toEqual([
      ["2026-12-31T00:00:00", "2027-01-01T00:00:00", true, "Ohne Jahr"],
      ["2026-04-02T00:00:00", "2026-04-03T00:00:00", true, "Karl Groß (1214)"],
    ]);
    expect(found.every((o) => o.readOnly && o.timeZone === null)).toBe(true);
  });

  it("finds the birthday events of the other calendars and matches them", () => {
    const contacts = [person("k1", "Mia", "Mood"), person("k2", "Noah", "Stern"), person("k3", "Leni", "")];
    contacts[2]!.birthday = "1990-01-01";
    // The sample events are laid out around today; a fixed today keeps Leni's day apart from hers.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 8, 29, 10, 0) });
    const calendar = new DemoCalendar(
      "en",
      () => {},
      () => contacts,
    );
    vi.useRealTimers();
    const found = Object.fromEntries(calendar.scanBirthdays().map((c) => [c.name, c]));
    expect(found["Mia Mood"]).toMatchObject({ match: "matched", mayDeleteEvent: true });
    expect(found["Mia Mood"]!.birthday.startsWith("1999-")).toBe(true);
    expect(found["Noah"]).toMatchObject({ match: "matched" });
    // With the day in his card, Noah's event is known already.
    contacts[1]!.birthday = `--${found["Noah"]!.birthday.slice(-5)}`;
    const noah = calendar.scanBirthdays().find((c) => c.name === "Noah")!;
    expect(noah).toMatchObject({ birthday: contacts[1]!.birthday, match: "known" });
    expect(found["Oma Hilde"]).toMatchObject({ match: "unmatched", contacts: [] });
    expect(Object.keys(found)).toHaveLength(3);
  });
});
