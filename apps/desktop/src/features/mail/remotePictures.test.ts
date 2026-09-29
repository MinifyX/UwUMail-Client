import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageSizeProbe, RemoteImageSize } from "@/backend/types";
import { isPlaceholder } from "./imageSizes";
import {
  deferRemotePictures,
  FAILED,
  FAILED_EVENT,
  LOADED_EVENT,
  loadRemotePictures,
  PENDING,
  SOURCE,
  SOURCE_EVENT,
  type PictureProgress,
} from "./remotePictures";

const proxy = (url: string) => `uwuimg://localhost/picture?account=a1&url=${encodeURIComponent(url)}`;

function parse(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

const sizeOf = (image: Element) => {
  const text = decodeURIComponent(image.getAttribute("src") ?? "");
  const match = /width='([\d.]+)' height='([\d.]+)'/.exec(text);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
};

describe("deferRemotePictures", () => {
  it("puts a placeholder of the mail's size where a remote picture goes, and keeps the address aside", () => {
    const root = parse(
      deferRemotePictures(
        '<img src="https://cdn.example/hero.jpg" width="600" height="300" loading="lazy" alt="Hero">',
        proxy,
      ),
    );
    const image = root.querySelector("img")!;
    expect(isPlaceholder(image.getAttribute("src"))).toBe(true);
    expect(sizeOf(image)).toEqual({ width: 600, height: 300 });
    expect(image.getAttribute(SOURCE)).toBe(proxy("https://cdn.example/hero.jpg"));
    expect(image.getAttribute("data-uwu-url")).toBe("https://cdn.example/hero.jpg");
    expect(image.hasAttribute(PENDING)).toBe(true);
    expect(image.hasAttribute("loading")).toBe(false);
    expect(image.getAttribute("alt")).toBe("Hero");
  });

  it("uses a tiny placeholder where the mail says nothing about the size", () => {
    const image = parse(deferRemotePictures('<img src="https://track.example/o.gif">', proxy)).querySelector("img")!;
    expect(sizeOf(image)).toEqual({ width: 1, height: 1 });
  });

  it("keeps a srcset aside through the proxy and asks about its density candidate", () => {
    const image = parse(
      deferRemotePictures('<img srcset="https://cdn.example/a.jpg 1x, https://cdn.example/a2.jpg 2x">', proxy),
    ).querySelector("img")!;
    expect(image.hasAttribute("srcset")).toBe(false);
    expect(image.getAttribute("data-uwu-srcset")).toBe(
      `${proxy("https://cdn.example/a.jpg")} 1x, ${proxy("https://cdn.example/a2.jpg")} 2x`,
    );
    expect(image.getAttribute("data-uwu-url")).toBe("https://cdn.example/a.jpg");
    expect(image.hasAttribute(SOURCE)).toBe(false);
  });

  it("loads directly without a proxy", () => {
    const image = parse(deferRemotePictures('<img src="https://cdn.example/a.jpg">', null)).querySelector("img")!;
    expect(image.getAttribute(SOURCE)).toBe("https://cdn.example/a.jpg");
  });

  it("leaves embedded pictures and <picture> alone, and drops markers the mail set itself", () => {
    const root = parse(
      deferRemotePictures(
        '<img src="cid:logo" data-uwu-pending data-uwu-src="https://evil.example/x.gif">' +
          '<img src="data:image/png;base64,AAAA">' +
          '<picture><source srcset="https://cdn.example/a.webp"><img src="https://cdn.example/a.jpg"></picture>',
        proxy,
      ),
    );
    const [cid, data, inPicture] = Array.from(root.querySelectorAll("img"));
    expect(cid!.getAttribute("src")).toBe("cid:logo");
    expect(cid!.hasAttribute(PENDING)).toBe(false);
    expect(cid!.hasAttribute(SOURCE)).toBe(false);
    expect(data!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(inPicture!.getAttribute("src")).toBe("https://cdn.example/a.jpg");
  });
});

describe("loadRemotePictures", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A probe the test answers line by line. */
  function scriptedProbe() {
    const calls: { urls: string[]; onSize: (size: RemoteImageSize) => void; signal: AbortSignal }[] = [];
    let finish: () => void = () => {};
    let fail: (error: Error) => void = () => {};
    const probe: ImageSizeProbe = (urls, onSize, signal) => {
      calls.push({ urls, onSize, signal });
      return new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
    };
    return { probe, calls, finish: () => finish(), fail: (error: Error) => fail(error) };
  }

  const mail = (html: string) => parse(deferRemotePictures(html, proxy));
  const load = (image: Element) => image.dispatchEvent(new Event("load"));
  const error = (image: Element) => image.dispatchEvent(new Event("error"));

  it("sizes each picture before it gets its real address, and counts what arrived", async () => {
    const root = mail(
      '<img src="https://cdn.example/hero.jpg" width="480">' +
        '<img src="https://cdn.example/hero.jpg" style="width:100%">' +
        '<img src="https://track.example/o.gif">' +
        '<img src="https://slow.example/late.png" width="120" height="60">' +
        '<img src="https://slow.example/unsized.png">',
    );
    const [hero, again, pixel, late, unsized] = Array.from(root.querySelectorAll("img"));
    const { probe, calls, finish } = scriptedProbe();
    const progress: PictureProgress[] = [];
    const events: string[] = [];
    for (const name of [SOURCE_EVENT, LOADED_EVENT, FAILED_EVENT]) {
      hero!.addEventListener(name, () => events.push(name));
    }
    loadRemotePictures(root, probe, (next) => progress.push(next));

    // Where the mail gives both sides, the placeholder is final already: that one loads at once.
    expect(calls[0]!.urls).toEqual([
      "https://cdn.example/hero.jpg",
      "https://track.example/o.gif",
      "https://slow.example/unsized.png",
    ]);
    expect(late!.getAttribute("src")).toBe(proxy("https://slow.example/late.png"));
    expect(progress).toEqual([{ done: 0, total: 5 }]);

    calls[0]!.onSize({ url: "https://cdn.example/hero.jpg", width: 960, height: 540, failed: false });
    // First the placeholder of the real size, both places the address is used …
    expect(sizeOf(hero!)).toEqual({ width: 960, height: 540 });
    expect(sizeOf(again!)).toEqual({ width: 960, height: 540 });
    expect(hero!.hasAttribute(PENDING)).toBe(true);
    // … then, with the placeholder in place, the real picture.
    load(hero!);
    await vi.advanceTimersByTimeAsync(250);
    expect(hero!.getAttribute("src")).toBe(proxy("https://cdn.example/hero.jpg"));
    expect(events).toEqual([SOURCE_EVENT]);
    load(hero!);
    expect(hero!.hasAttribute(PENDING)).toBe(false);
    expect(events).toEqual([SOURCE_EVENT, LOADED_EVENT]);
    expect(progress.at(-1)).toEqual({ done: 1, total: 5 });

    // A dead tracking pixel is never loaded and stays an invisible speck, without a box.
    calls[0]!.onSize({ url: "https://track.example/o.gif", failed: true, width: null, height: null });
    expect(pixel!.hasAttribute(PENDING)).toBe(false);
    expect(pixel!.hasAttribute(FAILED)).toBe(false);
    expect(sizeOf(pixel!)).toEqual({ width: 1, height: 1 });
    expect(progress.at(-1)).toEqual({ done: 2, total: 5 });

    // A picture that fails to load keeps its place as a quiet box.
    error(late!);
    expect(late!.hasAttribute(FAILED)).toBe(true);
    expect(sizeOf(late!)).toEqual({ width: 120, height: 60 });

    // What was never answered loads directly once it's done.
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(unsized!.getAttribute("src")).toBe(proxy("https://slow.example/unsized.png"));
    load(unsized!);

    load(again!);
    expect(progress.at(-1)).toEqual({ done: 5, total: 5 });
  });

  it("shows a picture that can't be had as a box of its size", () => {
    const root = mail('<img src="https://gone.example/a.jpg" width="300">');
    const image = root.querySelector("img")!;
    const { probe, calls } = scriptedProbe();
    loadRemotePictures(root, probe, () => {});
    calls[0]!.onSize({ url: "https://gone.example/a.jpg", failed: true, width: null, height: null });
    expect(image.hasAttribute(FAILED)).toBe(true);
    // The mail's width, in the shape guessed while the height is unknown.
    expect(sizeOf(image)).toEqual({ width: 300, height: 168.75 });
    expect(image.getAttribute("src")).not.toBe(proxy("https://gone.example/a.jpg"));
  });

  it("loads everything directly when the sizes can't be asked for", async () => {
    const root = mail('<img src="https://cdn.example/a.jpg"><img src="https://cdn.example/b.jpg">');
    const { probe, fail } = scriptedProbe();
    loadRemotePictures(root, probe, () => {});
    fail(new Error("502"));
    await vi.advanceTimersByTimeAsync(0);
    expect(Array.from(root.querySelectorAll("img")).map((image) => image.getAttribute("src"))).toEqual([
      proxy("https://cdn.example/a.jpg"),
      proxy("https://cdn.example/b.jpg"),
    ]);
  });

  it("loads at once without a probe, and counts a slow picture done after a while", async () => {
    const root = mail('<img src="https://cdn.example/a.jpg" width="10" height="10">');
    const image = root.querySelector("img")!;
    const progress: PictureProgress[] = [];
    loadRemotePictures(root, null, (next) => progress.push(next));
    expect(image.getAttribute("src")).toBe(proxy("https://cdn.example/a.jpg"));
    expect(progress).toEqual([{ done: 0, total: 1 }]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(progress.at(-1)).toEqual({ done: 1, total: 1 });
    // It keeps its shimmer until it really arrives.
    expect(image.hasAttribute(PENDING)).toBe(true);
  });

  it("stops asking when the mail closes", () => {
    const root = mail('<img src="https://cdn.example/a.jpg">');
    const { probe, calls } = scriptedProbe();
    const progress: PictureProgress[] = [];
    const stop = loadRemotePictures(root, probe, (next) => progress.push(next));
    stop();
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.onSize({ url: "https://cdn.example/a.jpg", width: 5, height: 5, failed: false });
    expect(root.querySelector("img")!.hasAttribute(PENDING)).toBe(true);
    expect(progress).toHaveLength(1);
  });

  it("does nothing for a mail without remote pictures", () => {
    const progress: PictureProgress[] = [];
    loadRemotePictures(mail('<img src="cid:logo">'), scriptedProbe().probe, (next) => progress.push(next));
    expect(progress).toEqual([]);
  });
});
