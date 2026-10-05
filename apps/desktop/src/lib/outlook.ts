// Things Outlook and Microsoft 365 put into mail that the reader can say more about.

import type { Attachment } from "@/backend/types";

/**
 * Outlook's own container for a mail's formatting, attachments and meeting requests (TNEF).
 * UwUMail unpacks it (crates/uwumail-core/src/tnef.rs), and so does a current UwUMail server; what
 * still arrives as one file is one that couldn't be unpacked, or came from an older server.
 */
export function isTnefAttachment(attachment: Pick<Attachment, "filename" | "mimeType">): boolean {
  const type = attachment.mimeType.toLowerCase().split(";")[0]!.trim();
  return (
    type === "application/ms-tnef" ||
    type === "application/vnd.ms-tnef" ||
    attachment.filename.trim().toLowerCase() === "winmail.dat"
  );
}

/** How many links of a mail are looked at for a meeting link. */
const MAX_LINKS = 500;

const HREF = /\shref="([^"]*)"/g;

/** A Teams meeting join link: `teams.microsoft.com/l/meetup-join/…`, `…/meet/<id>` or Teams (free) `teams.live.com/meet/…`. */
export function isTeamsMeetingLink(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (host === "teams.microsoft.com") return path.startsWith("/l/meetup-join/") || /^\/meet\/[^/]+/.test(path);
  if (host === "teams.live.com") return /^\/meet\/[^/]+/.test(path);
  return false;
}

function unescapeAttribute(value: string) {
  return value.replace(/&(amp|quot|lt|gt|#39);/g, (_, name: string) =>
    name === "amp" ? "&" : name === "quot" ? '"' : name === "lt" ? "<" : name === "gt" ? ">" : "'",
  );
}

/**
 * The first Teams meeting link in the mail as the reader shows it (see readableBody: sanitized,
 * with Safe Links already removed), or null.
 */
export function teamsMeetingLink(readableHtml: string): string | null {
  let seen = 0;
  for (const match of readableHtml.matchAll(HREF)) {
    if (++seen > MAX_LINKS) break;
    const href = unescapeAttribute(match[1]!);
    if (isTeamsMeetingLink(href)) return href;
  }
  return null;
}
