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

  it("finds none for a mailbox that may send anywhere", () => {
    expect(undeliverableRecipients([{ email: "kim@example.com" }], null)).toEqual([]);
  });
});
