import { beforeEach, describe, expect, it } from "vitest";
import { useLinks } from "@/state/links";
import { DEFAULT_SETTINGS, useSettings } from "@/state/settings";
import { keepFrameOnMail, watchLinks } from "./linkEvents";

function mailDocument(body: string) {
  const doc = document.implementation.createHTMLDocument("mail");
  doc.body.innerHTML = body;
  const frame = document.createElement("iframe");
  document.body.append(frame);
  watchLinks(frame, doc);
  return doc;
}

beforeEach(() => {
  useSettings.setState({ ...DEFAULT_SETTINGS });
  useLinks.setState({ pending: null, hover: null, sheet: null });
});

describe("links in a mail", () => {
  it("asks before a middle click opens a link, and never lets one be dragged out", () => {
    const doc = mailDocument(`<a href="https://shop.example/">Shop</a>`);
    const link = doc.querySelector("a")!;
    const middle = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
    link.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);
    expect(useLinks.getState().pending?.href).toBe("https://shop.example/");

    const drag = new Event("dragstart", { bubbles: true, cancelable: true });
    link.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
  });

  it("catches SVG links that point with xlink:href", () => {
    const doc = mailDocument(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">` +
        `<a xlink:href="https://evil.example/"><text>Hi</text></a></svg>`,
    );
    const text = doc.querySelector("text")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    text.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(useLinks.getState().pending?.href).toBe("https://evil.example/");
  });

  it("leaves anchors without a target alone", () => {
    const doc = mailDocument(`<a name="top">Top</a>`);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    doc.querySelector("a")!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(useLinks.getState().pending).toBeNull();
  });

  it("tells the link question which Safe Link the reader took off", () => {
    const doc = mailDocument(
      `<a href="https://wanders.example/clip" data-uwu-safelink="eur01.safelinks.protection.outlook.com">Clip</a>`,
    );
    doc.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const pending = useLinks.getState().pending;
    expect(pending?.href).toBe("https://wanders.example/clip");
    expect(pending?.safeLink).toBe("eur01.safelinks.protection.outlook.com");
  });
});

describe("keepFrameOnMail", () => {
  /** A stand-in for the Navigation API, which jsdom lacks. */
  function navigate(doc: Document, url: string) {
    const event = Object.assign(new Event("navigate", { cancelable: true }), { destination: { url } });
    (doc.defaultView as unknown as { navigation: EventTarget }).navigation.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it("stops every navigation but loading the mail itself", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const doc = frame.contentDocument!;
    Object.defineProperty(doc.defaultView!, "navigation", { value: new EventTarget() });
    keepFrameOnMail(doc);
    expect(navigate(doc, "https://evil.example/")).toBe(true);
    expect(navigate(doc, "about:blank#top")).toBe(true);
    expect(navigate(doc, "about:srcdoc")).toBe(false);
    frame.remove();
  });

  it("does nothing where the engine has no Navigation API", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    expect(() => keepFrameOnMail(frame.contentDocument!)).not.toThrow();
    frame.remove();
  });
});
