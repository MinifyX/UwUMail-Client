// A mail's remote pictures, loaded after its text.
//
// A frame's load event waits for every picture, and one dead host (a tracking pixel) held the
// whole mail back for as long as fetching it took. So the reader document names no remote picture
// at all: each one waits as a placeholder of its size with a shimmer, while the app finds out the
// sizes (`Backend.imageSizes`: the account's UwUMail server tells them, for other mailboxes the app
// reads them from the pictures it fetched). A picture gets its real address (`uwuimg:`) once its
// size is in place, so nothing moves when it arrives; one that can't be had is shown as a quiet box
// of the same size, or kept as the invisible speck it is when it's a tracking pixel.

import type { ImageSizeProbe, RemoteImageSize } from "@/backend/types";
import { proxyAddress, proxySrcset, type ImageProxy } from "@/lib/remoteImages";
import {
  displaySize,
  isPlaceholder,
  isRemote,
  isTrackingPixel,
  parseSrcset,
  placeholderFromMail,
  placeholderSource,
  sizeFromMail,
  sizeTarget,
  type PartialSize,
  type Size,
} from "./imageSizes";

/** On a picture waiting for its real address or for it to load: shows the shimmer. */
export const PENDING = "data-uwu-pending";
/** On a picture that can't be had: a quiet box in its place. */
export const FAILED = "data-uwu-failed";
/** The real (proxied) `src` and `srcset` while a picture waits. */
export const SOURCE = "data-uwu-src";
const SOURCE_SET = "data-uwu-srcset";
/** The address to ask about, as the mail has it, and the density it shows at. */
const ADDRESS = "data-uwu-url";
const DENSITY = "data-uwu-density";

/** Fired on a picture right after it got its real address. */
export const SOURCE_EVENT = "uwu-picture-source";
/** Fired once the real picture loaded. */
export const LOADED_EVENT = "uwu-picture-loaded";
/** Fired when the picture can't be had; it then shows a placeholder or nothing. */
export const FAILED_EVENT = "uwu-picture-failed";

/** The most addresses asked about at once; the rest load directly. */
const MAX_PROBED = 200;
/** A picture still loading after this long no longer holds up the progress bar. */
const SLOW_MS = 15_000;
/** How long the sizes may take before the pictures load without them. */
const PROBE_MS = 20_000;
const CACHE_SIZE = 500;
const CACHE_MS = 10 * 60_000;

/** The shimmer while a picture waits and the box for one that failed, inside the mail's frame. */
export const PICTURE_STYLES = `img[${PENDING}]{background-color:rgba(128,112,124,.14)!important;background-color:light-dark(rgba(120,100,115,.13),rgba(255,255,255,.08))!important;background-image:linear-gradient(100deg,rgba(255,255,255,0) 30%,rgba(255,255,255,.5) 50%,rgba(255,255,255,0) 70%)!important;background-image:linear-gradient(100deg,rgba(255,255,255,0) 30%,light-dark(rgba(255,255,255,.55),rgba(255,255,255,.09)) 50%,rgba(255,255,255,0) 70%)!important;background-size:200% 100%!important;background-repeat:no-repeat!important;animation:uwu-shimmer 1.4s linear infinite!important}
@keyframes uwu-shimmer{from{background-position:150% 0}to{background-position:-50% 0}}
@media (prefers-reduced-motion:reduce){img[${PENDING}]{animation:none!important;background-image:none!important}}
img[${FAILED}]{background-color:rgba(128,112,124,.08)!important;background-color:light-dark(rgba(120,100,115,.07),rgba(255,255,255,.05))!important;outline:1px dashed rgba(128,112,124,.35)!important;outline-offset:-1px!important}`;

/**
 * Takes the remote pictures out of an already sanitized mail body: each `<img>` that loads from
 * the web gets a placeholder of the size the mail gives it, and keeps its real (proxied) address
 * aside for `loadRemotePictures`. Everything else goes through the proxy as before. Parsed in a
 * `<template>`, where nothing loads.
 */
export function deferRemotePictures(html: string, proxy: ImageProxy | null | undefined): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const elements = Array.from(template.content.querySelectorAll("*"));
  // Our own markers mean something to the reader; a mail doesn't get to set them.
  for (const element of elements) {
    for (const name of element.getAttributeNames()) {
      if (name.toLowerCase().startsWith("data-uwu-")) element.removeAttribute(name);
    }
  }
  const through = (url: string) => (proxy ? proxyAddress(url, proxy) : url);
  for (const image of Array.from(template.content.querySelectorAll("img"))) {
    // A <picture> picks from its <source>s before the <img>; it loads as it is.
    if (image.parentElement?.localName === "picture") continue;
    const src = image.getAttribute("src");
    const srcset = image.getAttribute("srcset");
    const remoteSet = srcset !== null && parseSrcset(srcset).some((candidate) => isRemote(candidate.url));
    if (!isRemote(src) && !remoteSet) continue;
    if (src !== null) image.setAttribute(SOURCE, through(src));
    if (srcset !== null) image.setAttribute(SOURCE_SET, proxy ? proxySrcset(srcset, proxy) : srcset);
    const target = sizeTarget(src, srcset);
    if (target) {
      image.setAttribute(ADDRESS, target.url);
      if (target.density !== 1) image.setAttribute(DENSITY, String(target.density));
    }
    image.removeAttribute("srcset");
    // The reader decides when a picture loads; a lazy one would keep the progress waiting.
    image.removeAttribute("loading");
    image.setAttribute("src", placeholderSource(placeholderFromMail(mailSize(image))));
    image.setAttribute(PENDING, "");
  }
  return template.innerHTML;
}

function mailSize(image: Element): PartialSize {
  return sizeFromMail({
    width: image.getAttribute("width"),
    height: image.getAttribute("height"),
    style: image.getAttribute("style"),
  });
}

/** Sizes told lately, so reopening a mail or switching its look asks nothing again. */
const sizes = new Map<string, { size: RemoteImageSize; at: number }>();

function cachedSize(url: string): RemoteImageSize | null {
  const found = sizes.get(url);
  if (!found) return null;
  if (Date.now() - found.at > CACHE_MS) {
    sizes.delete(url);
    return null;
  }
  return found.size;
}

function rememberSize(size: RemoteImageSize) {
  sizes.delete(size.url);
  sizes.set(size.url, { size, at: Date.now() });
  while (sizes.size > CACHE_SIZE) sizes.delete(sizes.keys().next().value!);
}

export interface PictureProgress {
  done: number;
  total: number;
}

/**
 * Loads the pictures `deferRemotePictures` set aside, in a document that is already shown. With
 * `probe`, a picture gets its real address once its size is known (dead hosts never get
 * one); without, all at once. `onProgress` counts the pictures that loaded or failed. Returns a
 * function that stops everything, e.g. when the mail closes.
 */
export function loadRemotePictures(
  root: HTMLElement,
  probe: ImageSizeProbe | null,
  onProgress: (progress: PictureProgress) => void,
): () => void {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>(`img[${PENDING}]`));
  if (images.length === 0) return () => {};
  const total = images.length;
  const controller = new AbortController();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;
  let done = 0;
  const counted = new Set<HTMLImageElement>();
  const started = new Set<HTMLImageElement>();
  const settled = new Set<HTMLImageElement>();
  const fromMail = new Map(images.map((image) => [image, mailSize(image)] as const));
  const known = new Map<HTMLImageElement, Size>();

  const count = (image: HTMLImageElement) => {
    if (stopped || counted.has(image)) return;
    counted.add(image);
    done += 1;
    onProgress({ done, total });
  };

  const fail = (image: HTMLImageElement) => {
    if (stopped || settled.has(image)) return;
    settled.add(image);
    image.removeAttribute(PENDING);
    image.removeAttribute("srcset");
    const size = known.get(image) ?? null;
    const mail = fromMail.get(image)!;
    // A tracking pixel stays the tiny see-through placeholder it already is: leaving it out
    // (display:none) would take its line with it and move the text below.
    if (!isTrackingPixel(size, mail)) image.setAttribute(FAILED, "");
    const placeholder = placeholderSource(size ?? placeholderFromMail(mail));
    if (image.getAttribute("src") !== placeholder) image.setAttribute("src", placeholder);
    image.dispatchEvent(new Event(FAILED_EVENT));
    count(image);
  };

  const start = (image: HTMLImageElement) => {
    if (stopped || started.has(image) || settled.has(image)) return;
    started.add(image);
    const src = image.getAttribute(SOURCE);
    const srcset = image.getAttribute(SOURCE_SET);
    if (src === null && srcset === null) return fail(image);
    const finish = (ok: boolean) => {
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);
      if (!ok) return fail(image);
      if (stopped || settled.has(image)) return;
      settled.add(image);
      image.removeAttribute(PENDING);
      image.dispatchEvent(new Event(LOADED_EVENT));
      count(image);
    };
    // A placeholder that was still on its way may report in late; only the real picture counts.
    const onLoad = () => {
      if (!isPlaceholder(image.currentSrc)) finish(true);
    };
    const onError = () => finish(false);
    image.addEventListener("load", onLoad);
    image.addEventListener("error", onError);
    if (srcset !== null) image.setAttribute("srcset", srcset);
    if (src !== null) image.setAttribute("src", src);
    else image.removeAttribute("src");
    image.dispatchEvent(new Event(SOURCE_EVENT));
    timers.push(setTimeout(() => count(image), SLOW_MS));
  };

  /** Puts the placeholder of the known size in place, then the real picture over it. */
  const sized = (image: HTMLImageElement, pixels: Size) => {
    const density = Number(image.getAttribute(DENSITY) ?? "1") || 1;
    const size = displaySize(pixels, density);
    if (!size) return start(image);
    known.set(image, size);
    const placeholder = placeholderSource(size);
    if (image.getAttribute("src") === placeholder) return start(image);
    let waiting = true;
    const go = () => {
      if (!waiting) return;
      waiting = false;
      image.removeEventListener("load", onPlaceholder);
      image.removeEventListener("error", go);
      start(image);
    };
    const onPlaceholder = () => {
      // The one before may still report in; wait for this one.
      if (image.complete) go();
    };
    image.addEventListener("load", onPlaceholder);
    image.addEventListener("error", go);
    image.setAttribute("src", placeholder);
    // Should the placeholder never report, the picture loads anyway.
    timers.push(setTimeout(go, 250));
  };

  const byAddress = new Map<string, HTMLImageElement[]>();
  const direct: HTMLImageElement[] = [];
  for (const image of images) {
    const address = image.getAttribute(ADDRESS);
    const mail = fromMail.get(image)!;
    // The mail says both sides: its placeholder already has the final size, so it need not wait.
    if (!address || (mail.width !== null && mail.height !== null)) direct.push(image);
    else byAddress.set(address, [...(byAddress.get(address) ?? []), image]);
  }

  const apply = (size: RemoteImageSize) => {
    for (const image of byAddress.get(size.url) ?? []) {
      if (size.failed) fail(image);
      else if (size.width === null || size.height === null) start(image);
      else sized(image, { width: size.width, height: size.height });
    }
  };

  onProgress({ done: 0, total });
  const ask: string[] = [];
  for (const address of byAddress.keys()) {
    const cached = cachedSize(address);
    if (cached) apply(cached);
    else ask.push(address);
  }
  const asked = probe ? ask.slice(0, MAX_PROBED) : [];
  const unasked = [...direct, ...ask.slice(asked.length).flatMap((address) => byAddress.get(address)!)];
  for (const image of unasked) start(image);

  if (probe && asked.length > 0) {
    const answered = new Set<string>();
    timers.push(setTimeout(() => controller.abort(), PROBE_MS));
    probe(
      asked,
      (size) => {
        if (stopped || answered.has(size.url) || !byAddress.has(size.url)) return;
        answered.add(size.url);
        rememberSize(size);
        apply(size);
      },
      controller.signal,
    )
      // The sizes couldn't be asked for, or stopped coming: what's left loads directly.
      .catch(() => {})
      .then(() => {
        if (stopped) return;
        for (const address of asked) {
          if (!answered.has(address)) for (const image of byAddress.get(address)!) start(image);
        }
      });
  }

  return () => {
    stopped = true;
    controller.abort();
    for (const timer of timers) clearTimeout(timer);
  };
}
