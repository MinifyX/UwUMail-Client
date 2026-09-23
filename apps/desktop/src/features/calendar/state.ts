import { create } from "zustand";
import type { CalendarOccurrence, EventDeleteScope } from "@/backend/types";
import { addDays, addMonths, todayKey, type DateKey, type WallTime } from "@/lib/calendarDates";

/** Agenda is the phone's list; the others are the grids. */
export type CalendarView = "month" | "week" | "day" | "agenda";

/** Where on screen a popover points to. */
export interface Anchor {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function anchorOf(element: Element | null, fallback?: { x: number; y: number }): Anchor {
  if (element) {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  return {
    left: fallback?.x ?? window.innerWidth / 2,
    top: fallback?.y ?? window.innerHeight / 3,
    width: 0,
    height: 0,
  };
}

/** A new event waiting for its title: the slot that was clicked or dragged across. */
export interface QuickCreate {
  start: WallTime;
  end: WallTime;
  allDay: boolean;
  anchor: Anchor;
}

/** The full editor: an occurrence to change, or the start of a new event. */
export interface EditorRequest {
  occurrence: CalendarOccurrence | null;
  draft?: { start: WallTime; end: WallTime; allDay: boolean; title?: string };
}

interface CalendarUiState {
  view: CalendarView;
  date: DateKey;
  popover: { occurrence: CalendarOccurrence; anchor: Anchor } | null;
  quick: QuickCreate | null;
  editor: EditorRequest | null;
  /** The open "only this one or the whole series?" question. */
  deleteScope: { title: string; answer: (scope: EventDeleteScope | null) => void } | null;

  setView: (view: CalendarView) => void;
  setDate: (date: DateKey) => void;
  goToday: () => void;
  /** One month, week or day forward or back, whatever is on screen. */
  step: (direction: 1 | -1) => void;
  showPopover: (occurrence: CalendarOccurrence, anchor: Anchor) => void;
  closePopover: () => void;
  openQuick: (quick: QuickCreate) => void;
  closeQuick: () => void;
  openEditor: (request: EditorRequest) => void;
  closeEditor: () => void;
}

export const useCalendarUi = create<CalendarUiState>()((set, get) => ({
  view: "week",
  date: todayKey(),
  popover: null,
  quick: null,
  editor: null,
  deleteScope: null,

  setView: (view) => set({ view, popover: null, quick: null }),
  setDate: (date) => set({ date, popover: null, quick: null }),
  goToday: () => set({ date: todayKey(), popover: null, quick: null }),
  step: (direction) => {
    const { view, date } = get();
    const next =
      view === "month" ? addMonths(date, direction) : addDays(date, view === "week" ? 7 * direction : direction);
    set({ date: next, popover: null, quick: null });
  },
  showPopover: (occurrence, anchor) => set({ popover: { occurrence, anchor }, quick: null }),
  closePopover: () => set({ popover: null }),
  openQuick: (quick) => set({ quick, popover: null }),
  closeQuick: () => set({ quick: null }),
  openEditor: (editor) => set({ editor, popover: null, quick: null }),
  closeEditor: () => set({ editor: null }),
}));

/** Asks whether one occurrence or the whole series goes. Resolves null when the person backs out. */
export function askDeleteScope(title: string): Promise<EventDeleteScope | null> {
  return new Promise((resolve) => {
    useCalendarUi.getState().deleteScope?.answer(null);
    useCalendarUi.setState({ deleteScope: { title, answer: resolve } });
  });
}

export function answerDeleteScope(scope: EventDeleteScope | null) {
  const { deleteScope } = useCalendarUi.getState();
  if (!deleteScope) return;
  useCalendarUi.setState({ deleteScope: null });
  deleteScope.answer(scope);
}
