import { describe, expect, it } from "vitest";
import { accountLabel, hasOwnName, sharedMailboxLabel } from "./accountLabel";

describe("account labels", () => {
  it("is the mailbox's own name, else its address", () => {
    expect(accountLabel({ name: "Arbeit", email: "mini@example.com" })).toBe("Arbeit");
    expect(accountLabel({ name: "  ", email: "mini@example.com" })).toBe("mini@example.com");
    expect(hasOwnName({ name: "Mini@Example.com", email: "mini@example.com" })).toBe(false);
  });

  it("names shared mailboxes by their server's name until they get one of their own", () => {
    const shared = { name: "team@example.com", email: "team@example.com", displayName: "Team" };
    expect(sharedMailboxLabel(shared)).toBe("Team");
    expect(sharedMailboxLabel({ ...shared, name: "Support" })).toBe("Support");
    expect(sharedMailboxLabel({ ...shared, displayName: "" })).toBe("team@example.com");
  });
});
