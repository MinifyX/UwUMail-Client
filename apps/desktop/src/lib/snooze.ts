import type { Folder } from "@/backend/types";
import type { SnoozeEntry } from "@/state/settings";

/** The folder snoozed mail waits in; found by this name (any case) on every device. */
export const SNOOZED_FOLDER = "Snoozed";

export function isSnoozedFolder(folder: Pick<Folder, "role" | "name">): boolean {
  return folder.role === null && folder.name.toLowerCase() === SNOOZED_FOLDER.toLowerCase();
}

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** A random id for a `snooze:<id>` key: 16 characters of `[A-Za-z0-9_-]`. */
export function newSnoozeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => ID_ALPHABET[byte & 63]).join("");
}

/** A time as the synced value keeps it: RFC 3339 in UTC, to the second. */
export function toUtc(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export type SnoozePreset = "laterToday" | "tomorrow" | "weekend" | "nextWeek";

function at(base: Date, days: number, hour: number): Date {
  const date = new Date(base);
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date;
}

/**
 * The picker's choices from `now` (local time): later today (three hours on, on the hour, while
 * that's still the same day and not past 21:00), tomorrow at 8, Saturday at 9 (on weekdays) and
 * next Monday at 8.
 */
export function snoozePresets(now: Date): { preset: SnoozePreset; at: Date }[] {
  const presets: { preset: SnoozePreset; at: Date }[] = [];
  const later = new Date(now.getTime() + 3 * 3600_000);
  if (later.getMinutes() > 0 || later.getSeconds() > 0 || later.getMilliseconds() > 0) {
    later.setHours(later.getHours() + 1, 0, 0, 0);
  }
  if (later.toDateString() === now.toDateString() && later.getHours() <= 21) {
    presets.push({ preset: "laterToday", at: later });
  }
  presets.push({ preset: "tomorrow", at: at(now, 1, 8) });
  const weekday = now.getDay();
  if (weekday >= 1 && weekday <= 5) {
    presets.push({ preset: "weekend", at: at(now, 6 - weekday, 9) });
  }
  presets.push({ preset: "nextWeek", at: at(now, (8 - weekday) % 7 || 7, 8) });
  return presets;
}

/** The snoozes whose time has come, oldest first. */
export function dueSnoozes(snoozes: Record<string, SnoozeEntry>, now: Date): [string, SnoozeEntry][] {
  const time = now.getTime();
  return Object.entries(snoozes)
    .filter(([, entry]) => Date.parse(entry.until) <= time)
    .sort(([, a], [, b]) => Date.parse(a.until) - Date.parse(b.until));
}

/**
 * When the mail of each list row comes back, from the Snoozed folder's `[list id, Message-ID]`
 * pairs: the earliest snooze of the mailbox's that names one of the row's messages.
 */
export function snoozedUntil(
  snoozes: Record<string, SnoozeEntry>,
  address: string,
  headers: [string, string][],
): Map<string, string> {
  const byHeader = new Map<string, string>();
  for (const entry of Object.values(snoozes)) {
    if (entry.account !== address) continue;
    const known = byHeader.get(entry.messageId);
    if (!known || Date.parse(entry.until) < Date.parse(known)) byHeader.set(entry.messageId, entry.until);
  }
  const rows = new Map<string, string>();
  for (const [listId, headerId] of headers) {
    const until = byHeader.get(headerId);
    const known = rows.get(listId);
    if (until && (!known || Date.parse(until) < Date.parse(known))) rows.set(listId, until);
  }
  return rows;
}

/** The existing snooze of this mail, so snoozing it again keeps one key. */
export function findSnooze(
  snoozes: Record<string, SnoozeEntry>,
  address: string,
  headerId: string,
): [string, SnoozeEntry] | undefined {
  return Object.entries(snoozes).find(([, entry]) => entry.account === address && entry.messageId === headerId);
}
