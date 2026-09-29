import { create } from "zustand";

/** The mails whose appointment bar was put away, on this device. */
export const DISMISSED_KEY = "uwumail.datesDismissed";
/** The newest ones are kept; an old mail's bar coming back is no harm. */
const MAX_KEPT = 500;

function load(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string").slice(-MAX_KEPT) : [];
  } catch {
    return [];
  }
}

interface DismissedState {
  ids: string[];
  dismiss: (messageId: string) => void;
  restore: (messageId: string) => void;
  clear: () => void;
}

function save(ids: string[]) {
  try {
    if (ids.length === 0) localStorage.removeItem(DISMISSED_KEY);
    else localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids));
  } catch {
    // Without storage it lasts until the app closes.
  }
}

export const useDismissedDates = create<DismissedState>()((set, get) => ({
  ids: load(),
  dismiss: (messageId) => {
    const ids = [...get().ids.filter((id) => id !== messageId), messageId].slice(-MAX_KEPT);
    save(ids);
    set({ ids });
  },
  restore: (messageId) => {
    const ids = get().ids.filter((id) => id !== messageId);
    save(ids);
    set({ ids });
  },
  clear: () => {
    save([]);
    set({ ids: [] });
  },
}));
