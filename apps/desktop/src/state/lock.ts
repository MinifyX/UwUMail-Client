import { create } from "zustand";
import { mobile, nativeMobile } from "@/backend/mobile";
import { useSettings } from "./settings";

interface LockState {
  /** The app lock covers UwUMail. Dialogs stay closed meanwhile: a modal <dialog> would sit above the lock. */
  locked: boolean;
  /** The phone's own unlock screen is up; UwUMail being hidden then isn't "leaving". */
  prompting: boolean;
  /** When UwUMail went into the background, if it is there (or just came back). */
  leftAt: number | null;
  setLocked: (locked: boolean) => void;
}

export const useAppLock = create<LockState>((set) => ({
  // Settings load synchronously from storage, so a locked app starts covered.
  locked: nativeMobile && useSettings.getState().appLock,
  prompting: false,
  leftAt: null,
  setLocked: (locked) => set({ locked }),
}));

/** Whether the lock covers UwUMail right now: it is on, on a phone, and not yet unlocked. */
export function isLocked(): boolean {
  return nativeMobile && useSettings.getState().appLock && useAppLock.getState().locked;
}

/** {@link isLocked}, for components. */
export function useLocked(): boolean {
  const locked = useAppLock((s) => s.locked);
  const appLock = useSettings((s) => s.appLock);
  return nativeMobile && appLock && locked;
}

/**
 * UwUMail went into the background or came back. Answers whether the lock is due: it was away for
 * at least `afterMinutes`. The phone's unlock screen hides UwUMail too; coming back from it doesn't
 * count until the question is answered (see confirmIdentity).
 */
export function noteVisibility(visible: boolean, afterMinutes: number, now = Date.now()): boolean {
  const { leftAt, prompting } = useAppLock.getState();
  if (!visible) {
    if (leftAt === null) useAppLock.setState({ leftAt: now });
    return false;
  }
  if (prompting) return false;
  useAppLock.setState({ leftAt: null });
  return leftAt !== null && now - leftAt >= afterMinutes * 60_000;
}

/**
 * A question answered after this long was left open: someone went away from UwUMail while it was
 * up and came back later, rather than looking at the phone's unlock screen.
 */
const LEFT_OPEN_MS = 60_000;

/** Asks for fingerprint, face or the phone's PIN. Resolves to false when cancelled. */
export async function confirmIdentity(
  reason: string,
  title: string,
  isVisible: () => boolean = () => document.visibilityState === "visible",
): Promise<boolean> {
  useAppLock.setState({ prompting: true });
  let ok = false;
  try {
    ok = await mobile.unlock(reason, title);
    return ok;
  } finally {
    const { leftAt } = useAppLock.getState();
    if (!isVisible()) {
      // Still in the background: the question went away because someone left during it. That
      // time counts; the lock decides when UwUMail comes back (noteVisibility).
      useAppLock.setState({ prompting: false });
    } else {
      // Back in UwUMail: the time behind the unlock screen wasn't leaving, unless the question
      // stayed unanswered so long that someone must have left during it.
      useAppLock.setState({ prompting: false, leftAt: null });
      const { appLock, appLockAfter } = useSettings.getState();
      const away = leftAt === null ? 0 : Date.now() - leftAt;
      if (!ok && nativeMobile && appLock && away >= Math.max(appLockAfter * 60_000, LEFT_OPEN_MS)) {
        useAppLock.getState().setLocked(true);
      }
    }
  }
}
