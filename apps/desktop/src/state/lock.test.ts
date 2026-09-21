import { beforeEach, describe, expect, it, vi } from "vitest";

const unlock = vi.fn<(reason: string, title: string) => Promise<boolean>>();
vi.mock("@/backend/mobile", () => ({
  nativeMobile: true,
  mobile: { unlock: (r: string, t: string) => unlock(r, t) },
}));

const { confirmIdentity, noteVisibility, useAppLock } = await import("./lock");
const { useSettings } = await import("./settings");

const MINUTE = 60_000;

describe("the app lock timer", () => {
  beforeEach(() => {
    useAppLock.setState({ locked: false, prompting: false, leftAt: null });
    useSettings.setState({ appLock: true, appLockAfter: 5 });
    unlock.mockReset();
  });

  it("locks after the chosen time away", () => {
    expect(noteVisibility(false, 5, 0)).toBe(false);
    expect(noteVisibility(true, 5, 6 * MINUTE)).toBe(true);
    expect(noteVisibility(false, 5, 10 * MINUTE)).toBe(false);
    expect(noteVisibility(true, 5, 11 * MINUTE)).toBe(false);
  });

  it("doesn't count the phone's unlock screen as leaving", async () => {
    unlock.mockImplementation(async () => {
      // The unlock screen hides UwUMail and it comes back before the answer arrives.
      noteVisibility(false, 0);
      expect(noteVisibility(true, 0)).toBe(false);
      return true;
    });
    expect(await confirmIdentity("r", "t", () => true)).toBe(true);
    expect(useAppLock.getState()).toMatchObject({ prompting: false, leftAt: null, locked: false });
  });

  it("counts the time when someone leaves while the question is up", async () => {
    unlock.mockImplementation(async () => {
      noteVisibility(false, 5, Date.now() - 10 * MINUTE);
      return false;
    });
    // The question goes away while UwUMail is in the background.
    expect(await confirmIdentity("r", "t", () => false)).toBe(false);
    expect(noteVisibility(true, 5)).toBe(true);
  });

  it("locks when a question left open that long is only cancelled on coming back", async () => {
    unlock.mockImplementation(async () => {
      noteVisibility(false, 5, Date.now() - 10 * MINUTE);
      expect(noteVisibility(true, 5)).toBe(false);
      return false;
    });
    await confirmIdentity("r", "t", () => true);
    expect(useAppLock.getState().locked).toBe(true);
  });

  it("doesn't lock for a question cancelled right away", async () => {
    useSettings.setState({ appLockAfter: 0 });
    unlock.mockImplementation(async () => {
      noteVisibility(false, 0);
      return false;
    });
    await confirmIdentity("r", "t", () => true);
    expect(useAppLock.getState().locked).toBe(false);
  });
});
