import { create } from "zustand";
import type { AssistAnswer, AssistSpamCheck } from "@/backend/types";

/** What the reader shows of the assistant: summaries and spam checks, while the page is open. */
interface AssistReaderState {
  /** Summaries on screen, by `mail:<id>` or `thread:<id>`. */
  summaries: Record<string, true>;
  /** Mails with a spam check on screen. */
  spamChecks: Record<string, true>;
  /** Finished summaries, so opening the mail again costs nothing. */
  done: Record<string, { text: string; answer: AssistAnswer | null }>;
  /** Finished spam checks, by mail. */
  spamResults: Record<string, AssistSpamCheck>;
  showSummary: (key: string) => void;
  hideSummary: (key: string) => void;
  showSpamCheck: (emailId: string) => void;
  hideSpamCheck: (emailId: string) => void;
  remember: (key: string, text: string, answer: AssistAnswer | null) => void;
  forget: (key: string) => void;
  rememberSpamCheck: (result: AssistSpamCheck) => void;
  forgetSpamCheck: (emailId: string) => void;
}

const without = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  const next = { ...record };
  delete next[key];
  return next;
};

export const useAssistReader = create<AssistReaderState>()((set) => ({
  summaries: {},
  spamChecks: {},
  done: {},
  spamResults: {},
  showSummary: (key) => set((state) => ({ summaries: { ...state.summaries, [key]: true } })),
  hideSummary: (key) => set((state) => ({ summaries: without(state.summaries, key) })),
  showSpamCheck: (emailId) => set((state) => ({ spamChecks: { ...state.spamChecks, [emailId]: true } })),
  hideSpamCheck: (emailId) => set((state) => ({ spamChecks: without(state.spamChecks, emailId) })),
  remember: (key, text, answer) => set((state) => ({ done: { ...state.done, [key]: { text, answer } } })),
  forget: (key) => set((state) => ({ done: without(state.done, key) })),
  rememberSpamCheck: (result) => set((state) => ({ spamResults: { ...state.spamResults, [result.emailId]: result } })),
  forgetSpamCheck: (emailId) => set((state) => ({ spamResults: without(state.spamResults, emailId) })),
}));

export const mailKey = (emailId: string) => `mail:${emailId}`;
export const threadKey = (threadId: string) => `thread:${threadId}`;

/** A summary's text as the card shows it: sentences first, then the `- ` points as a list. */
export function summaryParts(text: string): { lead: string[]; points: string[] } {
  const lead: string[] = [];
  const points: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const point = /^[-•*]\s+(.*)$/.exec(line);
    if (point) points.push(point[1]!);
    else if (points.length === 0) lead.push(line);
    else points.push(line);
  }
  return { lead, points };
}

export type SignalTone = "good" | "bad" | "neutral";

/** How an SPF, DKIM or DMARC result reads: `pass` is good, failures bad, the rest neutral. */
export function authTone(result: string | null): SignalTone {
  if (!result) return "neutral";
  const value = result.toLowerCase();
  if (value === "pass") return "good";
  if (value === "fail" || value === "softfail" || value === "permerror" || value === "temperror") return "bad";
  return "neutral";
}

/** The spam filter's points against its limit, 0 to 1 for a bar; null when it didn't look. */
export function scoreShare(score: number | null, threshold: number | null): number | null {
  if (score === null || threshold === null || threshold <= 0) return null;
  return Math.min(1, Math.max(0, score / threshold));
}

/** A confidence of 0 to 1 as a whole percentage. */
export function percent(confidence: number): number {
  return Math.round(Math.min(1, Math.max(0, confidence)) * 100);
}
