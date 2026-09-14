import type { Folder } from "@/backend/types";

export interface FolderNode {
  folder: Folder;
  depth: number;
  children: FolderNode[];
  /** Unread mail in this folder and everything below it, for collapsed folders. */
  unreadInside: number;
}

// System folders first, custom folders in the middle, spam and trash last.
const TOP = ["inbox", "drafts", "sent", "archive"];
const BOTTOM = ["junk", "trash"];

function rank(folder: Folder) {
  if (folder.role && TOP.includes(folder.role)) return TOP.indexOf(folder.role);
  if (folder.role && BOTTOM.includes(folder.role)) return 100 + BOTTOM.indexOf(folder.role);
  return 50;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Only the inbox and custom folders count unread mail; nobody wants a badge on Trash. */
export function countsUnread(folder: Folder) {
  return folder.role === "inbox" || folder.role === null;
}

export function buildFolderTree(folders: Folder[]): FolderNode[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const children = new Map<string | null, Folder[]>();
  for (const folder of folders) {
    const parent = folder.parentId && byId.has(folder.parentId) ? folder.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(folder);
    children.set(parent, list);
  }

  const build = (parentId: string | null, depth: number, seen: Set<string>): FolderNode[] =>
    (children.get(parentId) ?? [])
      .filter((folder) => !seen.has(folder.id))
      .sort((a, b) => rank(a) - rank(b) || collator.compare(a.name, b.name))
      .map((folder) => {
        const nested = build(folder.id, depth + 1, new Set(seen).add(folder.id));
        const own = countsUnread(folder) ? folder.unread : 0;
        return {
          folder,
          depth,
          children: nested,
          unreadInside: own + nested.reduce((sum, child) => sum + child.unreadInside, 0),
        };
      })
      // A container without folders inside (like Gmail's "[Gmail]") is just noise.
      .filter((node) => node.folder.selectable || node.children.length > 0);

  return build(null, 0, new Set());
}
