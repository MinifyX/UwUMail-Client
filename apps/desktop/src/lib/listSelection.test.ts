import { describe, expect, it } from "vitest";
import { extendSelection, stepThrough } from "./listSelection";

const order = ["a", "b", "c", "d", "e"];

describe("stepThrough", () => {
  it("moves to the row below and above", () => {
    expect(stepThrough(order, "b", 1)).toBe("c");
    expect(stepThrough(order, "b", -1)).toBe("a");
  });

  it("stays at the ends", () => {
    expect(stepThrough(order, "e", 1)).toBe("e");
    expect(stepThrough(order, "a", -1)).toBe("a");
  });

  it("starts at the first row when nothing is open", () => {
    expect(stepThrough(order, null, 1)).toBe("a");
    expect(stepThrough(order, null, -1)).toBe("a");
    expect(stepThrough(order, "gone", 1)).toBe("a");
  });

  it("has nothing to open in an empty list", () => {
    expect(stepThrough([], null, 1)).toBeNull();
  });
});

describe("extendSelection", () => {
  it("ticks the open row and the one below", () => {
    expect(extendSelection(order, { checked: [], anchor: "b", cursor: null }, 1)).toEqual({
      checked: ["b", "c"],
      anchor: "b",
      cursor: "c",
    });
  });

  it("grows and shrinks the range from the anchor", () => {
    let selection = { checked: [] as string[], anchor: "c" as string | null, cursor: null as string | null };
    selection = extendSelection(order, selection, 1);
    selection = extendSelection(order, selection, 1);
    expect(selection.checked.sort()).toEqual(["c", "d", "e"]);
    selection = extendSelection(order, selection, -1);
    expect(selection.checked.sort()).toEqual(["c", "d"]);
    selection = extendSelection(order, selection, -1);
    selection = extendSelection(order, selection, -1);
    expect(selection.checked.sort()).toEqual(["b", "c"]);
    expect(selection.cursor).toBe("b");
  });

  it("keeps rows ticked on their own", () => {
    const next = extendSelection(order, { checked: ["e"], anchor: "a", cursor: null }, 1);
    expect(next.checked.sort()).toEqual(["a", "b", "e"]);
  });

  it("stays at the end of the list", () => {
    const next = extendSelection(order, { checked: ["d", "e"], anchor: "d", cursor: "e" }, 1);
    expect(next).toEqual({ checked: ["d", "e"], anchor: "d", cursor: "e" });
  });

  it("starts at the first row, or the last going up, when nothing is open", () => {
    expect(extendSelection(order, { checked: [], anchor: null, cursor: null }, 1)).toEqual({
      checked: ["a"],
      anchor: "a",
      cursor: "a",
    });
    expect(extendSelection(order, { checked: [], anchor: null, cursor: null }, -1).checked).toEqual(["e"]);
  });

  it("starts over from the cursor when the anchor left the list", () => {
    const next = extendSelection(order, { checked: ["c"], anchor: "gone", cursor: "c" }, 1);
    expect(next).toEqual({ checked: ["c", "d"], anchor: "c", cursor: "d" });
  });

  it("does nothing in an empty list", () => {
    const selection = { checked: ["x"], anchor: "x", cursor: null };
    expect(extendSelection([], selection, 1)).toBe(selection);
  });
});
