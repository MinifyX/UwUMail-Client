/**
 * The search field's operators, as the engine reads them (uwumail-core `search_query`): this copy
 * serves the help in the search field and the demo backend. Keep both in step.
 *
 * `from:` `to:` `subject:` `has:attachment` `is:unread` `is:flagged` `before:YYYY-MM-DD`
 * `after:YYYY-MM-DD`, `"exact phrases"`, the rest is free text. A term that isn't a known operator
 * with a valid value stays text.
 */

export interface SearchQuery {
  words: string[];
  from: string[];
  /** To or Cc. */
  to: string[];
  subject: string[];
  hasAttachment: boolean;
  unread: boolean;
  flagged: boolean;
  /** `YYYY-MM-DD`: mail from before this local day. */
  before: string | null;
  /** `YYYY-MM-DD`: mail from this local day on. */
  after: string | null;
}

/** The operators the help lists, in its order, each with an example to insert. */
export const SEARCH_OPERATORS = [
  { key: "from", example: "from:" },
  { key: "to", example: "to:" },
  { key: "subject", example: "subject:" },
  { key: "phrase", example: '""' },
  { key: "hasAttachment", example: "has:attachment" },
  { key: "unread", example: "is:unread" },
  { key: "flagged", example: "is:flagged" },
  { key: "after", example: "after:" },
  { key: "before", example: "before:" },
] as const;
export type SearchOperatorKey = (typeof SEARCH_OPERATORS)[number]["key"];

const TERM_MAX = 200;
const TERMS_MAX = 32;

function terms(input: string): [string | null, string][] {
  const out: [string | null, string][] = [];
  const chars = [...input];
  let i = 0;
  const quoted = () => {
    let value = "";
    while (i < chars.length && chars[i] !== '"') value += chars[i++];
    i++;
    return value;
  };
  while (i < chars.length) {
    if (/\s/.test(chars[i]!)) {
      i++;
      continue;
    }
    if (chars[i] === '"') {
      i++;
      out.push([null, quoted()]);
      continue;
    }
    let word = "";
    let operator: string | null = null;
    while (i < chars.length && !/\s/.test(chars[i]!)) {
      const c = chars[i++]!;
      if (c === ":" && operator === null && /^[A-Za-z]+$/.test(word)) {
        operator = word;
        word = "";
        if (chars[i] === '"') {
          i++;
          word = quoted();
          break;
        }
        continue;
      }
      word += c;
    }
    out.push([operator, word]);
  }
  return out;
}

function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function parseSearch(input: string): SearchQuery {
  const query: SearchQuery = {
    words: [],
    from: [],
    to: [],
    subject: [],
    hasAttachment: false,
    unread: false,
    flagged: false,
    before: null,
    after: null,
  };
  for (const [operator, raw] of terms(input).slice(0, TERMS_MAX)) {
    // eslint-disable-next-line no-control-regex
    const value = [...raw.replace(/[\u0000-\u001f\u007f]/g, " ")].slice(0, TERM_MAX).join("").trim();
    const lower = value.toLowerCase();
    let known = false;
    switch (operator?.toLowerCase()) {
      case "from":
      case "to":
      case "subject":
        if (value) {
          query[operator!.toLowerCase() as "from" | "to" | "subject"].push(value);
          known = true;
        }
        break;
      case "has":
        known = lower === "attachment" || lower === "attachments";
        if (known) query.hasAttachment = true;
        break;
      case "is":
        if (lower === "unread") query.unread = known = true;
        else if (lower === "flagged" || lower === "starred") query.flagged = known = true;
        break;
      case "before":
      case "after":
        known = isDay(value);
        if (known) query[operator!.toLowerCase() as "before" | "after"] = value;
        break;
    }
    if (known) continue;
    const text = operator !== null ? `${operator}:${value}` : value;
    if (text.trim()) query.words.push(text);
  }
  return query;
}

/** The local midnight a `YYYY-MM-DD` day starts at, as epoch milliseconds. */
function dayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime();
}

export interface Searchable {
  subject: string;
  from: string;
  to: string;
  body: string;
  /** ISO date. */
  date: string;
  seen: boolean;
  flagged: boolean;
  attachments: number;
}

/** Whether a mail matches, by plain substring (the demo has no index). */
export function matchesSearch(mail: Searchable, query: SearchQuery): boolean {
  const has = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle.toLowerCase());
  const all = [mail.subject, mail.from, mail.to, mail.body].join("\n");
  const time = new Date(mail.date).getTime();
  return (
    query.words.every((word) => has(all, word)) &&
    query.from.every((value) => has(mail.from, value)) &&
    query.to.every((value) => has(mail.to, value)) &&
    query.subject.every((value) => has(mail.subject, value)) &&
    (!query.hasAttachment || mail.attachments > 0) &&
    (!query.unread || !mail.seen) &&
    (!query.flagged || mail.flagged) &&
    (query.before === null || time < dayStart(query.before)) &&
    (query.after === null || time >= dayStart(query.after))
  );
}

/** The search text with `term` added at the end, one space apart. */
export function withSearchTerm(search: string, term: string): string {
  const trimmed = search.replace(/\s+$/, "");
  return trimmed ? `${trimmed} ${term}` : term;
}
