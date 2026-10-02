import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, useSettings } from "./settings";

const KEY = "uwumail.settings";

afterEach(() => {
  useSettings.setState({ nyuAnimations: DEFAULT_SETTINGS.nyuAnimations });
  localStorage.removeItem(KEY);
});

describe("Nyu animations setting", () => {
  it("is on by default", () => {
    expect(DEFAULT_SETTINGS.nyuAnimations).toBe("on");
  });

  it("is kept on this device and comes back", async () => {
    useSettings.getState().update({ nyuAnimations: "reduced" });
    const saved = localStorage.getItem(KEY)!;
    expect(JSON.parse(saved).state.nyuAnimations).toBe("reduced");
    // A new page: the store starts from the defaults and reads what the browser kept.
    useSettings.setState({ nyuAnimations: "on" });
    localStorage.setItem(KEY, saved);
    await useSettings.persist.rehydrate();
    expect(useSettings.getState().nyuAnimations).toBe("reduced");
  });

  it("falls back to on for a value this version doesn't know", async () => {
    localStorage.setItem(KEY, JSON.stringify({ state: { nyuAnimations: "wild" }, version: 1 }));
    await useSettings.persist.rehydrate();
    expect(useSettings.getState().nyuAnimations).toBe("on");
  });
});

describe("font settings", () => {
  afterEach(() => {
    useSettings.setState({ font: DEFAULT_SETTINGS.font, senderFonts: DEFAULT_SETTINGS.senderFonts });
  });

  it("start with UwU Sans and serif fonts replaced", () => {
    expect(DEFAULT_SETTINGS.font).toBe("uwu");
    expect(DEFAULT_SETTINGS.senderFonts).toBe("replace");
  });

  it("are kept on this device and come back", async () => {
    useSettings.getState().update({ font: "rubik", senderFonts: "keep" });
    const saved = localStorage.getItem(KEY)!;
    expect(JSON.parse(saved).state).toMatchObject({ font: "rubik", senderFonts: "keep" });
    useSettings.setState({ font: "uwu", senderFonts: "replace" });
    localStorage.setItem(KEY, saved);
    await useSettings.persist.rehydrate();
    expect(useSettings.getState()).toMatchObject({ font: "rubik", senderFonts: "keep" });
  });

  it("fall back to the defaults for values this version doesn't know", async () => {
    localStorage.setItem(KEY, JSON.stringify({ state: { font: "comic", senderFonts: 3 }, version: 1 }));
    await useSettings.persist.rehydrate();
    expect(useSettings.getState()).toMatchObject({ font: "uwu", senderFonts: "replace" });
  });
});
