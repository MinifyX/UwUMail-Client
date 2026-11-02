import type { VerificationCode } from "./types";

/** A digits-only code in groups of three for reading ("482 913", with an en space). */
export function groupCode(code: string): string {
  if (!/^\d{6,}$/.test(code)) return code;
  return code.replace(/(\d{3})(?=\d)/g, "$1 ");
}

/** Whole seconds until `expiresAt`, 0 once it passed. */
export function secondsLeft(code: Pick<VerificationCode, "expiresAt">, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(code.expiresAt) - now) / 1000));
}

/** "m:ss". */
export function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The codes that still work at `now`, soonest to expire first. */
export function activeCodes(codes: readonly VerificationCode[], now: number): VerificationCode[] {
  return codes.filter((code) => secondsLeft(code, now) > 0).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
}

/** How long a copied code stays on the clipboard. */
export const CLIPBOARD_CLEAR_MS = 60_000;

let clearTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Empties the clipboard if it still holds `text`. Best effort: where reading the clipboard isn't
 * allowed (or asks the user), it stays as it is rather than wiping something else.
 */
async function clearClipboardIf(text: string) {
  try {
    if ((await navigator.clipboard.readText()) === text) await navigator.clipboard.writeText("");
  } catch {
    // Not allowed to read it: leave it alone.
  }
}

/**
 * Copies `text`; false when the clipboard turned it down. The code itself is never logged.
 * A minute later the clipboard is emptied again if it still holds the code (security review:
 * codes left on the clipboard).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return false;
  }
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => void clearClipboardIf(text), CLIPBOARD_CLEAR_MS);
  return true;
}

/** The working code of a conversation, for the mark on its row. */
export function codeFor(codes: readonly VerificationCode[], threadId: string, now = Date.now()) {
  return codes.find((code) => code.threadId === threadId && secondsLeft(code, now) > 0);
}
