import { describe, expect, it } from "vitest";
import { lookOfPixels, SAMPLE_SIZE } from "./pictureLook";

type Rgba = [number, number, number, number];

/** A square picture where `paint` decides the color of every pixel. */
function picture(paint: (x: number, y: number) => Rgba, size = SAMPLE_SIZE) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) data.set(paint(x, y), (y * size + x) * 4);
  }
  return data;
}

const CLEAR: Rgba = [0, 0, 0, 0];
const center = (SAMPLE_SIZE - 1) / 2;
const within = (x: number, y: number, radius: number) => Math.hypot(x - center, y - center) <= radius;

describe("picture look", () => {
  it("keeps opaque logos edge to edge, even light ones", () => {
    expect(lookOfPixels(picture(() => [31, 42, 92, 255]))).toEqual({ seeThrough: false, light: false });
    expect(lookOfPixels(picture(() => [255, 255, 255, 255]))).toEqual({ seeThrough: false, light: false });
  });

  it("ignores transparent corners outside the circle", () => {
    const round = picture((x, y) => (within(x, y, SAMPLE_SIZE / 2) ? [255, 77, 141, 255] : CLEAR));
    expect(lookOfPixels(round).seeThrough).toBe(false);
  });

  it("gives dark logos on transparent ground a light backdrop", () => {
    const mark = picture((x, y) => (within(x, y, 8) ? [28, 20, 32, 255] : CLEAR));
    expect(lookOfPixels(mark)).toEqual({ seeThrough: true, light: false });
  });

  it("gives white logos on transparent ground a dark backdrop", () => {
    const mark = picture((x, y) => (within(x, y, 8) ? [250, 250, 250, 255] : CLEAR));
    expect(lookOfPixels(mark)).toEqual({ seeThrough: true, light: true });
  });

  it("stays light-backed when only a little of the logo is white", () => {
    const mark = picture((x, y) => {
      if (!within(x, y, 10)) return CLEAR;
      return within(x, y, 4) ? [255, 255, 255, 255] : [225, 29, 116, 255];
    });
    expect(lookOfPixels(mark).light).toBe(false);
  });
});
