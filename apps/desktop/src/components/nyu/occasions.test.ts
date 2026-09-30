import { describe, expect, it } from "vitest";
import {
  contactFor,
  isBirthdayToday,
  isLateNight,
  localDay,
  openCameos,
  photoCount,
  seasonalHat,
  type OccasionContact,
} from "./occasions";

const at = (iso: string) => new Date(iso);

const leni: OccasionContact = { emails: [{ address: "Leni@Wanders.example" }], birthday: "1996-09-30" };
const group: OccasionContact = { emails: [{ address: "team@wanders.example" }], birthday: "--09-30", isGroup: true };

const photo = { mimeType: "image/jpeg", inline: false };
const inlineLogo = { mimeType: "image/png", inline: true };

describe("late at night", () => {
  it("runs from 23:00 until 04:59 local time", () => {
    expect(isLateNight(at("2026-09-30T22:59:00"))).toBe(false);
    expect(isLateNight(at("2026-09-30T23:00:00"))).toBe(true);
    expect(isLateNight(at("2026-10-01T02:30:00"))).toBe(true);
    expect(isLateNight(at("2026-10-01T04:59:00"))).toBe(true);
    expect(isLateNight(at("2026-10-01T05:00:00"))).toBe(false);
    expect(isLateNight(at("2026-10-01T12:00:00"))).toBe(false);
  });
});

describe("seasonal hats", () => {
  it("puts on a Santa hat in December until Boxing Day and a party hat around New Year", () => {
    expect(seasonalHat(at("2026-11-30T12:00:00"))).toBeNull();
    expect(seasonalHat(at("2026-12-01T12:00:00"))).toBe("santa");
    expect(seasonalHat(at("2026-12-26T12:00:00"))).toBe("santa");
    expect(seasonalHat(at("2026-12-27T12:00:00"))).toBeNull();
    expect(seasonalHat(at("2026-12-31T12:00:00"))).toBe("party");
    expect(seasonalHat(at("2027-01-01T12:00:00"))).toBe("party");
    expect(seasonalHat(at("2027-01-02T12:00:00"))).toBeNull();
  });
});

describe("birthdays", () => {
  it("matches the day with and without a year", () => {
    expect(isBirthdayToday("1996-09-30", "2026-09-30")).toBe(true);
    expect(isBirthdayToday("--09-30", "2026-09-30")).toBe(true);
    expect(isBirthdayToday("1996-09-29", "2026-09-30")).toBe(false);
    expect(isBirthdayToday(null, "2026-09-30")).toBe(false);
    expect(isBirthdayToday("not a date", "2026-09-30")).toBe(false);
  });

  it("celebrates 29 February on the 28th in other years", () => {
    expect(isBirthdayToday("2000-02-29", "2027-02-28")).toBe(true);
    expect(isBirthdayToday("2000-02-29", "2028-02-28")).toBe(false);
    expect(isBirthdayToday("2000-02-29", "2028-02-29")).toBe(true);
  });

  it("reads the local day", () => {
    expect(localDay(at("2026-01-05T08:00:00"))).toBe("2026-01-05");
  });
});

describe("contacts and photos", () => {
  it("finds a contact by address, ignoring case and groups", () => {
    expect(contactFor([group, leni], "leni@wanders.example")).toBe(leni);
    expect(contactFor([group], "team@wanders.example")).toBeNull();
    expect(contactFor([leni], "")).toBeNull();
  });

  it("counts attached pictures, not inline ones or drawings", () => {
    expect(
      photoCount([
        photo,
        inlineLogo,
        { mimeType: "image/svg+xml", inline: false },
        { mimeType: "application/pdf", inline: false },
      ]),
    ).toBe(1);
    expect(photoCount([{ mimeType: "IMAGE/HEIC", inline: false }])).toBe(1);
  });
});

describe("the scene for an opened mail", () => {
  const noon = at("2026-09-30T12:00:00");
  const names = (list: ReturnType<typeof openCameos>) => list.map((choice) => choice.name);

  it("puts the birthday first, then new mail from a contact, photos, the night and a peek", () => {
    const choices = openCameos(
      { from: "leni@wanders.example", unread: true, attachments: [photo] },
      [leni],
      at("2026-09-30T23:30:00"),
    );
    expect(names(choices)).toEqual(["birthday", "friend", "photos", "night", "peek"]);
    // A birthday greets once per sender and day.
    expect(choices[0]!.key).toBe("birthday:leni@wanders.example:2026-09-30");
  });

  it("only greets a contact's mail with hearts while it is new", () => {
    const read = openCameos({ from: "leni@wanders.example", unread: false, attachments: [] }, [], noon);
    expect(names(read)).toEqual(["peek"]);
    const known = { ...leni, birthday: null };
    expect(names(openCameos({ from: "leni@wanders.example", unread: true, attachments: [] }, [known], noon))).toEqual([
      "friend",
      "peek",
    ]);
    expect(names(openCameos({ from: "leni@wanders.example", unread: false, attachments: [] }, [known], noon))).toEqual([
      "peek",
    ]);
  });

  it("lets strangers and one's own mail only get a peek, with a seasonal hat", () => {
    const december = openCameos({ from: "", unread: true, attachments: [] }, [leni], at("2026-12-10T10:00:00"));
    expect(december).toEqual([{ name: "peek", key: "peek", hat: "santa" }]);
  });
});
