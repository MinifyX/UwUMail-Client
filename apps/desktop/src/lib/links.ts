// Links from mail: only web and mail links open, and links whose visible text
// names a different address than their target (a typical phishing trick) ask first.

const DOMAIN = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#]\S*)?$/i;
const EMAIL = /^(?:mailto:)?([^\s@<>]+@((?:[a-z0-9-]+\.)+[a-z]{2,}))$/i;

export function isOpenableLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href.trim());
}

function bareHost(host: string) {
  return host
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

/** The host a link really goes to (for mailto: the recipient's domain). */
export function targetHost(href: string): string | null {
  const trimmed = href.trim();
  const mail = EMAIL.exec(trimmed.split("?")[0] ?? "");
  if (/^mailto:/i.test(trimmed)) return mail ? bareHost(mail[2]!) : null;
  try {
    const url = new URL(trimmed);
    return /^https?:$/.test(url.protocol) ? bareHost(url.hostname) : null;
  } catch {
    return null;
  }
}

/** The host the visible text claims, if the text looks like an address at all. */
export function claimedHost(text: string): string | null {
  const trimmed = text.trim().replace(/[.,;:!?)]+$/, "");
  if (!trimmed || /\s/.test(trimmed)) return null;
  const mail = EMAIL.exec(trimmed);
  if (mail) return bareHost(mail[2]!);
  const domain = DOMAIN.exec(trimmed);
  return domain ? bareHost(domain[1]!) : null;
}

function sameSite(a: string, b: string) {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export interface Misleading {
  shown: string;
  actual: string;
}

/** Details when the text shows one address but the link goes to another. */
export function misleadingLink(href: string, text: string): Misleading | null {
  const shown = claimedHost(text);
  const actual = targetHost(href);
  if (!shown || !actual || sameSite(shown, actual)) return null;
  return { shown, actual };
}
