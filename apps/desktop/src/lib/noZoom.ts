import { isAndroid, isIos } from "./device";

/** Safari's pinch gestures (iOS, also iPadOS); other engines have none. */
const GESTURES = ["gesturestart", "gesturechange", "gestureend"] as const;

const cancel = (event: Event) => event.preventDefault();

/** True on phones and tablets, where the app must not zoom. */
export const blocksZoom = isIos || isAndroid;

/**
 * Keeps a document from zooming with two fingers. iOS ignores `user-scalable=no` since iOS 10, so
 * its pinch gestures are cancelled here; the app's own two-finger handling (cropping a picture)
 * works with pointer events and isn't touched. Returns the undo.
 */
export function blockPinchZoom(target: Document): () => void {
  for (const type of GESTURES) target.addEventListener(type, cancel, { passive: false });
  return () => {
    for (const type of GESTURES) target.removeEventListener(type, cancel);
  };
}
