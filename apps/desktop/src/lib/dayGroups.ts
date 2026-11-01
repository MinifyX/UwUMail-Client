/** Where a mail falls in the list grouped by day. */
export type DayGroup = "today" | "yesterday" | "week" | "older";

const startOfDay = (time: number) => {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/** The day group of `date` (ISO 8601) at `now`, local time. Future dates count as today. */
export function dayGroup(date: string, now = Date.now()): DayGroup {
  const today = startOfDay(now);
  const time = Date.parse(date);
  if (Number.isNaN(time) || time >= today) return "today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (time >= yesterday.getTime()) return "yesterday";
  const week = new Date(today);
  week.setDate(week.getDate() - 6);
  return time >= week.getTime() ? "week" : "older";
}

/**
 * `items` (newest first) in runs of the same day group, in their order. A group only shows up
 * where its mail is, and once per run.
 */
export function groupByDay<T>(items: readonly T[], dateOf: (item: T) => string, now = Date.now()) {
  const groups: { group: DayGroup; items: T[] }[] = [];
  for (const item of items) {
    const group = dayGroup(dateOf(item), now);
    const last = groups[groups.length - 1];
    if (last && last.group === group) last.items.push(item);
    else groups.push({ group, items: [item] });
  }
  return groups;
}
