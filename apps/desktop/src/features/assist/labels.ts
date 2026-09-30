/**
 * The person's labels on mail, as the assistant keeps them: a label is a JMAP keyword on the
 * email, so the chips are read from the mail's own keywords, and the log says which of them the
 * model set and why.
 */

import type { CSSProperties } from "react";
import type {
  AssistLabel,
  AssistLabelInput,
  AssistLabelLogEntry,
  LabelCondition,
  LabelDetector,
  LabelRules,
} from "@/backend/types";

/** What a label has unless it says otherwise, as the server makes one. */
export const LABEL_DEFAULTS = {
  rules: null,
  detector: null,
  learnSenders: true,
  classifier: true,
  totalEmails: null,
  unreadEmails: null,
  examples: 0,
} as const satisfies Omit<AssistLabel, "id" | "name" | "description" | "keyword" | "color">;

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
export const STARTER_LABELS: readonly { id: StarterLabel; color: string; detector: LabelDetector | null }[] = [
  { id: "invoices", color: "#f59e0b", detector: "invoice" },
  { id: "newsletters", color: "#8b5cf6", detector: "newsletter" },
  { id: "orders", color: "#0ea5e9", detector: "shipping" },
  { id: "travel", color: "#14b8a6", detector: null },
  { id: "appointments", color: "#e11d74", detector: "appointment" },
  { id: "personal", color: "#10b981", detector: null },
];

/** The starter labels that aren't there yet (by name, ignoring case), as ready inputs. */
export function missingStarters(
  labels: readonly AssistLabel[],
  text: (id: StarterLabel) => { name: string; description: string },
): AssistLabelInput[] {
  const taken = new Set(labels.map((label) => label.name.trim().toLowerCase()));
  return STARTER_LABELS.map(({ id, color, detector }) => ({
    ...text(id),
    color,
    ...(detector ? { detector } : {}),
  })).filter((input) => !taken.has(input.name.trim().toLowerCase()));
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
  if (input.rules !== undefined && JSON.stringify(cleanRules(input.rules)) !== JSON.stringify(label.rules)) {
    patch.rules = cleanRules(input.rules);
  }
  if (input.detector !== undefined && input.detector !== label.detector) patch.detector = input.detector;
  if (input.learnSenders !== undefined && input.learnSenders !== label.learnSenders) {
    patch.learnSenders = input.learnSenders;
  }
  if (input.classifier !== undefined && input.classifier !== label.classifier) patch.classifier = input.classifier;
  return patch;
}

/** Rules as they are saved: trimmed values, empty conditions left out, none without any. */
export function cleanRules(rules: LabelRules | null): LabelRules | null {
  const conditions = (rules?.conditions ?? [])
    .map((condition) => ({ field: condition.field, value: condition.value.trim() }))
    .filter((condition) => condition.value !== "");
  return rules && conditions.length > 0 ? { match: rules.match, conditions } : null;
}

/** The longest value of a condition, as the server takes it. */
export const CONDITION_MAX_CHARS = 200;

/** Per condition what is wrong with it: too long, or a control character. Empty ones are left out on saving. */
export function conditionProblems(rules: LabelRules | null): ("tooLong" | "control" | null)[] {
  return (rules?.conditions ?? []).map((condition) => {
    const value = condition.value.trim();
    if ([...value].length > CONDITION_MAX_CHARS) return "tooLong";
    if (CONTROL.test(value)) return "control";
    return null;
  });
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

type Translate = (key: string, options?: Record<string, unknown>) => string;

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/** What a condition of a label's rules says, in the person's language. */
export function conditionText(condition: LabelCondition, t: Translate): string {
  switch (condition.field) {
    case "from":
      return t("labels.reason.from", { value: condition.value });
    case "subject":
      return t("labels.reason.subject", { value: condition.value });
    case "text":
      return t("labels.reason.text", { value: condition.value });
    case "hasAttachment":
      return condition.value === "false" ? t("labels.reason.noAttachment") : t("labels.reason.attachment");
  }
}

/**
 * Why a label went on by itself, in the person's language: from the log entry's `code` and
 * `params`, or the entry's own sentence (the model's words, or a code this version doesn't know).
 */
export function labelReason(entry: Pick<AssistLabelLogEntry, "code" | "params" | "reason">, t: Translate): string {
  const params = entry.params;
  switch (entry.code) {
    case "rule": {
      const conditions = Array.isArray(params.conditions) ? (params.conditions as LabelCondition[]) : [];
      if (conditions.length === 0) break;
      const joined = conditions
        .map((condition) => conditionText(condition, t))
        .join(params.match === "any" ? t("labels.reason.or") : t("labels.reason.and"));
      return t("labels.reason.rule", { conditions: joined });
    }
    case "sender":
      if (!text(params.address)) break;
      return t("labels.reason.sender", { address: params.address, count: Number(params.count) || 2 });
    case "invoice":
      if (text(params.attachment)) return t("labels.reason.invoiceAttachment", { name: params.attachment });
      if (!text(params.word)) break;
      return text(params.amount)
        ? t("labels.reason.invoiceAmount", { word: params.word, amount: params.amount })
        : t("labels.reason.invoiceWord", { word: params.word });
    case "appointment":
      if (params.calendar === true) return t("labels.reason.appointmentCalendar");
      if (!text(params.word)) break;
      return t("labels.reason.appointment", { word: params.word, date: params.date ?? "", time: params.time ?? "" });
    case "newsletter":
      if (!text(params.header)) break;
      return t("labels.reason.newsletter", { header: params.header });
    case "shipping": {
      const parts = [
        text(params.carrier),
        text(params.tracking) && t("labels.reason.tracking", { number: params.tracking }),
      ];
      const known = parts.filter(Boolean);
      return known.length > 0
        ? t("labels.reason.shipping", { details: known.join(", ") })
        : t("labels.reason.shippingPlain");
    }
    case "classifier": {
      const probability = Number(params.probability);
      if (!Number.isFinite(probability)) break;
      return t("labels.reason.classifier", {
        count: Number(params.examples) || 0,
        percent: Math.floor(probability * 1000) / 10,
      });
    }
  }
  return entry.reason;
}
