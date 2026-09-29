/**
 * The part of a draft the person wrote themselves, for the assistant: rewriting works on their
 * own text, not on the signature or the quoted mail below it, and the answer goes back in place
 * of that part. The composer's body is HTML; the assistant reads and writes plain text.
 *
 * A reply is laid out as [own text…] [signature] [quote header] <blockquote>; a forward as
 * [own text…] [signature] [---------- header] [forwarded mail…]; new mail as [own text…]
 * [signature]. Own text ends at the first of these that comes.
 */

import { escapeHtml, textToHtml } from "@/lib/format";
import { htmlToPlainText } from "@/lib/safeHtml";
import { SIGNATURE_ATTRIBUTE } from "@/lib/signatures";

/** The forward header's first line, as draft.ts writes it. */
const FORWARD_HEADER = /^-{5,}\s/;

function parse(html: string): HTMLElement {
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
}

/** Where the own text ends among the body's top-level nodes: an index into `childNodes`. */
function ownEnd(body: HTMLElement): number {
  const nodes = [...body.childNodes];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (!(node instanceof HTMLElement)) continue;
    if (node.hasAttribute(SIGNATURE_ATTRIBUTE)) return index;
    if (FORWARD_HEADER.test(node.textContent?.trim() ?? "")) return index;
    if (node.tagName === "BLOCKQUOTE") {
      // The "On …, … wrote:" line right above the quote belongs to it.
      let before = index - 1;
      while (before >= 0 && !(nodes[before] instanceof HTMLElement)) before -= 1;
      const header = nodes[before] as HTMLElement | undefined;
      return header && header.tagName === "P" && header.textContent?.trim() ? before : index;
    }
  }
  return nodes.length;
}

function htmlOf(nodes: ChildNode[]): string {
  return nodes.map((node) => (node instanceof Element ? node.outerHTML : escapeHtml(node.textContent ?? ""))).join("");
}

/** The draft split into the person's own part and the rest (signature, quote), both as HTML. */
export function splitDraft(html: string): { own: string; rest: string } {
  const body = parse(html);
  const end = ownEnd(body);
  const nodes = [...body.childNodes];
  return { own: htmlOf(nodes.slice(0, end)), rest: htmlOf(nodes.slice(end)) };
}

/** The person's own text as plain text, for the assistant. */
export function ownText(html: string): string {
  return htmlToPlainText(splitDraft(html).own);
}

/** The draft with its own part replaced by `text`; the signature and the quote stay as they were. */
export function replaceOwnText(html: string, text: string): string {
  const { rest } = splitDraft(html);
  return textToHtml(text.trim()) + (rest ? `<p><br></p>${rest}` : "");
}

/** The draft with `text` added at the end of its own part (in place of an empty one). */
export function appendToOwnText(html: string, text: string): string {
  const { own, rest } = splitDraft(html);
  if (!htmlToPlainText(own).trim()) return replaceOwnText(html, text);
  return own + textToHtml(text.trim()) + (rest ? `<p><br></p>${rest}` : "");
}

/** Plain text as HTML to put at the cursor: paragraphs and line breaks kept. */
export function insertableHtml(text: string): string {
  return textToHtml(text.trim());
}
