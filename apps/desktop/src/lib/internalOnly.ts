// Mailboxes their UwUMail server lets send only to addresses it hosts itself (UwUMail-Server 0.27:
// `uwuInternalOnly` and `uwuInternalDomains` in the session). The server refuses other recipients;
// the composer shows them beforehand and doesn't send while there are any. The engine checks the
// same again before anything goes out (crates/uwumail-core/src/internal_only.rs).

import type { Address } from "@/backend/types";

/**
 * A domain as it is compared: trimmed, without a final dot, in lower case, in its ASCII (punycode)
 * form like the server lists it. Anything but letters, digits, dots and hyphens (or non-ASCII
 * letters) is kept as typed, so `/ \\ ? # : @` can't be stripped away by URL parsing into a hosted
 * host; such a string never matches.
 */
function normalDomain(domain: string): string | null {
  const normal = domain.trim().replace(/\.+$/, "").toLowerCase();
  if (!normal || /[\s@<>]/.test(normal)) return null;
  if (!/^[a-z0-9.\-\u0080-\uffff]+$/.test(normal)) return normal;
  try {
    const host = new URL(`http://${normal}/`).hostname;
    return host || normal;
  } catch {
    return normal;
  }
}

/** The domain of an address (`mini+news@Example.COM` → `example.com`), also of `Name <a@b>`. */
export function domainOf(address: string): string | null {
  const bracketed = /<([^<>]*)>\s*$/.exec(address);
  const bare = (bracketed ? bracketed[1]! : address).trim();
  const at = bare.lastIndexOf("@");
  if (at <= 0) return null;
  return normalDomain(bare.slice(at + 1));
}

/** Whether mail to `email` stays on one of `domains` (the server's own, already in lower case). */
export function isInternal(email: string, domains: readonly string[]): boolean {
  const domain = domainOf(email);
  return domain !== null && domains.some((known) => normalDomain(known) === domain);
}

/** The recipients a mailbox restricted to `domains` can't send to, each once; none without a restriction. */
export function undeliverableRecipients(recipients: readonly Address[], domains: readonly string[] | null): Address[] {
  if (!domains || domains.length === 0) return [];
  const seen = new Set<string>();
  return recipients.filter((address) => {
    const key = address.email.trim().toLowerCase();
    if (isInternal(address.email, domains) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
