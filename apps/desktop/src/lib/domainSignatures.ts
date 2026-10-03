/**
 * Signatures per domain (the server's docs/signatures.md): one signature for all sending addresses
 * of a domain, or one for every domain (`*`); a single address may have its own. An admin may give
 * a domain a company signature: a template for people without their own, or a footer the server
 * appends to every message sent from the domain.
 *
 * What an address sends with, first match wins: its own, its domain's, every domain's, the company
 * template. The server hands that out as the address's `Identity` signature with the placeholders
 * filled, so the composer needs nothing of this; only the settings do.
 *
 * Kept free of React and of the backend, so the UwUMail apps can take it over as it is.
 */

/** The key of the signature for every domain. */
export const ALL_DOMAINS = "*";

/** The placeholders offered in the editor; `{address}` and `{email}` work as well. */
export const PLACEHOLDERS = ["{name}", "{adresse}", "{domain}"] as const;

/** Up to what the server keeps, text and HTML each (256 KiB). */
export const DOMAIN_SIGNATURE_MAX_BYTES = 262_144;

export interface SignatureText {
  text: string;
  html: string;
}

export type SignatureSource = "identity" | "domain" | "allDomains" | "company" | "none";

export type CompanySignatureMode = "off" | "template" | "footer";

export interface CompanySignature {
  mode: CompanySignatureMode;
  text: string;
  html: string;
}

export interface DomainSignatureInfo {
  domain: string;
  /** How many sending addresses the person has on it. */
  addressCount: number;
  /** The person's own signature for the domain. */
  signature: SignatureText | null;
  company: CompanySignature | null;
  /** What its addresses without one of their own use. */
  source: SignatureSource;
}

export interface IdentitySignatureInfo {
  /** The identity's id as the backend knows it. */
  id: string;
  name: string;
  email: string;
  domain: string;
  /** Its own signature, placeholders as written. */
  signature: SignatureText | null;
  /** What it sends with, placeholders filled. */
  effective: SignatureText;
  source: SignatureSource;
}

export interface DomainSignatureOverview {
  state: string;
  allDomains: SignatureText | null;
  domains: DomainSignatureInfo[];
  identities: IdentitySignatureInfo[];
}

/** A change: per domain (or `*`) and per identity id; null removes. All or nothing. */
export interface DomainSignatureChange {
  domains?: Record<string, SignatureText | null>;
  identities?: Record<string, SignatureText | null>;
}

export const EMPTY_SIGNATURE: SignatureText = { text: "", html: "" };

export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

/**
 * `template` with `{name}`, `{adresse}` (`{address}`, `{email}`) and `{domain}` filled for one
 * address, the way the server does it. In HTML the values are escaped: a name is whatever its
 * owner typed and must never turn into markup.
 */
export function fillPlaceholders(template: string, name: string, email: string, html: boolean): string {
  const domain = email.includes("@") ? email.slice(email.lastIndexOf("@") + 1) : "";
  return template.replace(/\{([^{}]{1,16})\}/g, (whole, key: string) => {
    let value: string;
    switch (key.trim().toLowerCase()) {
      case "name":
        value = name;
        break;
      case "adresse":
      case "address":
      case "email":
      case "e-mail":
        value = email;
        break;
      case "domain":
        value = domain;
        break;
      default:
        return whole;
    }
    return html ? escapeHtml(value) : value;
  });
}

export function sameSignature(a: SignatureText | null | undefined, b: SignatureText | null | undefined): boolean {
  return (a?.text ?? "") === (b?.text ?? "") && (a?.html ?? "") === (b?.html ?? "");
}

export function isEmptySignature(signature: SignatureText | null | undefined): boolean {
  return !signature || (!signature.text.trim() && !signature.html.trim());
}

/** Whether the text or the HTML is over what the server keeps (UTF-8 bytes). */
export function tooLarge(signature: SignatureText, max = DOMAIN_SIGNATURE_MAX_BYTES): boolean {
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  return bytes(signature.text) > max || bytes(signature.html) > max;
}

/** A text-only signature as HTML, line by line. */
export function textAsHtml(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => escapeHtml(line))
    .join("<br>");
}

/** The HTML to edit a signature in: its HTML, else its text as HTML. */
export function editableHtml(signature: SignatureText | null | undefined): string {
  if (!signature) return "";
  if (signature.html.trim()) return signature.html;
  return signature.text.trim() ? `<p>${textAsHtml(signature.text)}</p>` : "";
}

/** What the editor of a domain starts with, and which domains it applies to at first. */
export interface DomainEditorStart {
  signature: SignatureText;
  origin: "domain" | "allDomains" | "template" | "empty";
  targets: string[];
}

export function editorStart(overview: DomainSignatureOverview, domain: string): DomainEditorStart {
  const info = overview.domains.find((entry) => entry.domain === domain);
  if (info?.signature) return { signature: info.signature, origin: "domain", targets: [domain] };
  if (overview.allDomains) return { signature: overview.allDomains, origin: "allDomains", targets: [ALL_DOMAINS] };
  if (info?.company?.mode === "template") {
    return { signature: { text: info.company.text, html: info.company.html }, origin: "template", targets: [domain] };
  }
  return { signature: EMPTY_SIGNATURE, origin: "empty", targets: [domain] };
}

/** The targets after ticking or unticking one: "all domains" stands alone. */
export function toggleTarget(targets: string[], target: string, on: boolean, current: string): string[] {
  if (target === ALL_DOMAINS) return on ? [ALL_DOMAINS] : [current];
  const next = on
    ? [...targets.filter((entry) => entry !== ALL_DOMAINS), target]
    : targets.filter((entry) => entry !== target);
  return next.length > 0 ? [...new Set(next)] : [current];
}

/**
 * The change that gives `targets` the signature (null removes it). "All domains" stores it once
 * for every domain and drops the domains' own ones, so it really applies everywhere.
 */
export function domainChange(
  overview: DomainSignatureOverview,
  targets: string[],
  signature: SignatureText | null,
): DomainSignatureChange {
  const domains: Record<string, SignatureText | null> = {};
  if (targets.includes(ALL_DOMAINS)) {
    domains[ALL_DOMAINS] = signature;
    if (signature) for (const info of overview.domains) if (info.signature) domains[info.domain] = null;
  } else {
    for (const target of targets) domains[target] = signature;
  }
  return { domains };
}

/** The domains whose own signature "all domains" would replace, other than `current`. */
export function replacedByAllDomains(overview: DomainSignatureOverview, current: string): string[] {
  return overview.domains.filter((info) => info.signature && info.domain !== current).map((info) => info.domain);
}

export function identitiesOf(overview: DomainSignatureOverview, domain: string): IdentitySignatureInfo[] {
  return overview.identities.filter((identity) => identity.domain === domain);
}

/** The signature as one address sends it, placeholders filled. */
export function previewFor(signature: SignatureText, identity: { name: string; email: string }): SignatureText {
  return {
    text: fillPlaceholders(signature.text, identity.name, identity.email, false),
    html: fillPlaceholders(signature.html, identity.name, identity.email, true),
  };
}

/** The company footer the server adds to mail from `email`, when the domain's admin set one. */
export function companyFooterFor(
  overview: DomainSignatureOverview | null | undefined,
  email: string,
): SignatureText | null {
  if (!overview || !email.includes("@")) return null;
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  const company = overview.domains.find((info) => info.domain === domain)?.company;
  return company?.mode === "footer" ? { text: company.text, html: company.html } : null;
}
