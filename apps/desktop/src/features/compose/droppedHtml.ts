import type { DragEvent } from "react";

/** Firefox's name for `caretRangeFromPoint`; not in every DOM typing yet. */
interface CaretPositionDocument {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
}

function caretAt(x: number, y: number): Range | null {
  if (typeof document.caretRangeFromPoint === "function") return document.caretRangeFromPoint(x, y);
  const position = (document as CaretPositionDocument).caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const range = document.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  return range;
}

/**
 * Markup dropped into an editor of the app's own page, e.g. a selection dragged out of a mail,
 * goes through `clean` like pasted markup, so nothing remote in it loads here (security-audit
 * W-20). Files and drags that start in the editor itself (moving text) are left to the browser.
 * Answers whether it inserted something.
 */
export function insertDroppedHtml(event: DragEvent<HTMLElement>, clean: (html: string) => string): boolean {
  const html = event.dataTransfer.getData("text/html");
  if (!html || event.dataTransfer.files.length > 0) return false;
  event.preventDefault();
  const range = caretAt(event.clientX, event.clientY);
  if (range && event.currentTarget.contains(range.startContainer)) {
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  } else {
    event.currentTarget.focus();
  }
  document.execCommand("insertHTML", false, clean(html));
  return true;
}
