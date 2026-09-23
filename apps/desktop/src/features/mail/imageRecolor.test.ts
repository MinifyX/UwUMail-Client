import { describe, expect, it } from "vitest";
import { recolor, recolorPixels } from "./imageRecolor";
import { DARK_SURFACE, contrast, toOklch, type Rgba } from "./darkMode";

type Paint = (x: number, y: number) => [number, number, number, number];

function image(width: number, height: number, paint: Paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(paint(x, y), (y * width + x) * 4);
  }
  return data;
}

function pixel(data: Uint8ClampedArray, width: number, x: number, y: number): Rgba {
  const i = (y * width + x) * 4;
  return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]!, a: data[i + 3]! / 255 };
}

/** Deterministic noise, so "photos" look the same on every run. */
function noise(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return (state >> 16) & 255;
  };
}

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BLACK: [number, number, number, number] = [20, 20, 20, 255];
/** Black "text": thin horizontal strokes every eight rows. */
const text: Paint = (x, y) => (y % 8 < 2 && x > 4 && x < 120 ? BLACK : WHITE);

describe("recolor", () => {
  it("turns white into the paper and black into light ink", () => {
    const paper = recolor({ r: 255, g: 255, b: 255, a: 1 }, DARK_SURFACE);
    expect(contrast(paper, DARK_SURFACE)).toBeLessThan(1.1);
    const ink = recolor({ r: 0, g: 0, b: 0, a: 1 }, DARK_SURFACE);
    expect(contrast(ink, DARK_SURFACE)).toBeGreaterThan(7);
  });

  it("keeps the hue of colors", () => {
    const pink = { r: 0xff, g: 0x4d, b: 0x8d, a: 1 };
    const navy = { r: 0x10, g: 0x20, b: 0x70, a: 1 };
    const lighter = recolor(navy, DARK_SURFACE);
    expect(Math.abs(toOklch(lighter).h - toOklch(navy).h)).toBeLessThan(15);
    expect(contrast(lighter, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
    expect(recolor(pink, DARK_SURFACE)).toEqual(pink);
  });
});

describe("recolorPixels", () => {
  it("flips text printed on white", () => {
    const data = image(128, 64, text);
    expect(recolorPixels(data, 128, 64, DARK_SURFACE)).toBe("recolored");
    expect(contrast(pixel(data, 128, 60, 4), DARK_SURFACE)).toBeLessThan(1.2);
    expect(contrast(pixel(data, 128, 60, 8), DARK_SURFACE)).toBeGreaterThan(7);
  });

  it("leaves photos alone", () => {
    const random = noise(7);
    const data = image(128, 64, () => [random(), random(), random(), 255]);
    const before = data.slice();
    expect(recolorPixels(data, 128, 64, DARK_SURFACE)).toBe("unchanged");
    expect(data).toEqual(before);
  });

  it("leaves dark images alone", () => {
    const data = image(128, 64, (_x, y) => (y % 8 < 2 ? WHITE : [30, 30, 40, 255]));
    expect(recolorPixels(data, 128, 64, DARK_SURFACE)).toBe("unchanged");
  });

  it("keeps a photo inside a light layout as it is", () => {
    const random = noise(3);
    const photo = (x: number, y: number) => x >= 128 && x < 224 && y >= 32 && y < 128;
    const data = image(256, 160, (x, y) => (photo(x, y) ? [random(), random(), random(), 255] : text(x, y)));
    const before = data.slice();
    expect(recolorPixels(data, 256, 160, DARK_SURFACE)).toBe("recolored");
    // The text around it is flipped...
    expect(contrast(pixel(data, 256, 60, 4), DARK_SURFACE)).toBeLessThan(1.2);
    // ...the photo is untouched.
    for (let y = 32; y < 128; y += 1) {
      for (let x = 128; x < 224; x += 1) {
        const i = (y * 256 + x) * 4;
        expect([data[i], data[i + 1], data[i + 2]]).toEqual([before[i], before[i + 1], before[i + 2]]);
      }
    }
  });

  it("keeps light ink on transparency and flips dark ink", () => {
    const logo =
      (ink: [number, number, number, number]): Paint =>
      (x, y) =>
        x > 8 && x < 56 && y > 8 && y < 24 && (x + y) % 3 === 0 ? ink : [0, 0, 0, 0];
    expect(recolorPixels(image(64, 32, logo([250, 250, 250, 255])), 64, 32, DARK_SURFACE)).toBe("light-ink");

    const dark = image(64, 32, logo([10, 10, 10, 255]));
    expect(recolorPixels(dark, 64, 32, DARK_SURFACE)).toBe("recolored");
    expect(contrast(pixel(dark, 64, 12, 9), DARK_SURFACE)).toBeGreaterThan(7);
    // Transparency stays transparent.
    expect(dark[3]).toBe(0);
  });

  it("keeps light text on a colored button and large shapes as they are", () => {
    const GREEN: [number, number, number, number] = [5, 206, 120, 255];
    const paint: Paint = (x, y) => {
      if (x >= 20 && x < 120 && y >= 20 && y < 60) return y >= 36 && y < 40 && x >= 40 && x < 100 ? WHITE : GREEN;
      if (x >= 140 && x < 240 && y >= 20 && y < 120) return BLACK;
      return y >= 80 && y < 82 && x >= 20 && x < 120 ? BLACK : WHITE;
    };
    const data = image(256, 140, paint);
    expect(recolorPixels(data, 256, 140, DARK_SURFACE)).toBe("recolored");
    const at = (x: number, y: number) => Array.from(data.slice((y * 256 + x) * 4, (y * 256 + x) * 4 + 4));
    expect(at(50, 37)).toEqual(WHITE);
    expect(at(25, 25)).toEqual(GREEN);
    expect(at(190, 70)).toEqual(BLACK);
    // The line of text and the paper around everything turn.
    expect(contrast(pixel(data, 256, 50, 80), DARK_SURFACE)).toBeGreaterThan(7);
    expect(contrast(pixel(data, 256, 10, 10), DARK_SURFACE)).toBeLessThan(1.2);
  });

  it("skips tiny images", () => {
    expect(recolorPixels(image(16, 16, text), 16, 16, DARK_SURFACE)).toBe("unchanged");
  });
});
