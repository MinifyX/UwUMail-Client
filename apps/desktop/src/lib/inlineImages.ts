// Mails show their embedded images (logos, signatures, screenshots) through `cid:` links to parts of
// the same message. The reader swaps those links for the locally cached files.

const CID = /cid:([^"'\s)>]+)/gi;

/** The Content-IDs an HTML body points at, as written after `cid:`. */
export function referencedContentIds(html: string | null): Set<string> {
  const ids = new Set<string>();
  if (!html) return ids;
  for (const match of html.matchAll(CID)) ids.add(decodeContentId(match[1]!));
  return ids;
}

/** `cid:` links replaced by the URLs of the files; links without a file stay as they are. */
export function replaceContentIds(html: string, urls: ReadonlyMap<string, string>): string {
  if (urls.size === 0) return html;
  return html.replace(CID, (link, id: string) => urls.get(decodeContentId(id)) ?? link);
}

function decodeContentId(id: string) {
  try {
    return decodeURIComponent(id).toLowerCase();
  } catch {
    return id.toLowerCase();
  }
}

/** Content-IDs compare without angle brackets and case. */
export function normalizeContentId(id: string) {
  return id.trim().replace(/^<|>$/g, "").toLowerCase();
}
