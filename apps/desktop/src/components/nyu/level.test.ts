import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, useSettings } from "@/state/settings";
import { currentNyuLevel, resolveNyuLevel } from "./level";

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

afterEach(() => {
  vi.unstubAllGlobals();
  useSettings.setState({ nyuAnimations: DEFAULT_SETTINGS.nyuAnimations, motion: DEFAULT_SETTINGS.motion });
});

describe("Nyu's level", () => {
  it("follows the setting while motion is allowed", () => {
    expect(resolveNyuLevel("on", "system", false)).toBe("full");
    expect(resolveNyuLevel("reduced", "system", false)).toBe("reduced");
    expect(resolveNyuLevel("off", "on", false)).toBe("off");
  });

  it("is capped at reduced by the system's reduced motion or the animations switched off", () => {
    expect(resolveNyuLevel("on", "system", true)).toBe("reduced");
    expect(resolveNyuLevel("on", "off", false)).toBe("reduced");
    // Animations switched on explicitly override the system.
    expect(resolveNyuLevel("on", "on", true)).toBe("full");
    expect(resolveNyuLevel("off", "system", true)).toBe("off");
  });

  it("reads the settings and prefers-reduced-motion outside React", () => {
    prefersReducedMotion(false);
    expect(currentNyuLevel()).toBe("full");
    prefersReducedMotion(true);
    expect(currentNyuLevel()).toBe("reduced");
    useSettings.setState({ nyuAnimations: "off" });
    expect(currentNyuLevel()).toBe("off");
    useSettings.setState({ nyuAnimations: "on", motion: "on" });
    expect(currentNyuLevel()).toBe("full");
  });
});
