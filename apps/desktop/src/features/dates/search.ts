import { create } from "zustand";
import { useDismissedDates } from "./dismissed";

/**
 * The mails the person asked the assistant to read for appointments, by the "Find appointment"
 * button or "Check with AI" in the bar: the model reads those even when the automatic refinement
 * is off. Only while the app runs; every request costs tokens, so none is made without a click.
 */
interface EventSearchState {
  asked: Record<string, true>;
  /** Asks for this mail; a bar put away for it shows again with the answer. */
  ask: (messageId: string) => void;
}

export const useEventSearch = create<EventSearchState>()((set) => ({
  asked: {},
  ask: (messageId) => {
    useDismissedDates.getState().restore(messageId);
    set((state) => ({ asked: { ...state.asked, [messageId]: true } }));
  },
}));
