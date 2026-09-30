import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkedText } from "./EventPopover";

const requestOpenLink = vi.fn((_url: string, _text: string) => "asked");
vi.mock("@/state/links", () => ({ requestOpenLink: (url: string, text: string) => requestOpenLink(url, text) }));

afterEach(() => {
  cleanup();
  requestOpenLink.mockClear();
});

describe("links in calendar events (C-12)", () => {
  const url = "https://meet.example.com/room";

  it("ask on a click and a middle click, and open nothing on other buttons", () => {
    render(<LinkedText text={`Call: ${url}`} />);
    const link = screen.getByRole("link", { name: url });
    fireEvent.click(link);
    fireEvent(link, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    fireEvent(link, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 3 }));
    expect(requestOpenLink.mock.calls).toEqual([
      [url, url],
      [url, url],
    ]);
  });

  it("can't be dragged out past the question or opened from the system menu", () => {
    render(<LinkedText text={url} />);
    const link = screen.getByRole("link", { name: url });
    expect(link.getAttribute("draggable")).toBe("false");
    const drag = createEvent.dragStart(link);
    fireEvent(link, drag);
    expect(drag.defaultPrevented).toBe(true);
    const menu = createEvent.contextMenu(link);
    fireEvent(link, menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(requestOpenLink).not.toHaveBeenCalled();
  });
});
