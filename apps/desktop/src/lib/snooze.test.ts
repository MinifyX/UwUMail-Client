import { describe, expect, it } from "vitest";
import type { Folder } from "@/backend/types";
import type { SnoozeEntry } from "@/state/settings";
import { folderBySyncPath, syncFolderPath } from "./arrangement";
import { dueSnoozes, findSnooze, isSnoozedFolder, newSnoozeId, snoozedUntil, snoozePresets, toUtc } from "./snooze";

const entry = (until: string, messageId = "a@example.com", account = "me@example.com"): SnoozeEntry => ({
  account,
  messageId,
  folder: "INBOX",
  until,
});

const folder = (id: string, name: string, parentId: string | null = null, path = id): Folder => ({
  id,
  accountId: "acc",
  name,
  path,
  role: null,
  parentId,
  selectable: true,
  unread: 0,
  total: 0,
});

describe("snooze", () => {
  it("makes ids the settings accept", () => {
    const ids = new Set(Array.from({ length: 50 }, newSnoozeId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it("writes times in UTC to the second", () => {
    expect(toUtc(new Date(Date.UTC(2026, 9, 21, 7, 0, 0, 450)))).toBe("2026-10-21T07:00:00Z");
  });

  it("offers later today, tomorrow, the weekend and next week", () => {
    // Tuesday, 20 October 2026, 10:20 local time.
    const presets = snoozePresets(new Date(2026, 9, 20, 10, 20));
    expect(presets.map((p) => [p.preset, p.at.toString()])).toEqual([
      ["laterToday", new Date(2026, 9, 20, 14, 0).toString()],
      ["tomorrow", new Date(2026, 9, 21, 8, 0).toString()],
      ["weekend", new Date(2026, 9, 24, 9, 0).toString()],
      ["nextWeek", new Date(2026, 9, 26, 8, 0).toString()],
    ]);
  });

  it("leaves out later today in the evening and the weekend on the weekend", () => {
    // Saturday, 24 October 2026, 19:00.
    const presets = snoozePresets(new Date(2026, 9, 24, 19, 0));
    expect(presets.map((p) => p.preset)).toEqual(["tomorrow", "nextWeek"]);
    expect(presets[1]!.at.toString()).toBe(new Date(2026, 9, 26, 8, 0).toString());
    // Sunday: next week is tomorrow.
    const sunday = snoozePresets(new Date(2026, 9, 25, 9, 0));
    expect(sunday.at(-1)!.at.toString()).toBe(new Date(2026, 9, 26, 8, 0).toString());
    // Monday: next week is in seven days.
    const monday = snoozePresets(new Date(2026, 9, 26, 9, 0));
    expect(monday.at(-1)!.at.toString()).toBe(new Date(2026, 10, 2, 8, 0).toString());
  });

  it("finds the due snoozes, oldest first", () => {
    const snoozes = {
      b: entry("2026-10-20T09:00:00Z"),
      a: entry("2026-10-20T08:00:00Z"),
      c: entry("2026-10-21T08:00:00Z"),
    };
    expect(dueSnoozes(snoozes, new Date("2026-10-20T09:00:00Z")).map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("names JMAP folders by their names and IMAP folders by their path", () => {
    const parent = folder("m1", "Projects");
    const child = folder("m2", "Snoozed", "m1");
    const folders = [parent, child];
    expect(syncFolderPath(child, folders, "jmap")).toBe("Projects/Snoozed");
    expect(syncFolderPath(folder("x", "Snoozed", null, "INBOX.Snoozed"), folders, "imap")).toBe("INBOX.Snoozed");
    expect(folderBySyncPath("Projects/Snoozed", "acc", folders, "jmap")).toBe(child);
    expect(folderBySyncPath("Projects/Other", "acc", folders, "jmap")).toBeUndefined();
    expect(isSnoozedFolder(child)).toBe(true);
    expect(isSnoozedFolder({ name: "Snoozed", role: "archive" })).toBe(false);
  });

  it("labels each row with its earliest snooze of this mailbox", () => {
    const snoozes = {
      one: entry("2026-10-22T08:00:00Z", "a@example.com"),
      two: entry("2026-10-21T08:00:00Z", "b@example.com"),
      other: entry("2026-10-20T08:00:00Z", "a@example.com", "else@example.org"),
    };
    const rows = snoozedUntil(snoozes, "me@example.com", [
      ["t1", "a@example.com"],
      ["t1", "b@example.com"],
      ["t2", "c@example.com"],
    ]);
    expect([...rows]).toEqual([["t1", "2026-10-21T08:00:00Z"]]);
    expect(findSnooze(snoozes, "me@example.com", "a@example.com")?.[0]).toBe("one");
  });
});
