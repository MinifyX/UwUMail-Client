/**
 * A mail's remote pictures, fetched by the app instead of loaded by the web view from their senders.
 *
 * A picture loaded from the sender tells them the mail was opened, when, and from where. The app
 * fetches it (`uwuimg:`): through the account's UwUMail server, or from here through the privacy
 * proxy. This only swaps addresses; whatever it misses stays blocked by the CSP, which allows no
 * remote pictures at all.
 */

/** Where the app fetches a remote picture for us. */
export type ImageProxy = (url: string) => string;

const REMOTE = /^\s*https?:\/\//i;
/**
 * `url(...)` with a quoted or bare address. The spaces around it are taken whole (a lookahead
 * captures them and nothing ever gives a space back), and a bare address stops at the next `(`,
 * which it can't contain anyway. Otherwise a long run of spaces or of `url(url(…` makes this
 * backtrack for minutes and freezes the reader.
 */
const CSS_URL = /url\((?=(\s*))\1(?:"([^"]*)"|'([^']*)'|([^\s"'()]*))(?=(\s*))\5\)/gi;

/** One address through the proxy when it points at the web; anything else as it is. */
export function proxyAddress(url: string, proxy: ImageProxy): string {
  return REMOTE.test(url) ? proxy(url.trim()) : url;
}

/** Every `url(...)` in a piece of CSS that points at the web, through the proxy. */
export function proxyCss(css: string, proxy: ImageProxy): string {
  return css.replace(CSS_URL, (whole, _space: string, double?: string, single?: string, bare?: string) => {
    const url = double ?? single ?? bare ?? "";
    // The proxy's address is percent-encoded throughout, so it needs no escaping inside quotes.
    return REMOTE.test(url) ? `url("${proxy(url.trim())}")` : whole;
  });
}

/**
 * `srcset` candidates are "address [descriptor]", separated by a comma and a space. Addresses may
 * hold commas themselves (`w_100,h_100`), so a bare comma is not taken as a separator; a candidate
 * written that way stays unproxied and blocked.
 */
export function proxySrcset(srcset: string, proxy: ImageProxy): string {
  return srcset
    .split(/,\s+/)
    .map((candidate) => {
      const [url = "", ...descriptor] = candidate.trim().split(/\s+/);
      return [proxyAddress(url, proxy), ...descriptor].join(" ");
    })
    .join(", ");
}

const ADDRESSES = ["src", "background", "poster", "href", "xlink:href"] as const;

/**
 * Sends the remote pictures of an already sanitized mail body through `proxy`. Parsed in a
 * `<template>`, where nothing loads.
 */
export function proxyRemoteImages(html: string, proxy: ImageProxy): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    for (const name of ADDRESSES) {
      // Links stay links; only an SVG <image> loads what its href names.
      if ((name === "href" || name === "xlink:href") && element.localName !== "image") continue;
      const value = element.getAttribute(name);
      if (value !== null) element.setAttribute(name, proxyAddress(value, proxy));
    }
    const srcset = element.getAttribute("srcset");
    if (srcset !== null) element.setAttribute("srcset", proxySrcset(srcset, proxy));
    const style = element.getAttribute("style");
    if (style !== null) element.setAttribute("style", proxyCss(style, proxy));
    if (element.localName === "style" && element.textContent) {
      element.textContent = proxyCss(element.textContent, proxy);
    }
  }
  return template.innerHTML;
}
