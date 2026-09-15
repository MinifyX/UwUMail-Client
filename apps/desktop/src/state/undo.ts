import { backend } from "@/backend/backend";
import type { MovedMessage } from "@/backend/types";
import { translate } from "@/i18n";
import { toast } from "@/state/toasts";

/** How long "z" can still take back the last move. */
const UNDO_WINDOW = 30_000;

let last: { run: () => void; at: number } | null = null;

/** Remembers the newest undo, e.g. for the "z" shortcut. */
export function rememberUndo(run: () => void) {
  last = { run, at: Date.now() };
}

/** Runs the newest undo if it's recent enough. Returns whether there was one. */
export function runLastUndo(): boolean {
  if (!last || Date.now() - last.at > UNDO_WINDOW) return false;
  const { run } = last;
  last = null;
  run();
  return true;
}

/** Puts moved mail back into the folders it came from. */
export async function moveBack(moved: MovedMessage[]) {
  const byFolder = new Map<string, string[]>();
  for (const { id, fromFolderId } of moved) byFolder.set(fromFolderId, [...(byFolder.get(fromFolderId) ?? []), id]);
  for (const [folderId, ids] of byFolder) await backend().moveMessages(ids, folderId);
}

/** Tells that mail moved, with "Undo" in the toast and on "z". `refresh` runs after undoing. */
export function announceMove(moved: MovedMessage[], message: string, refresh: () => unknown) {
  if (moved.length === 0) {
    toast(message, "success");
    return;
  }
  const undo = () => {
    void moveBack(moved)
      .then(() => toast(translate("toast.moveUndone")))
      .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), "error"))
      .finally(() => void refresh());
  };
  rememberUndo(undo);
  toast(message, "success", undefined, { duration: 6000, action: { label: translate("toast.undo"), run: undo } });
}
