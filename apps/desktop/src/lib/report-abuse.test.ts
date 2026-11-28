import { describe, expect, it } from "vitest";
import { abuseDestinations } from "./report-abuse";

describe("abuseDestinations", () => {
  it("takes both an HTTPS page and a single complaint address", () => {
    expect(
      abuseDestinations({
        url: "https://www.postshiba.com/abuse/abc?m=90ef",
        address: "abuse@postshiba.com",
      }),
    ).toEqual([
      { kind: "url", value: "https://www.postshiba.com/abuse/abc?m=90ef" },
      { kind: "mail", value: "abuse@postshiba.com" },
    ]);
  });

  it("keeps each destination verbatim for the confirmation dialog", () => {
    const url = "https://esp.example/abuse/a?m=1&x=2";
    expect(abuseDestinations({ url })).toEqual([{ kind: "url", value: url }]);
  });

  it("never offers a non-HTTPS URL or one with embedded credentials", () => {
    expect(abuseDestinations({ url: "http://esp.example/abuse" })).toEqual([]);
    expect(abuseDestinations({ url: "javascript:alert(1)" })).toEqual([]);
    expect(abuseDestinations({ url: "https://user:pass@esp.example/abuse" })).toEqual([]);
    expect(abuseDestinations({ url: "not a url" })).toEqual([]);
  });

  it("only accepts one plain address, with no display name or separators", () => {
    expect(abuseDestinations({ address: "abuse@postshiba.com" })).toEqual([
      { kind: "mail", value: "abuse@postshiba.com" },
    ]);
    expect(abuseDestinations({ address: "a@b.com,c@d.com" })).toEqual([]);
    expect(abuseDestinations({ address: "Name <abuse@postshiba.com>" })).toEqual([]);
    expect(abuseDestinations({ address: "abuse@postshiba.com; other@x.com" })).toEqual([]);
    expect(abuseDestinations({ address: "not-an-address" })).toEqual([]);
  });

  it("returns nothing when the mail offers no complaint destination", () => {
    expect(abuseDestinations(undefined)).toEqual([]);
    expect(abuseDestinations({})).toEqual([]);
  });
});
