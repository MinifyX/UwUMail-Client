import type { Folder } from "@/backend/types";

/** "Projects/UwUMail/Bugs" from the folders' own (translated) names, the way the sidebar shows them. */
export function folderDisplayPath(folder: Folder, folders: Folder[], label: (folder: Folder) => string): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  let current: Folder | undefined = folder;
  // Guarded against a cycle a broken server could hand us.
  for (let depth = 0; current && depth < 64; depth += 1) {
    parts.unshift(label(current));
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return parts.join("/");
}
