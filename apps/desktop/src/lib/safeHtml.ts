import DOMPurify from "dompurify";

const REMOTE = /^\s*(https?:)?\/\//i;
const CSS_URL = /url\s*\(/i;

/**
 * Mail HTML for places inside the app's own page, such as a quoted reply in
 * the composer. Unlike the mail view, there is no sandboxed frame around it,
 * so styles must not leak into the app and nothing may load from the internet
 * (a tracking pixel would otherwise fire just by pressing "Reply").
 */
export function quotableHtml(html: string): string {
  const purify = DOMPurify();
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node instanceof Element) {
      for (const name of ["src", "srcset", "background", "poster"]) {
        const value = node.getAttribute(name);
        if (value !== null && (REMOTE.test(value) || name === "srcset")) node.removeAttribute(name);
      }
      const style = node.getAttribute("style");
      if (style !== null && CSS_URL.test(style)) node.removeAttribute("style");
      if (node.tagName === "IMG" && !node.hasAttribute("src")) node.remove();
      if (node.tagName === "A") {
        const href = node.getAttribute("href") ?? "";
        if (!/^(https?:|mailto:)/i.test(href.trim())) node.removeAttribute("href");
      }
    }
  });
  return purify.sanitize(html, {
    FORBID_TAGS: [
      "style",
      "link",
      "meta",
      "base",
      "script",
      "iframe",
      "frame",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "video",
      "audio",
      "source",
      "svg",
      "math",
    ],
    FORBID_ATTR: ["class", "id", "srcdoc", "formaction", "ping"],
    FORCE_BODY: true,
  });
}

/** Plain text of some HTML, without loading anything it references. */
export function htmlToPlainText(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n");
  const doc = new DOMParser().parseFromString(withBreaks, "text/html");
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Only web and mail links may go into a message the user writes. */
export function isSafeLinkTarget(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url.trim());
}
