/**
 * Pictures for people: contact photos and the own profile picture.
 *
 * A picture is read in the browser, cropped to a circle the person places themselves, and only
 * the small square that comes out of that leaves the page — never the original file with its
 * metadata. Everything here but `readPicture` and the canvas is plain arithmetic, so it can be
 * tested without a browser.
 */

/** Files larger than this are refused before they are decoded. */
export const PICTURE_MAX_BYTES = 20 * 1024 * 1024;
/** Decoded pictures with more pixels than this are refused; a phone photo has about 12 million. */
export const PICTURE_MAX_PIXELS = 60_000_000;
/** How far in one can zoom, from the size where the picture just covers the circle. */
export const MAX_ZOOM = 8;

/** A contact photo: small enough that a card stays far below the server's 1 MiB. */
export const CONTACT_PHOTO = { size: 256, type: "image/jpeg", quality: 0.85 } as const;
/** The own profile picture; the server scales it to at most 512 × 512 anyway. */
export const PROFILE_PICTURE = { size: 512, type: "image/jpeg", quality: 0.9 } as const;

export type PictureProblem = "notImage" | "tooLarge" | "unreadable";

export class PictureError extends Error {
  readonly problem: PictureProblem;

  constructor(problem: PictureProblem) {
    super(problem);
    this.name = "PictureError";
    this.problem = problem;
  }
}

/** A decoded picture, turned the way its camera meant it. */
export interface Picture {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** Frees the decoded pixels. */
  close: () => void;
}

/** What a file must look like before it is decoded at all. */
export function pictureFileProblem(file: Pick<Blob, "type" | "size">): PictureProblem | null {
  if (!/^image\//i.test(file.type)) return "notImage";
  if (file.size > PICTURE_MAX_BYTES) return "tooLarge";
  if (file.size === 0) return "unreadable";
  return null;
}

/** Decodes through an `<img>`, for what createImageBitmap can't read (SVG in most browsers). */
function decodeWithImage(file: Blob): Promise<Picture> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  return new Promise<Picture>((resolve, reject) => {
    image.onload = () => {
      // An SVG without a size of its own has no pixels to count; it is drawn at a sensible one.
      const width = image.naturalWidth || 512;
      const height = image.naturalHeight || 512;
      resolve({ source: image, width, height, close: () => URL.revokeObjectURL(url) });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new PictureError("unreadable"));
    };
    image.src = url;
  });
}

// ------------------------------------------------------------------------------------------------
// The size a picture file claims, read before anything is decoded

export interface PictureSize {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const i32le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24);
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const ascii = (b: Uint8Array, i: number, text: string) =>
  b.length >= i + text.length && [...text].every((char, k) => b[i + k] === char.charCodeAt(0));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(b: Uint8Array): PictureSize | null {
  if (b.length < 24 || !PNG_SIGNATURE.every((byte, i) => b[i] === byte) || !ascii(b, 12, "IHDR")) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

/** The logical screen, grown by every frame that reaches past it (browsers make room for those). */
function gifSize(b: Uint8Array): PictureSize | null {
  if (b.length < 13 || !ascii(b, 0, "GIF8")) return null;
  let width = u16le(b, 6);
  let height = u16le(b, 8);
  const table = (flags: number) => (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  const skipBlocks = (at: number) => {
    while (at < b.length && b[at] !== 0) at += b[at]! + 1;
    return at + 1;
  };
  let i = 13 + table(b[10]!);
  while (i < b.length) {
    const kind = b[i];
    if (kind === 0x21) i = skipBlocks(i + 2);
    else if (kind === 0x2c && i + 10 <= b.length) {
      width = Math.max(width, u16le(b, i + 1) + u16le(b, i + 5));
      height = Math.max(height, u16le(b, i + 3) + u16le(b, i + 7));
      i = skipBlocks(i + 10 + table(b[i + 9]!) + 1);
    } else break;
  }
  return { width, height };
}

function jpegSize(b: Uint8Array): PictureSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    // Every start of frame but DHT, JPG and DAC, which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) return null;
      const size = { width: u16be(b, i + 7), height: u16be(b, i + 5) };
      // A height of 0 comes later in the file (DNL); the check after decoding covers that.
      return size.height > 0 ? size : null;
    }
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

function webpSize(b: Uint8Array): PictureSize | null {
  if (!ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8 ") && b.length >= 30) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (ascii(b, 12, "VP8L") && b.length >= 25) {
    return {
      width: 1 + (((b[22]! & 0x3f) << 8) | b[21]!),
      height: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)),
    };
  }
  if (ascii(b, 12, "VP8X") && b.length >= 30) return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  return null;
}

/** A BMP's DIB header, as in a .bmp after its 14-byte file header or inside an icon. */
function dibSize(b: Uint8Array, at: number, icon: boolean): PictureSize | null {
  if (b.length < at + 12) return null;
  const header = u32le(b, at);
  if (header === 12) return { width: u16le(b, at + 4), height: u16le(b, at + 6) / (icon ? 2 : 1) };
  if (header < 40) return null;
  // Negative heights are top-down pictures; an icon's counts its mask as well.
  return { width: Math.abs(i32le(b, at + 4)), height: Math.abs(i32le(b, at + 8)) / (icon ? 2 : 1) };
}

/** An icon holds several pictures; the browser may pick any, so the largest counts. */
function icoSize(b: Uint8Array): PictureSize | null {
  if (b.length < 6 || b[0] !== 0 || b[1] !== 0 || (b[2] !== 1 && b[2] !== 2) || b[3] !== 0) return null;
  const count = u16le(b, 4);
  let largest: PictureSize | null = null;
  for (let n = 0; n < count && 6 + 16 * (n + 1) <= b.length; n++) {
    const entry = 6 + 16 * n;
    const offset = u32le(b, entry + 12);
    const inner = b.subarray(offset, offset + u32le(b, entry + 8));
    const size = pngSize(inner) ?? dibSize(inner, 0, true);
    if (size && (!largest || size.width * size.height > largest.width * largest.height)) largest = size;
  }
  return largest;
}

/**
 * The width and height a picture file says it has, read from its header without decoding a
 * pixel: PNG, GIF, JPEG, WebP, BMP and icons. A small file can claim a huge picture (a
 * decompression bomb, say a website icon taken as a company logo), and decoding it would take
 * gigabytes before its size could be checked (security-audit W-32). Null for anything else; the
 * check after decoding still holds for those.
 */
export function pictureDimensions(bytes: Uint8Array): PictureSize | null {
  if (ascii(bytes, 0, "BM")) return dibSize(bytes, 14, false);
  return pngSize(bytes) ?? gifSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes) ?? icoSize(bytes);
}

/**
 * Reads a picture file. The EXIF orientation of photos is applied, so a portrait taken on a
 * phone stays upright. Throws a PictureError for anything that isn't a picture or is too big —
 * by its header before it is decoded, and by what came out after.
 */
export async function readPicture(file: Blob): Promise<Picture> {
  const problem = pictureFileProblem(file);
  if (problem) throw new PictureError(problem);
  const claimed = pictureDimensions(new Uint8Array(await file.arrayBuffer()));
  if (claimed && claimed.width * claimed.height > PICTURE_MAX_PIXELS) throw new PictureError("tooLarge");
  let picture: Picture;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    picture = { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  } catch {
    picture = await decodeWithImage(file);
  }
  if (picture.width < 1 || picture.height < 1) {
    picture.close();
    throw new PictureError("unreadable");
  }
  if (picture.width * picture.height > PICTURE_MAX_PIXELS) {
    picture.close();
    throw new PictureError("tooLarge");
  }
  return picture;
}

// ------------------------------------------------------------------------------------------------
// Placing the picture under the circle

/**
 * Where the picture lies under the square crop area of `view` × `view` pixels: its top left
 * corner at (x, y), drawn `scale` pixels per picture pixel. The circle is the square's inscribed one.
 */
export interface Crop {
  x: number;
  y: number;
  scale: number;
}

/** The smallest scale at which the picture still covers the whole square. */
export function coverScale(width: number, height: number, view: number): number {
  return Math.max(view / width, view / height);
}

/** Keeps the scale within cover × [1, MAX_ZOOM] and the square covered, nothing empty showing. */
export function clampCrop(crop: Crop, width: number, height: number, view: number): Crop {
  const min = coverScale(width, height, view);
  const scale = Math.min(Math.max(crop.scale, min), min * MAX_ZOOM);
  const clamp = (value: number, size: number) => Math.min(0, Math.max(view - size * scale, value));
  return { scale, x: clamp(crop.x, width), y: clamp(crop.y, height) };
}

/** The whole picture's short side under the circle, centred. */
export function initialCrop(width: number, height: number, view: number): Crop {
  const scale = coverScale(width, height, view);
  return { scale, x: (view - width * scale) / 2, y: (view - height * scale) / 2 };
}

/** Moves the picture by (dx, dy) screen pixels. */
export function moveCrop(crop: Crop, dx: number, dy: number, width: number, height: number, view: number): Crop {
  return clampCrop({ ...crop, x: crop.x + dx, y: crop.y + dy }, width, height, view);
}

/** Zooms by `factor` around the point (cx, cy) of the square, which stays where it is. */
export function zoomCrop(
  crop: Crop,
  factor: number,
  cx: number,
  cy: number,
  width: number,
  height: number,
  view: number,
): Crop {
  const wanted = clampCrop({ ...crop, scale: crop.scale * factor }, width, height, view).scale;
  const ratio = wanted / crop.scale;
  return clampCrop(
    { scale: wanted, x: cx - (cx - crop.x) * ratio, y: cy - (cy - crop.y) * ratio },
    width,
    height,
    view,
  );
}

/** How far in the crop is zoomed: 1 where the picture just covers the square. */
export function zoomOf(crop: Crop, width: number, height: number, view: number): number {
  return crop.scale / coverScale(width, height, view);
}

/** The square of the picture, in picture pixels, that ends up in the output. */
export function sourceSquare(crop: Crop, view: number): { x: number; y: number; size: number } {
  return { x: -crop.x / crop.scale, y: -crop.y / crop.scale, size: view / crop.scale };
}

// ------------------------------------------------------------------------------------------------
// Drawing the result

export interface PictureOutput {
  size: number;
  type: string;
  quality: number;
}

/** The parts of a canvas the output needs, so tests can hand in their own. */
export interface OutputCanvas {
  width: number;
  height: number;
  getContext(
    kind: "2d",
  ): Pick<
    CanvasRenderingContext2D,
    "drawImage" | "fillRect" | "fillStyle" | "imageSmoothingEnabled" | "imageSmoothingQuality"
  > | null;
  toDataURL(type: string, quality: number): string;
  toBlob(callback: (blob: Blob | null) => void, type: string, quality: number): void;
}

const newCanvas = (): OutputCanvas => document.createElement("canvas") as unknown as OutputCanvas;

/** Draws the cropped square at the output size, on white: JPEG has no transparency. */
function drawOutput(
  picture: Pick<Picture, "source">,
  crop: Crop,
  view: number,
  output: PictureOutput,
  createCanvas: () => OutputCanvas,
): OutputCanvas {
  const canvas = createCanvas();
  canvas.width = output.size;
  canvas.height = output.size;
  const context = canvas.getContext("2d");
  if (!context) throw new PictureError("unreadable");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, output.size, output.size);
  const square = sourceSquare(crop, view);
  context.drawImage(picture.source, square.x, square.y, square.size, square.size, 0, 0, output.size, output.size);
  return canvas;
}

/** The cropped picture as a `data:` URI, e.g. for a contact card. */
export function renderPicture(
  picture: Pick<Picture, "source">,
  crop: Crop,
  view: number,
  output: PictureOutput = CONTACT_PHOTO,
  createCanvas: () => OutputCanvas = newCanvas,
): string {
  const uri = drawOutput(picture, crop, view, output, createCanvas).toDataURL(output.type, output.quality);
  // A browser that can't write the type falls back to PNG; better to say so than to store that.
  if (!uri.startsWith(`data:${output.type}`)) throw new PictureError("unreadable");
  return uri;
}

/** The cropped picture as a file, e.g. for an upload. */
export function renderPictureBlob(
  picture: Pick<Picture, "source">,
  crop: Crop,
  view: number,
  output: PictureOutput = PROFILE_PICTURE,
  createCanvas: () => OutputCanvas = newCanvas,
): Promise<Blob> {
  const canvas = drawOutput(picture, crop, view, output, createCanvas);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob && blob.type === output.type ? resolve(blob) : reject(new PictureError("unreadable"))),
      output.type,
      output.quality,
    ),
  );
}

/** The first picture file among dropped or pasted ones. */
export function firstPictureFile(files: FileList | readonly File[] | null | undefined): File | null {
  for (const file of Array.from(files ?? [])) if (/^image\//i.test(file.type)) return file;
  return null;
}
