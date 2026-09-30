import "@/test/dom";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, useSettings } from "@/state/settings";
import { CAMEOS, playNyu, useNyuCameo } from "./cameo";
import { useApplyNyuLevel } from "./level";
import { NyuStage } from "./NyuStage";
import { NyuThinking } from "./NyuThinking";

function prefersReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: reduce && query.includes("reduce"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

beforeEach(() => {
  useNyuCameo.setState({ current: null, played: {} });
  prefersReducedMotion(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useSettings.setState({ nyuAnimations: DEFAULT_SETTINGS.nyuAnimations, motion: DEFAULT_SETTINGS.motion });
});

describe("the stage", () => {
  it("shows a cameo that takes no clicks, is hidden from assistive tech and goes away by itself", async () => {
    const { container } = render(<NyuStage />);
    act(() => void playNyu("sent"));
    const stage = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>(".nyu-stage");
      if (!found) throw new Error("no stage yet");
      return found;
    });
    expect(stage.dataset.cameo).toBe("sent");
    expect(stage.getAttribute("aria-hidden")).toBe("true");
    expect(stage.classList.contains("nyu-stage-still")).toBe(false);
    expect(stage.style.getPropertyValue("--nyu-cameo-ms")).toBe(`${CAMEOS.sent.duration}ms`);

    vi.useFakeTimers();
    // A new cameo restarts the clock; this one ends after its own time.
    act(() => void playNyu("archived"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAMEOS.archived.duration - 1);
    });
    expect(container.querySelector(".nyu-stage")?.getAttribute("data-cameo")).toBe("archived");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container.querySelector(".nyu-stage")).toBeNull();
    expect(useNyuCameo.getState().current).toBeNull();
  });

  it("shows a still picture when motion is reduced", async () => {
    prefersReducedMotion(true);
    const { container } = render(<NyuStage />);
    act(() => void playNyu("trashed"));
    const stage = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>(".nyu-stage");
      if (!found) throw new Error("no stage yet");
      return found;
    });
    expect(stage.classList.contains("nyu-stage-still")).toBe(true);
  });

  it("stays empty when Nyu's animations are off", () => {
    useSettings.setState({ nyuAnimations: "off" });
    const { container } = render(<NyuStage />);
    act(() => void playNyu("sent"));
    expect(useNyuCameo.getState().current).toBeNull();
    expect(container.innerHTML).toBe("");
  });
});

describe("Nyu thinking", () => {
  it("thinks while allowed and gives way to the plain indicator when off", () => {
    const { rerender } = render(<NyuThinking fallback={<span>dots</span>} />);
    expect(screen.getByTestId("nyu-thinking").getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByText("dots")).toBeNull();
    act(() => useSettings.setState({ nyuAnimations: "off" }));
    rerender(<NyuThinking fallback={<span>dots</span>} />);
    expect(screen.queryByTestId("nyu-thinking")).toBeNull();
    expect(screen.getByText("dots")).toBeTruthy();
  });
});

function ApplyLevel() {
  useApplyNyuLevel();
  return null;
}

describe("the level on <html>", () => {
  it("marks the page, so the styles stop Nyu's movement", () => {
    render(<ApplyLevel />);
    expect(document.documentElement.dataset.nyu).toBe("full");
    act(() => useSettings.setState({ nyuAnimations: "reduced" }));
    expect(document.documentElement.dataset.nyu).toBe("reduced");
    act(() => useSettings.setState({ nyuAnimations: "on", motion: "off" }));
    expect(document.documentElement.dataset.nyu).toBe("reduced");
    act(() => useSettings.setState({ nyuAnimations: "off" }));
    expect(document.documentElement.dataset.nyu).toBe("off");
  });
});
