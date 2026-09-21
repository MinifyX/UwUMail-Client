import { isEmail } from "./format";

/** What unsubscribing by mail would send. */
export interface UnsubscribeMail {
  address: string;
  subject: string;
}

/**
 * Reads the `mailto:` form of `List-Unsubscribe`.
 *
 * Every part of that header was written by whoever sent the mail, and what comes out of it is a
 * message sent from the reader's own account. So only two pieces are taken, and both are held to
 * something: one address that really looks like a single address, and a subject on one line —
 * list managers match on it, so it cannot simply be dropped. The body is not taken at all. A mail
 * going out under somebody's own name should not carry text a stranger wrote.
 *
 * The engine sends the mail and applies the same rules itself (`unsubscribe_mail` in
 * crates/uwumail-core/src/engine.rs); this copy lets the dialog name the address beforehand.
 */
export function unsubscribeMail(mailto: string): UnsubscribeMail | null {
  let target: URL;
  try {
    target = new URL(mailto);
  } catch {
    return null;
  }
  if (target.protocol !== "mailto:") return null;
  let address: string;
  try {
    address = decodeURIComponent(target.pathname).trim();
  } catch {
    return null;
  }
  // One recipient, and nothing in it that could turn into a second one or into a header of its own.
  if (address.includes(",") || /[\s<>;"]/.test(address) || !isEmail(address)) return null;
  const subject = (target.searchParams.get("subject") ?? "unsubscribe").replace(/\s+/g, " ").trim().slice(0, 200);
  return { address, subject: subject || "unsubscribe" };
}
