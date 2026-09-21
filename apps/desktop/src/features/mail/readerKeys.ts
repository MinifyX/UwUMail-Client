import { isTyping } from "@/lib/hotkeys";

/** Marks the reader, whose text Ctrl+A selects as usual. */
const READER_ATTR = "data-reader";
/** Marks the reader's scrolling area, which Space and Page Up/Down scroll from the list too. */
const READER_SCROLL_ATTR = "data-reader-scroll";
/** Marks the list's scrolling area. */
const THREAD_LIST_ATTR = "data-thread-list";

function asElement(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

/** The key came from the mail list itself or one of its rows, not from a button like "Load more". */
function fromList(element: Element | null) {
  const list = element?.closest(`[${THREAD_LIST_ATTR}]`);
  return !!list && (element === list || !!element?.closest("[data-thread-id]"));
}

/** Nothing has the focus, so the page itself gets the key. */
function fromPage(target: EventTarget | null) {
  return target === document || target === document.body || target === document.documentElement;
}

/**
 * Space, Shift+Space, Page Up/Down, Home and End scroll the open mail while the focus is in
 * the list, on nothing, or in the mail itself (forwarded from the frame). Answers whether it
 * scrolled; everywhere else the keys keep their usual meaning.
 */
export function scrollReader(event: KeyboardEvent): boolean {
  const element = asElement(event.target);
  if (!fromPage(event.target) && !fromList(element) && !(element instanceof HTMLIFrameElement)) return false;
  const scroller = document.querySelector<HTMLElement>(`[${READER_SCROLL_ATTR}]`);
  if (!scroller) return false;
  // Like a browser: a page is a bit less than the visible height, so a line stays in view.
  const page = Math.max(scroller.clientHeight - 48, 40);
  const behavior: ScrollBehavior = event.repeat ? "auto" : "smooth";
  switch (event.key) {
    case " ":
      scroller.scrollBy({ top: event.shiftKey ? -page : page, behavior });
      return true;
    case "PageDown":
      scroller.scrollBy({ top: page, behavior });
      return true;
    case "PageUp":
      scroller.scrollBy({ top: -page, behavior });
      return true;
    case "Home":
      scroller.scrollTo({ top: 0, behavior });
      return true;
    case "End":
      scroller.scrollTo({ top: scroller.scrollHeight, behavior });
      return true;
    default:
      return false;
  }
}

/**
 * Ctrl+A ticks all conversations unless the user means text: in a field or the composer, while
 * selecting text, or with the focus in the reader. (Inside the mail frame it never gets here.)
 */
export function wantsTextSelectAll(event: KeyboardEvent): boolean {
  if (isTyping(event.target)) return true;
  const element = asElement(event.target);
  if (fromList(element)) return false;
  if (element instanceof HTMLIFrameElement) return true;
  const selection = document.getSelection();
  // Only real selected text counts: a bare caret stays wherever the last click was.
  if (selection && !selection.isCollapsed) return true;
  return !fromPage(event.target) && !!element?.closest(`[${READER_ATTR}]`);
}

/**
 * Hands keys pressed inside a mail frame to the app's shortcuts, so ↑/↓, j/k, Space and the
 * other single-key shortcuts work there too. Ctrl/Cmd combinations stay in the frame (Ctrl+A and
 * Ctrl+C select and copy the mail's text), except Ctrl+K for the command palette. The frame has
 * no scripts of its own; this listener runs in the app.
 */
export function forwardFrameKeys(frame: HTMLIFrameElement, doc: Document) {
  doc.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || isTyping(event.target)) return;
    const mod = event.ctrlKey || event.metaKey;
    if (event.altKey || (mod && event.key.toLowerCase() !== "k")) return;
    const copy = new KeyboardEvent("keydown", {
      key: event.key,
      code: event.code,
      location: event.location,
      repeat: event.repeat,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      bubbles: true,
      cancelable: true,
    });
    frame.dispatchEvent(copy);
    if (copy.defaultPrevented) event.preventDefault();
  });
}
