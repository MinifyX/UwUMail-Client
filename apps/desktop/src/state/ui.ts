import { create } from "zustand";
import type { Address, ListFilter, MailboxView, Message, OutgoingAttachment } from "@/backend/types";

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

export interface ComposeRequest {
  key: number;
  mode: ComposeMode;
  source?: Message;
  to?: Address[];
  /** Prefilled from a mailto: link. */
  cc?: Address[];
  bcc?: Address[];
  subject?: string;
  body?: string;
  /** Files shared from another app. */
  attachments?: OutgoingAttachment[];
  /** A draft saved on the phone, brought back after Android closed UwUMail. */
  restore?: SavedDraft;
}

/** What the phone keeps of an unsent draft. */
export interface SavedDraft {
  mode: ComposeMode;
  accountId: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  inReplyTo?: string;
}

export type SettingsSection = "appearance" | "mail" | "security" | "accounts" | "addons" | "about";

interface UiState {
  view: MailboxView;
  filter: ListFilter;
  search: string;
  selectedThreadId: string | null;
  /** Thread ids in the order the list currently shows them. */
  visibleThreadIds: string[];
  folderDrawerOpen: boolean;
  compose: ComposeRequest | null;
  composeMinimized: boolean;
  settingsOpen: SettingsSection | null;
  addAccountOpen: boolean;
  paletteOpen: boolean;
  shortcutsOpen: boolean;

  setView: (view: MailboxView) => void;
  setFilter: (filter: ListFilter) => void;
  setSearch: (search: string) => void;
  selectThread: (id: string | null) => void;
  setVisibleThreadIds: (ids: string[]) => void;
  selectRelative: (offset: 1 | -1) => void;
  setFolderDrawerOpen: (open: boolean) => void;
  openCompose: (request: Omit<ComposeRequest, "key">) => void;
  closeCompose: () => void;
  setComposeMinimized: (minimized: boolean) => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setAddAccountOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
}

export const useUi = create<UiState>()((set, get) => ({
  view: { kind: "unified", role: "inbox" },
  filter: "all",
  search: "",
  selectedThreadId: null,
  visibleThreadIds: [],
  folderDrawerOpen: false,
  compose: null,
  composeMinimized: false,
  settingsOpen: null,
  addAccountOpen: false,
  paletteOpen: false,
  shortcutsOpen: false,

  setView: (view) => set({ view, selectedThreadId: null, folderDrawerOpen: false }),
  setFilter: (filter) => set({ filter, selectedThreadId: null }),
  setSearch: (search) => set({ search }),
  selectThread: (id) => set({ selectedThreadId: id }),
  setVisibleThreadIds: (ids) => set({ visibleThreadIds: ids }),
  selectRelative: (offset) => {
    const { visibleThreadIds, selectedThreadId } = get();
    if (visibleThreadIds.length === 0) return;
    const index = selectedThreadId ? visibleThreadIds.indexOf(selectedThreadId) : -1;
    const next = Math.min(Math.max(index + offset, 0), visibleThreadIds.length - 1);
    set({ selectedThreadId: visibleThreadIds[next] ?? null });
  },
  setFolderDrawerOpen: (open) => set({ folderDrawerOpen: open }),
  openCompose: (request) => set({ compose: { ...request, key: Date.now() }, composeMinimized: false }),
  closeCompose: () => set({ compose: null, composeMinimized: false }),
  setComposeMinimized: (minimized) => set({ composeMinimized: minimized }),
  openSettings: (section = "appearance") => set({ settingsOpen: section, paletteOpen: false }),
  closeSettings: () => set({ settingsOpen: null }),
  setAddAccountOpen: (open) => set({ addAccountOpen: open }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
}));
