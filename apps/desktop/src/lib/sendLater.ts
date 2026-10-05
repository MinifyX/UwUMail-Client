/**
 * "Send later": the times offered, and what a chosen time has to be. The server holds the mail
 * until then (`sendAt` in the submission), at most `maxDelayedSend` seconds ahead.
 */

export type SendLaterPreset = "laterToday" | "tomorrowMorning" | "tomorrowAfternoon" | "mondayMorning";

/** A time has to be this far ahead, so it is really "later" and not the undo window. */
export const MIN_LATER_MS = 2 * 60 * 1000;

function at(date: Date, hours: number, minutes = 0): Date {
  const copy = new Date(date);
  copy.setHours(hours, minutes, 0, 0);
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** The quick choices for now, in the device's time: later today only while there's still a later today. */
export function sendLaterPresets(now: Date = new Date()): { preset: SendLaterPreset; at: Date }[] {
  const presets: { preset: SendLaterPreset; at: Date }[] = [];
  const evening = at(now, 18);
  if (evening.getTime() - now.getTime() >= 60 * 60 * 1000) presets.push({ preset: "laterToday", at: evening });
  const tomorrow = addDays(now, 1);
  presets.push({ preset: "tomorrowMorning", at: at(tomorrow, 8) });
  presets.push({ preset: "tomorrowAfternoon", at: at(tomorrow, 13) });
  // Next Monday; on a Sunday that is tomorrow, which is offered already.
  const untilMonday = (8 - now.getDay()) % 7 || 7;
  if (untilMonday > 1) presets.push({ preset: "mondayMorning", at: at(addDays(now, untilMonday), 8) });
  return presets;
}

/** A date as the value of `<input type="datetime-local">`, in the device's time. */
export function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** What `<input type="datetime-local">` holds, as a date in the device's time; null when it's empty or broken. */
export function fromLocalInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [, year, month, day, hours, minutes] = match.map(Number) as [number, number, number, number, number, number];
  const date = new Date(year, month - 1, day, hours, minutes, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Why a time doesn't work: too soon (or past), or further ahead than the server holds mail. */
export function sendLaterProblem(
  date: Date | null,
  maxDelaySeconds: number,
  now: Date = new Date(),
): "invalid" | "tooSoon" | "tooFar" | null {
  if (!date) return "invalid";
  const ahead = date.getTime() - now.getTime();
  if (ahead < MIN_LATER_MS) return "tooSoon";
  if (ahead > maxDelaySeconds * 1000) return "tooFar";
  return null;
}
