import { create } from "zustand";

/**
 * The widths of the sidebar and the mail list in the three-column layout, dragged by the person
 * and kept on this device only (another screen wants other widths). The reader takes the rest.
 */
export const PANE_WIDTHS_KEY = "uwumail.paneWidths";

export type Pane = "nav" | "list";

export const PANE_LIMITS: Record<Pane, { min: number; max: number; initial: number }> = {
  nav: { min: 180, max: 420, initial: 240 },
  list: { min: 280, max: 720, initial: 400 },
};

/** The reader never gets narrower than this while there is room at all. */
export const READER_MIN = 360;
/** One arrow key press on a handle; with Shift ten times as much. */
export const PANE_STEP = 16;

export type PaneWidths = Record<Pane, number>;

export function clampPane(pane: Pane, width: number): number {
  const { min, max } = PANE_LIMITS[pane];
  if (!Number.isFinite(width)) return PANE_LIMITS[pane].initial;
  return Math.round(Math.min(max, Math.max(min, width)));
}

/** Initial widths, and whatever part of the saved ones is unreadable. */
export function readPaneWidths(raw: string | null): PaneWidths {
  let saved: Partial<Record<Pane, unknown>> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") saved = parsed as Partial<Record<Pane, unknown>>;
  } catch {
    // Broken JSON: the initial widths.
  }
  const pick = (pane: Pane) => {
    const value = saved[pane];
    return typeof value === "number" ? clampPane(pane, value) : PANE_LIMITS[pane].initial;
  };
  return { nav: pick("nav"), list: pick("list") };
}

/**
 * The widths actually drawn in a window this wide: the list gives way first so the reader keeps
 * READER_MIN, then the sidebar, but neither below its minimum.
 */
export function fitPanes(widths: PaneWidths, windowWidth: number): PaneWidths {
  let { nav, list } = widths;
  const over = nav + list + READER_MIN - windowWidth;
  if (over > 0) {
    const fromList = Math.min(over, list - PANE_LIMITS.list.min);
    list -= fromList;
    nav -= Math.min(over - fromList, nav - PANE_LIMITS.nav.min);
  }
  return { nav, list };
}

function load(): PaneWidths {
  try {
    return readPaneWidths(localStorage.getItem(PANE_WIDTHS_KEY));
  } catch {
    return readPaneWidths(null);
  }
}

function save(widths: PaneWidths) {
  try {
    localStorage.setItem(PANE_WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    // Without storage the widths last until the app closes.
  }
}

interface PaneWidthsState {
  widths: PaneWidths;
  setWidth: (pane: Pane, width: number) => void;
  reset: (pane: Pane) => void;
}

export const usePaneWidths = create<PaneWidthsState>()((set, get) => ({
  widths: load(),
  setWidth: (pane, width) => {
    const widths = { ...get().widths, [pane]: clampPane(pane, width) };
    save(widths);
    set({ widths });
  },
  reset: (pane) => get().setWidth(pane, PANE_LIMITS[pane].initial),
}));
