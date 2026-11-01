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

/** Copies `text`; false when the clipboard turned it down. The code itself is never logged. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The working code of a conversation, for the mark on its row. */
export function codeFor(codes: readonly VerificationCode[], threadId: string, now = Date.now()) {
  return codes.find((code) => code.threadId === threadId && secondsLeft(code, now) > 0);
}
