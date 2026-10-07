import { describe, expect, it } from "vitest";
import { blockPinchZoom } from "./noZoom";

const gesture = (type: string) => new Event(type, { cancelable: true });

describe("blockPinchZoom", () => {
  it("cancels Safari's pinch gestures until undone", () => {
    const stop = blockPinchZoom(document);
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
      const event = gesture(type);
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    stop();
    const later = gesture("gesturestart");
    document.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
  });

  it("leaves touches alone, so lists and the mail still scroll", () => {
    const stop = blockPinchZoom(document);
    const move = new Event("touchmove", { cancelable: true });
    document.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(false);
    stop();
  });
});
