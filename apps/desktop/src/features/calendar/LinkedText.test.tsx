import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkedText } from "./LinkedText";

const requestOpenLink = vi.fn((_url: string, _text: string) => "asked");
const setLinks = vi.fn();
vi.mock("@/state/links", () => ({
  requestOpenLink: (url: string, text: string) => requestOpenLink(url, text),
  useLinks: { setState: (state: unknown) => setLinks(state) },
}));

afterEach(() => {
  cleanup();
  requestOpenLink.mockClear();
  setLinks.mockClear();
});

describe("links in calendar events (C-12, W-23)", () => {
  const url = "https://meet.example.com/room";

  it("ask on a click, Enter and a middle click, and open nothing on other buttons", () => {
    render(<LinkedText text={`Call: ${url}`} />);
    const link = screen.getByRole("link", { name: url });
    fireEvent.click(link);
    fireEvent.keyDown(link, { key: "Enter" });
    fireEvent(link, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    fireEvent(link, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 3 }));
    expect(requestOpenLink.mock.calls).toEqual([
      [url, url],
      [url, url],
      [url, url],
    ]);
  });

  it("has no address the browser could open past the question", () => {
    render(<LinkedText text={url} />);
    const link = screen.getByRole("link", { name: url });
    expect(link.hasAttribute("href")).toBe(false);
    const drag = createEvent.dragStart(link);
    fireEvent(link, drag);
    expect(drag.defaultPrevented).toBe(true);
    expect(requestOpenLink).not.toHaveBeenCalled();
  });

  it("shows the link sheet instead of the system menu", () => {
    render(<LinkedText text={url} />);
    const link = screen.getByRole("link", { name: url });
    const menu = createEvent.contextMenu(link);
    fireEvent(link, menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(setLinks).toHaveBeenCalledWith(expect.objectContaining({ hover: null }));
    expect(setLinks.mock.calls[0]![0].sheet?.href).toBe(url);
    expect(requestOpenLink).not.toHaveBeenCalled();
  });

  it("leaves text without addresses alone", () => {
    const { container } = render(<LinkedText text="Room 4, second floor." />);
    expect(container.textContent).toBe("Room 4, second floor.");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
