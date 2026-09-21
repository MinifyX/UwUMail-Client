import { create } from "zustand";
import { mobile, nativeMobile } from "@/backend/mobile";
import { useSettings } from "./settings";

interface LockState {
  /** The app lock covers UwUMail. Dialogs stay closed meanwhile: a modal <dialog> would sit above the lock. */
  locked: boolean;
  /** The phone's own unlock screen is up; UwUMail being hidden then isn't "leaving". */
  prompting: boolean;
  setLocked: (locked: boolean) => void;
}

export const useAppLock = create<LockState>((set) => ({
  // Settings load synchronously from storage, so a locked app starts covered.
  locked: nativeMobile && useSettings.getState().appLock,
  prompting: false,
  setLocked: (locked) => set({ locked }),
}));

/** Asks for fingerprint, face or the phone's PIN. Resolves to false when cancelled. */
export async function confirmIdentity(reason: string, title: string): Promise<boolean> {
  useAppLock.setState({ prompting: true });
  try {
    return await mobile.unlock(reason, title);
  } finally {
    useAppLock.setState({ prompting: false });
  }
}
