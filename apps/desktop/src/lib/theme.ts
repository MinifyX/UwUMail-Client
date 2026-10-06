import { useSyncExternalStore } from "react";
import { QUERIES, type ResolvedAppearance, useAppearance } from "@uwusuite/design";
import { useSettings } from "@/state/settings";

/**
 * Settings → Darstellung → Design, Kontrast and Animationen, resolved against the system by
 * @uwusuite/design and mirrored onto <html data-theme data-contrast data-motion>, where the styles
 * switch. public/boot.js does the same before the first paint. Call it once, in App.
 */
export function useApplyTheme(): ResolvedAppearance {
  const theme = useSettings((s) => s.theme);
  const contrast = useSettings((s) => s.contrast);
  const motion = useSettings((s) => s.motion);
  return useAppearance({ theme, contrast, motion });
}

function useSystemDark() {
  return useSyncExternalStore(
    (callback) => {
      const media = window.matchMedia(QUERIES.dark);
      media.addEventListener("change", callback);
      return () => media.removeEventListener("change", callback);
    },
    () => window.matchMedia(QUERIES.dark).matches,
  );
}

/** The theme the app shows right now: the setting, or the system's while it is followed. */
export function useResolvedTheme(): "light" | "dark" {
  const setting = useSettings((s) => s.theme);
  const systemDark = useSystemDark();
  if (setting === "system") return systemDark ? "dark" : "light";
  return setting;
}
