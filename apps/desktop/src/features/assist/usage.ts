/** What the assistant used, shaped for the settings: today against the limits, and the last days. */

import type { AssistUsage, AssistUsageToday } from "@/backend/types";

export interface DayTotal {
  /** `YYYY-MM-DD` (UTC). */
  day: string;
  requests: number;
  tokens: number;
}

export interface FeatureTotal {
  feature: string;
  requests: number;
  tokens: number;
}

/** The last `days` days up to `today` (UTC), oldest first, each with what was used (zero when nothing). */
export function dailyTotals(usage: AssistUsage, days: number, today = new Date()): DayTotal[] {
  const sums = new Map<string, DayTotal>();
  for (const entry of usage.days) {
    const sum = sums.get(entry.day) ?? { day: entry.day, requests: 0, tokens: 0 };
    sum.requests += entry.requests;
    sum.tokens += entry.inputTokens + entry.outputTokens;
    sums.set(entry.day, sum);
  }
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(base - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
    return sums.get(day) ?? { day, requests: 0, tokens: 0 };
  });
}

/** Per feature over the whole report, most used first. */
export function featureTotals(usage: AssistUsage): FeatureTotal[] {
  const sums = new Map<string, FeatureTotal>();
  for (const entry of usage.days) {
    const sum = sums.get(entry.feature) ?? { feature: entry.feature, requests: 0, tokens: 0 };
    sum.requests += entry.requests;
    sum.tokens += entry.inputTokens + entry.outputTokens;
    sums.set(entry.feature, sum);
  }
  return [...sums.values()].sort((a, b) => b.requests - a.requests || a.feature.localeCompare(b.feature));
}

/**
 * How much of today's limits a provider used, 0 to 1 per limit (null without one), and the larger
 * of both: that one runs out first.
 */
export function todayShare(entry: AssistUsageToday): {
  requests: number | null;
  tokens: number | null;
  max: number | null;
} {
  const share = (used: number, limit: number | null) => (limit && limit > 0 ? Math.min(1, used / limit) : null);
  const requests = share(entry.requests, entry.requestsPerDay);
  const tokens = share(entry.tokens, entry.tokensPerDay);
  const known = [requests, tokens].filter((value): value is number => value !== null);
  return { requests, tokens, max: known.length > 0 ? Math.max(...known) : null };
}
