import { checkLink } from "@/lib/links";
import { requestOpenLink, useLinks, type ReaderArea } from "@/state/links";

const LINK_SELECTOR = "a[href], area[href]";
/** How long a finger rests on a link before the sheet opens. */
const LONG_PRESS_MS = 500;
/** A finger moving further than this scrolls instead. */
const MOVE_TOLERANCE = 10;

// Events come from the mail's own document, a different realm: `instanceof Element` would fail
// there, so elements are recognized by what they can do.
function linkOf(target: EventTarget | null): Element | null {
  return (target as Element | null)?.closest?.(LINK_SELECTOR) ?? null;
}

function linkText(anchor: Element) {
  return anchor.textContent ?? "";
}

/** The bottom of the scrolling box around the mail, where the status line goes. */
function readerArea(frame: HTMLIFrameElement): ReaderArea {
  let box: HTMLElement | null = frame.parentElement;
  while (box) {
    const overflow = getComputedStyle(box).overflowY;
    if (overflow === "auto" || overflow === "scroll") break;
    box = box.parentElement;
  }
  const rect = (box ?? frame).getBoundingClientRect();
  const bottom = Math.min(rect.bottom, window.innerHeight);
  return { left: Math.max(rect.left, 0), bottom: window.innerHeight - bottom, width: rect.width };
}

export function hideLinkStatus() {
  if (useLinks.getState().hover) useLinks.setState({ hover: null });
}

/**
 * Everything the reader does with links in a mail: a click asks through requestOpenLink, hover and
 * keyboard focus show the status line, and a long press on a touch screen opens the link sheet.
 */
export function watchLinks(frame: HTMLIFrameElement, doc: Document) {
  let ignoreClicksUntil = 0;

  doc.addEventListener("click", (event) => {
    // `area` as well as `a`: an image map is a link with no text, and today it only ever gets
    // here without its href because a table of attributes in the sanitizer happens to drop it.
    // Catching it here does not depend on that staying true.
    const anchor = linkOf(event.target);
    if (!anchor) return;
    event.preventDefault();
    // The click that ends a long press belongs to the sheet.
    if (performance.now() < ignoreClicksUntil) return;
    hideLinkStatus();
    requestOpenLink(anchor.getAttribute("href") ?? "", linkText(anchor));
  });

  const show = (anchor: Element) => {
    const check = checkLink(anchor.getAttribute("href") ?? "", linkText(anchor));
    if (check) useLinks.setState({ hover: { check, area: readerArea(frame) } });
    else hideLinkStatus();
  };
  const leave = (event: MouseEvent | FocusEvent) => {
    const anchor = linkOf(event.target);
    const next = event.relatedTarget as Node | null;
    if (anchor && next && anchor.contains(next)) return;
    hideLinkStatus();
  };
  doc.addEventListener("mouseover", (event) => {
    const anchor = linkOf(event.target);
    if (anchor) show(anchor);
  });
  doc.addEventListener("mouseout", leave);
  doc.addEventListener("focusin", (event) => {
    const anchor = linkOf(event.target);
    if (anchor) show(anchor);
  });
  doc.addEventListener("focusout", leave);

  let timer = 0;
  let start: { x: number; y: number } | null = null;
  const cancel = () => {
    window.clearTimeout(timer);
    start = null;
  };
  doc.addEventListener(
    "touchstart",
    (event) => {
      cancel();
      const anchor = linkOf(event.target);
      const touch = event.touches[0];
      if (!anchor || !touch || event.touches.length !== 1) return;
      start = { x: touch.clientX, y: touch.clientY };
      timer = window.setTimeout(() => {
        start = null;
        const check = checkLink(anchor.getAttribute("href") ?? "", linkText(anchor));
        if (!check) return;
        ignoreClicksUntil = performance.now() + 1000;
        useLinks.setState({ sheet: check, hover: null });
      }, LONG_PRESS_MS);
    },
    { passive: true },
  );
  doc.addEventListener(
    "touchmove",
    (event) => {
      const touch = event.touches[0];
      if (start && touch && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > MOVE_TOLERANCE) cancel();
    },
    { passive: true },
  );
  doc.addEventListener("touchend", cancel);
  doc.addEventListener("touchcancel", cancel);
  // The system's own link menu would open the link past every check.
  doc.addEventListener("contextmenu", (event) => {
    if (linkOf(event.target)) event.preventDefault();
  });
}
