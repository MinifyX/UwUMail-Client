import { describe, expect, it } from "vitest";
import { updatesInApp } from "./distribution";

describe("updatesInApp", () => {
  it("offers updates only in a direct download on a computer or Android", () => {
    expect(updatesInApp("direct", false)).toBe(true);
    expect(updatesInApp("store", false)).toBe(false);
    expect(updatesInApp("direct", true)).toBe(false);
    expect(updatesInApp(undefined, false)).toBe(false);
  });
});
