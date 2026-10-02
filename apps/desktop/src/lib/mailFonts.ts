/**
 * The fonts an HTML mail asks for, made to work with Settings → Reading → Sender fonts.
 *
 * Mails that name no font, or only fonts this device doesn't have (Calibri, Aptos on Linux and
 * Android), used to land on the engine's default: Times. The sanitizer rewrites every font list
 * once, the same way whatever the setting says, and the frame decides with three custom properties
 * (see `fontVariables`):
 *
 * - serif fonts (`Times New Roman`, `Georgia`, … and `serif`) become `var(--uwu-serif, <as written>)`:
 *   the chosen font while serif fonts are replaced, the sender's otherwise;
 * - `sans-serif` and `system-ui` become `var(--uwu-sans, <as written>)`, so a font that isn't
 *   installed falls to the chosen font rather than the engine's sans-serif;
 * - a list without any generic family gets `var(--uwu-font)` at the end, always: an installed font
 *   still wins, a missing one never ends in Times.
 *
 * Monospace lists (`pre`, `Courier New`, `Consolas` …) stay as they are, and so do sizes, weights
 * and everything else in the declaration.
 */

import { mailStack, type FontChoice, type SenderFonts } from "./fonts";

const SERIF_NAMES = new Set([
  "times new roman",
  "times",
  "tinos",
  "georgia",
  "cambria",
  "garamond",
  "eb garamond",
  "book antiqua",
  "palatino",
  "palatino linotype",
  "bookman",
  "bookman old style",
  "constantia",
  "century schoolbook",
  "new century schoolbook",
  "baskerville",
  "baskerville old face",
  "didot",
  "bodoni mt",
  "hoefler text",
  "liberation serif",
  "dejavu serif",
  "noto serif",
  "droid serif",
  "nimbus roman",
  "nimbus roman no9 l",
]);

const SANS_GENERICS = new Set(["sans-serif", "system-ui", "ui-sans-serif"]);

const GENERICS = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

/** A list naming one of these is code or tabular text: never touched. */
const MONOSPACE =
  /\b(monospace|ui-monospace|courier|consolas|menlo|monaco|lucida console|lucida sans typewriter|sf mono|cascadia|fira code|fira mono|source code pro|jetbrains mono|dejavu sans mono|liberation mono|andale mono|roboto mono|ubuntu mono|noto sans mono|ocr-?a)\b/i;

const KEYWORDS =
  /^(inherit|initial|unset|revert|revert-layer|caption|icon|menu|message-box|small-caption|status-bar)$/i;

/** The size (and line height) in a `font` shorthand; the family list follows it. */
const SHORTHAND_SIZE =
  /^(.*?(?:^|\s)(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:px|pt|pc|em|rem|ex|ch|%|vw|vh|vmin|vmax|cm|mm|in|q|lh|rlh)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)(?:\s*\/\s*[^\s,]+)?\s+)(\S[\s\S]*)$/i;

/** Splits a family list at its commas, but not at commas inside quotes. */
function splitFamilies(list: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of list) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function familyKey(family: string) {
  return family
    .trim()
    .replace(/^(["'])([\s\S]*)\1$/, "$2")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Rewrites a family list (the value of `font-family`, or the families of a `font` shorthand). */
export function rewriteFamilies(list: string): string {
  const families = splitFamilies(list);
  if (families.some((family) => family.trim() === "")) return list;
  let generic = false;
  const rewritten = families.map((family) => {
    const key = familyKey(family);
    const written = family.trim();
    if (GENERICS.has(key)) generic = true;
    if (key === "serif" || SERIF_NAMES.has(key)) return `var(--uwu-serif, ${written})`;
    if (SANS_GENERICS.has(key)) return `var(--uwu-sans, ${written})`;
    return written;
  });
  if (!generic) rewritten.push("var(--uwu-font)");
  return rewritten.join(", ");
}

/** Rewrites the value of a `font-family` (or, with `shorthand`, a `font`) declaration. */
export function rewriteFontValue(value: string, shorthand = false): string {
  const important = /\s*!\s*important\s*$/i.exec(value);
  const body = (important ? value.slice(0, important.index) : value).trim();
  if (body === "" || KEYWORDS.test(body) || /var\(|env\(/i.test(body) || MONOSPACE.test(body)) return value;
  let prefix = "";
  let families = body;
  if (shorthand) {
    const match = SHORTHAND_SIZE.exec(body);
    if (!match) return value;
    prefix = match[1]!;
    families = match[2]!;
  }
  return `${prefix}${rewriteFamilies(families)}${important ? " !important" : ""}`;
}

/** `font-family:` or `font:` declarations, wherever they stand in a rule or a style attribute. */
const DECLARATION = /(^|[{;\s])(font-family|font)(\s*:\s*)([^;{}]*)/gi;

/** Rewrites the font declarations in a style attribute or a block of CSS. */
export function rewriteFontDeclarations(css: string): string {
  // An @font-face rule names the one family it defines: leave those alone.
  return css
    .split(/(@font-face\s*\{[^}]*\})/i)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(
            DECLARATION,
            (_, before: string, property: string, colon: string, value: string) =>
              `${before}${property}${colon}${rewriteFontValue(value, property.toLowerCase() === "font")}`,
          ),
    )
    .join("");
}

/**
 * Applies the rewriting to one sanitized element: its style attribute, a `<style>` block's text,
 * and `<font face>` (as a style, since an attribute can't hold `var()`).
 */
export function rewriteElementFonts(node: Element) {
  if (node.tagName === "STYLE") {
    const css = node.textContent ?? "";
    if (/font/i.test(css)) node.textContent = rewriteFontDeclarations(css);
    return;
  }
  const style = node.getAttribute("style");
  if (style && /font/i.test(style)) node.setAttribute("style", rewriteFontDeclarations(style));
  if (node.tagName === "FONT") {
    const face = node.getAttribute("face");
    if (face && face.trim() && !/[;{}<>]/.test(face)) {
      const family = rewriteFontValue(face);
      if (family !== face) {
        const own = node.getAttribute("style");
        node.setAttribute("style", `font-family:${family}${own ? `;${own}` : ""}`);
      }
    }
  }
}

/** The custom properties the rewritten lists read, for the frame's `:root`. */
export function fontVariables(font: FontChoice, senderFonts: SenderFonts) {
  const stack = mailStack(font);
  return senderFonts === "replace"
    ? `--uwu-font:${stack};--uwu-serif:var(--uwu-font);--uwu-sans:var(--uwu-font)`
    : `--uwu-font:${stack}`;
}
