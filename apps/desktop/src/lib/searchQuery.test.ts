import { describe, expect, it } from "vitest";
import { matchesSearch, parseSearch, withSearchTerm } from "./searchQuery";

describe("search operators", () => {
  it("reads operators, phrases and free text like the engine", () => {
    expect(
      parseSearch(
        'Leni from:shop@example.com TO:noah subject:"big news" "two words" has:attachment is:unread is:starred after:2026-10-01 before:2026-10-31',
      ),
    ).toEqual({
      words: ["Leni", "two words"],
      from: ["shop@example.com"],
      to: ["noah"],
      subject: ["big news"],
      hasAttachment: true,
      unread: true,
      flagged: true,
      before: "2026-10-31",
      after: "2026-10-01",
    });
  });

  it("keeps unknown or broken operators as text", () => {
    expect(parseSearch("foo:bar before:someday after:2026-02-30 is:big from: has:cats").words).toEqual([
      "foo:bar",
      "before:someday",
      "after:2026-02-30",
      "is:big",
      "from:",
      "has:cats",
    ]);
  });

  it("matches mail by local days", () => {
    const mail = {
      subject: "Big news",
      from: "Shop <shop@example.com>",
      to: "noah@example.com",
      body: "two words here",
      date: new Date(2026, 9, 10, 23, 30).toISOString(),
      seen: false,
      flagged: false,
      attachments: 0,
    };
    expect(matchesSearch(mail, parseSearch('from:shop "two words" after:2026-10-10 before:2026-10-11'))).toBe(true);
    expect(matchesSearch(mail, parseSearch("after:2026-10-11"))).toBe(false);
    expect(matchesSearch(mail, parseSearch("has:attachment"))).toBe(false);
    expect(matchesSearch(mail, parseSearch("is:flagged"))).toBe(false);
    expect(matchesSearch(mail, parseSearch("is:unread subject:big"))).toBe(true);
  });

  it("adds a term at the end", () => {
    expect(withSearchTerm("", "is:unread")).toBe("is:unread");
    expect(withSearchTerm("leni  ", "is:unread")).toBe("leni is:unread");
  });
});
