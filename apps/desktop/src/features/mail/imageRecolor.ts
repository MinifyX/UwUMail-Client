// Recoloring images for dark mode, pixel by pixel. No DOM here: it also runs
// in a worker (imageRecolor.worker.ts), darkImages.ts puts it into the mail.
//
// Newsletters put headlines, logos and whole layouts into images with white
// paper baked in. When a mail is shown dark, such images get the treatment the
// HTML around them gets: the paper takes the color behind the image, dark ink
// turns light, colors keep their hue. Photos stay as they are.
//
// The image is split into connected areas of light paper and of ink. Ink that
// is small or thin (letters, lines, icons) turns light. Paper turns dark where
// it reaches the image's edge or surrounds such ink. Large solid shapes, photos
// and light text on colored buttons stay as they are. A few linear passes over
// the pixels, colors are cached: a typical newsletter image takes milliseconds.

import { darkenBackground, fromOklch, lightenText, toOklch } from "./darkMode";
import type { Rgba } from "./darkMode";

/** Icons and spacers are too small to matter. */
export const MIN_PIXELS = 24 * 24;
/** Larger images are photos; they are skipped without looking. */
export const MAX_PIXELS = 2_500_000;
/** Photos are found in tiles of this size, by having more colors than `PHOTO_COLORS` (4 bits per channel). */
const TILE = 16;
const PHOTO_COLORS = 32;
/** Ink up to this share of the image (or `SMALL_INK_MIN` pixels) is small: a letter, an icon. */
const SMALL_INK = 0.004;
const SMALL_INK_MIN = 1500;
/** Ink covering at most this share of its bounding box is thin: lines, outlines, underlines. */
const THIN_INK = 0.3;
/** Lightness of ink after recoloring, like `lightenText` makes dark text. */
const INK_LIGHTNESS = 0.94;

export type ImageVerdict =
  /** The pixels were recolored in place. */
  | "recolored"
  /** Light ink on transparency: made for dark backgrounds already. */
  | "light-ink"
  | "unchanged";

const luma = (r: number, g: number, b: number) => (54 * r + 183 * g + 19 * b) >> 8;
const spread = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b);
/** White or almost white, or see-through. */
const isPaper = (r: number, g: number, b: number, a: number) =>
  a < 32 || (luma(r, g, b) >= 200 && spread(r, g, b) <= 40);

// ------------------------------------------------------------- colors

/** What one color becomes, `paper` being what white turns into. */
export function recolor(color: Rgba, paper: Rgba): Rgba {
  const o = toOklch(color);
  if (o.c < 0.035) {
    // Grays flip: white becomes the paper, black becomes light ink, in between stays in between.
    const p = toOklch(paper);
    return fromOklch({ l: INK_LIGHTNESS - (INK_LIGHTNESS - p.l) * o.l, c: p.c * o.l, h: p.h });
  }
  if (o.l >= 0.8) return darkenBackground(color);
  if (o.l < 0.5) return lightenText(color, paper);
  return color;
}

let palette = new Int32Array(0);
let palettePaper = "";

/**
 * `recolor` for 6 bits per channel, filled in as colors come up: images repeat the same few
 * colors a lot. Kept for the next image on the same paper.
 */
function paletteFor(paper: Rgba): Int32Array {
  const key = `${paper.r},${paper.g},${paper.b}`;
  if (palettePaper !== key || palette.length === 0) {
    palette = new Int32Array(1 << 18).fill(-1);
    palettePaper = key;
  }
  return palette;
}

function paletteEntry(key: number, paper: Rgba): number {
  const expand = (v: number) => (v << 2) | (v >> 4);
  const out = recolor({ r: expand(key >> 12), g: expand((key >> 6) & 63), b: expand(key & 63), a: 1 }, paper);
  return (Math.round(out.r) << 16) | (Math.round(out.g) << 8) | Math.round(out.b);
}

// ------------------------------------------------------------- pixels

/** Tiles with many colors: parts of a photo. */
function photoTiles(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const cols = Math.ceil(width / TILE);
  const rows = Math.ceil(height / TILE);
  const photo = new Uint8Array(cols * rows);
  const seen = new Uint32Array(4096);
  for (let tile = 0; tile < cols * rows; tile += 1) {
    const left = (tile % cols) * TILE;
    const top = Math.floor(tile / cols) * TILE;
    const right = Math.min(width, left + TILE);
    const bottom = Math.min(height, top + TILE);
    let colors = 0;
    for (let y = top; y < bottom && colors <= PHOTO_COLORS; y += 1) {
      for (let i = (y * width + left) * 4, end = (y * width + right) * 4; i < end; i += 4) {
        if (data[i + 3]! < 32) continue;
        const key = ((data[i]! >> 4) << 8) | ((data[i + 1]! >> 4) << 4) | (data[i + 2]! >> 4);
        if (seen[key] !== tile + 1) {
          seen[key] = tile + 1;
          colors += 1;
        }
      }
    }
    photo[tile] = colors > PHOTO_COLORS ? 1 : 0;
  }
  return photo;
}

const LIGHT = 1;
const RECOLOR = 2;

/**
 * Which pixels to recolor: flags with the `RECOLOR` bit (`LIGHT` marks paper), and how many.
 */
export function recolorMask(data: Uint8ClampedArray, width: number, height: number) {
  const total = width * height;
  const cols = Math.ceil(width / TILE);
  const photo = photoTiles(data, width, height);
  const flags = new Uint8Array(total);
  for (let y = 0, p = 0; y < height; y += 1) {
    const tileRow = ((y / TILE) | 0) * cols;
    for (let x = 0; x < width; x += 1, p += 1) {
      const i = p << 2;
      if (data[i + 3]! < 32) {
        flags[p] = LIGHT;
        continue;
      }
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const l = (54 * r + 183 * g + 19 * b) >> 8;
      // Inside a photo only pure white counts as paper, so skies and shirts stay part of it.
      if (photo[tileRow + ((x / TILE) | 0)]) {
        if (l >= 245 && Math.max(r, g, b) - Math.min(r, g, b) <= 12) flags[p] = LIGHT;
      } else if (l >= 200) flags[p] = LIGHT;
    }
  }

  // Areas of the same kind, 4-connected: ink areas get labels 1, 2, ..., paper areas -1, -2, ...
  // `fill` leaves an area's pixels at the start of `queue` and returns how many there are.
  const labels = new Int32Array(total);
  const queue = new Int32Array(total);
  const fill = (start: number, label: number): number => {
    const kind = flags[start]! & LIGHT;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    labels[start] = label;
    while (head < tail) {
      const p = queue[head++]!;
      const x = p % width;
      if (x > 0 && labels[p - 1] === 0 && (flags[p - 1]! & LIGHT) === kind) {
        labels[p - 1] = label;
        queue[tail++] = p - 1;
      }
      if (x < width - 1 && labels[p + 1] === 0 && (flags[p + 1]! & LIGHT) === kind) {
        labels[p + 1] = label;
        queue[tail++] = p + 1;
      }
      if (p >= width && labels[p - width] === 0 && (flags[p - width]! & LIGHT) === kind) {
        labels[p - width] = label;
        queue[tail++] = p - width;
      }
      if (p < total - width && labels[p + width] === 0 && (flags[p + width]! & LIGHT) === kind) {
        labels[p + width] = label;
        queue[tail++] = p + width;
      }
    }
    return tail;
  };

  // Small or thin ink is text or line art; the rest is shapes and photos.
  const small = Math.max(SMALL_INK_MIN, total * SMALL_INK);
  const inkTurns: boolean[] = [false];
  for (let p = 0; p < total; p += 1) {
    if (flags[p]! & LIGHT || labels[p] !== 0) continue;
    const area = fill(p, inkTurns.length);
    let turns = area <= small;
    if (!turns) {
      let left = width;
      let right = 0;
      let top = height;
      let bottom = 0;
      for (let k = 0; k < area; k += 1) {
        const q = queue[k]!;
        const x = q % width;
        const y = (q - x) / width;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
      turns = area <= (right - left + 1) * (bottom - top + 1) * THIN_INK;
    }
    inkTurns.push(turns);
  }

  // Paper turns dark where it reaches the edge (the image's own paper) or where it's mostly
  // surrounded by ink that turns light (the inside of letters). Light text on a button stays.
  const paperTurns: boolean[] = [false];
  let changed = 0;
  const vote = (n: number) => (labels[n]! > 0 ? (inkTurns[labels[n]!] ? 1 : -1) : 0);
  for (let p = 0; p < total; p += 1) {
    if (!(flags[p]! & LIGHT) || labels[p] !== 0) continue;
    const area = fill(p, -paperTurns.length);
    let edge = false;
    let votes = 0;
    for (let k = 0; k < area; k += 1) {
      const q = queue[k]!;
      const x = q % width;
      if (x === 0 || x === width - 1 || q < width || q >= total - width) {
        edge = true;
        break;
      }
      votes += vote(q - 1) + vote(q + 1) + vote(q - width) + vote(q + width);
    }
    const turns = edge || votes > 0;
    paperTurns.push(turns);
    if (turns) {
      for (let k = 0; k < area; k += 1) flags[queue[k]!]! |= RECOLOR;
      changed += area;
    }
  }

  // Ink follows the paper around it, so light text never ends up on paper that stayed light.
  const around = new Int32Array(inkTurns.length);
  const side = (label: number, n: number) => {
    const other = labels[n]!;
    if (other < 0) around[label]! += paperTurns[-other] ? 1 : -1;
  };
  for (let p = 0; p < total; p += 1) {
    const label = labels[p]!;
    if (label <= 0 || !inkTurns[label]) continue;
    const x = p % width;
    if (x > 0) side(label, p - 1);
    if (x < width - 1) side(label, p + 1);
    if (p >= width) side(label, p - width);
    if (p < total - width) side(label, p + width);
  }
  for (let p = 0; p < total; p += 1) {
    const label = labels[p]!;
    if (label > 0 && inkTurns[label] && around[label]! >= 0) {
      flags[p]! |= RECOLOR;
      changed += 1;
    }
  }
  return { flags, changed };
}

/**
 * Recolors light images in place for a dark background: `paper` is what white becomes, the
 * color behind the image. Leaves photos, dark images and light ink alone.
 */
export function recolorPixels(data: Uint8ClampedArray, width: number, height: number, paper: Rgba): ImageVerdict {
  const total = width * height;
  if (total < MIN_PIXELS || total > MAX_PIXELS) return "unchanged";

  let clear = 0;
  let inkWeight = 0;
  let inkLuma = 0;
  for (let i = 3; i < total * 4; i += 4) {
    const a = data[i]!;
    if (a < 32) clear += 1;
    else if (a >= 128) {
      inkWeight += a;
      inkLuma += ((54 * data[i - 3]! + 183 * data[i - 2]! + 19 * data[i - 1]!) >> 8) * a;
    }
  }
  if (clear / total >= 0.1) {
    // A cut-out logo: light ink was made for dark backgrounds, dark ink needs flipping.
    if (inkWeight === 0 || inkLuma / inkWeight >= 150) return "light-ink";
  } else {
    // Printed on paper, the paper shows at the edges. Otherwise it's a photo or already dark.
    let edge = 0;
    let edgePaper = 0;
    const check = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      edge += 1;
      if (isPaper(data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!)) edgePaper += 1;
    };
    for (let x = 0; x < width; x += 1) {
      check(x, 0);
      check(x, height - 1);
    }
    for (let y = 1; y < height - 1; y += 1) {
      check(0, y);
      check(width - 1, y);
    }
    if (edgePaper / edge < 0.5) return "unchanged";
  }

  const { flags, changed } = recolorMask(data, width, height);
  if (changed < total * 0.01) return "unchanged";
  const colors = paletteFor(paper);
  for (let p = 0; p < total; p += 1) {
    if (!(flags[p]! & RECOLOR)) continue;
    const i = p << 2;
    const key = ((data[i]! >> 2) << 12) | ((data[i + 1]! >> 2) << 6) | (data[i + 2]! >> 2);
    let out = colors[key]!;
    if (out < 0) out = colors[key] = paletteEntry(key, paper);
    data[i] = out >> 16;
    data[i + 1] = (out >> 8) & 255;
    data[i + 2] = out & 255;
  }
  return "recolored";
}

/** A `recolorPixels` call sent to the worker; `buffer` holds the RGBA pixels and is handed over. */
export interface RecolorJob {
  id: number;
  buffer: ArrayBuffer;
  width: number;
  height: number;
  paper: Rgba;
}

/** Its answer, with the (possibly recolored) pixels handed back. */
export interface RecolorDone {
  id: number;
  verdict: ImageVerdict;
  buffer: ArrayBuffer;
}
