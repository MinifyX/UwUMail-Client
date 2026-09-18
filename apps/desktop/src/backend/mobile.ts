import { isAndroid, isIos } from "@/lib/device";
import { isTauri } from "./backend";
import type { Address, OutgoingAttachment, ThreadPage, ThreadQuery } from "./types";

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

/** True inside the Android app. */
export const nativeAndroid = isTauri() && isAndroid;
/** True inside the iOS app. */
export const nativeIos = isTauri() && isIos;
/** True inside either phone app; everything below does nothing elsewhere. */
export const nativeMobile = nativeAndroid || nativeIos;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!nativeMobile) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/** Searches on the servers as well, including mail that was never downloaded. Null in the browser demo. */
export async function searchServer(query: ThreadQuery): Promise<ThreadPage | null> {
  if (!isTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ThreadPage>("search_server", { query });
}

/** Phone-only pieces of the app shell. Safe to call anywhere. */
export const mobile = {
  /**
   * Language and tone for notifications shown while no window is open. With the app lock on,
   * notifications leave out what the mail says and Recents shows no preview. Android only:
   * on iOS nothing of UwUMail runs without the app.
   */
  setPrefs: (language: string, tone: string, appLock: boolean) =>
    call<void>("set_mobile_prefs", { language, tone, appLock }),
  /** Colors behind the status and navigation bars. */
  setSystemBars: (dark: boolean, background: string) => call<void>("set_system_bars", { dark, background }),
  requestNotifications: () => call<void>("mobile_action", { action: "requestNotifications" }),
  /** The first screen is drawn: the splash with Nyu may go. */
  uiReady: () => call<void>("mobile_action", { action: "uiReady" }),
  /** Android's settings for the lasting "waiting for mail" notification. */
  openWatchSettings: () => call<void>("mobile_action", { action: "watchSettings" }),

  /** Days of mail kept complete on the phone (0 keeps everything). */
  setOfflineDays: (days: number) => call<void>("set_offline_days", { days: days > 0 ? days : null }),

  takeLaunchAction: () => call<LaunchAction>("take_launch_action"),
  onLaunchAction(listener: () => void) {
    if (!nativeMobile) return () => {};
    const pending = import("@tauri-apps/api/event").then(({ listen }) => listen("launch:action", listener));
    return () => void pending.then((unlisten) => unlisten());
  },

  /** A short tick, e.g. when a swipe crosses its threshold. */
  async haptic(style: "light" | "medium" = "light") {
    if (nativeMobile) {
      const { impactFeedback } = await import("@tauri-apps/plugin-haptics");
      await impactFeedback(style).catch(() => undefined);
    } else if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(style === "light" ? 8 : 16);
    }
  },

  /** Whether the phone can check a fingerprint, face or screen lock. */
  async canLock() {
    if (!nativeMobile) return false;
    const { checkStatus } = await import("@tauri-apps/plugin-biometric");
    const status = await checkStatus().catch(() => null);
    // A PIN or pattern works too, even without enrolled biometrics.
    return status !== null && (status.isAvailable || status.errorCode === "biometryNotEnrolled");
  },

  /** Asks for fingerprint, face or the phone's PIN. Resolves to false when cancelled. */
  async unlock(reason: string, title: string) {
    if (!nativeMobile) return true;
    const { authenticate } = await import("@tauri-apps/plugin-biometric");
    try {
      await authenticate(reason, { allowDeviceCredential: true, title });
      return true;
    } catch {
      return false;
    }
  },
};
