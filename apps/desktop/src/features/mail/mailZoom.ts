/** The wrapper inside the mail root that is scaled; see buildDocument. */
export const FIT_ID = "uwu-mail-fit";

/** Below this a fitted mail is unreadable anyway; it scrolls sideways instead. */
const MIN_FIT = 0.25;
/** How far a reader may zoom in, over the fitted size. */
const MAX_ZOOM = 4;

/** The scale that makes content `natural` wide fit into `available`, never above 1. */
export function fitScale(available: number, natural: number): number {
  if (available <= 0 || natural <= available + 1) return 1;
  return Math.max(available / natural, MIN_FIT);
}

/** The reader's own zoom over the fitted size, kept between the fitted size and MAX_ZOOM. */
export function clampZoom(fit: number, zoom: number): number {
  return Math.min(Math.max(zoom, 1), MAX_ZOOM / fit);
}

/**
 * Shows a mail that is wider than the reader (a fixed 600 px newsletter on a phone) scaled down
 * to the reader's width, like other mail apps do, rather than cut off and pushed sideways. On top
 * of that the mail zooms with two fingers or ⌃/⌘ and the wheel (trackpad pinch), while the app
 * around it doesn't. CSS `zoom` and not a transform: it changes the layout, so the frame's height
 * follows by itself. `onZoom` is told before a zoom changes the height, so that growth isn't taken
 * for a runaway layout. Returns the undo.
 */
export function fitAndZoom(doc: Document, root: HTMLElement, onZoom: () => void): () => void {
  const fit = doc.getElementById(FIT_ID);
  const view = doc.defaultView;
  if (!fit || !view) return () => {};
  let scale = 1;
  let user = 1;
  let width = -1;

  const apply = () => {
    const next = String(scale * user);
    if (fit.style.getPropertyValue("zoom") !== next) {
      onZoom();
      fit.style.setProperty("zoom", next);
    }
  };

  /** Measures the mail unscaled: the wrapper grows past the root's width where the mail won't wrap. */
  const refit = () => {
    const before = fit.style.getPropertyValue("zoom");
    fit.style.removeProperty("zoom");
    const style = view.getComputedStyle(root);
    const available = root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    scale = fitScale(available, fit.offsetWidth);
    if (before) fit.style.setProperty("zoom", before);
    user = clampZoom(scale, user);
    apply();
  };

  // A new width (window, rotation) needs a new fit; a new height alone, e.g. from zooming, doesn't.
  const observer = new ResizeObserver(() => {
    if (root.clientWidth === width) return;
    width = root.clientWidth;
    refit();
  });
  observer.observe(root);
  // Pictures arriving can make the mail wider.
  const onLoad = () => refit();
  doc.addEventListener("load", onLoad, true);

  /** Zooms by `factor`, keeping the point at `x` (in the frame) where it is sideways. */
  const zoomBy = (factor: number, x: number) => {
    const next = clampZoom(scale, user * factor);
    if (next === user) return;
    const ratio = next / user;
    const anchor = x - root.getBoundingClientRect().left;
    user = next;
    apply();
    root.scrollLeft = (root.scrollLeft + anchor) * ratio - anchor;
  };

  const stops: (() => void)[] = [];
  const listen = <K extends keyof DocumentEventMap>(
    type: K,
    handler: (event: DocumentEventMap[K]) => void,
  ) => {
    const listener = handler as EventListener;
    doc.addEventListener(type, listener, { passive: false });
    stops.push(() => doc.removeEventListener(type, listener));
  };

  // Safari (iOS, iPadOS, macOS trackpads) reports a pinch as gesture events with the total scale.
  const safari = "ongesturechange" in view;
  if (safari) {
    let start = 1;
    let x = 0;
    type Gesture = UIEvent & { scale: number; clientX: number };
    const begin = (event: Event) => {
      event.preventDefault();
      start = user;
      x = (event as Gesture).clientX ?? 0;
    };
    const change = (event: Event) => {
      event.preventDefault();
      zoomBy((start * (event as Gesture).scale) / user, x);
    };
    doc.addEventListener("gesturestart", begin, { passive: false });
    doc.addEventListener("gesturechange", change, { passive: false });
    stops.push(() => {
      doc.removeEventListener("gesturestart", begin);
      doc.removeEventListener("gesturechange", change);
    });
  } else {
    // Elsewhere (Android) from the two touches themselves.
    let distance = 0;
    const spread = (touches: TouchList) =>
      Math.hypot(touches[0]!.clientX - touches[1]!.clientX, touches[0]!.clientY - touches[1]!.clientY);
    listen("touchstart", (event) => {
      if (event.touches.length === 2) distance = spread(event.touches);
    });
    listen("touchmove", (event) => {
      if (event.touches.length !== 2 || distance <= 0) return;
      event.preventDefault();
      const next = spread(event.touches);
      zoomBy(next / distance, (event.touches[0]!.clientX + event.touches[1]!.clientX) / 2);
      distance = next;
    });
    listen("touchend", (event) => {
      if (event.touches.length < 2) distance = 0;
    });
  }
  // Pinching a trackpad in Chromium and WebView2 arrives as the wheel with ⌃ held.
  listen("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomBy(Math.exp(-event.deltaY / 200), event.clientX);
  });

  return () => {
    observer.disconnect();
    doc.removeEventListener("load", onLoad, true);
    for (const stop of stops) stop();
  };
}
