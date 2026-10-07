import { describe, expect, it } from "vitest";
import { deviceNameFromAgent } from "./deviceName";

describe("device names from the user agent", () => {
  it("says iPhone or iPad on iOS", () => {
    expect(deviceNameFromAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15")).toBe(
      "iPhone",
    );
    expect(deviceNameFromAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 5)).toBe("iPad");
  });

  it("takes the model on Android", () => {
    expect(
      deviceNameFromAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36",
      ),
    ).toBe("Pixel 8");
    expect(deviceNameFromAgent("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/128.0 Mobile")).toBe(
      "Android",
    );
  });

  it("knows nothing about computers", () => {
    expect(deviceNameFromAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36", 0)).toBeNull();
    expect(deviceNameFromAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 0)).toBeNull();
  });
});
