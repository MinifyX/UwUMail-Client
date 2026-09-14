/**
 * How a sender picture should sit in its round avatar: logos that fill the
 * circle stay edge to edge, see-through ones get a plain backdrop, and that
 * backdrop turns dark when the logo itself is white or very light.
 */
export interface PictureLook {
  /** Some of the circle would show through the picture. */
  seeThrough: boolean;
  /** Most of the visible logo is close to white, so it needs a dark backdrop. */
  light: boolean;
}

/** Side length of the square the picture is scaled into before looking at it. */
export const SAMPLE_SIZE = 32;

/** Pixels see-through enough that the backdrop would be noticeable. */
const SEE_THROUGH_ALPHA = 200;
/** Share of see-through pixels inside the circle that counts, ignoring anti-aliased edges. */
const SEE_THROUGH_SHARE = 0.02;
/** Luminance (0–255) from which a pixel reads as white on a white backdrop. */
const LIGHT_LUMINANCE = 225;
const LIGHT_SHARE = 0.5;

/** Looks at RGBA pixels of a SAMPLE_SIZE × SAMPLE_SIZE square. */
export function lookOfPixels(data: Uint8ClampedArray, size = SAMPLE_SIZE): PictureLook {
  const center = (size - 1) / 2;
  // Only the round part is ever visible, so transparent corners don't matter.
  const radius = size / 2 - 1;
  let inside = 0;
  let seeThrough = 0;
  let visible = 0;
  let light = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const alpha = data[i + 3]!;
      if (Math.hypot(x - center, y - center) <= radius) {
        inside++;
        if (alpha < SEE_THROUGH_ALPHA) seeThrough++;
      }
      if (alpha >= 128) {
        visible++;
        const luminance = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
        if (luminance >= LIGHT_LUMINANCE) light++;
      }
    }
  }

  const isSeeThrough = inside > 0 && seeThrough / inside > SEE_THROUGH_SHARE;
  return {
    seeThrough: isSeeThrough,
    // An opaque picture brings its own background, whatever its colors.
    light: isSeeThrough && visible > 0 && light / visible >= LIGHT_SHARE,
  };
}

const looks = new Map<string, PictureLook | null>();

export function cachedLook(url: string): PictureLook | null | undefined {
  return looks.get(url);
}

/**
 * Reads a loaded image once per URL. Null when the pixels can't be read, for
 * example when the image came from another origin without CORS.
 */
export function lookOfImage(url: string, image: HTMLImageElement): PictureLook | null {
  const known = looks.get(url);
  if (known !== undefined) return known;
  let look: PictureLook | null = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context) {
      // Fit without stretching, so a wide logo leaves see-through bands instead of getting cropped.
      const width = image.naturalWidth || SAMPLE_SIZE;
      const height = image.naturalHeight || SAMPLE_SIZE;
      const scale = SAMPLE_SIZE / Math.max(width, height);
      const w = width * scale;
      const h = height * scale;
      context.drawImage(image, (SAMPLE_SIZE - w) / 2, (SAMPLE_SIZE - h) / 2, w, h);
      look = lookOfPixels(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
    }
  } catch {
    look = null;
  }
  looks.set(url, look);
  return look;
}
