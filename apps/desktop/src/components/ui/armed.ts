import type { KeyboardEvent } from "react";

/**
 * How long after a question appears its answering button still ignores a click: the second click
 * of a double click, or the rest of the gesture that opened the question, must not answer it.
 */
export const ARMING_MS = 600;

/** Props for a button that answers a question: no answer while arming, none from a held-down key. */
export function armedActivation(shownAt: number, action: () => void) {
  return {
    onClick: () => {
      if (performance.now() - shownAt >= ARMING_MS) action();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.repeat) event.preventDefault();
    },
  };
}
