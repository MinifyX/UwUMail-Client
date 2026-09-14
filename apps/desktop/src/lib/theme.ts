import { useEffect, useSyncExternalStore } from "react";
import { useSettings } from "@/state/settings";

const darkQuery = "(prefers-color-scheme: dark)";
const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (callback) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", callback);
      return () => media.removeEventListener("change", callback);
    },
    () => window.matchMedia(query).matches,
  );
}

export function useResolvedTheme(): "light" | "dark" {
  const setting = useSettings((s) => s.theme);
  const systemDark = useMediaQuery(darkQuery);
  if (setting === "system") return systemDark ? "dark" : "light";
  return setting;
}

export function useResolvedMotion(): "full" | "reduced" {
  const setting = useSettings((s) => s.motion);
  const systemReduced = useMediaQuery(reducedMotionQuery);
  if (setting === "system") return systemReduced ? "reduced" : "full";
  return setting === "on" ? "full" : "reduced";
}

/** Mirrors the resolved theme and motion onto <html data-theme data-motion>, where the styles switch. */
export function useApplyTheme() {
  const theme = useResolvedTheme();
  const motion = useResolvedMotion();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.motion = motion;
  }, [theme, motion]);
}
