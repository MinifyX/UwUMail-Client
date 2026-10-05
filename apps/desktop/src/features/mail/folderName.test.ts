import { describe, expect, it } from "vitest";
import type { Folder } from "@/backend/types";
import { folderNameProblem, folderNameRules } from "./folderName";

const JMAP = { separator: "/", imap: false };
const IMAP_DOT = { separator: ".", imap: true };

const folder = (id: string, path: string, parentId: string | null = null): Folder => ({
  id,
  accountId: "a1",
  name: path.split(/[./]/).pop()!,
  path,
  role: null,
  parentId,
  selectable: true,
  unread: 0,
  total: 0,
});

describe("folderNameProblem", () => {
  it("accepts an ordinary name, also with umlauts and spaces around it", () => {
    expect(folderNameProblem("  Rechnungen 2026 ", [], JMAP)).toBeNull();
    expect(folderNameProblem("Grüße", ["Kunden"], IMAP_DOT)).toBeNull();
    // A "/" is fine where the server separates levels with ".".
    expect(folderNameProblem("Ein/Aus", [], IMAP_DOT)).toBeNull();
  });

  it("names what's wrong", () => {
    expect(folderNameProblem("   ", [], JMAP)).toEqual({ kind: "empty" });
    expect(folderNameProblem("Work/Boss", [], JMAP)).toEqual({ kind: "slash" });
    expect(folderNameProblem("v1.2", [], IMAP_DOT)).toEqual({ kind: "character", character: "." });
    expect(folderNameProblem("50%", [], IMAP_DOT)).toEqual({ kind: "character", character: "%" });
    expect(folderNameProblem("50%", [], JMAP)).toBeNull();
    expect(folderNameProblem("Tab\there", [], JMAP)).toEqual({ kind: "control" });
    expect(folderNameProblem(`Line${String.fromCharCode(0x2028)}break`, [], JMAP)).toEqual({ kind: "control" });
    expect(folderNameProblem("..", [], { separator: "/", imap: true })).toEqual({ kind: "dots" });
    expect(folderNameProblem("kunden", ["Kunden"], JMAP)).toEqual({ kind: "taken" });
  });

  it("counts characters and bytes like the engine", () => {
    expect(folderNameProblem("a".repeat(200), [], JMAP)).toBeNull();
    expect(folderNameProblem("a".repeat(201), [], JMAP)).toEqual({ kind: "tooLong" });
    // Two bytes each in UTF-8; four for the emoji, which still counts as one character.
    expect(folderNameProblem("ü".repeat(128), [], JMAP)).toEqual({ kind: "tooLong" });
    expect(folderNameProblem("🐱".repeat(60), [], JMAP)).toBeNull();
    expect(folderNameProblem("🐱".repeat(64), [], JMAP)).toEqual({ kind: "tooLong" });
  });
});

describe("folderNameRules", () => {
  it("knows UwUMail's separator and reads an IMAP server's from a nested folder", () => {
    expect(folderNameRules("jmap", [])).toEqual(JMAP);
    expect(folderNameRules("imap", [folder("i", "INBOX"), folder("k", "INBOX.Kunden", "i")])).toEqual(IMAP_DOT);
    expect(folderNameRules("imap", [folder("w", "Work"), folder("b", "Work/Boss", "w")])).toEqual({
      separator: "/",
      imap: true,
    });
    expect(folderNameRules("imap", [folder("i", "INBOX")])).toEqual({ separator: null, imap: true });
  });
});
