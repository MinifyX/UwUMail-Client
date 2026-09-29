/**
 * The person's labels on mail, as the assistant keeps them: a label is a JMAP keyword on the
 * email, so the chips are read from the mail's own keywords, and the log says which of them the
 * model set and why.
 */

import type { CSSProperties } from "react";
import type { AssistLabel, AssistLabelInput, AssistLabelLogEntry } from "@/backend/types";

/** The server's limits for a label. */
export const LABEL_LIMITS = { name: 40, description: 300 } as const;

/** Colours to pick from; `null` is the plain look. Readable as chips in light and dark. */
export const LABEL_COLORS = [
  "#e11d74",
  "#f59e0b",
  "#10b981",
  "#0ea5e9",
  "#8b5cf6",
  "#ef4444",
  "#14b8a6",
  "#64748b",
] as const;

/** The labels a mail carries, in the order the person keeps them. */
export function labelsOn(keywords: readonly string[] | undefined, labels: readonly AssistLabel[]): AssistLabel[] {
  if (!keywords || keywords.length === 0) return [];
  const set = new Set(keywords.map((keyword) => keyword.toLowerCase()));
  return labels.filter((label) => set.has(label.keyword));
}

/**
 * Why the model put a label on this mail: its newest log entry for it that is not undone, or null
 * when the person set it by hand (or the log forgot it).
 */
export function setByAssistant(
  log: readonly AssistLabelLogEntry[],
  emailId: string,
  keyword: string,
): AssistLabelLogEntry | null {
  let best: AssistLabelLogEntry | null = null;
  for (const entry of log) {
    if (entry.emailId !== emailId || entry.keyword !== keyword || entry.undone) continue;
    if (!best || entry.createdAt > best.createdAt) best = entry;
  }
  return best;
}

/** The labels a mail doesn't carry yet, for "add a label". */
export function labelsOff(keywords: readonly string[] | undefined, labels: readonly AssistLabel[]): AssistLabel[] {
  const on = new Set(labelsOn(keywords, labels).map((label) => label.id));
  return labels.filter((label) => !on.has(label.id));
}

/** The labels of a conversation: those of every mail in it. */
export function threadKeywords(messages: readonly { keywords?: string[] }[]): string[] {
  return [...new Set(messages.flatMap((message) => message.keywords ?? []))].sort();
}

export type StarterLabel = "invoices" | "newsletters" | "orders" | "travel" | "appointments" | "personal";

/** The suggested first labels: names and descriptions come from the translations. */
export const STARTER_LABELS: readonly { id: StarterLabel; color: string }[] = [
  { id: "invoices", color: "#f59e0b" },
  { id: "newsletters", color: "#8b5cf6" },
  { id: "orders", color: "#0ea5e9" },
  { id: "travel", color: "#14b8a6" },
  { id: "appointments", color: "#e11d74" },
  { id: "personal", color: "#10b981" },
];

/** The starter labels that aren't there yet (by name, ignoring case), as ready inputs. */
export function missingStarters(
  labels: readonly AssistLabel[],
  text: (id: StarterLabel) => { name: string; description: string },
): AssistLabelInput[] {
  const taken = new Set(labels.map((label) => label.name.trim().toLowerCase()));
  return STARTER_LABELS.map(({ id, color }) => ({ ...text(id), color })).filter(
    (input) => !taken.has(input.name.trim().toLowerCase()),
  );
}

export type LabelProblem = "nameMissing" | "nameTooLong" | "nameTaken" | "descriptionTooLong" | "control";

// Line breaks and control characters don't belong in a name.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** What is wrong with a label form, per field; empty when it can be saved. */
export function labelProblems(
  input: AssistLabelInput,
  labels: readonly AssistLabel[],
  except?: string,
): Partial<Record<"name" | "description", LabelProblem>> {
  const problems: Partial<Record<"name" | "description", LabelProblem>> = {};
  const name = input.name.trim();
  if (!name) problems.name = "nameMissing";
  else if ([...name].length > LABEL_LIMITS.name) problems.name = "nameTooLong";
  else if (CONTROL.test(name)) problems.name = "control";
  else if (labels.some((label) => label.id !== except && label.name.trim().toLowerCase() === name.toLowerCase())) {
    problems.name = "nameTaken";
  }
  if ([...input.description.trim()].length > LABEL_LIMITS.description) problems.description = "descriptionTooLong";
  return problems;
}

/** Only what changed, for `AssistLabel/set`. */
export function labelPatch(label: AssistLabel, input: AssistLabelInput): Partial<AssistLabelInput> {
  const patch: Partial<AssistLabelInput> = {};
  if (input.name.trim() !== label.name) patch.name = input.name.trim();
  if (input.description.trim() !== label.description) patch.description = input.description.trim();
  if (input.color !== label.color) patch.color = input.color;
  return patch;
}

/** A chip's colours from the label's: a light tint with the colour as text, the plain look without. */
export function chipStyle(color: string | null): CSSProperties | undefined {
  if (!color) return undefined;
  return {
    backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
    color: `color-mix(in srgb, ${color} 72%, var(--color-ink))`,
    borderColor: `color-mix(in srgb, ${color} 35%, transparent)`,
  };
}
