import { useSyncExternalStore } from "react";

/** Running inside the Android app (also true for Android tablets). */
export const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

/** Below this width UwUMail uses the one-column phone layout. */
export const PHONE_QUERY = "(max-width: 699px)";
/** The Pro layout needs room for three columns; narrower windows fall back to Simple. */
export const PRO_QUERY = "(min-width: 1100px)";

export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (callback) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", callback);
      return () => media.removeEventListener("change", callback);
    },
    () => window.matchMedia(query).matches,
  );
}

export function useIsPhone() {
  return useMediaQuery(PHONE_QUERY);
}
