/**
 * Senders whose remote images load without asking. An entry is either one
 * address (`orders@shop.example`) or a whole company domain (`@shop.example`),
 * which also covers its subdomains (`news@mail.shop.example`).
 */

export function domainEntry(domain: string): string {
  return `@${domain.toLowerCase()}`;
}

export function isDomainEntry(entry: string): boolean {
  return entry.startsWith("@");
}

/** The entries in `trusted` that allow remote images for `email`. */
export function matchingEntries(email: string, trusted: readonly string[]): string[] {
  const address = email.trim().toLowerCase();
  const host = address.slice(address.lastIndexOf("@") + 1);
  if (!host || !address.includes("@")) return [];
  return trusted.filter((entry) => {
    if (!isDomainEntry(entry)) return entry === address;
    const domain = entry.slice(1);
    return domain !== "" && (host === domain || host.endsWith(`.${domain}`));
  });
}

/** Domains first, then addresses, each alphabetically. */
export function sortEntries(trusted: readonly string[]): string[] {
  const key = (entry: string) => (isDomainEntry(entry) ? entry.slice(1) : entry.slice(entry.indexOf("@") + 1));
  return [...trusted].sort(
    (a, b) => Number(isDomainEntry(b)) - Number(isDomainEntry(a)) || key(a).localeCompare(key(b)) || a.localeCompare(b),
  );
}
