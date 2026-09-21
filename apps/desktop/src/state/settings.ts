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
/** Seconds a sent mail waits so it can still be taken back; 0 sends right away. */
export const UNDO_SEND_CHOICES = [0, 5, 10, 20, 30] as const;
export type UndoSendSeconds = (typeof UNDO_SEND_CHOICES)[number];
/** What swiping a mail in the phone list does. */
export type SwipeAction = "read" | "archive" | "spam" | "trash" | "flag" | "none";
/** Minutes in the background before the app lock asks again; 0 locks right away. */
export type LockAfter = 0 | 1 | 5 | 15;
/** Android: days of mail kept complete on the phone; 0 keeps everything. */
export type OfflineDays = 30 | 90 | 365 | 0;
/** Mailboxes shown apart, see lib/workspaces. */
export type Workspace = "private" | "business";

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
  /** Ask before a link from a mail opens. Disguised links ask anyway. */
  linkConfirm: boolean;
  /** Registrable domains (lower-case, punycode) whose links open without asking, see lib/links. */
  linkDomains: string[];
  /** The message header shows every address in full. Kept on this device only. */
  showAddressDetails: boolean;
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
  undoSendSeconds: UndoSendSeconds;
  /** Phone list: swiping right and left. */
  swipeRight: SwipeAction;
  swipeLeft: SwipeAction;
  /** Android: ask for fingerprint, face or PIN when UwUMail opens. */
  appLock: boolean;
  appLockAfter: LockAfter;
  offlineDays: OfflineDays;
  /** Private and business mailboxes shown apart, one workspace at a time. */
  workspaces: boolean;
  activeWorkspace: Workspace;
  /** Own names for the workspaces; empty keeps "Private" and "Business". */
  workspaceNames: Record<Workspace, string>;
  /** Mailboxes in the business workspace; all others are private. Kept while the feature is off. */
  businessAccounts: string[];
}

interface SettingsActions {
  update: (patch: Partial<Settings>) => void;
  /** An address or an `@domain`. */
  trustSender: (entry: string) => void;
  untrustSenders: (entries: string[]) => void;
  rememberLinkDomain: (domain: string) => void;
  forgetLinkDomains: (domains: string[]) => void;
  rememberAppearance: (email: string, appearance: "light" | "dark") => void;
  forgetAppearances: () => void;
  toggleFolder: (folderId: string) => void;
  setAccountWorkspace: (accountId: string, workspace: Workspace) => void;
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
  linkConfirm: true,
  linkDomains: [],
  showAddressDetails: false,
  mailAppearance: "auto",
  senderAppearance: {},
  collapsedFolders: [],
  senderPictures: true,
  runInBackground: true,
  // Someone who installed a beta wants the next beta too.
  updateChannel: pkg.version.includes("-") ? "beta" : "stable",
  undoSendSeconds: 10,
  swipeRight: "read",
  swipeLeft: "archive",
  appLock: false,
  appLockAfter: 5,
  offlineDays: 90,
  workspaces: false,
  activeWorkspace: "private",
  workspaceNames: { private: "", business: "" },
  businessAccounts: [],
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
      rememberLinkDomain: (domain) =>
        set((state) => ({ linkDomains: [...new Set([...state.linkDomains, domain.toLowerCase()])] })),
      forgetLinkDomains: (domains) =>
        set((state) => ({ linkDomains: state.linkDomains.filter((domain) => !domains.includes(domain)) })),
      rememberAppearance: (email, appearance) =>
        set((state) => ({ senderAppearance: { ...state.senderAppearance, [email.toLowerCase()]: appearance } })),
      forgetAppearances: () => set({ senderAppearance: {} }),
      toggleFolder: (folderId) =>
        set((state) => ({
          collapsedFolders: state.collapsedFolders.includes(folderId)
            ? state.collapsedFolders.filter((id) => id !== folderId)
            : [...state.collapsedFolders, folderId],
        })),
      setAccountWorkspace: (accountId, workspace) =>
        set((state) => {
          const others = state.businessAccounts.filter((id) => id !== accountId);
          return { businessAccounts: workspace === "business" ? [...others, accountId] : others };
        }),
    }),
    { name: "uwumail.settings", version: 1 },
  ),
);
