import { afterEach, describe, expect, it, vi } from "vitest";
import { flushBeforeQuit, onQuit } from "./quit";

describe("flushing before quitting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for every registered flush, also when one fails", async () => {
    const saved: string[] = [];
    const offDraft = onQuit(async () => {
      await Promise.resolve();
      saved.push("draft");
    });
    const offBroken = onQuit(() => {
      throw new Error("server away");
    });
    const offSettings = onQuit(() => {
      saved.push("settings");
    });
    await flushBeforeQuit();
    expect(saved.sort()).toEqual(["draft", "settings"]);
    offDraft();
    offBroken();
    offSettings();
  });

  it("runs nothing that was taken back", async () => {
    const flush = vi.fn();
    onQuit(flush)();
    await flushBeforeQuit();
    expect(flush).not.toHaveBeenCalled();
  });

  it("gives up on a flush that never ends", async () => {
    vi.useFakeTimers();
    const off = onQuit(() => new Promise(() => undefined));
    let done = false;
    const quitting = flushBeforeQuit(500).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await quitting;
    expect(done).toBe(true);
    off();
  });
});
