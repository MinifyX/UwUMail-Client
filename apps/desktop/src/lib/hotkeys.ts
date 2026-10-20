import { useEffect, useRef } from "react";
import { isLocked } from "@/state/lock";

/** A handler that returns false leaves the key to the browser, e.g. Ctrl+A in a text field. */
export type HotkeyMap = Record<string, (event: KeyboardEvent) => void | boolean>;

interface HotkeyOptions {
  enabled?: boolean;
  /** Combos that run again while their key is held down, like moving through a list. */
  repeat?: string[];
}

/** Also answers for elements inside the mail frame, which come from another window. */
export function isTyping(target: EventTarget | null) {
  const element = target as Partial<HTMLElement> | null;
  if (!element || typeof element.tagName !== "string") return false;
  return element.isContentEditable === true || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
}

/**
 * Keys use the format "mod+k", "shift+i" or plain "j". "mod" is Cmd on macOS
 * and Ctrl elsewhere. Single keys are ignored while the user types. "g i" is
 * a sequence: g, then i within a second. A key held down runs its handler once,
 * so holding Delete can't delete one conversation after the other.
 */
export function comboOf(event: KeyboardEvent) {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  // Shift only counts with letters: "?" and "#" already tell it.
  if (event.shiftKey && /^[a-z]$/i.test(event.key)) parts.push("shift");
  parts.push(event.key.length === 1 ? event.key.toLowerCase() : event.key);
  return parts.join("+");
}

/**
 * The combos a key answers to, most specific first. Shift+letter falls back to the letter
 * alone, so Shift+J still moves, Cmd+Shift+K still opens the palette and a sequence
 * "g i" also takes "g", Shift+I. Only a map entry with "shift+" claims Shift for itself.
 */
export function combosOf(event: KeyboardEvent): string[] {
  const combo = comboOf(event);
  const plain = combo.replace(/(^|\+)shift\+(?=[a-z]$)/, "$1");
  return plain === combo ? [combo] : [combo, plain];
}

/** The handler for a key, after an optional first key of a sequence. */
export function findHotkey(map: HotkeyMap, combos: string[], started: string | null) {
  if (started) {
    for (const combo of combos) {
      const handler = map[`${started} ${combo}`];
      if (handler) return { combo, handler };
    }
  }
  for (const combo of combos) {
    const handler = map[combo];
    if (handler) return { combo, handler };
  }
  return null;
}

const SEQUENCE_WAIT = 1000;

export function useHotkeys(map: HotkeyMap, { enabled = true, repeat = [] }: HotkeyOptions = {}) {
  const latest = useRef(map);
  const repeating = useRef(repeat);
  useEffect(() => {
    latest.current = map;
    repeating.current = repeat;
  });

  useEffect(() => {
    if (!enabled) return;
    let pending: { key: string; at: number } | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // Behind the app lock nothing may be opened, moved or deleted, keyboard or not.
      if (isLocked()) return;
      const combos = combosOf(event);
      const plain = combos.at(-1) ?? "";
      if (!plain.startsWith("mod+") && isTyping(event.target)) return;
      if (document.querySelector("dialog[open]") && plain !== "mod+k") return;
      // An open menu keeps the arrows and letters to itself.
      if (document.querySelector('[role="menu"]')) return;
      const started = pending && event.timeStamp - pending.at < SEQUENCE_WAIT ? pending.key : null;
      pending = null;
      const found = findHotkey(latest.current, combos, started);
      if (!found) {
        // The first key of a sequence waits for the second one.
        const first = combos.find((combo) => Object.keys(latest.current).some((key) => key.startsWith(`${combo} `)));
        if (first) {
          pending = { key: first, at: event.timeStamp };
          event.preventDefault();
        }
        return;
      }
      const { combo, handler } = found;
      if (event.repeat && !repeating.current.includes(combo) && !repeating.current.includes(plain)) {
        event.preventDefault();
        return;
      }
      if (handler(event) !== false) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
