import type { Account, Address, Message } from "@/backend/types";
import { escapeHtml, formatAddress, formatFullDate, textToHtml } from "@/lib/format";
import { quotableHtml } from "@/lib/safeHtml";
import type { ComposeRequest } from "@/state/ui";

export interface DraftState {
  accountId: string;
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

function withoutMe(addresses: Address[], accounts: Account[]) {
  const mine = new Set(accounts.map((a) => a.email.toLowerCase()));
  return addresses.filter((a) => !mine.has(a.email.toLowerCase()));
}

function quoted(message: Message) {
  return message.bodyHtml ? quotableHtml(message.bodyHtml) : textToHtml(message.bodyText ?? "");
}

export function initialDraft(request: ComposeRequest, accounts: Account[], t: Translate, locale: string): DraftState {
  if (request.restore) {
    const { accountId, to, cc, bcc, subject, html } = request.restore;
    return { accountId, to, cc, bcc, subject, html };
  }
  const source = request.source;
  const accountId = source?.accountId ?? accounts[0]?.id ?? "";
  const empty: DraftState = {
    accountId,
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
  const to = request.mode === "replyAll" ? withoutMe([...replyTo, ...source.to], accounts) : replyTo;
  const cc = request.mode === "replyAll" ? withoutMe(source.cc, accounts) : [];
  const header = escapeHtml(t("compose.quoteHeader", { date, name: "%%NAME%%" })).replace("%%NAME%%", name);
  return {
    ...empty,
    to: to.length > 0 ? to : replyTo,
    cc,
    subject: prefixed("Re", source.subject),
    html: `<p><br></p><p>${header}</p><blockquote>${quoted(source)}</blockquote>`,
  };
}
