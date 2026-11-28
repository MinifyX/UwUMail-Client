import type { ReportAbuse } from "@/backend/types";
import { isEmail } from "./format";

/** A complaint destination read from the mail itself, checked before it is shown or used. */
export interface AbuseDestination {
  kind: "url" | "mail";
  /** The exact value from the header, for the confirmation dialog. */
  value: string;
}

/**
 * The two ways a mail can offer to report abuse, in the order we prefer them.
 * Both are attacker-controlled header values, so only a syntactically valid
 * HTTPS URL or a single plain address is ever offered to the user — and the
 * full value is shown before anything is opened or sent.
 */
export function abuseDestinations(options: ReportAbuse | undefined): AbuseDestination[] {
  if (!options) return [];
  const out: AbuseDestination[] = [];
  if (options.url) {
    try {
      const parsed = new URL(options.url);
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password) {
        out.push({ kind: "url", value: parsed.toString() });
      }
    } catch {
      // Ignore a malformed header rather than offering a broken link.
    }
  }
  if (
    options.address &&
    !options.address.includes(",") &&
    !/[\s<>;"]/u.test(options.address) &&
    isEmail(options.address)
  ) {
    out.push({ kind: "mail", value: options.address });
  }
  return out;
}
