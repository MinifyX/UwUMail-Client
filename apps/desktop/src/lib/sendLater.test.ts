import { describe, expect, it } from "vitest";
import { fromLocalInput, sendLaterPresets, sendLaterProblem, toLocalInput } from "./sendLater";

describe("send later presets", () => {
  it("offers later today, tomorrow and Monday on a Wednesday morning", () => {
    const wednesday = new Date(2026, 8, 23, 9, 30);
    const presets = sendLaterPresets(wednesday);
    expect(presets.map((entry) => entry.preset)).toEqual([
      "laterToday",
      "tomorrowMorning",
      "tomorrowAfternoon",
      "mondayMorning",
    ]);
    expect(toLocalInput(presets[0]!.at)).toBe("2026-09-23T18:00");
    expect(toLocalInput(presets[1]!.at)).toBe("2026-09-24T08:00");
    expect(toLocalInput(presets[3]!.at)).toBe("2026-09-28T08:00");
  });

  it("leaves out later today in the evening and Monday on a Sunday", () => {
    const sunday = new Date(2026, 8, 27, 17, 30);
    expect(sendLaterPresets(sunday).map((entry) => entry.preset)).toEqual(["tomorrowMorning", "tomorrowAfternoon"]);
  });

  it("offers the Monday after next on a Monday", () => {
    const monday = new Date(2026, 8, 28, 20, 0);
    const monday2 = sendLaterPresets(monday).find((entry) => entry.preset === "mondayMorning");
    expect(toLocalInput(monday2!.at)).toBe("2026-10-05T08:00");
  });
});

describe("the time field", () => {
  it("reads back what it wrote", () => {
    const date = new Date(2026, 11, 24, 7, 5);
    expect(fromLocalInput(toLocalInput(date))?.getTime()).toBe(date.getTime());
  });

  it("refuses what isn't a time", () => {
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("tomorrow")).toBeNull();
  });
});

describe("what a chosen time has to be", () => {
  const now = new Date(2026, 8, 25, 12, 0);
  const days30 = 30 * 24 * 60 * 60;

  it("takes a time within the server's limit", () => {
    expect(sendLaterProblem(new Date(2026, 8, 26, 8, 0), days30, now)).toBeNull();
  });

  it("refuses the past, the next minute and no time at all", () => {
    expect(sendLaterProblem(new Date(2026, 8, 25, 11, 0), days30, now)).toBe("tooSoon");
    expect(sendLaterProblem(new Date(2026, 8, 25, 12, 1), days30, now)).toBe("tooSoon");
    expect(sendLaterProblem(null, days30, now)).toBe("invalid");
  });

  it("refuses more than the server holds", () => {
    expect(sendLaterProblem(new Date(2026, 9, 26, 12, 0), days30, now)).toBe("tooFar");
  });
});
