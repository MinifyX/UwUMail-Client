import { describe, expect, it } from "vitest";
import { clampPane, fitPanes, PANE_LIMITS, READER_MIN, readPaneWidths } from "./paneWidths";

describe("readPaneWidths", () => {
  it("falls back to the initial widths", () => {
    expect(readPaneWidths(null)).toEqual({ nav: PANE_LIMITS.nav.initial, list: PANE_LIMITS.list.initial });
    expect(readPaneWidths("{broken")).toEqual({ nav: PANE_LIMITS.nav.initial, list: PANE_LIMITS.list.initial });
    expect(readPaneWidths('{"nav":"wide"}').nav).toBe(PANE_LIMITS.nav.initial);
  });

  it("keeps saved widths inside the limits", () => {
    expect(readPaneWidths('{"nav":300,"list":9000}')).toEqual({ nav: 300, list: PANE_LIMITS.list.max });
    expect(clampPane("nav", 10)).toBe(PANE_LIMITS.nav.min);
    expect(clampPane("list", Number.NaN)).toBe(PANE_LIMITS.list.initial);
  });
});

describe("fitPanes", () => {
  it("leaves the widths alone when there is room", () => {
    expect(fitPanes({ nav: 240, list: 400 }, 1600)).toEqual({ nav: 240, list: 400 });
  });

  it("narrows the list first, then the sidebar, to keep the reader readable", () => {
    expect(fitPanes({ nav: 240, list: 600 }, 1100)).toEqual({ nav: 240, list: 1100 - 240 - READER_MIN });
    const tight = fitPanes({ nav: 400, list: 600 }, 900);
    expect(tight.list).toBe(PANE_LIMITS.list.min);
    expect(tight.nav).toBe(900 - READER_MIN - PANE_LIMITS.list.min);
  });

  it("never goes below the minimums", () => {
    expect(fitPanes({ nav: 240, list: 400 }, 300)).toEqual({ nav: PANE_LIMITS.nav.min, list: PANE_LIMITS.list.min });
  });
});
