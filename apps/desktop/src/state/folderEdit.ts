import { create } from "zustand";
import type { Folder } from "@/backend/types";

/** What the folder dialog is open for. */
export type FolderRequest =
  | { kind: "create"; accountId: string; parent: Folder | null }
  | { kind: "rename"; folder: Folder }
  | { kind: "delete"; folder: Folder }
  | { kind: "empty"; folder: Folder };

interface FolderEditState {
  request: FolderRequest | null;
  open: (request: FolderRequest) => void;
  close: () => void;
}

export const useFolderEdit = create<FolderEditState>()((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

/** Only trash and junk can be emptied. */
export function canEmpty(folder: Pick<Folder, "role">): boolean {
  return folder.role === "trash" || folder.role === "junk";
}
