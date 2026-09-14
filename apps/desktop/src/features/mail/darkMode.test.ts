import { describe, expect, it } from "vitest";
import {
  contrast,
  darkenBackground,
  DARK_SURFACE,
  decide,
  declaresDarkMode,
  forceColorSchemeQueries,
  fromOklch,
  lightenText,
  parseColor,
  toCss,
  toOklch,
  type Rgba,
} from "./darkMode";

const rgb = (r: number, g: number, b: number): Rgba => ({ r, g, b, a: 1 });

describe("colors", () => {
  it("parses computed style colors", () => {
    expect(parseColor("rgb(255, 77, 141)")).toEqual(rgb(255, 77, 141));
    expect(parseColor("rgba(0, 0, 0, 0)")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor("rgb(10 20 30 / 50%)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor("transparent")).toBeNull();
  });

  it("round-trips through OKLCH", () => {
    for (const color of [rgb(255, 77, 141), rgb(28, 23, 31), rgb(255, 255, 255), rgb(15, 110, 86)]) {
      const back = fromOklch(toOklch(color));
      expect(Math.abs(back.r - color.r)).toBeLessThan(1);
      expect(Math.abs(back.g - color.g)).toBeLessThan(1);
      expect(Math.abs(back.b - color.b)).toBeLessThan(1);
    }
  });

  it("measures WCAG contrast", () => {
    expect(contrast(rgb(255, 255, 255), rgb(0, 0, 0))).toBeCloseTo(21, 0);
    expect(contrast(rgb(255, 255, 255), rgb(225, 29, 116))).toBeGreaterThan(4.5);
  });
});

describe("darkening", () => {
  it("turns white paper dark and leaves dark blocks alone", () => {
    expect(toOklch(darkenBackground(rgb(255, 255, 255))).l).toBeLessThan(0.25);
    expect(darkenBackground(rgb(28, 23, 31))).toEqual(rgb(28, 23, 31));
  });

  it("keeps the hue of brand colors", () => {
    const pink = rgb(255, 77, 141);
    const darkened = darkenBackground(pink);
    expect(Math.abs(toOklch(darkened).h - toOklch(pink).h)).toBeLessThan(3);
    expect(toOklch(darkened).l).toBeLessThan(toOklch(pink).l);
  });

  it("makes dark text light and always readable", () => {
    const text = lightenText(rgb(28, 20, 32), DARK_SURFACE);
    expect(contrast(text, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
    const link = lightenText(rgb(24, 95, 165), DARK_SURFACE);
    expect(contrast(link, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
    expect(Math.abs(toOklch(link).h - toOklch(rgb(24, 95, 165)).h)).toBeLessThan(8);
  });

  it("writes CSS colors", () => {
    expect(toCss(rgb(28, 23, 31))).toBe("rgb(28, 23, 31)");
    expect(toCss({ r: 0, g: 0, b: 0, a: 0.5 })).toBe("rgba(0, 0, 0, 0.5)");
  });
});

describe("detection", () => {
  it("notices a mail's own dark mode styles", () => {
    expect(declaresDarkMode("<style>@media (prefers-color-scheme: dark) { body { background: #000 } }</style>")).toBe(
      true,
    );
    expect(declaresDarkMode("<style>:root { color-scheme: light dark; }</style>")).toBe(true);
    expect(declaresDarkMode('<p style="color: #333">Hi</p>')).toBe(false);
  });

  it("forces the color scheme queries to match the rendering", () => {
    const css = "@media (prefers-color-scheme: dark) { a {} } @media screen and (prefers-color-scheme: light) { b {} }";
    expect(forceColorSchemeQueries(css, true)).toBe(
      "@media (min-width: 0px) { a {} } @media screen and (max-width: -1px) { b {} }",
    );
    expect(forceColorSchemeQueries(css, false)).toContain("@media (max-width: -1px) { a {} }");
  });

  const page = 1000 * 2000;

  it("darkens plain mails", () => {
    expect(decide({ area: page, imageArea: page * 0.05, backgroundImageArea: 0, blocks: [] })).toBe("darken");
  });

  it("keeps image-heavy and background-image mails light", () => {
    expect(decide({ area: page, imageArea: page * 0.6, backgroundImageArea: 0, blocks: [] })).toBe("original");
    expect(decide({ area: page, imageArea: 0, backgroundImageArea: page * 0.3, blocks: [] })).toBe("original");
  });

  it("keeps mails with many colorful blocks light", () => {
    const blocks = [
      { area: page * 0.12, hue: 40, chroma: 0.15, lightness: 0.7 },
      { area: page * 0.12, hue: 140, chroma: 0.12, lightness: 0.5 },
      { area: page * 0.12, hue: 340, chroma: 0.18, lightness: 0.65 },
    ];
    expect(decide({ area: page, imageArea: 0, backgroundImageArea: 0, blocks })).toBe("original");
  });

  it("still darkens a mail with one small colored button", () => {
    const blocks = [{ area: page * 0.02, hue: 350, chroma: 0.2, lightness: 0.65 }];
    expect(decide({ area: page, imageArea: 0, backgroundImageArea: 0, blocks })).toBe("darken");
  });
});
