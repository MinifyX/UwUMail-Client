import { describe, expect, it } from "vitest";
import type { Folder } from "@/backend/types";
import { buildFolderTree, type FolderNode } from "./folderTree";

function folder(id: string, patch: Partial<Folder> = {}): Folder {
  return {
    id,
    accountId: "a1",
    name: id,
    path: id,
    role: null,
    parentId: null,
    selectable: true,
    unread: 0,
    total: 0,
    ...patch,
  };
}

const outline = (nodes: FolderNode[]): string[] =>
  nodes.flatMap((node) => [`${"  ".repeat(node.depth)}${node.folder.name}`, ...outline(node.children)]);

describe("buildFolderTree", () => {
  it("nests folders and orders system folders around the custom ones", () => {
    const tree = buildFolderTree([
      folder("Trash", { role: "trash" }),
      folder("Projekte"),
      folder("Bugs", { parentId: "UwUMail" }),
      folder("UwUMail", { parentId: "Projekte" }),
      folder("Kunden 10"),
      folder("Kunden 2"),
      folder("Inbox", { role: "inbox" }),
      folder("Sent", { role: "sent" }),
      folder("Spam", { role: "junk" }),
    ]);
    expect(outline(tree)).toEqual([
      "Inbox",
      "Sent",
      "Kunden 2",
      "Kunden 10",
      "Projekte",
      "  UwUMail",
      "    Bugs",
      "Spam",
      "Trash",
    ]);
  });

  it("adds up unread mail of subfolders for collapsed parents", () => {
    const [projekte] = buildFolderTree([
      folder("Projekte", { unread: 1 }),
      folder("UwUMail", { parentId: "Projekte", unread: 2 }),
      folder("Bugs", { parentId: "UwUMail", unread: 3 }),
    ]);
    expect(projekte!.unreadInside).toBe(6);
    expect(projekte!.children[0]!.unreadInside).toBe(5);
  });

  it("hides empty containers but keeps ones with folders inside", () => {
    const tree = buildFolderTree([
      folder("[Gmail]", { selectable: false }),
      folder("Archiv", { selectable: false }),
      folder("2025", { parentId: "Archiv" }),
    ]);
    expect(outline(tree)).toEqual(["Archiv", "  2025"]);
  });

  it("puts folders with a missing parent at the top level", () => {
    expect(outline(buildFolderTree([folder("Orphan", { parentId: "gone" })]))).toEqual(["Orphan"]);
  });
});
