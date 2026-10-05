import {
  ALL_DOMAINS,
  fillPlaceholders,
  type CompanySignature,
  type DomainSignatureChange,
  type DomainSignatureOverview,
  type SignatureSource,
  type SignatureText,
} from "@/lib/domainSignatures";
import { BackendError } from "./backend";
import type { Identity } from "./types";

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/** The JMAP demo mailbox's signatures per domain, as its UwUMail server would keep them, in memory. */
export class DemoSignatures {
  private domains: Record<string, SignatureText> = {};
  private overrides: Record<string, SignatureText> = {};
  private company: Record<string, CompanySignature> = {
    "uwumail.example": { mode: "footer", text: "UwUMail Studio · {name} · {adresse}", html: "" },
  };
  private state = 1;

  constructor(initial: { id: string; html: string }[]) {
    for (const entry of initial) this.overrides[entry.id] = { text: "", html: entry.html };
  }

  private forDomain(domain: string): [SignatureText, SignatureSource] {
    if (this.domains[domain]) return [this.domains[domain], "domain"];
    if (this.domains[ALL_DOMAINS]) return [this.domains[ALL_DOMAINS], "allDomains"];
    const company = this.company[domain];
    if (company?.mode === "template") return [{ text: company.text, html: company.html }, "company"];
    return [{ text: "", html: "" }, "none"];
  }

  overview(identities: Identity[]): DomainSignatureOverview {
    const domains = [...new Set(identities.map((identity) => domainOf(identity.email)))].sort();
    return structuredClone({
      state: String(this.state),
      allDomains: this.domains[ALL_DOMAINS] ?? null,
      domains: domains.map((domain) => ({
        domain,
        addressCount: identities.filter((identity) => domainOf(identity.email) === domain).length,
        signature: this.domains[domain] ?? null,
        company: this.company[domain] ?? null,
        source: this.forDomain(domain)[1],
      })),
      identities: identities.map((identity) => {
        const own = this.overrides[identity.id] ?? null;
        const [signature, source] = own ? [own, "identity" as const] : this.forDomain(domainOf(identity.email));
        return {
          id: identity.id,
          name: identity.name,
          email: identity.email,
          domain: domainOf(identity.email),
          signature: own,
          effective: {
            text: fillPlaceholders(signature.text, identity.name, identity.email, false),
            html: fillPlaceholders(signature.html, identity.name, identity.email, true),
          },
          source,
        };
      }),
    });
  }

  change(identities: Identity[], change: DomainSignatureChange): DomainSignatureOverview {
    if (change.ifInState !== undefined && change.ifInState !== String(this.state)) {
      throw new BackendError("state_mismatch", "The signatures were changed elsewhere.");
    }
    const own = new Set(identities.map((identity) => domainOf(identity.email)));
    for (const domain of Object.keys(change.domains ?? {})) {
      if (domain !== ALL_DOMAINS && !own.has(domain)) {
        throw new BackendError("invalid_input", `${domain} is not a domain of your addresses`);
      }
    }
    for (const [domain, signature] of Object.entries(change.domains ?? {})) {
      if (signature) this.domains[domain] = structuredClone(signature);
      else delete this.domains[domain];
    }
    for (const [id, signature] of Object.entries(change.identities ?? {})) {
      if (signature) this.overrides[id] = structuredClone(signature);
      else delete this.overrides[id];
    }
    this.state += 1;
    return this.overview(identities);
  }
}
