import { useSyncExternalStore } from "react";

/** Running inside the Android app (also true for Android tablets). */
export const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

/** Running inside the iOS app. iPadOS reports itself as a Mac, hence the touch check. */
export const isIos =
  typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Mac/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

/**
 * A phone rather than a tablet, from the device and the short side of its screen: Android draws its
 * tablet line at 600 dp and the smallest iPad is 744 pt wide, so turning a phone sideways keeps it a
 * phone. Desktops (also narrow windows and touch screens) never are.
 */
export function phoneDevice(mobile: boolean, screenWidth: number, screenHeight: number) {
  return mobile && Math.min(screenWidth, screenHeight) > 0 && Math.min(screenWidth, screenHeight) < 600;
}

/** An iPhone or an Android phone (not an iPad or an Android tablet). */
export const isPhoneDevice = phoneDevice(
  isIos || isAndroid,
  typeof screen === "undefined" ? 0 : screen.width,
  typeof screen === "undefined" ? 0 : screen.height,
);

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
