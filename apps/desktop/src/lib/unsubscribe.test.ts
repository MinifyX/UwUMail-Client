import { describe, expect, it } from "vitest";
import { unsubscribeFallback, unsubscribeMail } from "./unsubscribe";

describe("unsubscribeMail", () => {
  it("takes the address and a subject list managers can match on", () => {
    expect(unsubscribeMail("mailto:leave@list.example")).toEqual({
      address: "leave@list.example",
      subject: "unsubscribe",
    });
    expect(unsubscribeMail("mailto:leave@list.example?subject=unsubscribe%20a1b2")).toEqual({
      address: "leave@list.example",
      subject: "unsubscribe a1b2",
    });
  });

  it("never carries text somebody else wrote", () => {
    const target = unsubscribeMail("mailto:leave@list.example?subject=bye&body=I%20quit%2C%20and%20here%20is%20why");
    expect(target).toEqual({ address: "leave@list.example", subject: "bye" });
    expect(JSON.stringify(target)).not.toContain("quit");
  });

  it("keeps a subject to one line and a sensible length", () => {
    expect(unsubscribeMail("mailto:leave@list.example?subject=one%0D%0Atwo")?.subject).toBe("one two");
    expect(unsubscribeMail(`mailto:leave@list.example?subject=${"x".repeat(500)}`)?.subject).toHaveLength(200);
    expect(unsubscribeMail("mailto:leave@list.example?subject=%20%20")?.subject).toBe("unsubscribe");
  });

  it("refuses anything that is not one plain address", () => {
    // A second recipient smuggled into the header.
    expect(unsubscribeMail("mailto:leave@list.example,boss@work.example")).toBeNull();
    // A line break, which would become a header of its own further down the line.
    expect(unsubscribeMail("mailto:leave@list.example%0D%0Abcc:boss@work.example")).toBeNull();
    expect(unsubscribeMail("mailto:Name%20%3Cleave@list.example%3E")).toBeNull();
    expect(unsubscribeMail("mailto:not-an-address")).toBeNull();
    expect(unsubscribeMail("mailto:")).toBeNull();
  });

  it("refuses an address that would read as another one (W-30)", () => {
    // A right-to-left override turns what follows around; a zero-width space or joiner hides.
    expect(unsubscribeMail("mailto:leave%E2%80%AEelpmaxe.knab@list.example")).toBeNull();
    expect(unsubscribeMail("mailto:le%E2%80%8Bave@list.example")).toBeNull();
    expect(unsubscribeMail("mailto:leave@list%E2%80%8D.example")).toBeNull();
    expect(unsubscribeMail("mailto:leave%C2%AD@list.example")).toBeNull();
    expect(unsubscribeMail("mailto:leave%00@list.example")).toBeNull();
  });

  it("refuses a scheme that is not mailto", () => {
    expect(unsubscribeMail("https://list.example/leave")).toBeNull();
    expect(unsubscribeMail("javascript:alert(1)")).toBeNull();
    expect(unsubscribeMail("not a url at all")).toBeNull();
  });

  it("refuses an address that would read as another one (W-30)", () => {
    // A right-to-left override turns what follows around; a zero-width space or joiner hides.
    expect(unsubscribeMail("mailto:leave%E2%80%AEelpmaxe.knab@list.example")).toBeNull();
    expect(unsubscribeMail("mailto:le%E2%80%8Bave@list.example")).toBeNull();
    expect(unsubscribeMail("mailto:leave@list%E2%80%8D.example")).toBeNull();
    expect(unsubscribeMail("mailto:leave%C2%AD@list.example")).toBeNull();
    expect(unsubscribeMail("mailto:leave%00@list.example")).toBeNull();
  });
});

describe("unsubscribeFallback", () => {
  it("offers the mail first, then the page, and nothing for an address that would never be used", () => {
    const page = "https://list.example/u";
    expect(unsubscribeFallback({ oneClick: true, url: page, mailto: "mailto:leave@list.example" })).toBe("mail");
    expect(unsubscribeFallback({ oneClick: true, url: page, mailto: "mailto:le%E2%80%8Bave@list.example" })).toBe(
      "page",
    );
    expect(unsubscribeFallback({ oneClick: true, mailto: "mailto:a@b,c@list.example" })).toBeNull();
    expect(unsubscribeFallback({ oneClick: true })).toBeNull();
  });
});
