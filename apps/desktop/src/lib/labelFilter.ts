import type { AssistLabel, LabelRef, Message } from "@/backend/types";

/**
 * A label with where it lives: a UwUMail account's server keeps that account's labels, this
 * device the labels of every other mailbox. The same name elsewhere is another label.
 */
export interface LabelEntry {
  /** The assistant scope: the UwUMail account's id, or "device". */
  scope: string;
  /** The mailboxes whose mail it can be on. */
  accountIds: string[];
  label: AssistLabel;
}

export function labelRef(entry: LabelEntry): LabelRef {
  return { keyword: entry.label.keyword, accountIds: entry.accountIds };
}

export function hasLabel(message: Pick<Message, "accountId" | "keywords">, ref: LabelRef): boolean {
  return (
    ref.accountIds.includes(message.accountId) && (message.keywords ?? []).includes(ref.keyword.trim().toLowerCase())
  );
}

/** Every group holds when any of its labels is on the mail, as the engine filters. */
export function matchesLabels(message: Pick<Message, "accountId" | "keywords">, groups: readonly LabelRef[][]) {
  return groups.every((group) => group.some((ref) => hasLabel(message, ref)));
}

/** `label:Rechnungen`, `label:"Zwei Worte"` (also `labels:`), anywhere in the search text. */
const LABEL_TERM = /(^|\s)labels?:(?:"([^"]*)"|(\S+))/gi;

/** Takes `label:<name>` terms out of a search: the names, and the text that is left to search for. */
export function splitLabelSearch(search: string): { text: string; names: string[] } {
  const names: string[] = [];
  const text = search.replace(LABEL_TERM, (_, space: string, quoted?: string, bare?: string) => {
    const name = (quoted ?? bare ?? "").trim();
    if (name) names.push(name);
    return space;
  });
  return { text: text.replace(/\s+/g, " ").trim(), names };
}

/**
 * The label filters of `label:` names: per name, the labels of that name (or keyword) in any
 * scope. A name no label has matches nothing, so the list says "no results" instead of ignoring it.
 */
export function labelGroups(names: readonly string[], directory: readonly LabelEntry[]): LabelRef[][] {
  return names.map((name) => {
    const wanted = name.trim().toLowerCase();
    return directory
      .filter((entry) => entry.label.name.trim().toLowerCase() === wanted || entry.label.keyword === wanted)
      .map(labelRef);
  });
}

/** The labels of the directory a mail carries, in the order the person keeps them. */
export function entriesOn(message: Pick<Message, "accountId" | "keywords">, directory: readonly LabelEntry[]) {
  return directory.filter((entry) => hasLabel(message, labelRef(entry)));
}

/** Label names for the search field's suggestions, quoted when they hold a space. */
export function labelTerm(name: string): string {
  return /\s/.test(name) ? `label:"${name.replace(/"/g, "")}"` : `label:${name}`;
}

/** A section of the list grouped by label; `entry` null holds the mail without any label. */
export interface LabelSection<T> {
  entry: LabelEntry | null;
  items: T[];
}

/**
 * The list in sections per label, in the order the labels are kept; a conversation with several
 * labels sits under its first, so every row shows once. Mail without a label comes last.
 */
export function groupByLabel<T extends { accountIds: string[]; keywords?: string[] }>(
  items: readonly T[],
  directory: readonly LabelEntry[],
): LabelSection<T>[] {
  const sections: LabelSection<T>[] = directory.map((entry) => ({ entry, items: [] }));
  const rest: T[] = [];
  for (const item of items) {
    const accountId = item.accountIds[0] ?? "";
    const index = directory.findIndex((entry) => hasLabel({ accountId, keywords: item.keywords }, labelRef(entry)));
    if (index >= 0) sections[index]!.items.push(item);
    else rest.push(item);
  }
  const out = sections.filter((section) => section.items.length > 0);
  if (rest.length > 0) out.push({ entry: null, items: rest });
  return out;
}
