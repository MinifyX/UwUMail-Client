import { useEffect, useSyncExternalStore } from "react";
import { useSettings } from "@/state/settings";

const query = "(prefers-color-scheme: dark)";

function subscribe(callback: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

export function useResolvedTheme(): "light" | "dark" {
  const setting = useSettings((s) => s.theme);
  const systemDark = useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
  if (setting === "system") return systemDark ? "dark" : "light";
  return setting;
}

/** Mirrors the resolved theme onto <html data-theme>, where the tokens switch. */
export function useApplyTheme() {
  const theme = useResolvedTheme();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
}
