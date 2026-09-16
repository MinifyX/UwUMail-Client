import { create } from "zustand";

interface DeleteForeverState {
  /** The open "delete for good?" question: how many messages, and who waits for the answer. */
  pending: { count: number; answer: (confirmed: boolean) => void } | null;
}

export const useDeleteForever = create<DeleteForeverState>()(() => ({ pending: null }));

/** Asks whether `count` messages may go for good. Resolves true only when the person confirms. */
export function confirmDeleteForever(count: number): Promise<boolean> {
  return new Promise((resolve) => {
    // A question still open counts as "no"; only the newest one is on screen.
    useDeleteForever.getState().pending?.answer(false);
    useDeleteForever.setState({ pending: { count, answer: resolve } });
  });
}

export function answerDeleteForever(confirmed: boolean) {
  const { pending } = useDeleteForever.getState();
  if (!pending) return;
  useDeleteForever.setState({ pending: null });
  pending.answer(confirmed);
}
