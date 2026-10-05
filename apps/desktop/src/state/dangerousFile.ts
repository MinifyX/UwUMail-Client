import { create } from "zustand";

export type DangerousAction = "open" | "save";

interface DangerousFileState {
  /** The open "really open/save this?" question: the file, and who waits for the answer. */
  pending: { filename: string; action: DangerousAction; answer: (confirmed: boolean) => void } | null;
}

export const useDangerousFile = create<DangerousFileState>()(() => ({ pending: null }));

/**
 * Asks before a file that can run programs is opened or saved, in the browser demo.
 *
 * The app asks in a native dialog from the engine instead (src-tauri `confirm_dangerous`), so
 * nothing in the page can skip that question; the demo has no engine, so it asks here, like the
 * webmail does.
 */
export function confirmDangerousFile(filename: string, action: DangerousAction): Promise<boolean> {
  return new Promise((resolve) => {
    // A question still open counts as "no"; only the newest one is on screen.
    useDangerousFile.getState().pending?.answer(false);
    useDangerousFile.setState({ pending: { filename, action, answer: resolve } });
  });
}

export function answerDangerousFile(confirmed: boolean) {
  const { pending } = useDangerousFile.getState();
  if (!pending) return;
  useDangerousFile.setState({ pending: null });
  pending.answer(confirmed);
}
