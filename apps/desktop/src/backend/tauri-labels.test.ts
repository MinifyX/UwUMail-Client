import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args),
  Channel: class {},
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { TauriBackend } = await import("./tauri");

describe("labels through the engine", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("names the app's language for the base labels this device makes", async () => {
    await i18n.changeLanguage("de");
    invoke.mockResolvedValueOnce([{ id: "g1", name: "Rechnung", base: "invoice", auto: false }]);
    const backend = new TauriBackend();
    expect(await backend.assistLabels("device")).toMatchObject([{ id: "g1", base: "invoice", auto: false }]);
    expect(invoke).toHaveBeenLastCalledWith("assist_labels", { scope: "device", language: "de" });
    invoke.mockResolvedValueOnce({ id: "g9", name: "Werbung", base: "advertising" });
    expect(await backend.restoreBaseLabel("device", "advertising", false)).toMatchObject({
      id: "g9",
      base: "advertising",
      auto: true,
    });
    expect(invoke).toHaveBeenLastCalledWith("assist_create_label", {
      scope: "device",
      input: { base: "advertising", auto: false },
      language: "de",
    });
    await i18n.changeLanguage("en");
  });

  it("checks overlaps, but never with text the check wouldn't take", async () => {
    const backend = new TauriBackend();
    invoke.mockResolvedValueOnce({ overlaps: [{ id: "g1", name: "Invoice", base: "invoice", kind: "name" }] });
    expect(await backend.checkLabelOverlap("acc", " Invoice ", " Receipts ", "g9")).toEqual([
      { id: "g1", name: "Invoice", base: "invoice", kind: "name", words: [] },
    ]);
    expect(invoke).toHaveBeenLastCalledWith("assist_check_overlap", {
      scope: "acc",
      name: "Invoice",
      description: "Receipts",
      labelId: "g9",
    });
    invoke.mockResolvedValueOnce({ overlaps: [] });
    await backend.checkLabelOverlap("device", "Travel", "");
    expect(invoke).toHaveBeenLastCalledWith("assist_check_overlap", {
      scope: "device",
      name: "Travel",
      description: "",
      labelId: null,
    });
    invoke.mockClear();
    expect(await backend.checkLabelOverlap("acc", "x".repeat(101), "")).toEqual([]);
    expect(await backend.checkLabelOverlap("acc", "Ok", "y".repeat(2001))).toEqual([]);
    expect(await backend.checkLabelOverlap("acc", "   ", "")).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});
