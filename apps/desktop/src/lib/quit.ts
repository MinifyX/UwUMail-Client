/**
 * What has to be written before UwUMail ends: the open draft, settings waiting to sync. Whoever
 * holds such state registers here; `flushBeforeQuit` runs them all when the app is about to quit
 * (on macOS through `onMacQuit`, see features/shell/useMacShell.ts).
 *
 * The drafts are kept on this device every half second anyway (compose/localDraft.ts), so a quit
 * that comes too fast loses at most the last keystrokes, never the draft.
 */

type Flush = () => unknown;

const flushes = new Set<Flush>();

/** Runs `flush` before the app quits. Returns the function that takes it back. */
export function onQuit(flush: Flush): () => void {
  flushes.add(flush);
  return () => {
    flushes.delete(flush);
  };
}

/**
 * Runs every registered flush and waits for them, but not longer than `patience`: macOS quits
 * after ten seconds on its own (uwu-macos), and a server that does not answer must not hold up a
 * logout. A flush that fails doesn't stop the others or the quit.
 */
export async function flushBeforeQuit(patience = 8000): Promise<void> {
  const all = Promise.allSettled([...flushes].map(async (flush) => flush()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, patience);
  });
  try {
    await Promise.race([all, late]);
  } finally {
    clearTimeout(timer);
  }
}
