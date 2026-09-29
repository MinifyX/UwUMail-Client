// Sizes of a mail's remote pictures before they load.
//
// A picture waits for its place in the mail as a transparent SVG of its own size: laid out by the
// mail's CSS exactly like the real one (max-width, height:auto, width/height attributes), so
// nothing moves when the real one arrives. Until the size is known, whatever the mail says
// about it stands in.

export interface Size {
  width: number;
  height: number;
}

/** Either side may be unknown. */
export interface PartialSize {
  width: number | null;
  height: number | null;
}

/** Bigger than any real picture: a size beyond it is taken as unknown. */
const MAX_SIDE = 20_000;
/** The shape guessed while only one side is known. */
const GUESSED_RATIO = 9 / 16;

const REMOTE = /^\s*https?:\/\//i;

export function isRemote(url: string | null | undefined): boolean {
  return !!url && REMOTE.test(url);
}

const usable = (value: number) => (Number.isFinite(value) && value >= 0 && value <= MAX_SIDE ? value : null);

/**
 * A `width`/`height` attribute in pixels, read like browsers do: leading digits, an optional
 * fraction, and anything after it ignored, except that a percentage is no pixel size.
 */
export function attributePixels(value: string | null | undefined): number | null {
  if (value == null) return null;
  const match = /^\s*(\d+(?:\.\d+)?)(\s*%)?/.exec(value);
  if (!match || match[2]) return null;
  return usable(parseFloat(match[1]!));
}

/**
 * `width` and `height` from an inline style. A side the style names at all is the style's, even
 * when it's no pixel size (`auto`, `50%`): CSS wins over the attributes then.
 */
export function stylePixels(style: string | null | undefined): { width?: number | null; height?: number | null } {
  const found: { width?: number | null; height?: number | null } = {};
  if (!style) return found;
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    if (property !== "width" && property !== "height") continue;
    const value = declaration
      .slice(colon + 1)
      .replace(/!\s*important\s*$/i, "")
      .trim();
    const match = /^(\d+(?:\.\d+)?|\.\d+)(px)?$/i.exec(value);
    // `0` needs no unit; any other number without one is invalid CSS and ignored.
    found[property] = match && (match[2] || parseFloat(match[1]!) === 0) ? usable(parseFloat(match[1]!)) : null;
  }
  return found;
}

/** What the mail itself says about a picture's size. */
export function sizeFromMail(attributes: {
  width?: string | null;
  height?: string | null;
  style?: string | null;
}): PartialSize {
  const style = stylePixels(attributes.style);
  return {
    width: "width" in style ? style.width! : attributePixels(attributes.width),
    height: "height" in style ? style.height! : attributePixels(attributes.height),
  };
}

/** The placeholder's size while only the mail says anything; null when it says nothing. */
export function placeholderFromMail(mail: PartialSize): Size | null {
  if (mail.width !== null && mail.height !== null) return { width: mail.width, height: mail.height };
  if (mail.width !== null) return { width: mail.width, height: round(mail.width * GUESSED_RATIO) };
  if (mail.height !== null) return { width: round(mail.height / GUESSED_RATIO), height: mail.height };
  return null;
}

/** The size a picture takes on the page: the picture's pixels at the candidate's density. */
export function displaySize(pixels: Size, density = 1): Size | null {
  const width = usable(pixels.width);
  const height = usable(pixels.height);
  if (width === null || height === null || !(density > 0)) return null;
  return { width: round(width / density), height: round(height / density) };
}

const round = (value: number) => Math.round(value * 100) / 100;

const PLACEHOLDER = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20class='uwu-placeholder'%20";

/**
 * A transparent SVG of that size; a tiny one where the size is unknown. The frame's CSP allows
 * `data:` pictures.
 */
export function placeholderSource(size: Size | null): string {
  const { width, height } = size ?? { width: 1, height: 1 };
  return `${PLACEHOLDER}width='${width}'%20height='${height}'%3E%3C/svg%3E`;
}

export function isPlaceholder(url: string | null | undefined): boolean {
  return !!url && url.startsWith(PLACEHOLDER);
}

/**
 * Whether a picture that can't be had is a tracking pixel, to keep invisible rather than show as
 * broken: tiny (at most 2×2), or of unknown size in a mail that says nothing about its size either.
 */
export function isTrackingPixel(known: Size | null, mail: PartialSize): boolean {
  if (known) return known.width <= 2 && known.height <= 2;
  if (mail.width === null && mail.height === null) return true;
  return (mail.width ?? 0) <= 2 && (mail.height ?? 0) <= 2;
}

export interface SrcsetCandidate {
  url: string;
  /** `2x` → { density: 2 }, `600w` → { width: 600 }, nothing → 1x. */
  density: number | null;
  width: number | null;
}

/**
 * `srcset` candidates, split at a comma followed by a space like the proxy does: addresses may
 * hold commas themselves (`w_100,h_100`).
 */
export function parseSrcset(srcset: string): SrcsetCandidate[] {
  return srcset
    .split(/,\s+/)
    .map((candidate) => {
      const [url = "", descriptor = ""] = candidate.trim().split(/\s+/);
      const density = /^(\d+(?:\.\d+)?|\.\d+)x$/i.exec(descriptor);
      const width = /^(\d+)w$/i.exec(descriptor);
      return {
        url: url.replace(/,$/, ""),
        density: density ? parseFloat(density[1]!) : width ? null : 1,
        width: width ? parseInt(width[1]!, 10) : null,
      };
    })
    .filter((candidate) => candidate.url !== "");
}

/**
 * Which address to ask about for a picture's size, and at what density it shows: the
 * `src` where it is remote (also next to width descriptors, which say nothing about the height);
 * otherwise the remote density candidate closest to 1x. Null when there is none.
 */
export function sizeTarget(src: string | null, srcset: string | null): { url: string; density: number } | null {
  if (isRemote(src)) return { url: src!.trim(), density: 1 };
  if (!srcset) return null;
  const candidates = parseSrcset(srcset).filter(
    (candidate) => isRemote(candidate.url) && candidate.density !== null && candidate.density > 0,
  );
  candidates.sort((a, b) => Math.abs(Math.log(a.density!)) - Math.abs(Math.log(b.density!)));
  const best = candidates[0];
  return best ? { url: best.url.trim(), density: best.density! } : null;
}
