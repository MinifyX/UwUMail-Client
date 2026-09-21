import { beforeEach, describe, expect, it } from "vitest";
import { useUi } from "./ui";

const ids = ["a", "b", "c", "d"];

beforeEach(() => {
  useUi.setState({
    view: { kind: "unified", role: "inbox" },
    selectedThreadId: null,
    visibleThreadIds: ids,
    checkedThreadIds: [],
    selectionAnchor: null,
    selectionCursor: null,
  });
});

describe("keyboard selection in the list", () => {
  it("↓ and ↑ open the mail below and above, and stay at the ends", () => {
    const ui = useUi.getState();
    ui.selectRelative(1);
    expect(useUi.getState().selectedThreadId).toBe("a");
    ui.selectRelative(-1);
    expect(useUi.getState().selectedThreadId).toBe("a");
    ui.selectThread("d");
    ui.selectRelative(1);
    expect(useUi.getState().selectedThreadId).toBe("d");
    ui.selectRelative(-1);
    expect(useUi.getState().selectedThreadId).toBe("c");
  });

  it("Shift+↓ ticks a range from the open mail without opening another", () => {
    const ui = useUi.getState();
    ui.selectThread("b");
    ui.extendSelection(1);
    ui.extendSelection(1);
    expect(useUi.getState().checkedThreadIds.sort()).toEqual(["b", "c", "d"]);
    expect(useUi.getState().selectedThreadId).toBe("b");
    ui.extendSelection(-1);
    expect(useUi.getState().checkedThreadIds.sort()).toEqual(["b", "c"]);
  });

  it("a fresh Shift range starts at the open mail again after the ticks were cleared", () => {
    const ui = useUi.getState();
    ui.selectThread("a");
    ui.extendSelection(1);
    ui.setCheckedThreadIds([]);
    ui.selectRelative(1);
    ui.selectRelative(1);
    ui.extendSelection(-1);
    expect(useUi.getState().checkedThreadIds.sort()).toEqual(["b", "c"]);
  });

  it("Ctrl+A ticks every loaded conversation", () => {
    useUi.getState().checkAllVisible();
    expect(useUi.getState().checkedThreadIds).toEqual(ids);
  });

  it("switching the folder forgets the ticks and the anchor", () => {
    const ui = useUi.getState();
    ui.selectThread("b");
    ui.checkAllVisible();
    ui.setView({ kind: "unified", role: "sent" });
    const state = useUi.getState();
    expect(state.checkedThreadIds).toEqual([]);
    expect(state.selectionAnchor).toBeNull();
  });
});
