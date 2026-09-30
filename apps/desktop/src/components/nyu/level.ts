import { useEffect, useSyncExternalStore } from "react";
import { useSettings, type MotionSetting, type NyuAnimations } from "@/state/settings";

/**
 * How much Nyu moves, resolved from the setting "Nyu animations", the general animation setting
 * with the operating system's reduced motion:
 *
 * - `full`: the little scenes play with all their movement.
 * - `reduced`: the scenes that carry meaning (sent, archived, deleted, occasions) appear as still
 *   pictures for a moment, with no movement at all; purely decorative ones (Nyu peeking at an
 *   opened mail, idle loops in the empty states) stay away.
 * - `off`: no scenes; the AI keeps its plain dots. Empty states still show their still picture.
 */
export type NyuLevel = "full" | "reduced" | "off";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Reduced motion anywhere (the setting, or the system while it is followed) caps Nyu at `reduced`. */
export function resolveNyuLevel(setting: NyuAnimations, motion: MotionSetting, systemReduced: boolean): NyuLevel {
  if (setting === "off") return "off";
  const motionReduced = motion === "off" || (motion === "system" && systemReduced);
  if (setting === "reduced" || motionReduced) return "reduced";
  return "full";
}

function systemPrefersReduced(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION).matches
    : false;
}

/** The level right now, outside React (e.g. when an action finishes). */
export function currentNyuLevel(): NyuLevel {
  const { nyuAnimations, motion } = useSettings.getState();
  return resolveNyuLevel(nyuAnimations, motion, systemPrefersReduced());
}

function useSystemReduced(): boolean {
  return useSyncExternalStore((callback) => {
    if (typeof window.matchMedia !== "function") return () => {};
    const media = window.matchMedia(REDUCED_MOTION);
    media.addEventListener("change", callback);
    return () => media.removeEventListener("change", callback);
  }, systemPrefersReduced);
}

export function useNyuLevel(): NyuLevel {
  const setting = useSettings((s) => s.nyuAnimations);
  const motion = useSettings((s) => s.motion);
  return resolveNyuLevel(setting, motion, useSystemReduced());
}

/** Mirrors the level onto `<html data-nyu>`, where nyu.css stops Nyu's own movement. */
export function useApplyNyuLevel(): void {
  const level = useNyuLevel();
  useEffect(() => {
    document.documentElement.dataset.nyu = level;
  }, [level]);
}
