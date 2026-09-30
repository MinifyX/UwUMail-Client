import { afterEach, describe, expect, it } from "vitest";
import { THREAD_DRAG_TYPE, droppedThreads, endThreadDrag, isThreadDrag, startThreadDrag } from "./threadDrag";

function transfer(data: Record<string, string> = {}) {
  const store = new Map(Object.entries(data));
  return {
    get types() {
      return [...store.keys()];
    },
    setData: (type: string, value: string) => void store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
    effectAllowed: "none",
  } as unknown as DataTransfer;
}

afterEach(endThreadDrag);

describe("dragging mail list rows", () => {
  it("drops the rows the list started dragging", () => {
    const own = transfer();
    startThreadDrag(own, ["t1", "t2"]);
    expect(isThreadDrag(own)).toBe(true);
    expect(droppedThreads(own)).toEqual(["t1", "t2"]);
    // A drop takes them once.
    expect(droppedThreads(own)).toEqual([]);
  });

  it("ignores a drag of the same type from another app, whatever ids it names", () => {
    const foreign = transfer({ [THREAD_DRAG_TYPE]: JSON.stringify(["someone-elses-thread"]) });
    expect(isThreadDrag(foreign)).toBe(false);
    expect(droppedThreads(foreign)).toEqual([]);
    const broken = transfer({ [THREAD_DRAG_TYPE]: "{not json" });
    expect(droppedThreads(broken)).toEqual([]);
  });

  it("forgets the rows once the drag ends without a drop", () => {
    const own = transfer();
    startThreadDrag(own, ["t1"]);
    endThreadDrag();
    expect(droppedThreads(own)).toEqual([]);
  });
});
