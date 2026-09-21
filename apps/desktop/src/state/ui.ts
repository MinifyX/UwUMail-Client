import { create } from "zustand";
import type { Address, ListFilter, MailboxView, Message, OutgoingAttachment } from "@/backend/types";
import { extendSelection, stepThrough } from "@/lib/listSelection";

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
  /** A draft to keep writing: from the Drafts folder, or kept on this device. */
  restore?: SavedDraft;
}

/** A draft to continue: kept on this device, or opened from the Drafts folder. */
export interface SavedDraft {
  mode: ComposeMode;
  accountId: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  inReplyTo?: string;
  /** Its Message-ID in the Drafts folder, once saved there. */
  draftKey?: string;
  /** The sender address when it isn't the mailbox's own. */
  fromEmail?: string;
  /** False while the newest text only exists on this device. */
  savedToServer?: boolean;
}

/** Mail waiting for "Move to…". */
export interface MoveRequest {
  messageIds: string[];
  accountIds: string[];
  /** Runs once moved, e.g. to close the conversation. */
  onMoved?: () => void;
}

export type SettingsSection = "appearance" | "mail" | "compose" | "security" | "accounts" | "addons" | "about";

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
  /** A form inside the settings dialog (e.g. a signature being edited) has unsaved input. */
  settingsFormDirty: boolean;
  addAccountOpen: boolean;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  /** Conversations ticked in the list (Ctrl/Shift+click or x). */
  checkedThreadIds: string[];
  /** Where a Shift range starts: the conversation last clicked or opened. */
  selectionAnchor: string | null;
  /** Where a Shift range ends: the row Shift+↑/↓ last reached. */
  selectionCursor: string | null;
  moving: MoveRequest | null;

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
  setSettingsFormDirty: (dirty: boolean) => void;
  setAddAccountOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setCheckedThreadIds: (ids: string[]) => void;
  setSelectionAnchor: (id: string | null, cursor?: string | null) => void;
  /** Shift+↑/↓: grows or shrinks the ticked range from the anchor by one row. */
  extendSelection: (offset: 1 | -1) => void;
  /** Ticks every conversation the list has loaded so far. */
  checkAllVisible: () => void;
  openMove: (request: MoveRequest) => void;
  closeMove: () => void;
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
  settingsFormDirty: false,
  addAccountOpen: false,
  paletteOpen: false,
  shortcutsOpen: false,
  checkedThreadIds: [],
  selectionAnchor: null,
  selectionCursor: null,
  moving: null,

  setView: (view) =>
    set({
      view,
      selectedThreadId: null,
      folderDrawerOpen: false,
      checkedThreadIds: [],
      selectionAnchor: null,
      selectionCursor: null,
    }),
  setFilter: (filter) =>
    set({ filter, selectedThreadId: null, checkedThreadIds: [], selectionAnchor: null, selectionCursor: null }),
  setSearch: (search) => set({ search }),
  selectThread: (id) =>
    set(id ? { selectedThreadId: id, selectionAnchor: id, selectionCursor: null } : { selectedThreadId: null }),
  setVisibleThreadIds: (ids) => set({ visibleThreadIds: ids }),
  selectRelative: (offset) => {
    const { visibleThreadIds, selectedThreadId } = get();
    const next = stepThrough(visibleThreadIds, selectedThreadId, offset);
    if (next) set({ selectedThreadId: next, selectionAnchor: next, selectionCursor: null });
  },
  setFolderDrawerOpen: (open) => set({ folderDrawerOpen: open }),
  openCompose: (request) => set({ compose: { ...request, key: Date.now() }, composeMinimized: false }),
  closeCompose: () => set({ compose: null, composeMinimized: false }),
  setComposeMinimized: (minimized) => set({ composeMinimized: minimized }),
  openSettings: (section = "appearance") => set({ settingsOpen: section, paletteOpen: false }),
  closeSettings: () => set({ settingsOpen: null, settingsFormDirty: false }),
  setSettingsFormDirty: (dirty) => set({ settingsFormDirty: dirty }),
  setAddAccountOpen: (open) => set({ addAccountOpen: open }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  setCheckedThreadIds: (ids) =>
    set(ids.length > 0 ? { checkedThreadIds: ids } : { checkedThreadIds: [], selectionCursor: null }),
  setSelectionAnchor: (id, cursor = null) => set({ selectionAnchor: id, selectionCursor: cursor }),
  extendSelection: (offset) => {
    const { visibleThreadIds, checkedThreadIds, selectionAnchor, selectionCursor, selectedThreadId } = get();
    const next = extendSelection(
      visibleThreadIds,
      {
        checked: checkedThreadIds,
        anchor: selectionAnchor ?? selectedThreadId,
        // A fresh range starts at the anchor again once nothing is ticked.
        cursor: checkedThreadIds.length > 0 ? selectionCursor : null,
      },
      offset,
    );
    set({ checkedThreadIds: next.checked, selectionAnchor: next.anchor, selectionCursor: next.cursor });
  },
  checkAllVisible: () => set((state) => ({ checkedThreadIds: [...state.visibleThreadIds] })),
  openMove: (request) => set({ moving: request }),
  closeMove: () => set({ moving: null }),
}));
