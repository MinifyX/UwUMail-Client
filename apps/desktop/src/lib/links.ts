// Links from mail: only web and mail links open. By default every link asks first (checkLink and
// needsConfirmation below); links whose visible text names a different address than their target
// (a typical phishing trick) always do.

import type { MailtoDraft } from "@/backend/types";
import { isIpAddress, isLookalikeHost, isPunycodeHost, isSharedHost, registrableDomain, unicodeHost } from "./domains";
import { parseMailto } from "./mailto";
import { detectRedirect, type Redirect } from "./redirects";

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

/**
 * Text from a link made safe to show: invisible format and control characters (bidi overrides,
 * zero-width spaces, line breaks) become a visible `<U+202E>` so an address can't visually lie.
 */
export function visibleText(text: string): string {
  return text.replace(
    /[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/gu,
    (char) => `<U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`,
  );
}

/** A web address split for display: the registrable domain gets the emphasis. */
export interface UrlParts {
  scheme: string;
  /** A user name before the host (`https://bank.example@evil.example/`), a classic disguise. */
  userinfo: string;
  /** Subdomains, with their trailing dot. */
  subdomain: string;
  domain: string;
  port: string;
  /** Path, query and fragment. */
  rest: string;
}

export function urlParts(href: string): UrlParts | null {
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const domain = registrableDomain(host);
  const userinfo = url.username || url.password ? `${url.username}${url.password ? ":…" : ""}@` : "";
  return {
    scheme: `${url.protocol}//`,
    userinfo: visibleText(decodeSafely(userinfo)),
    subdomain: host.slice(0, host.length - domain.length),
    domain,
    port: url.port ? `:${url.port}` : "",
    rest: visibleText(`${url.pathname}${url.search}${url.hash}`),
  };
}

function decodeSafely(text: string) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Everything the app knows about a link from a mail before it opens. */
export interface LinkCheck {
  /** The link as written in the mail; this is what opens. */
  href: string;
  kind: "web" | "mail";
  /** Lower-case ASCII (xn--) host of a web link. */
  host: string | null;
  /** The host with internationalized labels decoded, when it has any. */
  unicodeHost: string | null;
  lookalike: boolean;
  /** Plain http: the connection can be read and changed on the way. */
  insecure: boolean;
  /** A user name before the host. */
  userinfo: boolean;
  misleading: Misleading | null;
  redirect: Redirect | null;
  mailto: MailtoDraft | null;
  /**
   * The domain the reader may stop being asked about, or null where that is not offered:
   * disguised, plain http, internationalized or lookalike hosts, IP addresses, shared hosting.
   */
  rememberable: string | null;
}

export function checkLink(href: string, text: string): LinkCheck | null {
  const trimmed = href.trim();
  if (!isOpenableLink(trimmed)) return null;
  const misleading = misleadingLink(trimmed, text);
  if (/^mailto:/i.test(trimmed)) {
    const mailto = parseMailto(trimmed);
    if (!mailto) return null;
    return {
      href: trimmed,
      kind: "mail",
      host: null,
      unicodeHost: null,
      lookalike: false,
      insecure: false,
      userinfo: false,
      misleading,
      redirect: null,
      mailto,
      rememberable: null,
    };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const punycode = isPunycodeHost(host);
  const lookalike = punycode && isLookalikeHost(host);
  const insecure = url.protocol === "http:";
  const userinfo = url.username !== "" || url.password !== "";
  const domain = registrableDomain(host);
  const rememberable =
    !misleading &&
    !insecure &&
    !punycode &&
    !userinfo &&
    !isIpAddress(host) &&
    domain.includes(".") &&
    !isSharedHost(domain)
      ? domain
      : null;
  return {
    href: trimmed,
    kind: "web",
    host,
    unicodeHost: punycode ? unicodeHost(host) : null,
    lookalike,
    insecure,
    userinfo,
    misleading,
    redirect: detectRedirect(trimmed),
    mailto: null,
    rememberable,
  };
}

export interface LinkPreferences {
  /** Ask before opening links from mail (the setting "linkConfirm"). */
  confirm: boolean;
  /** Domains the reader chose to stop being asked about. */
  domains: readonly string[];
}

/** Whether a link opens right away or the dialog asks first. Disguised links always ask. */
export function needsConfirmation(check: LinkCheck, preferences: LinkPreferences): boolean {
  if (check.misleading) return true;
  if (!preferences.confirm) return false;
  return check.rememberable === null || !preferences.domains.includes(check.rememberable);
}
