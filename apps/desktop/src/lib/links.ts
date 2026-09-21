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
  // Strip invisible format characters first (zero-width spaces, soft hyphens): rendered they show
  // nothing, so "paypal<U+200B>.com" reads as paypal.com but would otherwise slip past the check
  // (webmail security audit W-8).
  const trimmed = text
    .replace(/[\p{Cf}­]/gu, "")
    .trim()
    .replace(/[.,;:!?)]+$/, "");
  if (!trimmed || /\s/.test(trimmed)) return null;
  const mail = EMAIL.exec(trimmed);
  if (mail) return bareHost(mail[2]!);
  const domain = DOMAIN.exec(trimmed);
  return domain ? bareHost(domain[1]!) : null;
}

/** Every recipient host a mailto: link would send to: the path and the to/cc/bcc header fields. */
function mailtoHosts(href: string): string[] {
  const trimmed = href.trim();
  if (!/^mailto:/i.test(trimmed)) return [];
  const [rawPath = "", query = ""] = trimmed.slice("mailto:".length).split("?");
  let path = rawPath;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    // keep the raw path if it is not valid percent-encoding
  }
  const params = new URLSearchParams(query);
  const fields = [path, ...params.getAll("to"), ...params.getAll("cc"), ...params.getAll("bcc")];
  const hosts: string[] = [];
  for (const address of fields.flatMap((field) => field.split(","))) {
    const at = address.trim().lastIndexOf("@");
    if (at > 0 && at < address.trim().length - 1) hosts.push(bareHost(address.trim().slice(at + 1)));
  }
  return hosts;
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
  if (!shown) return null;
  // A mailto: link may carry several recipients -- more in the path or in the cc/bcc fields than
  // the text names. Warn if any recipient host is not the one the text shows (webmail security audit W-9).
  if (/^mailto:/i.test(href.trim())) {
    const elsewhere = mailtoHosts(href).find((host) => !sameSite(shown, host));
    return elsewhere ? { shown, actual: elsewhere } : null;
  }
  const actual = targetHost(href);
  if (!actual || sameSite(shown, actual)) return null;
  return { shown, actual };
}
