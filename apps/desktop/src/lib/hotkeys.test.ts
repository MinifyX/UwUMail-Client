import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { comboOf, combosOf, useHotkeys, type HotkeyMap } from "./hotkeys";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("key combos", () => {
  it("tells Shift with letters only", () => {
    expect(comboOf(key({ key: "I", shiftKey: true }))).toBe("shift+i");
    expect(comboOf(key({ key: "i" }))).toBe("i");
    expect(comboOf(key({ key: "?", shiftKey: true }))).toBe("?");
    expect(comboOf(key({ key: "D", shiftKey: true, ctrlKey: true }))).toBe("mod+shift+d");
  });

  it("falls back from Shift+letter to the letter alone", () => {
    expect(combosOf(key({ key: "J", shiftKey: true }))).toEqual(["shift+j", "j"]);
    expect(combosOf(key({ key: "K", shiftKey: true, metaKey: true }))).toEqual(["mod+shift+k", "mod+k"]);
    expect(combosOf(key({ key: "j" }))).toEqual(["j"]);
    expect(combosOf(key({ key: "ArrowDown", shiftKey: true }))).toEqual(["ArrowDown"]);
    expect(combosOf(key({ key: "#", shiftKey: true }))).toEqual(["#"]);
  });
});

describe("useHotkeys", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  function press(init: KeyboardEventInit) {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    window.dispatchEvent(event);
    return event;
  }

  function setup(extra: HotkeyMap = {}) {
    const calls: string[] = [];
    const map: HotkeyMap = {
      j: () => void calls.push("next"),
      k: () => void calls.push("previous"),
      "mod+k": () => void calls.push("palette"),
      e: () => void calls.push("archive"),
      "g i": () => void calls.push("inbox"),
      "shift+i": () => void calls.push("markAllRead"),
      ...extra,
    };
    renderHook(() => useHotkeys(map, { repeat: ["j", "k"] }));
    return calls;
  }

  it("keeps Shift+J/K moving through the list, also while held", () => {
    const calls = setup();
    press({ key: "J", shiftKey: true });
    press({ key: "K", shiftKey: true });
    press({ key: "J", shiftKey: true, repeat: true });
    expect(calls).toEqual(["next", "previous", "next"]);
  });

  it("opens the palette with Cmd/Ctrl+Shift+K, also over a dialog", () => {
    const calls = setup();
    press({ key: "K", shiftKey: true, metaKey: true });
    press({ key: "K", shiftKey: true, ctrlKey: true });
    document.body.innerHTML = "<dialog open></dialog>";
    press({ key: "K", shiftKey: true, ctrlKey: true });
    expect(calls).toEqual(["palette", "palette", "palette"]);
  });

  it("gives Shift+I to mark all read, plain I stays unclaimed", () => {
    const calls = setup();
    press({ key: "I", shiftKey: true });
    expect(press({ key: "i" }).defaultPrevented).toBe(false);
    expect(calls).toEqual(["markAllRead"]);
  });

  it("keeps other Shift+letters on their plain shortcut", () => {
    const calls = setup();
    press({ key: "E", shiftKey: true });
    expect(calls).toEqual(["archive"]);
  });

  it("runs sequences with Shift on either key", () => {
    const calls = setup();
    press({ key: "g" });
    press({ key: "I", shiftKey: true });
    press({ key: "G", shiftKey: true });
    press({ key: "i" });
    expect(calls).toEqual(["inbox", "inbox"]);
  });

  it("leaves Shift+letters to text fields", () => {
    const calls = setup();
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "J", shiftKey: true, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "I", shiftKey: true, bubbles: true, cancelable: true }));
    expect(calls).toEqual([]);
  });

  it("does not repeat a held Shift+I", () => {
    const fn = vi.fn();
    setup({ "shift+i": fn });
    press({ key: "I", shiftKey: true });
    press({ key: "I", shiftKey: true, repeat: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
