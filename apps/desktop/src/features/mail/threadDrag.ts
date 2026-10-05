/**
 * Dragging mail list rows onto a folder or a label. The drop takes the rows from this module,
 * not from the drag's data: another app (or a web page in a browser) can offer a drag of the same
 * type with thread ids of its choosing, and dropping that on a folder would move those threads.
 */

/** Drag data type of mail list rows (the thread ids as JSON, for the looks of the drag only). */
export const THREAD_DRAG_TYPE = "application/x-uwumail-threads";

let dragged: readonly string[] | null = null;

/** A drag of these rows starts in the mail list. */
export function startThreadDrag(dataTransfer: DataTransfer, threadIds: readonly string[]) {
  dragged = [...threadIds];
  dataTransfer.setData(THREAD_DRAG_TYPE, JSON.stringify(threadIds));
  // Onto a folder it moves, onto a label it copies (the label goes on).
  dataTransfer.effectAllowed = "copyMove";
}

/** The drag ended, dropped or not. */
export function endThreadDrag() {
  dragged = null;
}

/** Whether this drag carries rows of the app's own mail list. */
export function isThreadDrag(dataTransfer: Pick<DataTransfer, "types">): boolean {
  return dragged !== null && dataTransfer.types.includes(THREAD_DRAG_TYPE);
}

/** The thread ids a drop carries: the rows the mail list started dragging, else none. */
export function droppedThreads(dataTransfer: Pick<DataTransfer, "types">): string[] {
  const threadIds = isThreadDrag(dataTransfer) ? [...dragged!] : [];
  dragged = null;
  return threadIds;
}
