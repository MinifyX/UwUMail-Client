import { describe, expect, it } from "vitest";
import {
  ALL_DOMAINS,
  companyFooterFor,
  domainChange,
  editableHtml,
  editorStart,
  fillPlaceholders,
  replacedByAllDomains,
  toggleTarget,
  tooLarge,
  type DomainSignatureOverview,
} from "./domainSignatures";

const overview = (patch: Partial<DomainSignatureOverview> = {}): DomainSignatureOverview => ({
  state: "1",
  allDomains: null,
  domains: [
    { domain: "example.net", addressCount: 1, signature: { text: "Net", html: "" }, company: null, source: "domain" },
    {
      domain: "example.org",
      addressCount: 2,
      signature: null,
      company: { mode: "footer", text: "Beispiel GmbH", html: "" },
      source: "none",
    },
  ],
  identities: [],
  ...patch,
});

describe("domain signatures", () => {
  it("fill placeholders per address and escape them in HTML", () => {
    expect(fillPlaceholders("{name} · {adresse} · {domain} · {Address} · {x}", "Mini", "mini@example.org", false)).toBe(
      "Mini · mini@example.org · example.org · mini@example.org · {x}",
    );
    expect(fillPlaceholders("<p>{name}</p>", "<script>alert(1)</script>", "a@example.org", true)).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("start the editor with the domain's own, every domain's or the template", () => {
    expect(editorStart(overview(), "example.net")).toMatchObject({ origin: "domain", targets: ["example.net"] });
    expect(editorStart(overview(), "example.org")).toMatchObject({ origin: "empty" });
    expect(editorStart(overview({ allDomains: { text: "A", html: "" } }), "example.org")).toMatchObject({
      origin: "allDomains",
      targets: [ALL_DOMAINS],
    });
  });

  it("apply to several domains or to all, where all replaces the domains' own", () => {
    const signature = { text: "Hi", html: "<p>Hi</p>" };
    expect(domainChange(overview(), ["example.org", "example.net"], signature)).toEqual({
      domains: { "example.org": signature, "example.net": signature },
    });
    expect(domainChange(overview(), [ALL_DOMAINS], signature)).toEqual({
      domains: { [ALL_DOMAINS]: signature, "example.net": null },
    });
    expect(domainChange(overview(), [ALL_DOMAINS], null)).toEqual({ domains: { [ALL_DOMAINS]: null } });
    expect(replacedByAllDomains(overview(), "example.org")).toEqual(["example.net"]);
    expect(toggleTarget(["example.org"], ALL_DOMAINS, true, "example.org")).toEqual([ALL_DOMAINS]);
    expect(toggleTarget([ALL_DOMAINS], "example.net", true, "example.org")).toEqual(["example.net"]);
    expect(toggleTarget(["example.org"], "example.org", false, "example.org")).toEqual(["example.org"]);
  });

  it("know the company footer of the sender's domain, the size limit and text-only signatures", () => {
    expect(companyFooterFor(overview(), "Mini@Example.ORG")?.text).toBe("Beispiel GmbH");
    expect(companyFooterFor(overview(), "mini@example.net")).toBeNull();
    expect(companyFooterFor(null, "mini@example.org")).toBeNull();
    expect(tooLarge({ text: "ü".repeat(4), html: "" }, 7)).toBe(true);
    expect(editableHtml({ text: "A <b>\nB", html: "" })).toBe("<p>A &lt;b&gt;<br>B</p>");
  });
});
