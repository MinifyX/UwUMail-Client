import { isAndroid } from "@/lib/device";
import { isTauri } from "./backend";
import type { Address, OutgoingAttachment } from "./types";

/** Something UwUMail was opened for on Android. */
export type LaunchAction =
  | {
      kind: "compose";
      draft: { to: Address[]; cc: Address[]; bcc: Address[]; subject: string; body: string };
      attachments: OutgoingAttachment[];
      /** Shared files left out because they are too big for a mail. */
      tooBig: string[];
    }
  | { kind: "open"; threadId: string; messageId: string };

/** True inside the Android app; everything below does nothing elsewhere. */
export const nativeAndroid = isTauri() && isAndroid;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!nativeAndroid) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/** Android-only pieces of the app shell. Safe to call anywhere. */
export const mobile = {
  /** Language and tone for notifications shown while no window is open. */
  setPrefs: (language: string, tone: string) => call<void>("set_mobile_prefs", { language, tone }),
  /** Colors behind the status and navigation bars. */
  setSystemBars: (dark: boolean, background: string) => call<void>("set_system_bars", { dark, background }),
  requestNotifications: () => call<void>("mobile_action", { action: "requestNotifications" }),
  /** The first screen is drawn: the splash with Nyu may go. */
  uiReady: () => call<void>("mobile_action", { action: "uiReady" }),
  /** Android's settings for the lasting "waiting for mail" notification. */
  openWatchSettings: () => call<void>("mobile_action", { action: "watchSettings" }),

  takeLaunchAction: () => call<LaunchAction>("take_launch_action"),
  onLaunchAction(listener: () => void) {
    if (!nativeAndroid) return () => {};
    const pending = import("@tauri-apps/api/event").then(({ listen }) => listen("launch:action", listener));
    return () => void pending.then((unlisten) => unlisten());
  },

  /** A short tick, e.g. when a swipe crosses its threshold. */
  async haptic(style: "light" | "medium" = "light") {
    if (nativeAndroid) {
      const { impactFeedback } = await import("@tauri-apps/plugin-haptics");
      await impactFeedback(style).catch(() => undefined);
    } else if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(style === "light" ? 8 : 16);
    }
  },

  /** Whether the phone can check a fingerprint, face or screen lock. */
  async canLock() {
    if (!nativeAndroid) return false;
    const { checkStatus } = await import("@tauri-apps/plugin-biometric");
    const status = await checkStatus().catch(() => null);
    // A PIN or pattern works too, even without enrolled biometrics.
    return status !== null && (status.isAvailable || status.errorCode === "biometryNotEnrolled");
  },

  /** Asks for fingerprint, face or the phone's PIN. Resolves to false when cancelled. */
  async unlock(reason: string, title: string) {
    if (!nativeAndroid) return true;
    const { authenticate } = await import("@tauri-apps/plugin-biometric");
    try {
      await authenticate(reason, { allowDeviceCredential: true, title });
      return true;
    } catch {
      return false;
    }
  },
};
