/**
 * Templates: text snippets the composer puts in at the cursor. They follow the account as
 * `template:<id>` (lib/settingsSync), with an id of 16 random characters.
 *
 * Placeholders, filled in when the template goes into a draft: `{firstName}` and `{name}` of the
 * first recipient (the address's local part when it has no name), `{date}` (today, in the app's
 * language) and `{myName}` (the sender's name). Anything else in braces stays as written.
 */

import type { Address } from "@/backend/types";
import { escapeHtml } from "@/lib/format";
import { foreignHtml } from "@/lib/safeHtml";
import type { MailTemplate } from "@/state/settings";

export const TEMPLATE_PLACEHOLDERS = ["firstName", "name", "date", "myName"] as const;
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];
export type TemplateValues = Record<TemplatePlaceholder, string>;

export const TEMPLATE_NAME_MAX = 100;
export const TEMPLATE_SUBJECT_MAX = 998;

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** A new template's id: 16 characters of `[A-Za-z0-9_-]`, 96 random bits. */
export function newTemplateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // 64 characters: a byte modulo 64 is unbiased.
  return [...bytes].map((byte) => ID_ALPHABET[byte % 64]).join("");
}

/** The placeholders' values for a draft. */
export function templateValues({
  to,
  myName,
  language,
  now = new Date(),
}: {
  to: Address[];
  myName: string;
  language: string;
  now?: Date;
}): TemplateValues {
  const first = to[0];
  const name = first?.name?.trim() || first?.email.split("@")[0] || "";
  return {
    firstName: name.split(/\s+/)[0] ?? "",
    name,
    date: now.toLocaleDateString(language, { dateStyle: "long" }),
    myName: myName.trim(),
  };
}

const PLACEHOLDER = /\{(firstName|name|date|myName)\}/g;

/** Plain text (the subject) with its placeholders filled in. */
export function fillText(text: string, values: TemplateValues): string {
  return text.replace(PLACEHOLDER, (_, key: TemplatePlaceholder) => values[key]);
}

/** HTML with its placeholders filled in; the values go in as text. */
export function fillHtml(html: string, values: TemplateValues): string {
  return html.replace(PLACEHOLDER, (_, key: TemplatePlaceholder) => escapeHtml(values[key]));
}

/**
 * The markup a template puts into a draft: filled in, and cleaned like a signature, since it may
 * come from another device (no scripts, none of the app's own `data-uwu-*` markers).
 */
export function templateHtml(html: string, values: TemplateValues): string {
  return foreignHtml(fillHtml(html, values));
}

/** Templates by name, for menus and the settings list. */
export function sortedTemplates(templates: Record<string, MailTemplate>): [string, MailTemplate][] {
  return Object.entries(templates).sort(([, a], [, b]) => a.name.localeCompare(b.name));
}

/** A template's name cut to what the server takes, without control characters. */
export function cleanTemplateName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return [...name.replace(/[\u0000-\u001f\u007f]/g, " ").trim()].slice(0, TEMPLATE_NAME_MAX).join("");
}

/** A subject cut to what the server takes, without control characters. */
export function cleanTemplateSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  return [...subject.replace(/[\u0000-\u001f\u007f]/g, " ")].slice(0, TEMPLATE_SUBJECT_MAX).join("");
}
