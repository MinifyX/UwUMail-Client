import { describe, expect, it } from "vitest";
import { phoneDevice } from "./device";

describe("phoneDevice", () => {
  it("is an iPhone or Android phone, upright or turned", () => {
    expect(phoneDevice(true, 375, 667)).toBe(true);
    expect(phoneDevice(true, 844, 390)).toBe(true);
    expect(phoneDevice(true, 412, 915)).toBe(true);
  });

  it("is no tablet and no desktop", () => {
    // iPad mini, Android tablet (600 dp), a narrow desktop window.
    expect(phoneDevice(true, 744, 1133)).toBe(false);
    expect(phoneDevice(true, 600, 960)).toBe(false);
    expect(phoneDevice(false, 375, 667)).toBe(false);
  });

  it("is no phone while the screen size is unknown", () => {
    expect(phoneDevice(true, 0, 0)).toBe(false);
  });
});
