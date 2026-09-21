/** Keyboard steps through the mail list: moving the open mail, and ticking several with Shift. */

export interface ListSelection {
  /** Ticked thread ids. */
  checked: string[];
  /** Where a Shift range starts: the last row clicked or opened. */
  anchor: string | null;
  /** Where a Shift range ends: the row Shift+arrows last reached. */
  cursor: string | null;
}

/** The row `offset` steps away from `current` in `order`; the first row when nothing is open. Stays at the ends. */
export function stepThrough(order: string[], current: string | null, offset: number): string | null {
  if (order.length === 0) return null;
  const index = current ? order.indexOf(current) : -1;
  const next = Math.min(Math.max(index + offset, 0), order.length - 1);
  return order[next] ?? null;
}

/** The rows from `a` to `b`, both included, in list order. */
function range(order: string[], a: string, b: string): string[] {
  const start = order.indexOf(a);
  const end = order.indexOf(b);
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/**
 * Shift+↑/↓: moves the end of the range from the anchor one row and ticks exactly that range,
 * like Shift+click. Rows ticked before on their own stay ticked; the range can grow and shrink.
 */
export function extendSelection(order: string[], selection: ListSelection, offset: 1 | -1): ListSelection {
  if (order.length === 0) return selection;
  const known = (id: string | null) => (id && order.includes(id) ? id : null);
  const anchor = known(selection.anchor) ?? known(selection.cursor);
  const from = known(selection.cursor) ?? anchor;
  if (!anchor || !from) {
    // Nothing to start from: the first row (or the last, going up) is the start.
    const edge = order[offset > 0 ? 0 : order.length - 1]!;
    return { checked: [...new Set([...selection.checked, edge])], anchor: edge, cursor: edge };
  }
  const to = stepThrough(order, from, offset)!;
  const before = new Set(range(order, anchor, from));
  const kept = selection.checked.filter((id) => !before.has(id));
  return { checked: [...new Set([...kept, ...range(order, anchor, to)])], anchor, cursor: to };
}
