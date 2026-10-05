import { describe, expect, it } from "vitest";
import { colorFor, formatListDate, formatSize, initials, isEmail, parseAddress, textToHtml } from "./format";

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

describe("isEmail", () => {
  it("wants one @ and a dot inside the domain, and no white space", () => {
    expect(isEmail(" leni@wanders.example ")).toBe(true);
    expect(isEmail("a@b.c")).toBe(true);
    expect(isEmail("a@b..c")).toBe(true);
    expect(isEmail("a@.bc")).toBe(false);
    expect(isEmail("a@bc.")).toBe(false);
    expect(isEmail("a@bc")).toBe(false);
    expect(isEmail("@b.c")).toBe(false);
    expect(isEmail("a@b@c.d")).toBe(false);
    expect(isEmail("le ni@wanders.example")).toBe(false);
    expect(isEmail("leni@wanders\n.example")).toBe(false);
  });

  // Regression (webmail security audit WEBMAIL-1): a domain of nothing but dots, as in a crafted
  // List-Unsubscribe header, took quadratic time in the old pattern.
  it("stays fast on a long run of dots", () => {
    const started = performance.now();
    expect(isEmail(`a@${".".repeat(200_000)}@`)).toBe(false);
    expect(isEmail(`a@${".".repeat(200_000)} `)).toBe(true);
    expect(isEmail(`a@${".".repeat(200_000)}x!`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
