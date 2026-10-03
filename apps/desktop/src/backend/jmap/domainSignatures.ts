/**
 * Signatures per domain over the server's own extension `urn:uwumail:jmap:signatures`
 * (`SignatureSettings/get`, `SignatureSettings/set`; the server's docs/jmap-signatures.md).
 * The rules themselves are in lib/domainSignatures.
 */

import type {
  CompanySignature,
  DomainSignatureInfo,
  DomainSignatureOverview,
  IdentitySignatureInfo,
  SignatureSource,
  SignatureText,
} from "@/lib/domainSignatures";

export const SIGNATURES = "urn:uwumail:jmap:signatures";

const SOURCES: readonly SignatureSource[] = ["identity", "domain", "allDomains", "company", "none"];

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function signatureFrom(value: unknown): SignatureText | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { text?: unknown; html?: unknown };
  return { text: str(raw.text), html: str(raw.html) };
}

function companyFrom(value: unknown): CompanySignature | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { mode?: unknown; text?: unknown; html?: unknown };
  const mode = raw.mode === "template" || raw.mode === "footer" ? raw.mode : null;
  return mode ? { mode, text: str(raw.text), html: str(raw.html) } : null;
}

function sourceFrom(value: unknown): SignatureSource {
  return SOURCES.includes(value as SignatureSource) ? (value as SignatureSource) : "none";
}

/** What `SignatureSettings/get` answers, checked field by field: the server is trusted, its data isn't. */
export function overviewFrom(raw: Record<string, unknown>): DomainSignatureOverview {
  const list = (value: unknown) => (Array.isArray(value) ? (value as Record<string, unknown>[]) : []);
  const domains: DomainSignatureInfo[] = list(raw.domains)
    .filter((entry) => typeof entry.domain === "string")
    .map((entry) => ({
      domain: str(entry.domain),
      addressCount: typeof entry.addressCount === "number" ? entry.addressCount : 0,
      signature: signatureFrom(entry.signature),
      company: companyFrom(entry.company),
      source: sourceFrom(entry.source),
    }));
  const identities: IdentitySignatureInfo[] = list(raw.identities)
    .filter((entry) => typeof entry.id === "string" && typeof entry.email === "string")
    .map((entry) => ({
      id: str(entry.id),
      name: str(entry.name),
      email: str(entry.email),
      domain: str(entry.domain),
      signature: signatureFrom(entry.signature),
      effective: signatureFrom(entry.effective) ?? { text: "", html: "" },
      source: sourceFrom(entry.source),
    }));
  return { state: str(raw.state), allDomains: signatureFrom(raw.allDomains), domains, identities };
}
