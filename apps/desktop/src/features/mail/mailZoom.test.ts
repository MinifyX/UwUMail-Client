import { describe, expect, it } from "vitest";
import { clampZoom, fitScale } from "./mailZoom";

describe("fitScale", () => {
  it("leaves a mail alone that fits", () => {
    expect(fitScale(375, 375)).toBe(1);
    expect(fitScale(375, 300)).toBe(1);
    expect(fitScale(0, 600)).toBe(1);
  });

  it("scales a wide mail down to the reader's width", () => {
    expect(fitScale(300, 600)).toBe(0.5);
  });

  it("doesn't shrink a mail past readability", () => {
    expect(fitScale(100, 10_000)).toBe(0.25);
  });
});

describe("clampZoom", () => {
  it("keeps the reader's zoom between the fitted size and four times the real size", () => {
    expect(clampZoom(1, 0.5)).toBe(1);
    expect(clampZoom(1, 9)).toBe(4);
    expect(clampZoom(0.5, 9)).toBe(8);
  });
});
