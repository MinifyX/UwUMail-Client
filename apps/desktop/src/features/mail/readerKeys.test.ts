import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardFrameKeys, scrollReader, wantsTextSelectAll } from "./readerKeys";

function keydown(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

function page() {
  document.body.innerHTML = `
    <div data-thread-list>
      <div data-thread-id="t1"><button id="row">Row</button></div>
      <button id="more">Load more</button>
    </div>
    <section data-reader>
      <button id="reply">Reply</button>
      <div data-reader-scroll><p id="text">Hello</p></div>
    </section>
    <input id="search" />
    <div id="editor" contenteditable="true"></div>`;
  const scroller = document.querySelector<HTMLElement>("[data-reader-scroll]")!;
  scroller.scrollBy = vi.fn();
  scroller.scrollTo = vi.fn();
  return { scroller, byId: (id: string) => document.getElementById(id)! };
}

afterEach(() => {
  document.body.innerHTML = "";
  document.getSelection()?.removeAllRanges();
});

describe("scrollReader", () => {
  it("scrolls the open mail from a list row and from the page", () => {
    const { scroller, byId } = page();
    expect(scrollReader(keydown(byId("row"), { key: "PageDown" }))).toBe(true);
    expect(scrollReader(keydown(document.body, { key: " ", shiftKey: true }))).toBe(true);
    expect(scrollReader(keydown(document.body, { key: "Home" }))).toBe(true);
    expect(scroller.scrollBy).toHaveBeenCalledTimes(2);
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("leaves Space to buttons outside the rows", () => {
    const { scroller, byId } = page();
    expect(scrollReader(keydown(byId("more"), { key: " " }))).toBe(false);
    expect(scrollReader(keydown(byId("reply"), { key: " " }))).toBe(false);
    expect(scroller.scrollBy).not.toHaveBeenCalled();
  });

  it("does nothing without an open mail", () => {
    document.body.innerHTML = `<div data-thread-list><div data-thread-id="t1"><button id="row"></button></div></div>`;
    expect(scrollReader(keydown(document.getElementById("row")!, { key: "PageDown" }))).toBe(false);
  });
});

describe("wantsTextSelectAll", () => {
  it("keeps Ctrl+A for fields and the composer", () => {
    const { byId } = page();
    // jsdom does not compute isContentEditable.
    Object.defineProperty(byId("editor"), "isContentEditable", { value: true });
    expect(wantsTextSelectAll(keydown(byId("search"), { key: "a", ctrlKey: true }))).toBe(true);
    expect(wantsTextSelectAll(keydown(byId("editor"), { key: "a", ctrlKey: true }))).toBe(true);
  });

  it("takes Ctrl+A for the list from a row or the page", () => {
    const { byId } = page();
    expect(wantsTextSelectAll(keydown(byId("row"), { key: "a", ctrlKey: true }))).toBe(false);
    expect(wantsTextSelectAll(keydown(document.body, { key: "a", ctrlKey: true }))).toBe(false);
  });

  it("keeps Ctrl+A while text is selected or the focus is in the reader", () => {
    const { byId } = page();
    expect(wantsTextSelectAll(keydown(byId("reply"), { key: "a", ctrlKey: true }))).toBe(true);
    const range = document.createRange();
    range.selectNodeContents(byId("text"));
    document.getSelection()!.addRange(range);
    expect(wantsTextSelectAll(keydown(document.body, { key: "a", ctrlKey: true }))).toBe(true);
    // A caret left behind by a click is no selection.
    document.getSelection()!.collapseToStart();
    expect(wantsTextSelectAll(keydown(document.body, { key: "a", ctrlKey: true }))).toBe(false);
  });
});

describe("forwardFrameKeys", () => {
  function frame() {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = `<p id="text">Mail</p><input id="field" />`;
    forwardFrameKeys(iframe, doc);
    const seen: KeyboardEvent[] = [];
    iframe.addEventListener("keydown", (event) => {
      seen.push(event as KeyboardEvent);
      event.preventDefault();
    });
    const press = (id: string, init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      doc.getElementById(id)!.dispatchEvent(event);
      return event;
    };
    return { seen, press };
  }

  it("hands arrows and single keys to the app", () => {
    const { seen, press } = frame();
    const event = press("text", { key: "ArrowDown", shiftKey: true });
    expect(seen.map((e) => [e.key, e.shiftKey])).toEqual([["ArrowDown", true]]);
    expect(event.defaultPrevented).toBe(true);
    press("text", { key: "k", ctrlKey: true });
    expect(seen).toHaveLength(2);
  });

  it("keeps Ctrl+A, Ctrl+C and typing inside the mail", () => {
    const { seen, press } = frame();
    expect(press("text", { key: "a", ctrlKey: true }).defaultPrevented).toBe(false);
    press("text", { key: "c", metaKey: true });
    press("field", { key: "j" });
    expect(seen).toHaveLength(0);
  });
});
