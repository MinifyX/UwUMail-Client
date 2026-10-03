/**
 * Signatures per domain in the app, on top of lib/domainSignatures (the webmail's rules, kept
 * byte-identical).
 *
 * Addresses a UwUMail server with `urn:uwumail:jmap:signatures` knows follow the server: one
 * signature per domain, for every domain, or per address, which the server hands out with the
 * placeholders filled. Every other address (Gmail, Outlook, IMAP, older UwUMail servers) gets the
 * same idea on this device: a device signature whose `email` is `@domain` is the one for all
 * addresses of that domain, `*` the one for every such domain. Device signatures of a single
 * address stay as they were (several per address, for new mail and for replies) and win over
 * everything else, on this device.
 *
 * What an address sends with, first match wins:
 *   1. its own device signatures,
 *   2. on a server with signatures per domain: the server's effective signature (and nothing else),
 *   3. the device signature of its domain,
 *   4. the device signature for every domain.
 */

import type { AccountDomainSignatures, Identity, Signature } from "@/backend/types";
import {
  ALL_DOMAINS,
  companyFooterFor,
  editableHtml,
  fillPlaceholders,
  type DomainSignatureChange,
  type DomainSignatureOverview,
  type IdentitySignatureInfo,
  type SignatureSource,
  type SignatureText,
} from "./domainSignatures";
import { htmlToPlainText } from "./safeHtml";

export function domainOfAddress(email: string): string {
  return email.includes("@") ? email.slice(email.lastIndexOf("@") + 1).toLowerCase() : "";
}

/** The `email` of the device signature for a domain, or for every domain (`*`). */
export function deviceKey(domain: string): string {
  return domain === ALL_DOMAINS ? ALL_DOMAINS : `@${domain.toLowerCase()}`;
}

/** A device signature for a domain or for every domain, not for one address. */
export function isDomainSignature(signature: Signature): boolean {
  return signature.email === ALL_DOMAINS || signature.email.startsWith("@");
}

function deviceSignature(signatures: Signature[], domain: string): Signature | undefined {
  const key = deviceKey(domain);
  return signatures.find((signature) => signature.email.toLowerCase() === key);
}

function asText(signature: Signature | undefined): SignatureText | null {
  return signature ? { text: htmlToPlainText(signature.html).trim(), html: signature.html } : null;
}

/** The server's view of one address: its account's overview and its entry there. */
export function serverIdentity(
  servers: AccountDomainSignatures[] | undefined,
  identity: Pick<Identity, "accountId" | "email">,
): { server: AccountDomainSignatures; info: IdentitySignatureInfo } | null {
  const email = identity.email.toLowerCase();
  for (const server of servers ?? []) {
    if (server.accountId !== identity.accountId) continue;
    const info = server.overview.identities.find((entry) => entry.email.toLowerCase() === email);
    if (info) return { server, info };
  }
  return null;
}

/** The addresses whose signatures stay on this device: those no server with signatures per domain knows. */
export function deviceIdentities(identities: Identity[], servers: AccountDomainSignatures[] | undefined): Identity[] {
  return identities.filter((identity) => !serverIdentity(servers, identity));
}

/**
 * The device's signatures per domain in the shape of the server's overview, so the same editor
 * and the same rules ("applies to", "all domains") work on them. `identities` are the device
 * addresses (see deviceIdentities).
 */
export function deviceOverview(identities: Identity[], signatures: Signature[]): DomainSignatureOverview {
  const allDomains = asText(deviceSignature(signatures, ALL_DOMAINS));
  const domainNames = [...new Set(identities.map((identity) => domainOfAddress(identity.email)))]
    .filter(Boolean)
    .sort();
  const own = (identity: Identity) =>
    signatures.some((signature) => signature.email.toLowerCase() === identity.email.toLowerCase());
  const sourceOf = (domain: string): SignatureSource =>
    deviceSignature(signatures, domain) ? "domain" : allDomains ? "allDomains" : "none";
  const domains = domainNames.map((domain) => ({
    domain,
    addressCount: identities.filter((identity) => domainOfAddress(identity.email) === domain).length,
    signature: asText(deviceSignature(signatures, domain)),
    company: null,
    source: sourceOf(domain),
  }));
  const relevant = signatures.filter(isDomainSignature).map((signature) => `${signature.id}:${signature.html}`);
  return {
    state: `device:${checksum(relevant.join("\n"))}`,
    allDomains,
    domains,
    identities: identities.map((identity) => {
      const domain = domainOfAddress(identity.email);
      const fallback = asText(deviceSignature(signatures, domain)) ?? allDomains ?? { text: "", html: "" };
      return {
        id: identity.id,
        name: identity.name,
        email: identity.email,
        domain,
        // Own device signatures are listed by address, not here.
        signature: null,
        effective: {
          text: fillPlaceholders(fallback.text, identity.name, identity.email, false),
          html: fillPlaceholders(fallback.html, identity.name, identity.email, true),
        },
        source: own(identity) ? "identity" : sourceOf(domain),
      };
    }),
  };
}

/** A short fingerprint, enough to tell one state of the device's signatures from the next. */
function checksum(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  return hash.toString(36);
}

/** What a change of the device's signatures per domain means: signatures to save and ids to delete. */
export function deviceChange(
  change: DomainSignatureChange,
  signatures: Signature[],
): { save: Signature[]; remove: string[] } {
  const save: Signature[] = [];
  const remove: string[] = [];
  for (const [domain, value] of Object.entries(change.domains ?? {})) {
    const existing = deviceSignature(signatures, domain);
    const html = value ? editableHtml(value) : "";
    if (!html) {
      if (existing) remove.push(existing.id);
      continue;
    }
    save.push({ id: existing?.id ?? "", email: deviceKey(domain), name: "", html, forNew: true, forReplies: true });
  }
  return { save, remove };
}

export interface SignatureLabels {
  /** The menu name of a domain's signature. */
  domain: (domain: string) => string;
  allDomains: string;
}

/**
 * The signatures the composer offers, per address and in the order above: an address with own
 * device signatures gets those, else one that stands for its server's, domain's or every domain's.
 * Placeholders are filled for the address; the server's come filled already.
 */
export function senderSignatures(
  identities: Identity[],
  signatures: Signature[],
  servers: AccountDomainSignatures[] | undefined,
  labels: SignatureLabels,
): Signature[] {
  const fill = (signature: Signature, identity: { name: string; email: string } | undefined): Signature =>
    identity
      ? { ...signature, html: fillPlaceholders(signature.html, identity.name, identity.email, true) }
      : signature;
  const byEmail = (email: string) =>
    identities.find((identity) => identity.email.toLowerCase() === email.toLowerCase());
  // Every own device signature, also of addresses not (yet) set up here, as before.
  const result = signatures
    .filter((signature) => !isDomainSignature(signature))
    .map((signature) => fill(signature, byEmail(signature.email)));
  const seen = new Set(result.map((signature) => signature.email.toLowerCase()));
  for (const identity of identities) {
    const email = identity.email.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    const domain = domainOfAddress(email);
    const found = serverIdentity(servers, identity);
    if (found) {
      const html = editableHtml(found.info.effective);
      if (html) {
        result.push({
          id: `server:${identity.accountId}:${found.info.id}`,
          email: identity.email,
          name: labels.domain(domain),
          html,
          forNew: true,
          forReplies: true,
        });
      }
      continue;
    }
    const own = deviceSignature(signatures, domain);
    const fallback = own ?? deviceSignature(signatures, ALL_DOMAINS);
    if (!fallback) continue;
    result.push(
      fill(
        {
          ...fallback,
          id: `${fallback.id}:${email}`,
          email: identity.email,
          name: own ? labels.domain(domain) : labels.allDomains,
          forNew: true,
          forReplies: true,
        },
        identity,
      ),
    );
  }
  return result;
}

/** The company footer the server of `email`'s account appends on sending, if its admin set one. */
export function companyFooterForSender(
  servers: AccountDomainSignatures[] | undefined,
  accountId: string,
  email: string,
): SignatureText | null {
  const found = serverIdentity(servers, { accountId, email });
  return found ? companyFooterFor(found.server.overview, email) : null;
}
