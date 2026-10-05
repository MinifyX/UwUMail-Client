/**
 * Masked addresses as the settings list them and the form checks them, with the server's limits
 * (see the server's docs/jmap-masked-email.md), so a mistake shows next to its field instead of
 * coming back from the server.
 */

import type { MaskedAddress, MaskedAddressInput, MaskedState } from "@/backend/types";

/** What the list shows: active ones (waiting for their first mail or on), off, or deleted. */
export type MaskedFilter = "active" | "disabled" | "deleted";

export const MASKED_FILTERS: readonly MaskedFilter[] = ["active", "disabled", "deleted"];

export const MASKED_LIMITS = { description: 200, forDomain: 200, url: 2000, prefix: 64 } as const;

const PREFIX = /^[a-z0-9_]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function filterOf(state: MaskedState): MaskedFilter {
  return state === "pending" || state === "enabled" ? "active" : state;
}

/** Newest first; the same moment keeps the higher id (the later one) on top. */
export function newestFirst(list: MaskedAddress[]): MaskedAddress[] {
  const time = (item: MaskedAddress) => Date.parse(item.createdAt) || 0;
  return [...list].sort((a, b) => time(b) - time(a) || b.id.length - a.id.length || b.id.localeCompare(a.id));
}

/** The ones in the chosen filter whose address, note, site or link contains the search text. */
export function visibleMasked(list: MaskedAddress[], filter: MaskedFilter, search: string): MaskedAddress[] {
  const wanted = search.trim().toLowerCase();
  return newestFirst(list).filter(
    (item) =>
      filterOf(item.state) === filter &&
      (!wanted ||
        [item.email, item.description, item.forDomain, item.url ?? ""].some((text) =>
          text.toLowerCase().includes(wanted),
        )),
  );
}

export function countByFilter(list: MaskedAddress[]): Record<MaskedFilter, number> {
  const counts: Record<MaskedFilter, number> = { active: 0, disabled: 0, deleted: 0 };
  for (const item of list) counts[filterOf(item.state)] += 1;
  return counts;
}

/**
 * The site as password managers write it, an origin like `https://shop.example`: a bare host
 * name gets `https://`, a whole link is cut down to its origin. Anything else stays as typed.
 */
export function siteOrigin(input: string): string {
  const text = input.trim();
  if (!text) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    ? text
    : /^[^\s/:]+\.[^\s/:]+(?:[:/].*)?$/.test(text)
      ? `https://${text}`
      : null;
  if (!withScheme) return text;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return text;
    return url.origin;
  } catch {
    return text;
  }
}

/** The site without `https://`, for showing it. */
export function siteLabel(forDomain: string): string {
  return forDomain.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** A link that may be opened from the list: http(s) only. */
export function openableUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export type MaskedField = "description" | "forDomain" | "url" | "emailPrefix";

/** Why a field doesn't work: too long, a character the server refuses, or (the prefix) the wrong letters. */
export type MaskedProblem = "tooLong" | "control" | "spaces" | "prefix";

export interface MaskedForm {
  description: string;
  forDomain: string;
  url: string;
  emailPrefix?: string;
}

/** What the server would refuse, by field; empty when it would take it. */
export function maskedProblems(form: MaskedForm): Partial<Record<MaskedField, MaskedProblem>> {
  const problems: Partial<Record<MaskedField, MaskedProblem>> = {};
  const text = (field: "description" | "forDomain", value: string) => {
    if (value.length > MASKED_LIMITS[field]) problems[field] = "tooLong";
    else if (CONTROL.test(value)) problems[field] = "control";
  };
  text("description", form.description.trim());
  text("forDomain", siteOrigin(form.forDomain));
  const url = form.url.trim();
  if (url.length > MASKED_LIMITS.url) problems.url = "tooLong";
  else if (CONTROL.test(url)) problems.url = "control";
  else if (/\s/.test(url)) problems.url = "spaces";
  const prefix = (form.emailPrefix ?? "").trim().toLowerCase();
  if (prefix && (prefix.length > MASKED_LIMITS.prefix || !PREFIX.test(prefix))) problems.emailPrefix = "prefix";
  return problems;
}

/** The form as the server takes it: trimmed, the site as an origin, the prefix in lower case. */
export function maskedInput(form: MaskedForm, domain?: string): MaskedAddressInput {
  const prefix = (form.emailPrefix ?? "").trim().toLowerCase();
  const url = form.url.trim();
  return {
    description: form.description.trim(),
    forDomain: siteOrigin(form.forDomain),
    url: url || null,
    ...(prefix ? { emailPrefix: prefix } : {}),
    ...(domain ? { domain } : {}),
  };
}
