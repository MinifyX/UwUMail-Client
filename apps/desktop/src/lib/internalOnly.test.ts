import { describe, expect, it } from "vitest";
import { domainOf, isInternal, undeliverableRecipients } from "./internalOnly";

describe("domainOf", () => {
  it("reads the domain in lower case, also with a subaddress or a name", () => {
    expect(domainOf("mini@Example.COM")).toBe("example.com");
    expect(domainOf("mini+news@a.test")).toBe("a.test");
    expect(domainOf("Mini <mini@a.test.>")).toBe("a.test");
    expect(domainOf('"at@home"@b.example')).toBe("b.example");
  });

  it("finds none in what isn't an address", () => {
    expect(domainOf("nobody")).toBeNull();
    expect(domainOf("@a.test")).toBeNull();
    expect(domainOf("mini@")).toBeNull();
  });
});

describe("isInternal", () => {
  const domains = ["a.test", "example.org"];

  it("compares whole domains, ignoring case", () => {
    expect(isInternal("Kim@A.TEST", domains)).toBe(true);
    expect(isInternal("kim+team@example.org", domains)).toBe(true);
    expect(isInternal("kim@example.com", domains)).toBe(false);
    expect(isInternal("kim@sub.a.test", domains)).toBe(false);
    expect(isInternal("kim@a.test.example", domains)).toBe(false);
  });

  it("lets nothing through when the server names no domains", () => {
    expect(isInternal("kim@a.test", [])).toBe(false);
  });

  it("treats the Unicode form of a punycode domain as internal", () => {
    expect(isInternal("kim@bücher.example", ["xn--bcher-kva.example"])).toBe(true);
    expect(isInternal("kim@BÜCHER.example", ["xn--bcher-kva.example"])).toBe(true);
    expect(isInternal("kim@xn--bcher-kva.example", ["xn--bcher-kva.example"])).toBe(true);
    expect(isInternal("kim@bucher.example", ["xn--bcher-kva.example"])).toBe(false);
  });

  it("never lets URL syntax turn a foreign domain into a hosted one", () => {
    for (const bad of ["a.test/x", "a.test:25", "a.test?x", "a.test#x", "a.test\\x", "a.test%2f"]) {
      expect(isInternal(`kim@${bad}`, ["a.test"])).toBe(false);
    }
  });
});

describe("undeliverableRecipients", () => {
  it("names each outside recipient once", () => {
    const recipients = [
      { email: "mini@a.test" },
      { name: "Kim", email: "kim@example.com" },
      { email: "KIM@example.com" },
      { email: "sam@example.net" },
    ];
    expect(undeliverableRecipients(recipients, ["a.test"])).toEqual([
      { name: "Kim", email: "kim@example.com" },
      { email: "sam@example.net" },
    ]);
  });

  it("blocks nothing when the list is empty (unknown)", () => {
    expect(undeliverableRecipients([{ email: "kim@example.com" }], [])).toEqual([]);
  });

  it("finds none for a mailbox that may send anywhere", () => {
    expect(undeliverableRecipients([{ email: "kim@example.com" }], null)).toEqual([]);
  });
});
