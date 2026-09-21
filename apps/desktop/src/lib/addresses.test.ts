import { describe, expect, it } from "vitest";
import { addressRows, fullAddress } from "./addresses";

const leni = { name: "Leni Wanders", email: "leni@wanders.example" };
const mia = { name: "Mia", email: "mia@mood.example" };

describe("addressRows", () => {
  it("lists From, To and only the lines a mail has", () => {
    const rows = addressRows({ from: leni, replyTo: [], to: [mia], cc: [], bcc: [] });
    expect(rows.map((row) => row.role)).toEqual(["from", "to"]);
  });

  it("shows Reply-To only when it goes somewhere else", () => {
    expect(addressRows({ from: leni, replyTo: [{ email: "LENI@wanders.example" }], to: [mia], cc: [] })).toHaveLength(
      2,
    );
    const rows = addressRows({ from: leni, replyTo: [{ email: "help@wanders.example" }], to: [mia], cc: [mia] });
    expect(rows.map((row) => row.role)).toEqual(["from", "replyTo", "to", "cc"]);
  });

  it("includes Bcc when known, and copes with older messages without it", () => {
    const rows = addressRows({ from: leni, replyTo: [], to: [mia], cc: [], bcc: [{ email: "noah@zockt.example" }] });
    expect(rows.at(-1)).toEqual({ role: "bcc", addresses: [{ email: "noah@zockt.example" }] });
    expect(addressRows({ from: leni, replyTo: [], to: [], cc: [] }).map((row) => row.role)).toEqual(["from"]);
  });
});

describe("fullAddress", () => {
  it("writes name and address", () => {
    expect(fullAddress(leni)).toBe("Leni Wanders <leni@wanders.example>");
    expect(fullAddress({ email: "a@b.example" })).toBe("a@b.example");
    expect(fullAddress({ name: " a@b.example ", email: "a@b.example" })).toBe("a@b.example");
  });

  it("shows direction tricks in a display name instead of obeying them", () => {
    const rlo = String.fromCodePoint(0x202e);
    expect(fullAddress({ name: `Bank${rlo}gnp.exe`, email: "x@evil.example" })).toBe(
      "Bank<U+202E>gnp.exe <x@evil.example>",
    );
  });
});
