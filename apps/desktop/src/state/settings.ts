import { create } from "zustand";
import { persist } from "zustand/middleware";

export type LayoutMode = "simple" | "pro";
export type Tone = "playful" | "neutral";
export type ThemeSetting = "system" | "light" | "dark";
export type LanguageSetting = "system" | "de" | "en";
export type RemoteImages = "ask" | "always";

export interface Settings {
  onboarded: boolean;
  layout: LayoutMode;
  tone: Tone;
  theme: ThemeSetting;
  language: LanguageSetting;
  conversations: boolean;
  remoteImages: RemoteImages;
  /** Senders whose remote images are always allowed. */
  trustedSenders: string[];
}

interface SettingsActions {
  update: (patch: Partial<Settings>) => void;
  trustSender: (email: string) => void;
}

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  layout: "simple",
  tone: "playful",
  theme: "system",
  language: "system",
  conversations: true,
  remoteImages: "ask",
  trustedSenders: [],
};

export const useSettings = create<Settings & SettingsActions>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      update: (patch) => set(patch),
      trustSender: (email) =>
        set((state) => ({
          trustedSenders: [...new Set([...state.trustedSenders, email.toLowerCase()])],
        })),
    }),
    { name: "uwumail.settings", version: 1 },
  ),
);
