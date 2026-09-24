import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/backend/mobile", () => ({
  nativeMobile: true,
  mobile: { unlock: async () => false },
}));

const { BehindLock } = await import("./AppLock");
const { useHotkeys } = await import("@/lib/hotkeys");
const { useAppLock } = await import("@/state/lock");
const { useSettings } = await import("@/state/settings");

function Shell({ archive }: { archive: () => void }) {
  useHotkeys({ e: archive });
  return <button type="button">Rechnung von Leni</button>;
}

describe("behind the app lock", () => {
  afterEach(cleanup);
  beforeEach(() => {
    useSettings.setState({ appLock: true });
    useAppLock.setState({ locked: true, prompting: false, leftAt: null });
  });

  it("the app is inert, so neither focus nor the screen reader reach it", () => {
    render(
      <BehindLock>
        <Shell archive={() => {}} />
      </BehindLock>,
    );
    const button = screen.getByText("Rechnung von Leni");
    expect(button.closest("[inert]")).not.toBeNull();

    act(() => useAppLock.getState().setLocked(false));
    expect(button.closest("[inert]")).toBeNull();
  });

  it("shortcuts do nothing until it is unlocked", () => {
    const archive = vi.fn();
    render(<Shell archive={archive} />);
    fireEvent.keyDown(window, { key: "e" });
    expect(archive).not.toHaveBeenCalled();

    act(() => useAppLock.getState().setLocked(false));
    fireEvent.keyDown(window, { key: "e" });
    expect(archive).toHaveBeenCalledOnce();
  });

  it("the lock only counts where it is switched on", () => {
    useSettings.setState({ appLock: false });
    const archive = vi.fn();
    render(<Shell archive={archive} />);
    fireEvent.keyDown(window, { key: "e" });
    expect(archive).toHaveBeenCalledOnce();
  });
});
