// Dark mode for images in mail.
//
// When a mail is shown dark, its light images are recolored to match (see
// imageRecolor.ts for how). This part finds the images, reads their pixels,
// has a worker do the work and swaps in the result. Remote images the page
// may not read come from the engine (desktop) or need the sender's CORS
// permission (webmail); otherwise they stay as they are.

import { contrast, DARK_SURFACE, IMAGE_BACKING, parseColor, type Rgba } from "./darkMode";
import {
  MAX_PIXELS,
  MIN_PIXELS,
  recolorPixels,
  type ImageVerdict,
  type RecolorDone,
  type RecolorJob,
} from "./imageRecolor";

/** How long an image stays hidden at most while it's looked at. */
const REVEAL_AFTER_MS = 2500;
const CACHE_SIZE = 48;
/** The worker goes away after this long without work. */
const WORKER_IDLE_MS = 30_000;

// ------------------------------------------------------------- worker

let worker: Worker | null = null;
/** Set once the worker couldn't start; the page then does the work itself. */
let noWorker = typeof Worker === "undefined";
let nextJob = 1;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const jobs = new Map<number, (done: RecolorDone | null) => void>();

function startWorker(): Worker | null {
  if (worker || noWorker) return worker;
  try {
    worker = new Worker(new URL("./imageRecolor.worker.ts", import.meta.url), { type: "module" });
  } catch {
    noWorker = true;
    return null;
  }
  worker.onmessage = ({ data }: MessageEvent<RecolorDone>) => {
    jobs.get(data.id)?.(data);
    jobs.delete(data.id);
  };
  worker.onerror = () => {
    noWorker = true;
    stopWorker();
  };
  return worker;
}

function stopWorker() {
  worker?.terminate();
  worker = null;
  for (const finish of jobs.values()) finish(null);
  jobs.clear();
}

/** `recolorPixels` in the worker, or right here where there is none. Null if the worker failed. */
async function recolorOffPage(
  pixels: ImageData,
  paper: Rgba,
): Promise<{ verdict: ImageVerdict; pixels: ImageData } | null> {
  const target = startWorker();
  if (!target) return { verdict: recolorPixels(pixels.data, pixels.width, pixels.height, paper), pixels };
  clearTimeout(idleTimer);
  const id = nextJob++;
  const done = await new Promise<RecolorDone | null>((resolve) => {
    jobs.set(id, resolve);
    const job: RecolorJob = { id, buffer: pixels.data.buffer, width: pixels.width, height: pixels.height, paper };
    target.postMessage(job, [job.buffer]);
  });
  if (jobs.size === 0) idleTimer = setTimeout(stopWorker, WORKER_IDLE_MS);
  if (!done) return null;
  return {
    verdict: done.verdict,
    pixels: new ImageData(new Uint8ClampedArray(done.buffer), pixels.width, pixels.height),
  };
}

// ---------------------------------------------------------------- DOM

interface Result {
  verdict: ImageVerdict;
  /** Blob URL of the recolored image. */
  url?: string;
}

/** Recolored images by source and paper, so reopening a mail doesn't redo the work. */
const results = new Map<string, Promise<Result | null>>();

function remember(key: string, result: Promise<Result | null>) {
  results.set(key, result);
  while (results.size > CACHE_SIZE) {
    const [oldest, evicted] = results.entries().next().value!;
    results.delete(oldest);
    void evicted.then((done) => done?.url && URL.revokeObjectURL(done.url));
  }
}

/** Fetches a remote image's bytes where the page itself may not read them; null if it can't. */
export type RemoteImageLoader = (url: string) => Promise<Blob | null>;

/** The color right behind an element: its nearest ancestor with a background. */
function backdrop(element: Element): Rgba {
  const view = element.ownerDocument.defaultView!;
  for (let current = element.parentElement; current; current = current.parentElement) {
    const color = parseColor(view.getComputedStyle(current).backgroundColor);
    if (color && color.a >= 0.5) return { ...color, a: 1 };
  }
  return DARK_SURFACE;
}

function sitsOnBackgroundImage(element: Element): boolean {
  const view = element.ownerDocument.defaultView!;
  for (let current = element.parentElement; current; current = current.parentElement) {
    const image = view.getComputedStyle(current).backgroundImage;
    if (image && image !== "none") return true;
  }
  return false;
}

/** Resolves once the image loaded (true) or failed (false); lazy images may take until scrolled to. */
function loaded(image: HTMLImageElement): Promise<boolean> {
  if (image.complete) return Promise.resolve(image.naturalWidth > 0);
  return new Promise((resolve) => {
    image.addEventListener("load", () => resolve(true), { once: true });
    image.addEventListener("error", () => resolve(false), { once: true });
  });
}

async function decode(src: string, crossOrigin: boolean): Promise<HTMLImageElement | null> {
  const image = new Image();
  if (crossOrigin) image.crossOrigin = "anonymous";
  image.src = src;
  try {
    await image.decode();
    return image;
  } catch {
    return null;
  }
}

/** Something the canvas may read: same-origin sources directly, remote ones via `loadRemote` or CORS. */
async function readable(image: HTMLImageElement, src: string, loadRemote?: RemoteImageLoader) {
  if (/^(data|blob):/i.test(src)) return { source: image as CanvasImageSource, release: () => {} };
  if (!/^https?:/i.test(src)) return null;
  const blob = await loadRemote?.(src).catch(() => null);
  if (blob) {
    const url = URL.createObjectURL(blob);
    const decoded = await decode(url, false);
    if (decoded) return { source: decoded as CanvasImageSource, release: () => URL.revokeObjectURL(url) };
    URL.revokeObjectURL(url);
  }
  const shared = await decode(src, true);
  return shared && { source: shared as CanvasImageSource, release: () => {} };
}

async function recolorImage(
  image: HTMLImageElement,
  src: string,
  paper: Rgba,
  loadRemote?: RemoteImageLoader,
): Promise<Result | null> {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (width * height < MIN_PIXELS || width * height > MAX_PIXELS) return { verdict: "unchanged" };
  const input = await readable(image, src, loadRemote);
  if (!input) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let pixels: ImageData;
  try {
    if (!context) return null;
    context.drawImage(input.source, 0, 0, width, height);
    // Throws for images the page may not read.
    pixels = context.getImageData(0, 0, width, height);
  } catch {
    return null;
  } finally {
    input.release();
  }
  const done = await recolorOffPage(pixels, paper);
  if (!done || done.verdict !== "recolored") return done && { verdict: done.verdict };
  context.putImageData(done.pixels, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? { verdict: done.verdict, url: URL.createObjectURL(blob) } : null;
}

function apply(image: HTMLImageElement, result: Result) {
  if (result.verdict === "unchanged") return;
  if (image.style.getPropertyValue("background-color") === IMAGE_BACKING) {
    image.style.removeProperty("background-color");
    image.style.removeProperty("border-radius");
  }
  if (!result.url) return;
  // A <picture> picks from its <source>s before the <img>'s own address.
  if (image.parentElement?.tagName === "PICTURE") {
    for (const source of Array.from(image.parentElement.querySelectorAll("source"))) source.remove();
  }
  image.removeAttribute("srcset");
  image.src = result.url;
}

const idle = () =>
  new Promise<void>((resolve) =>
    "requestIdleCallback" in window ? requestIdleCallback(() => resolve(), { timeout: 200 }) : setTimeout(resolve, 0),
  );

/**
 * Recolors the light images of a mail shown dark. Images wait hidden until they're done (at most
 * a moment), so they never flash white. One image at a time, in the order they load, in idle
 * time. Returns a function that stops the work, e.g. when the mail closes.
 */
export function darkenImages(root: HTMLElement, loadRemote?: RemoteImageLoader): () => void {
  let stopped = false;
  const hidden = new Map<HTMLImageElement, ReturnType<typeof setTimeout>>();
  const reveal = (image: HTMLImageElement) => {
    const timer = hidden.get(image);
    if (timer === undefined) return;
    clearTimeout(timer);
    hidden.delete(image);
    image.style.removeProperty("opacity");
  };

  const handle = async (image: HTMLImageElement) => {
    const src = image.currentSrc || image.src;
    const paper = backdrop(image);
    // On light paper (a light box in the mail) the image is fine as it is.
    if (!src || contrast(paper, DARK_SURFACE) > 3) return;
    const key = `${paper.r},${paper.g},${paper.b}|${src}`;
    const cacheable = !src.startsWith("data:");
    let result = cacheable ? results.get(key) : undefined;
    if (!result) {
      result = recolorImage(image, src, paper, loadRemote);
      if (cacheable) remember(key, result);
    }
    const done = await result;
    if (done && !stopped) apply(image, done);
  };

  const queue: HTMLImageElement[] = [];
  let running = false;
  const pump = async () => {
    if (running) return;
    running = true;
    while (queue.length > 0 && !stopped) {
      const image = queue.shift()!;
      try {
        await handle(image);
      } catch {
        // Whatever went wrong, the image stays as the sender made it.
      }
      reveal(image);
      await idle();
    }
    running = false;
  };

  for (const image of Array.from(root.querySelectorAll("img"))) {
    if (sitsOnBackgroundImage(image)) continue;
    // Mails rarely set an inline opacity on images; one that does keeps its look while visible.
    if (!image.style.getPropertyValue("opacity")) {
      image.style.setProperty("opacity", "0", "important");
      hidden.set(
        image,
        setTimeout(() => reveal(image), REVEAL_AFTER_MS),
      );
    }
    void loaded(image).then((ok) => {
      if (!ok || stopped) return reveal(image);
      queue.push(image);
      void pump();
    });
  }

  return () => {
    stopped = true;
    for (const image of [...hidden.keys()]) reveal(image);
  };
}
