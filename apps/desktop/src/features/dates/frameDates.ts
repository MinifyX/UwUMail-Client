/**
 * The found dates inside the mail's frame: how they look and how they answer. The frame runs no
 * scripts; the app listens through the same-origin document (see MessageBody).
 */

import type { Anchor } from "../calendar/state";

/** How a found date looks in the mail: a quiet dotted line, a tint when pointed at or focused. */
export const DATE_STYLE = `.uwu-date{text-decoration:underline dotted 1.5px;text-decoration-color:#ff4d8d;text-underline-offset:3px;cursor:pointer;border-radius:3px}
.uwu-date:hover,.uwu-date:focus-visible{background:rgba(255,77,141,.16);outline:none}
.uwu-date:focus-visible{box-shadow:0 0 0 2px #ff4d8d}`;

/** A found date was clicked or pressed (its mark's index), or somewhere else in the mail (null). */
export type DateReport = (index: number | null, anchor: Anchor) => void;

/**
 * Clicks and Enter/Space on the found dates, reported with where the date sits on the page. Only
 * the marks the app inserted carry `data-uwu-date` (lib/dates strips a mail's own).
 */
export function watchDates(frame: HTMLIFrameElement, doc: Document, report: DateReport): void {
  const anchorOf = (element: Element): Anchor => {
    const outer = frame.getBoundingClientRect();
    const inner = element.getBoundingClientRect();
    return { left: outer.left + inner.left, top: outer.top + inner.top, width: inner.width, height: inner.height };
  };
  const dateOf = (target: EventTarget | null) =>
    typeof (target as Element | null)?.closest === "function"
      ? (target as Element).closest<HTMLElement>("[data-uwu-date]")
      : null;
  const activate = (date: HTMLElement) => {
    const index = Number(date.dataset.uwuDate);
    if (Number.isInteger(index)) report(index, anchorOf(date));
  };
  doc.addEventListener("click", (event) => {
    const date = dateOf(event.target);
    // A selection that ends on a date is someone copying text, not a click.
    if (!date || !doc.getSelection()?.isCollapsed) {
      report(null, anchorOf(doc.body));
      return;
    }
    event.preventDefault();
    activate(date);
  });
  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const date = dateOf(event.target);
    if (!date) return;
    // Space would scroll the reader and Enter open things elsewhere.
    event.preventDefault();
    event.stopPropagation();
    activate(date);
  });
}
