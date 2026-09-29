/**
 * A mail's text as a reader sees it, read from its (already sanitized) HTML, and the dates found
 * in it marked in place.
 *
 * Hidden text (preheaders, `display:none`, zero-size tricks) is left out; quoted replies and
 * signatures are read but reported as excluded. Whitespace collapses like HTML renders it, with a
 * map back to the text nodes so a hit can be wrapped exactly where it stands.
 */

import { MAX_TEXT } from "./parse";
import type { Range } from "./structure";

export interface TextPiece {
  node: Text;
  /** Where the node's text sits in the collected text; `to` exclusive. */
  from: number;
  to: number;
  /** For each collected character, its offset in the node; null when they are the same. */
  offsets: number[] | null;
  /** Inside a link: clicking it opens the link, so it isn't marked. */
  linked: boolean;
}

export interface CollectedText {
  text: string;
  pieces: TextPiece[];
  /** Quoted replies and signatures, by their markup. */
  excluded: Range[];
}

const SKIPPED = new Set([
  "style",
  "script",
  "title",
  "head",
  "template",
  "noscript",
  "svg",
  "math",
  "img",
  "video",
  "audio",
  "object",
  "iframe",
]);
const BLOCKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "caption",
  "center",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);
const HIDDEN_CLASSES = new Set([
  "preheader",
  "preview-text",
  "previewtext",
  "preview",
  "mcnpreviewtext",
  "hidden",
  "hide",
  "visually-hidden",
  "sr-only",
  "mso-hide",
]);
const QUOTE_CLASSES = new Set(["gmail_quote", "gmail_extra", "moz-cite-prefix", "yahoo_quoted", "protonmail_quote"]);
const QUOTE_IDS = new Set(["divrplyfwdmsg", "appendonsend", "mail-editor-reference-message-container"]);
const SIGNATURE_CLASSES = new Set(["gmail_signature", "moz-signature", "signature"]);
const SIGNATURE_IDS = new Set(["signature", "divtagdefaultwrapper-signature"]);
const MAX_DEPTH = 256;

function styleOf(element: Element): Map<string, string> {
  const style = new Map<string, string>();
  const raw = element.getAttribute("style");
  if (!raw) return style;
  for (const declaration of raw.slice(0, 4000).split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    style.set(
      declaration.slice(0, colon).trim().toLowerCase(),
      declaration
        .slice(colon + 1)
        .replace(/!important/i, "")
        .trim()
        .toLowerCase(),
    );
  }
  return style;
}

const isZero = (value: string | undefined) => value !== undefined && /^0*\.?0*(px|pt|em|rem|%)?$/.test(value);

/** What a reader never sees: hidden by attribute, style or a class the mail's own CSS hides. */
function isHidden(element: Element, style: Map<string, string>): boolean {
  if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return true;
  if (style.get("display") === "none" || style.get("visibility") === "hidden" || style.get("mso-hide") === "all")
    return true;
  if (isZero(style.get("opacity"))) return true;
  const fontSize = style.get("font-size");
  if (fontSize !== undefined && (isZero(fontSize) || /^(0?\.\d+|1)(px|pt)$/.test(fontSize))) return true;
  if (isZero(style.get("max-height")) || isZero(style.get("max-width"))) return true;
  if ((isZero(style.get("height")) || isZero(style.get("width"))) && style.get("overflow") === "hidden") return true;
  const classes = (element.getAttribute("class") ?? "").toLowerCase().split(/\s+/);
  return classes.some((name) => HIDDEN_CLASSES.has(name));
}

function isQuote(element: Element, forward: boolean): boolean {
  if (forward) return false;
  if (element.localName === "blockquote") return true;
  const classes = (element.getAttribute("class") ?? "").toLowerCase().split(/\s+/);
  return classes.some((name) => QUOTE_CLASSES.has(name)) || QUOTE_IDS.has((element.id ?? "").toLowerCase());
}

function isSignature(element: Element): boolean {
  const classes = (element.getAttribute("class") ?? "").toLowerCase().split(/\s+/);
  return classes.some((name) => SIGNATURE_CLASSES.has(name)) || SIGNATURE_IDS.has((element.id ?? "").toLowerCase());
}

/** Reads the visible text below `root`. `forward`: the mail forwards another; quotes are its content. */
export function collectText(root: Element, forward = false): CollectedText {
  let text = "";
  const pieces: TextPiece[] = [];
  const excluded: Range[] = [];
  const endsInSpace = () => text.length === 0 || /\s$/.test(text);
  const breakLine = () => {
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
  };

  const visit = (node: Node, depth: number, linked: boolean, pre: boolean) => {
    if (text.length > MAX_TEXT || depth > MAX_DEPTH) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data;
      if (pre) {
        pieces.push({ node: node as Text, from: text.length, to: text.length + data.length, offsets: null, linked });
        text += data;
        return;
      }
      let out = "";
      const offsets: number[] = [];
      let space = endsInSpace();
      for (let index = 0; index < data.length; index++) {
        const char = data[index]!;
        if (/\s/.test(char)) {
          if (space) continue;
          out += " ";
          space = true;
        } else {
          out += char;
          space = false;
        }
        offsets.push(index);
      }
      if (out.length === 0) return;
      pieces.push({ node: node as Text, from: text.length, to: text.length + out.length, offsets, linked });
      text += out;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const name = element.localName;
    if (SKIPPED.has(name)) return;
    const style = styleOf(element);
    if (isHidden(element, style)) return;
    if (name === "br") {
      text += "\n";
      return;
    }
    const block = BLOCKS.has(name);
    if (block) breakLine();
    else if ((name === "td" || name === "th") && !endsInSpace()) text += " ";
    const start = text.length;
    const inPre = pre || name === "pre" || /^pre/.test(style.get("white-space") ?? "");
    const inLink = linked || (name === "a" && element.hasAttribute("href"));
    for (const child of element.childNodes) visit(child, depth + 1, inLink, inPre);
    if (block) breakLine();
    else if ((name === "td" || name === "th") && !endsInSpace()) text += " ";
    if (text.length > start && (isQuote(element, forward) || isSignature(element))) excluded.push([start, text.length]);
  };

  for (const child of root.childNodes) visit(child, 0, false, false);
  return { text, pieces, excluded };
}

export interface Mark {
  from: number;
  to: number;
  /** Which hit, for the click. */
  index: number;
  /** What a screen reader says for it. */
  label: string;
}

function nodeOffset(piece: TextPiece, local: number): number {
  return piece.offsets ? (piece.offsets[local] ?? piece.node.data.length) : local;
}

/**
 * Wraps each hit in `<span class="uwu-date" data-uwu-date="index">`; the first piece of each can
 * take the focus and is announced as a button. Nothing inside a link: that click is the link's.
 */
export function markText(root: ParentNode, collected: CollectedText, marks: readonly Mark[]): void {
  const byNode = new Map<Text, { start: number; end: number; mark: Mark }[]>();
  for (const mark of marks) {
    for (const piece of collected.pieces) {
      if (piece.to <= mark.from || piece.from >= mark.to || piece.linked) continue;
      const localFrom = Math.max(mark.from, piece.from) - piece.from;
      const localTo = Math.min(mark.to, piece.to) - piece.from;
      if (localTo <= localFrom) continue;
      const start = nodeOffset(piece, localFrom);
      const end = nodeOffset(piece, localTo - 1) + 1;
      const list = byNode.get(piece.node) ?? [];
      list.push({ start, end, mark });
      byNode.set(piece.node, list);
    }
  }
  for (const [node, parts] of byNode) {
    const doc = node.ownerDocument;
    // From the end, so splitting never moves the offsets still to come.
    for (const { start, end, mark } of parts.sort((a, b) => b.start - a.start)) {
      if (end > node.data.length || start >= end) continue;
      node.splitText(end);
      const middle = node.splitText(start);
      const span = doc.createElement("span");
      span.className = "uwu-date";
      span.setAttribute("data-uwu-date", String(mark.index));
      middle.replaceWith(span);
      span.append(middle);
    }
  }
  for (const mark of marks) {
    const first = root.querySelector(`[data-uwu-date="${mark.index}"]`);
    if (!first) continue;
    first.setAttribute("tabindex", "0");
    first.setAttribute("role", "button");
    first.setAttribute("aria-haspopup", "dialog");
    first.setAttribute("aria-label", mark.label);
  }
}

/** The body of an inert document holding `html`; nothing in it loads or runs. */
export function parseBody(html: string): HTMLElement {
  return new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html").body;
}
