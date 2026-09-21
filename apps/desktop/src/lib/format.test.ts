import { describe, expect, it } from "vitest";
import {
  colorFor,
  displayName,
  formatAddress,
  formatListDate,
  formatSize,
  initials,
  parseAddress,
  textToHtml,
} from "./format";

describe("formatListDate", () => {
  const now = new Date(2026, 8, 14, 15, 0);

  it("shows the time for today", () => {
    expect(formatListDate(new Date(2026, 8, 14, 9, 41).toISOString(), "de-DE", "Gestern", now)).toBe("09:41");
  });

  it("says yesterday for yesterday", () => {
    expect(formatListDate(new Date(2026, 8, 13, 23, 0).toISOString(), "de-DE", "Gestern", now)).toBe("Gestern");
  });

  it("shows a short date for older mail this year", () => {
    expect(formatListDate(new Date(2026, 5, 2).toISOString(), "en-US", "Yesterday", now)).toBe("Jun 2");
  });
});

describe("parseAddress", () => {
  it("parses a bare address", () => {
    expect(parseAddress("leni@wanders.example")).toEqual({ email: "leni@wanders.example" });
  });

  it("parses a named address with quotes", () => {
    expect(parseAddress('"Leni Wanders" <leni@wanders.example>')).toEqual({
      name: "Leni Wanders",
      email: "leni@wanders.example",
    });
  });

  it("rejects text that is not an address", () => {
    expect(parseAddress("leni")).toBeNull();
    expect(parseAddress("Leni <nope>")).toBeNull();
  });
});

describe("helpers", () => {
  it("builds initials from names and addresses", () => {
    expect(initials({ name: "Noah Zockt", email: "n@z.example" })).toBe("NZ");
    expect(initials({ email: "mia.mood@example.com" })).toBe("MM");
  });

  it("formats sizes", () => {
    expect(formatSize(2048, "en-US")).toBe("2 KB");
    expect(formatSize(1_204_331, "en-US")).toBe("1.1 MB");
  });

  it("picks a stable color", () => {
    expect(colorFor("Leni@Wanders.example")).toBe(colorFor("leni@wanders.example"));
  });

  it("escapes text before turning it into HTML", () => {
    expect(textToHtml("a <b>\nc\n\nd")).toBe("<p>a &lt;b&gt;<br>c</p><p>d</p>");
  });
});

describe("names from mail", () => {
  it("drops characters that would turn the address next to them around", () => {
    const address = { name: "Support ‮moc.", email: "support@shop.example" };
    expect(displayName(address)).toBe("Support moc.");
    expect(formatAddress(address)).toBe("Support moc. <support@shop.example>");
    expect(displayName({ name: "⁧‮", email: "mini@uwumail.test" })).toBe("mini");
    // Right-to-left names themselves stay as they are.
    expect(displayName({ name: "שלום", email: "a@example.org" })).toBe("שלום");
  });
});
