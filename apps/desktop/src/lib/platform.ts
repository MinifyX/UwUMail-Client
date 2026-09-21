import { isTauri } from "@/backend/backend";

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
