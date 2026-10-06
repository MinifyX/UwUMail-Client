import { detectPlatform, withShortcut, type Platform } from "@uwusuite/design";
import { isTauri } from "@/backend/backend";
import { isAndroid, isIos } from "./device";

/**
 * Opens a web link in the user's browser, never inside UwUMail. The engine accepts only http(s)
 * and hands the browser the normalized address (`open_link` in src-tauri/src/lib.rs).
 */
export async function openExternal(url: string) {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_link", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export const modKey = isMac ? "⌘" : "Ctrl";

/**
 * Which window chrome UwUMail draws (docs/design.md): `"windows"`/`"linux"` get the suite's title
 * bar (the window has no system frame there), `"mac"` keeps the native title bar and fills the menu
 * bar. `null` on Android and iOS, which have neither, and in a plain browser (the demo), which has
 * its own frame.
 */
export const desktopPlatform: Platform | null = isTauri() && !isAndroid && !isIos ? detectPlatform() : null;

/**
 * `Senden (⌘↩)` on a Mac (and an iPad with a keyboard), `Senden (Strg+Enter)` elsewhere: a label
 * with its shortcut, written once as a Tauri accelerator, the same way the macOS menu shows it.
 */
export function shortcutHint(label: string, accelerator: string, language: string): string {
  return withShortcut(label, accelerator, detectPlatform(), language.startsWith("de") ? "de" : "en");
}
