import { describe, expect, it } from "vitest";
import { unsubscribeMail } from "./unsubscribe";

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

  it("refuses a scheme that is not mailto", () => {
    expect(unsubscribeMail("https://list.example/leave")).toBeNull();
    expect(unsubscribeMail("javascript:alert(1)")).toBeNull();
    expect(unsubscribeMail("not a url at all")).toBeNull();
  });
});
