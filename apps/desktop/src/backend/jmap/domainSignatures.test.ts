import { describe, expect, it } from "vitest";
import { overviewFrom } from "./domainSignatures";

describe("SignatureSettings/get", () => {
  it("is read field by field and odd values are dropped", () => {
    const overview = overviewFrom({
      state: "12",
      allDomains: { text: "Alle", html: 5 },
      domains: [
        {
          domain: "example.org",
          addressCount: 2,
          signature: null,
          company: { mode: "footer", text: "F" },
          source: "none",
        },
        { domain: 7 },
        { domain: "example.net", addressCount: "x", company: { mode: "weird" }, source: "nonsense" },
      ],
      identities: [
        {
          id: "i1",
          email: "mini@example.org",
          name: "Mini",
          domain: "example.org",
          signature: { text: "Own" },
          effective: { text: "Own", html: "" },
          source: "identity",
        },
        { id: 2, email: "broken@example.org" },
      ],
    });
    expect(overview.allDomains).toEqual({ text: "Alle", html: "" });
    expect(overview.domains).toEqual([
      {
        domain: "example.org",
        addressCount: 2,
        signature: null,
        company: { mode: "footer", text: "F", html: "" },
        source: "none",
      },
      { domain: "example.net", addressCount: 0, signature: null, company: null, source: "none" },
    ]);
    expect(overview.identities).toHaveLength(1);
    expect(overview.identities[0]!.signature).toEqual({ text: "Own", html: "" });
  });
});
