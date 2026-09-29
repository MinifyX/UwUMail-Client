import { describe, expect, it } from "vitest";
import {
  attributePixels,
  displaySize,
  isPlaceholder,
  isTrackingPixel,
  parseSrcset,
  placeholderFromMail,
  placeholderSource,
  sizeFromMail,
  sizeTarget,
  stylePixels,
} from "./imageSizes";

describe("what the mail says about a picture's size", () => {
  it("reads width and height attributes like browsers do", () => {
    expect(attributePixels("600")).toBe(600);
    expect(attributePixels(" 600px ")).toBe(600);
    expect(attributePixels("480.5")).toBe(480.5);
    expect(attributePixels("0")).toBe(0);
    expect(attributePixels("50%")).toBeNull();
    expect(attributePixels("auto")).toBeNull();
    expect(attributePixels("")).toBeNull();
    expect(attributePixels(null)).toBeNull();
    // Nothing that big is a real picture.
    expect(attributePixels("9999999")).toBeNull();
  });

  it("reads pixel sizes from an inline style, and knows when the style takes a side over", () => {
    expect(stylePixels("width: 300px; height:150px !important")).toEqual({ width: 300, height: 150 });
    expect(stylePixels("max-width:100%;min-height:20px")).toEqual({});
    expect(stylePixels("width:100%;height:auto")).toEqual({ width: null, height: null });
    expect(stylePixels("width:0;height:120")).toEqual({ width: 0, height: null });
    expect(stylePixels("WIDTH:2em")).toEqual({ width: null });
    expect(stylePixels(null)).toEqual({});
  });

  it("lets the style win over the attributes", () => {
    expect(sizeFromMail({ width: "600", height: "300" })).toEqual({ width: 600, height: 300 });
    expect(sizeFromMail({ width: "600", height: "300", style: "width:200px" })).toEqual({ width: 200, height: 300 });
    // `height:auto` in CSS makes the attribute's height count for nothing.
    expect(sizeFromMail({ width: "600", height: "300", style: "height:auto" })).toEqual({
      width: 600,
      height: null,
    });
    expect(sizeFromMail({})).toEqual({ width: null, height: null });
  });
});

describe("the placeholder", () => {
  it("takes the mail's size at once, and guesses the shape from one side", () => {
    expect(placeholderFromMail({ width: 600, height: 300 })).toEqual({ width: 600, height: 300 });
    expect(placeholderFromMail({ width: 480, height: null })).toEqual({ width: 480, height: 270 });
    expect(placeholderFromMail({ width: null, height: 90 })).toEqual({ width: 160, height: 90 });
    expect(placeholderFromMail({ width: null, height: null })).toBeNull();
  });

  it("is a transparent SVG of exactly that size, tiny when the size is unknown", () => {
    const source = placeholderSource({ width: 600, height: 300 });
    expect(source.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(source)).toContain("width='600' height='300'");
    expect(decodeURIComponent(placeholderSource(null))).toContain("width='1' height='1'");
    expect(isPlaceholder(source)).toBe(true);
    expect(isPlaceholder("data:image/svg+xml;charset=utf-8,%3Csvg%3E")).toBe(false);
    expect(isPlaceholder(undefined)).toBe(false);
  });

  it("shows a denser candidate at its density", () => {
    expect(displaySize({ width: 1200, height: 600 })).toEqual({ width: 1200, height: 600 });
    expect(displaySize({ width: 1200, height: 600 }, 2)).toEqual({ width: 600, height: 300 });
    expect(displaySize({ width: 100, height: 100 }, 3)).toEqual({ width: 33.33, height: 33.33 });
    expect(displaySize({ width: 100, height: 100 }, 0)).toBeNull();
    expect(displaySize({ width: 100_000, height: 10 })).toBeNull();
  });
});

describe("tracking pixels", () => {
  const none = { width: null, height: null };

  it("are tiny", () => {
    expect(isTrackingPixel({ width: 1, height: 1 }, none)).toBe(true);
    expect(isTrackingPixel({ width: 2, height: 2 }, none)).toBe(true);
    expect(isTrackingPixel({ width: 0, height: 0 }, none)).toBe(true);
    expect(isTrackingPixel({ width: 3, height: 1 }, none)).toBe(false);
    expect(isTrackingPixel({ width: 600, height: 300 }, none)).toBe(false);
  });

  it("or of unknown size where the mail says nothing either", () => {
    expect(isTrackingPixel(null, none)).toBe(true);
    expect(isTrackingPixel(null, { width: 1, height: 1 })).toBe(true);
    expect(isTrackingPixel(null, { width: 1, height: null })).toBe(true);
    expect(isTrackingPixel(null, { width: 480, height: null })).toBe(false);
  });

  it("go by the known size before the mail's", () => {
    expect(isTrackingPixel({ width: 600, height: 300 }, { width: 1, height: 1 })).toBe(false);
  });
});

describe("srcset", () => {
  it("splits candidates like the proxy, keeping commas inside addresses", () => {
    expect(
      parseSrcset("https://cdn.example/a.jpg 1x, https://cdn.example/w_200,h_100/a.jpg 2x, https://cdn.example/b.jpg"),
    ).toEqual([
      { url: "https://cdn.example/a.jpg", density: 1, width: null },
      { url: "https://cdn.example/w_200,h_100/a.jpg", density: 2, width: null },
      { url: "https://cdn.example/b.jpg", density: 1, width: null },
    ]);
    expect(parseSrcset("https://cdn.example/s.jpg 320w, https://cdn.example/l.jpg 960w")).toEqual([
      { url: "https://cdn.example/s.jpg", density: null, width: 320 },
      { url: "https://cdn.example/l.jpg", density: null, width: 960 },
    ]);
  });

  it("asks about the src where it's remote, also next to width descriptors", () => {
    expect(sizeTarget(" https://cdn.example/a.jpg ", "https://cdn.example/a@2x.jpg 2x")).toEqual({
      url: "https://cdn.example/a.jpg",
      density: 1,
    });
    expect(sizeTarget("https://cdn.example/a.jpg", "https://cdn.example/s.jpg 320w")).toEqual({
      url: "https://cdn.example/a.jpg",
      density: 1,
    });
  });

  it("otherwise asks about the candidate closest to 1x", () => {
    expect(sizeTarget(null, "https://cdn.example/a@3x.jpg 3x, https://cdn.example/a@2x.jpg 2x")).toEqual({
      url: "https://cdn.example/a@2x.jpg",
      density: 2,
    });
    expect(sizeTarget("cid:logo", "https://cdn.example/a.jpg 1x, https://cdn.example/a@2x.jpg 2x")).toEqual({
      url: "https://cdn.example/a.jpg",
      density: 1,
    });
  });

  it("has nothing to ask about with only width descriptors or nothing remote", () => {
    expect(sizeTarget(null, "https://cdn.example/s.jpg 320w")).toBeNull();
    expect(sizeTarget("cid:logo", null)).toBeNull();
    expect(sizeTarget("data:image/png;base64,AAAA", "")).toBeNull();
  });
});
