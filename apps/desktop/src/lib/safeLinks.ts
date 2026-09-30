// Microsoft Safe Links: Exchange Online / Microsoft Defender for Office 365 rewrites every link in a
// mail to `https://<region>.safelinks.protection.outlook.com/?url=<original>&data=…`. The reader
// shows and opens the original address instead. Display only: the stored mail stays as it came,
// and every other link check (disguised text, redirects, http, lookalikes) applies to the original.

import { embeddedUrl } from "./redirects";

export interface SafeLink {
  /** The original address the wrapper carries. */
  url: string;
  /** Host of the (outermost) Safe Links wrapper. */
  wrapper: string;
}

/** Safe Links hosts of Microsoft's clouds (commercial, GCC High/DoD, 21Vianet). */
const SAFE_LINKS_HOST = /(?:^|\.)safelinks\.protection\.(?:outlook\.com|office365\.us|apps\.mil|partner\.outlook\.cn)$/;

/** Teams and Office apps wrap links with Defender's page on the Office CDN. */
function isTeamsSafeLinks(url: URL, host: string): boolean {
  return host === "statics.teams.cdn.office.net" && url.pathname.toLowerCase().includes("/safelinks/");
}

/** Wrapped links inside wrapped links (forwarded twice through Exchange Online) unwrap this deep. */
const MAX_LEVELS = 3;

function parse(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function unwrapOnce(url: URL): URL | null {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!SAFE_LINKS_HOST.test(host) && !isTeamsSafeLinks(url, host)) return null;
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() === "url") return embeddedUrl(value);
  }
  return null;
}

/** The original address of a Microsoft Safe Link, or null for any other link. */
export function unwrapSafeLink(href: string): SafeLink | null {
  const outer = parse(href.trim());
  if (!outer) return null;
  let current = outer;
  for (let level = 0; level < MAX_LEVELS; level++) {
    const inner = unwrapOnce(current);
    if (!inner) break;
    current = inner;
  }
  if (current === outer) return null;
  return { url: current.href, wrapper: outer.hostname.toLowerCase() };
}

/**
 * What a link's visible text should read: the original address where the text is itself a Safe
 * Link (Outlook writes the wrapped address out in plain-text mail), else null to keep the text.
 */
export function unwrappedText(text: string): string | null {
  const trimmed = text.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  return unwrapSafeLink(trimmed)?.url ?? null;
}
