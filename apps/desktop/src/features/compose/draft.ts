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

function prefixed(prefix: string, subject: string) {
  const pattern = new RegExp(`^(${prefix}|re|aw|fwd|wg):\\s*`, "i");
  return pattern.test(subject) ? subject : `${prefix}: ${subject}`;
}

function withoutMe(addresses: Address[], accounts: Account[], identities: Identity[]) {
  const mine = new Set([...accounts, ...identities].map((a) => a.email.toLowerCase()));
  return addresses.filter((a) => !mine.has(a.email.toLowerCase()));
}

function quoted(message: Message) {
  return message.bodyHtml ? quotableHtml(message.bodyHtml) : textToHtml(message.bodyText ?? "");
}

/**
 * The address a reply comes from: the one of the mailbox's addresses the mail was sent to.
 * Empty means the mailbox's own address.
 */
export function replyFrom(source: Message, identities: Identity[]): string {
  const addressed = new Set([...source.to, ...source.cc].map((a) => a.email.toLowerCase()));
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

  const replyTo = source.replyTo.length > 0 ? source.replyTo : [source.from];
  const to = request.mode === "replyAll" ? withoutMe([...replyTo, ...source.to], accounts, identities) : replyTo;
  const cc = request.mode === "replyAll" ? withoutMe(source.cc, accounts, identities) : [];
  const header = escapeHtml(t("compose.quoteHeader", { date, name: "%%NAME%%" })).replace("%%NAME%%", name);
  return {
    ...empty,
    to: to.length > 0 ? to : replyTo,
    cc,
    subject: prefixed("Re", source.subject),
    html: `<p><br></p><p>${header}</p><blockquote>${quoted(source)}</blockquote>`,
  };
}
