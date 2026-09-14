import { create } from "zustand";
import { persist } from "zustand/middleware";
import pkg from "../../package.json";

export type LayoutMode = "simple" | "pro";
/** Mail list rows: roomy cards with three lines, or two lines with a small picture. */
export type ListDensity = "relaxed" | "compact";
export type Tone = "playful" | "neutral";
export type ThemeSetting = "system" | "light" | "dark";
/** Animations: follow the system's reduced-motion setting, or override it. */
export type MotionSetting = "system" | "on" | "off";
export type LanguageSetting = "system" | "de" | "en";
export type RemoteImages = "ask" | "always";
/** Beta gets pre-releases (tags like v0.2.0-beta.1) before everyone else. */
export type UpdateChannel = "stable" | "beta";
/** How HTML mail looks while the app is dark. */
export type MailAppearance = "auto" | "light" | "dark";

export interface Settings {
  onboarded: boolean;
  layout: LayoutMode;
  listDensity: ListDensity;
  tone: Tone;
  theme: ThemeSetting;
  motion: MotionSetting;
  language: LanguageSetting;
  conversations: boolean;
  remoteImages: RemoteImages;
  /** Addresses and `@domains` whose remote images are always allowed, see lib/trustedSenders. */
  trustedSenders: string[];
  mailAppearance: MailAppearance;
  /** Light/dark choices remembered per sender address (lowercase). */
  senderAppearance: Record<string, "light" | "dark">;
  /** Folder ids whose subfolders are hidden in the sidebar. */
  collapsedFolders: string[];
  /** Brand logos and website icons for company senders. */
  senderPictures: boolean;
  /** Closing the window keeps UwUMail running in the tray. */
  runInBackground: boolean;
  updateChannel: UpdateChannel;
}

interface SettingsActions {
  update: (patch: Partial<Settings>) => void;
  /** An address or an `@domain`. */
  trustSender: (entry: string) => void;
  untrustSenders: (entries: string[]) => void;
  rememberAppearance: (email: string, appearance: "light" | "dark") => void;
  forgetAppearances: () => void;
  toggleFolder: (folderId: string) => void;
}

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  layout: "simple",
  listDensity: "relaxed",
  tone: "playful",
  theme: "system",
  motion: "system",
  language: "system",
  conversations: true,
  remoteImages: "ask",
  trustedSenders: [],
  mailAppearance: "auto",
  senderAppearance: {},
  collapsedFolders: [],
  senderPictures: true,
  runInBackground: true,
  // Someone who installed a beta wants the next beta too.
  updateChannel: pkg.version.includes("-") ? "beta" : "stable",
};

export const useSettings = create<Settings & SettingsActions>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      update: (patch) => set(patch),
      trustSender: (entry) =>
        set((state) => ({
          trustedSenders: [...new Set([...state.trustedSenders, entry.toLowerCase()])],
        })),
      untrustSenders: (entries) =>
        set((state) => ({ trustedSenders: state.trustedSenders.filter((entry) => !entries.includes(entry)) })),
      rememberAppearance: (email, appearance) =>
        set((state) => ({ senderAppearance: { ...state.senderAppearance, [email.toLowerCase()]: appearance } })),
      forgetAppearances: () => set({ senderAppearance: {} }),
      toggleFolder: (folderId) =>
        set((state) => ({
          collapsedFolders: state.collapsedFolders.includes(folderId)
            ? state.collapsedFolders.filter((id) => id !== folderId)
            : [...state.collapsedFolders, folderId],
        })),
    }),
    { name: "uwumail.settings", version: 1 },
  ),
);
