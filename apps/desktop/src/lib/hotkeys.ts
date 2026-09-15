import { useEffect, useRef } from "react";

export type HotkeyMap = Record<string, (event: KeyboardEvent) => void>;

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Keys use the format "mod+k", "shift+3" or plain "j". "mod" is Cmd on macOS
 * and Ctrl elsewhere. Single keys are ignored while the user types. "g i" is
 * a sequence: g, then i within a second.
 */
function comboOf(event: KeyboardEvent) {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  parts.push(event.key.length === 1 ? event.key.toLowerCase() : event.key);
  return parts.join("+");
}

const SEQUENCE_WAIT = 1000;

export function useHotkeys(map: HotkeyMap, enabled = true) {
  const latest = useRef(map);
  useEffect(() => {
    latest.current = map;
  });

  useEffect(() => {
    if (!enabled) return;
    let pending: { key: string; at: number } | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const combo = comboOf(event);
      if (!combo.startsWith("mod+") && isTyping(event.target)) return;
      if (document.querySelector("dialog[open]") && combo !== "mod+k") return;
      const started = pending && event.timeStamp - pending.at < SEQUENCE_WAIT ? pending.key : null;
      pending = null;
      const handler = (started && latest.current[`${started} ${combo}`]) || latest.current[combo];
      if (!handler) {
        // The first key of a sequence waits for the second one.
        if (Object.keys(latest.current).some((key) => key.startsWith(`${combo} `))) {
          pending = { key: combo, at: event.timeStamp };
          event.preventDefault();
        }
        return;
      }
      event.preventDefault();
      handler(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
