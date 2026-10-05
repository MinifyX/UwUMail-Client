import { describe, expect, it } from "vitest";
import { isTeamsMeetingLink, isTnefAttachment, teamsMeetingLink } from "./outlook";

describe("isTnefAttachment", () => {
  it("knows Outlook's winmail.dat by type or name", () => {
    expect(isTnefAttachment({ filename: "winmail.dat", mimeType: "application/octet-stream" })).toBe(true);
    expect(isTnefAttachment({ filename: "WINMAIL.DAT", mimeType: "application/ms-tnef" })).toBe(true);
    expect(isTnefAttachment({ filename: "attachment", mimeType: "application/vnd.ms-tnef; name=x" })).toBe(true);
    expect(isTnefAttachment({ filename: "report.pdf", mimeType: "application/pdf" })).toBe(false);
  });
});

describe("Teams meeting links", () => {
  it("recognises join links only", () => {
    expect(
      isTeamsMeetingLink("https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d"),
    ).toBe(true);
    expect(isTeamsMeetingLink("https://teams.microsoft.com/meet/1234567?p=abc")).toBe(true);
    expect(isTeamsMeetingLink("https://teams.live.com/meet/9876?p=xyz")).toBe(true);
    expect(isTeamsMeetingLink("https://teams.microsoft.com/l/chat/0/0")).toBe(false);
    expect(isTeamsMeetingLink("http://teams.microsoft.com/l/meetup-join/x")).toBe(false);
    expect(isTeamsMeetingLink("https://teams.microsoft.com.evil.example/l/meetup-join/x")).toBe(false);
  });

  it("finds the first join link in the reader's markup", () => {
    const html =
      '<p><a href="https://shop.example/">Shop</a> <a href="https://teams.microsoft.com/l/meetup-join/abc?context=%7b%7d&amp;x=1">Join the meeting now</a></p>';
    expect(teamsMeetingLink(html)).toBe("https://teams.microsoft.com/l/meetup-join/abc?context=%7b%7d&x=1");
    expect(teamsMeetingLink('<a href="https://shop.example/">x</a>')).toBeNull();
  });
});
