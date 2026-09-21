// Where a wrapped link goes, read from the link alone. Nothing is ever fetched: link scanners,
// click trackers and redirect services often carry their destination in the address itself, and
// where they don't, the reader at least learns that the link passes through such a service.
// The result is information only. What opens is always the real href.

import { registrableDomain } from "./domains";

export type RedirectService = "tracking" | "service";

export interface Redirect {
  /** Hosts of the services the link passes through, outermost first, whose destination could be read. */
  via: string[];
  /** The innermost destination read from the link, or null when none could be read. */
  target: string | null;
  /** The innermost address belongs to a service that hides where it goes. */
  hidden: { service: RedirectService; host: string } | null;
}

/** Wrappers inside wrappers are unwrapped this deep. */
const MAX_LEVELS = 3;

/** Query parameters that carry the destination of common redirect links. */
const TARGET_PARAMS = [
  "url",
  "u",
  "q",
  "target",
  "dest",
  "destination",
  "redirect",
  "redirect_url",
  "redirect_uri",
  "goto",
  "link",
  "r",
  "to",
];

/** Click tracking of newsletter services: the destination sits on their server, not in the link. */
function isTracking(url: URL, host: string): boolean {
  const path = url.pathname.toLowerCase();
  if (host.endsWith(".list-manage.com")) return true; // Mailchimp
  if (host.endsWith("ct.sendgrid.net") || (path.startsWith("/ls/click") && url.searchParams.has("upn"))) {
    return true; // SendGrid, also on its customers' own link domains
  }
  if (host === "hubspotlinks.com" || host.endsWith(".hubspotlinks.com")) return true;
  if (host === "mandrillapp.com" && path.startsWith("/track/click")) return true;
  if (/^(?:.+\.)?(?:klclick\d?\.com|mjt\.lu|cmail\d+\.com|createsend\d*\.com)$/.test(host)) return true;
  return false;
}

/** Link scanners and short links that hide the destination. */
function isHidingService(host: string): boolean {
  if (/(?:^|\.)mimecast(?:protect)?\.com$/.test(host)) return true;
  return ["bit.ly", "t.co", "tinyurl.com", "ow.ly", "buff.ly", "rebrand.ly", "lnkd.in", "is.gd", "cutt.ly"].includes(
    host,
  );
}

function webUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function base64Text(value: string): string | null {
  try {
    const normal = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** A parameter value that is itself a web address: plain, percent-encoded once more, or base64. */
export function embeddedUrl(value: string): URL | null {
  let candidate = value.trim();
  for (let round = 0; round < 3 && /^https?%3a/i.test(candidate); round++) {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      return null;
    }
  }
  if (/^https?:\/\//i.test(candidate)) return webUrl(candidate);
  // "aHR0c" is how "http" starts in base64.
  if (/^aHR0c[A-Za-z0-9+/_-]{6,}={0,2}$/.test(candidate)) {
    const decoded = base64Text(candidate);
    if (decoded && /^https?:\/\//i.test(decoded)) return webUrl(decoded);
  }
  return null;
}

/** Proofpoint URL Defense v1/v2 (`?u=` with `-XX` for `%XX` and `_` for `/`) and v3 (`/v3/__…__;…`). */
function proofpoint(url: URL): URL | null {
  const path = url.pathname;
  if (path.startsWith("/v3/")) return proofpointV3(url.href);
  const encoded = url.searchParams.get("u");
  if (!encoded) return null;
  if (path.startsWith("/v1/")) return embeddedUrl(encoded);
  if (!path.startsWith("/v2/")) return null;
  try {
    return webUrl(decodeURIComponent(encoded.replace(/_/g, "/").replace(/-([0-9A-Fa-f]{2})/g, "%$1")));
  } catch {
    return null;
  }
}

const V3_RUN_LENGTHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** v3 swaps some characters for `*` (or `**X` for a run) and lists them, base64, after `__;`. */
function proofpointV3(href: string): URL | null {
  const match = /\/v3\/__(.+?)__;([A-Za-z0-9+/=_-]*)!/.exec(href);
  if (!match) return null;
  const [, wrapped = "", encoded = ""] = match;
  const replacements = [...(encoded ? (base64Text(encoded) ?? "") : "")];
  let next = 0;
  const restored = wrapped.replace(/\*\*(.)|\*/g, (_, run?: string) => {
    const length = run === undefined ? 1 : V3_RUN_LENGTHS.indexOf(run) + 2;
    if (length < 2 && run !== undefined) return "";
    if (next + length > replacements.length) return "";
    const chars = replacements.slice(next, next + length).join("");
    next += length;
    return chars;
  });
  return webUrl(restored);
}

type Step = { kind: "target"; url: URL } | { kind: "hidden"; service: RedirectService } | null;

function unwrap(url: URL): Step {
  const host = url.hostname.toLowerCase();
  if (host === "urldefense.com" || host === "urldefense.proofpoint.com") {
    const target = proofpoint(url);
    return target ? { kind: "target", url: target } : { kind: "hidden", service: "service" };
  }
  if (isTracking(url, host)) return { kind: "hidden", service: "tracking" };
  if (isHidingService(host)) return { kind: "hidden", service: "service" };
  const site = registrableDomain(host);
  const params = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    const name = key.toLowerCase();
    if (!params.has(name)) params.set(name, value);
  }
  for (const name of TARGET_PARAMS) {
    const value = params.get(name);
    const target = value ? embeddedUrl(value) : null;
    // A site sending its own visitors on within itself (`/login?redirect=…`) is no redirect worth naming.
    if (target && registrableDomain(target.hostname) !== site) return { kind: "target", url: target };
  }
  return null;
}

/** What a link reveals about where it leads, or null for a plain link. */
export function detectRedirect(href: string): Redirect | null {
  let current = webUrl(href.trim());
  if (!current) return null;
  const via: string[] = [];
  let hidden: Redirect["hidden"] = null;
  for (let level = 0; level <= MAX_LEVELS; level++) {
    const step = unwrap(current);
    if (!step) break;
    if (step.kind === "hidden") {
      hidden = { service: step.service, host: current.hostname.toLowerCase() };
      break;
    }
    if (level === MAX_LEVELS) break;
    via.push(current.hostname.toLowerCase());
    current = step.url;
  }
  if (via.length === 0 && !hidden) return null;
  return { via, target: via.length > 0 ? current.href : null, hidden };
}
