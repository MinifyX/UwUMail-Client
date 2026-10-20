import { describe, expect, it } from "vitest";
import { comboOf } from "./hotkeys";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("key combos", () => {
  it("tells Shift with letters only", () => {
    expect(comboOf(key({ key: "I", shiftKey: true }))).toBe("shift+i");
    expect(comboOf(key({ key: "i" }))).toBe("i");
    expect(comboOf(key({ key: "?", shiftKey: true }))).toBe("?");
    expect(comboOf(key({ key: "D", shiftKey: true, ctrlKey: true }))).toBe("mod+shift+d");
  });
});
