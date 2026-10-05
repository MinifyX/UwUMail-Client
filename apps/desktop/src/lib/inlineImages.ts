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

/** Attributes that load a picture (`href` only on SVG's picture elements). */
const PICTURE_ATTRIBUTES = ["src", "srcset", "background", "poster"] as const;
const PICTURE_LINKS = new Set(["image", "feimage"]);

/**
 * `cid:` addresses replaced by the URLs of the files, but only where a picture loads: `src`,
 * `srcset`, `background`, `poster`, an SVG picture's `href` and CSS (`style` attributes and
 * elements). A link (`<a href="cid:…">`) never becomes one of the app's own URLs, so a click can't
 * open such a file in the mail frame (security review 0.10 RD-1). Addresses without a file stay as
 * they are. Parsed in a `<template>`, where nothing loads.
 */
export function replaceContentIds(html: string, urls: ReadonlyMap<string, string>): string {
  if (urls.size === 0) return html;
  const swap = (value: string) => value.replace(CID, (link, id: string) => urls.get(decodeContentId(id)) ?? link);
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    for (const name of PICTURE_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value !== null) element.setAttribute(name, swap(value));
    }
    if (PICTURE_LINKS.has(element.localName.toLowerCase())) {
      for (const name of ["href", "xlink:href"]) {
        const value = element.getAttribute(name);
        if (value !== null) element.setAttribute(name, swap(value));
      }
    }
    const style = element.getAttribute("style");
    if (style !== null) element.setAttribute("style", swap(style));
    if (element.localName === "style" && element.textContent) element.textContent = swap(element.textContent);
  }
  return template.innerHTML;
}

/**
 * The picture type the bytes really are, for the formats a mail may embed: PNG, JPEG, GIF, WebP,
 * AVIF and BMP. Null for anything else (HTML, SVG, PDF, …): such a part is never turned into one
 * of the app's own URLs (security review 0.10 RD-1).
 */
export function rasterImageType(bytes: Uint8Array): string | null {
  const at = (offset: number, text: string) =>
    bytes.length >= offset + text.length && [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => bytes[i] === byte)) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  if (at(4, "ftypavif") || at(4, "ftypavis")) return "image/avif";
  if (at(0, "BM") && bytes.length >= 26) return "image/bmp";
  return null;
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
