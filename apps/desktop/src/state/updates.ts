import { create } from "zustand";
import type { UpdateInfo } from "@/backend/types";

interface UpdateState {
  /** A downloaded update waiting for a restart. */
  ready: UpdateInfo | null;
  /** "Later" hides the hint until UwUMail starts again. */
  dismissed: boolean;
  setReady: (update: UpdateInfo | null) => void;
  dismiss: () => void;
}

export const useUpdates = create<UpdateState>()((set) => ({
  ready: null,
  dismissed: false,
  setReady: (ready) => set({ ready }),
  dismiss: () => set({ dismissed: true }),
}));

/** Release notes are JSON with `de` and `en` when written for UwUMail, otherwise plain text. */
export function notesFor(notes: string | null | undefined, language: string): string {
  if (!notes) return "";
  try {
    const parsed = JSON.parse(notes) as Record<string, unknown>;
    const text = parsed[language.startsWith("de") ? "de" : "en"] ?? parsed.en ?? parsed.de;
    if (typeof text === "string") return text;
  } catch {
    // Plain text notes.
  }
  return notes;
}
