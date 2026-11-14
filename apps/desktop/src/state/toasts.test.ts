import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToasts } from "./toasts";

describe("toasts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    useToasts.setState({ toasts: [] });
    vi.useRealTimers();
  });

  it("stays while held and gets its full time again after", () => {
    const id = useToasts.getState().show("Archived");
    useToasts.getState().pause(id);
    vi.advanceTimersByTime(10_000);
    expect(useToasts.getState().toasts).toHaveLength(1);
    useToasts.getState().resume(id);
    vi.advanceTimersByTime(3_400);
    expect(useToasts.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("keeps counting down while held", () => {
    const id = useToasts.getState().show("Sending", "info", undefined, {
      duration: 5_000,
      countdownTo: new Date(Date.now() + 5_000).toISOString(),
    });
    useToasts.getState().pause(id);
    vi.advanceTimersByTime(5_000);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
