import type { Account, Address, Identity, Message } from "@/backend/types";
import { escapeHtml, formatAddress, formatFullDate, textToHtml } from "@/lib/format";
import { quotableHtml } from "@/lib/safeHtml";
import type { ComposeRequest } from "@/state/ui";

export interface DraftState {
  accountId: string;
  /** One of the account's other addresses, empty for its own; null picks the one a reply was sent to. */
  fromEmail: string | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

function prefixed(prefix: "Re" | "Fwd", subject: string) {
  // Only the mode's own family counts: a forward of "Re: …" still becomes "Fwd: Re: …".
  const pattern = prefix === "Re" ? /^(re|aw):\s*/i : /^(fwd|fw|wg):\s*/i;
  return pattern.test(subject) ? subject : `${prefix}: ${subject}`;
}

function quoted(message: Message) {
  return message.bodyHtml ? quotableHtml(message.bodyHtml, { foreign: true }) : textToHtml(message.bodyText ?? "");
}

/**
 * The address a reply comes from: the one of the mailbox's addresses the mail was sent from or
 * to. Empty means the mailbox's own address.
 */
export function replyFrom(source: Message, identities: Identity[]): string {
  // My own mail: the address I sent it from.
  const addressed = new Set([source.from, ...source.to, ...source.cc].map((a) => a.email.toLowerCase()));
  const match = identities.find(
    (i) => i.accountId === source.accountId && !i.primary && addressed.has(i.email.toLowerCase()),
  );
  return match?.email ?? "";
}

export function initialDraft(
  request: ComposeRequest,
  accounts: Account[],
  identities: Identity[],
  t: Translate,
  locale: string,
): DraftState {
  if (request.restore) {
    const { accountId, to, cc, bcc, subject, html, fromEmail } = request.restore;
    const own = accounts.find((a) => a.id === accountId)?.email.toLowerCase();
    return {
      accountId,
      fromEmail: fromEmail?.toLowerCase() === own ? "" : (fromEmail ?? ""),
      to,
      cc,
      bcc,
      subject,
      // A restored body goes into the composer itself, not into the reader's sandboxed frame, and
      // it does not always come from the person writing it: a draft read back from the server is
      // whatever that mail holds. It goes through the same cleaning as a quote, which is also what
      // sending would do to it anyway.
      html: quotableHtml(html),
    };
  }
  const source = request.source;
  const accountId = source?.accountId ?? accounts[0]?.id ?? "";
  const empty: DraftState = {
    accountId,
    fromEmail: source ? null : "",
    to: request.to ?? [],
    cc: request.cc ?? [],
    bcc: request.bcc ?? [],
    subject: request.subject ?? "",
    html: request.body ? textToHtml(request.body) : "",
  };
  if (!source) return empty;

  const date = formatFullDate(source.date, locale);
  const name = escapeHtml(source.from.name ?? source.from.email);

  if (request.mode === "forward") {
    const header = [
      `---------- ${escapeHtml(t("compose.forwardHeader"))} ----------`,
      `${escapeHtml(t("compose.from"))}: ${escapeHtml(formatAddress(source.from))}`,
      `${escapeHtml(t("compose.subject"))}: ${escapeHtml(source.subject)}`,
      date,
    ].join("<br>");
    return {
      ...empty,
      subject: prefixed("Fwd", source.subject),
      html: `<p><br></p><p>${header}</p>${quoted(source)}`,
    };
  }

  const mine = new Set([...accounts, ...identities].map((a) => a.email.toLowerCase()));
  // A reply to my own mail goes to the people it went to, not back to me.
  const fromMe = mine.has(source.from.email.toLowerCase()) && source.to.length > 0;
  const replyTo = source.replyTo.length > 0 ? source.replyTo : fromMe ? source.to : [source.from];
  // Each address once, in To before Cc, and none of mine in reply all.
  const seen = request.mode === "replyAll" ? new Set(mine) : new Set<string>();
  const fresh = (a: Address) => !seen.has(a.email.toLowerCase()) && !!seen.add(a.email.toLowerCase());
  const to = (request.mode === "replyAll" ? [...replyTo, ...source.to] : replyTo).filter(fresh);
  const cc = request.mode === "replyAll" ? source.cc.filter(fresh) : [];
  const header = escapeHtml(t("compose.quoteHeader", { date, name: "%%NAME%%" })).replace("%%NAME%%", name);
  return {
    ...empty,
    to: to.length > 0 ? to : replyTo,
    cc,
    subject: prefixed("Re", source.subject),
    html: `<p><br></p><p>${header}</p><blockquote>${quoted(source)}</blockquote>`,
  };
}
