import { describe, expect, it } from "vitest";
import { dayGroup, groupByDay } from "./dayGroups";

const now = new Date(2026, 10, 2, 10, 0).getTime();
const at = (day: number, hour = 9) => new Date(2026, 10, day, hour).toISOString();

describe("day groups", () => {
  it("sorts mail into today, yesterday, this week and older", () => {
    expect(dayGroup(at(2, 0), now)).toBe("today");
    expect(dayGroup(at(3), now)).toBe("today");
    expect(dayGroup(at(1, 23), now)).toBe("yesterday");
    expect(dayGroup(new Date(2026, 9, 28).toISOString(), now)).toBe("week");
    expect(dayGroup(new Date(2026, 9, 20).toISOString(), now)).toBe("older");
  });

  it("keeps the list's order and starts a group once per run", () => {
    const groups = groupByDay([at(2), at(2, 8), at(1), new Date(2026, 9, 1).toISOString()], (date) => date, now);
    expect(groups.map((group) => [group.group, group.items.length])).toEqual([
      ["today", 2],
      ["yesterday", 1],
      ["older", 1],
    ]);
  });
});
