import { backend } from "@/backend/backend";

/** The longest app password name a UwUMail server takes. */
export const MAX_APP_PASSWORD_NAME = 80;

/**
 * A name for this device from the browser's user agent: "iPad" or "iPhone" (iOS no longer tells
 * apps the name the person gave it), the model on Android ("Pixel 8"), or null.
 */
export function deviceNameFromAgent(userAgent: string, maxTouchPoints = 0): string | null {
  if (/iPad/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)) return "iPad";
  if (/iPhone|iPod/i.test(userAgent)) return "iPhone";
  const android = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?(?:;\s*wv)?\)/i.exec(userAgent);
  if (android) {
    const model = android[1]!.trim();
    // Chrome hides the model as "K" since its reduced user agent.
    return model && model !== "K" && !/^wv$/i.test(model) ? model : "Android";
  }
  if (/Android/i.test(userAgent)) return "Android";
  return null;
}

/** What to call this device's app password: the computer's name, the phone's, or "UwUMail". */
export async function defaultAppPasswordName(): Promise<string> {
  let name: string | null = null;
  try {
    name = (await backend().deviceName())?.trim() || null;
  } catch {
    // An older build without the command: the browser's guess below.
  }
  name ??= deviceNameFromAgent(navigator.userAgent, navigator.maxTouchPoints);
  return (name ?? "UwUMail").slice(0, MAX_APP_PASSWORD_NAME);
}
