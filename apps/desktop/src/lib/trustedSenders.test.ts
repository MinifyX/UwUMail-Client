import { describe, expect, it } from "vitest";
import { domainEntry, matchingEntries, sortEntries } from "./trustedSenders";

describe("trusted senders", () => {
  it("matches one address exactly, ignoring case", () => {
    const trusted = ["orders@shop.example"];
    expect(matchingEntries("Orders@Shop.example", trusted)).toEqual(["orders@shop.example"]);
    expect(matchingEntries("news@shop.example", trusted)).toEqual([]);
  });

  it("matches a company domain with its subdomains", () => {
    const trusted = [domainEntry("Shop.Example")];
    expect(matchingEntries("news@shop.example", trusted)).toEqual(["@shop.example"]);
    expect(matchingEntries("noreply@em.mail.shop.example", trusted)).toEqual(["@shop.example"]);
    expect(matchingEntries("x@badshop.example", trusted)).toEqual([]);
    expect(matchingEntries("x@shop.example.evil", trusted)).toEqual([]);
  });

  it("returns every entry that applies", () => {
    const trusted = ["orders@shop.example", "@shop.example", "leni@wanders.example"];
    expect(matchingEntries("orders@shop.example", trusted)).toEqual(["orders@shop.example", "@shop.example"]);
  });

  it("ignores broken addresses and entries", () => {
    expect(matchingEntries("not an address", ["@"])).toEqual([]);
    expect(matchingEntries("a@shop.example", ["@"])).toEqual([]);
  });

  it("lists domains first, then addresses by domain", () => {
    expect(sortEntries(["leni@wanders.example", "@shop.example", "anna@bakery.example", "@bank.example"])).toEqual([
      "@bank.example",
      "@shop.example",
      "anna@bakery.example",
      "leni@wanders.example",
    ]);
  });
});
