import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { ARMING_MS, armedActivation } from "./LinkWarning";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the link question's open button", () => {
  it("ignores clicks until the question has been on screen for a moment", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1000);
    const open = vi.fn();
    const props = armedActivation(1000, open);
    now.mockReturnValue(1000 + ARMING_MS - 1);
    props.onClick();
    expect(open).not.toHaveBeenCalled();
    now.mockReturnValue(1000 + ARMING_MS);
    props.onClick();
    expect(open).toHaveBeenCalledOnce();
  });

  it("does not answer to a key that is held down", () => {
    const props = armedActivation(0, () => undefined);
    const held = { repeat: true, preventDefault: vi.fn() };
    props.onKeyDown(held as unknown as KeyboardEvent);
    expect(held.preventDefault).toHaveBeenCalled();
    const pressed = { repeat: false, preventDefault: vi.fn() };
    props.onKeyDown(pressed as unknown as KeyboardEvent);
    expect(pressed.preventDefault).not.toHaveBeenCalled();
  });
});
