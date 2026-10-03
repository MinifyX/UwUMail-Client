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
  LabelBase,
  LabelOverlap,
  LabelRules,
} from "@/backend/types";

/** What a label has unless it says otherwise, as the server makes one. */
export const LABEL_DEFAULTS = {
  base: null,
  auto: true,
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

export type LabelProblem = "nameMissing" | "nameTooLong" | "nameTaken" | "descriptionTooLong" | "control";

// Line breaks and control characters don't belong in a name, nor do the bidi controls that would
// turn the text around it (a name shows in the list, the chips and the rules).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

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
  // A base label's description is its fixed definition, longer than an own label's may be.
  const base = except !== undefined && labels.some((label) => label.id === except && label.base);
  if (!base && [...input.description.trim()].length > LABEL_LIMITS.description) {
    problems.description = "descriptionTooLong";
  }
  return problems;
}

/**
 * The new labels a model proposed that could be saved as proposed. The model reads the mail, so a
 * mail can steer what it proposes: a name too long or with control characters isn't offered.
 */
export function usableProposals<T extends { name: string; description: string; color: string | null }>(
  proposals: readonly T[],
): T[] {
  return proposals.filter(
    (proposal) =>
      Object.keys(labelProblems({ name: proposal.name, description: proposal.description, color: proposal.color }, []))
        .length === 0,
  );
}

/** Only what changed, for `AssistLabel/set`. */
export function labelPatch(label: AssistLabel, input: AssistLabelInput): Partial<AssistLabelInput> {
  const patch: Partial<AssistLabelInput> = {};
  if (input.name.trim() !== label.name) patch.name = input.name.trim();
  // A base label's definition can't be changed; it is never sent.
  if (!label.base && input.description.trim() !== label.description) patch.description = input.description.trim();
  if (input.color !== label.color) patch.color = input.color;
  if (input.auto !== undefined && input.auto !== label.auto) patch.auto = input.auto;
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
      if (text(params.number) && text(params.amount)) {
        return t("labels.reason.invoiceNumber", { number: params.number, amount: params.amount });
      }
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
    case "account":
      if (text(params.word)) return t("labels.reason.accountWord", { word: params.word });
      if (params.code === true) return t("labels.reason.accountCode");
      break;
    case "personal":
      if (typeof params.known !== "boolean") break;
      return t(params.known ? "labels.reason.personalKnown" : "labels.reason.personalPrivate");
    case "work":
      if (params.colleague === true) return t("labels.reason.workColleague");
      if (params.known === true) return t("labels.reason.workContact");
      break;
    case "advertising": {
      const words = Array.isArray(params.words) ? params.words.filter((word) => text(word) !== null) : [];
      if (words.length === 0) break;
      return t("labels.reason.advertising", { words: words.join(", ") });
    }
    case "similar": {
      const similarity = params.similarity;
      const count = Number(params.neighbours);
      if (typeof similarity !== "number" || !Number.isFinite(similarity) || !(count > 0)) break;
      return t("labels.reason.similar", {
        count,
        percent: Math.round(Math.min(1, Math.max(0, similarity)) * 100),
      });
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

/**
 * The base labels the person deleted, in the server's order: they can be made again. `known` are
 * the ones the scope announces; an older server announces none, but one whose labels carry a
 * base knows them all.
 */
export function missingBases(
  labels: readonly Pick<AssistLabel, "base">[],
  all: readonly LabelBase[],
  known: readonly LabelBase[] = [],
): LabelBase[] {
  const candidates =
    known.length > 0 ? all.filter((base) => known.includes(base)) : labels.some((l) => l.base) ? all : [];
  const present = new Set(labels.map((label) => label.base));
  return candidates.filter((base) => !present.has(base));
}

/**
 * The overlap warning, one line per label: the same name, the meaning of a base label, or very
 * similar words (which ones). A label named twice keeps only its first, strongest reason.
 */
export function overlapLines(overlaps: readonly LabelOverlap[], t: Translate): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const overlap of overlaps) {
    if (seen.has(overlap.id)) continue;
    seen.add(overlap.id);
    switch (overlap.kind) {
      case "name":
        lines.push(t("labels.overlap.name", { name: overlap.name }));
        break;
      case "meaning":
        lines.push(t("labels.overlap.meaning", { name: overlap.name }));
        break;
      case "words":
        lines.push(t("labels.overlap.words", { name: overlap.name, words: overlap.words.join(", ") || "…" }));
        break;
    }
  }
  return lines;
}
