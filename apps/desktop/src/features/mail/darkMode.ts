// Dark mode for mail content.
//
// HTML mail is designed for white paper. In the dark app theme UwUMail either
// uses the mail's own dark styles, recolors simple mails, or leaves heavily
// designed mails light. Colors are recomputed in OKLCH so hues survive: a pink
// button stays pink, only darker.

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0 to 1 */
  a: number;
}

interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** The app's dark surface, `--uwu-surface` in dark mode. */
export const DARK_SURFACE: Rgba = { r: 0x1c, g: 0x17, b: 0x1f, a: 1 };
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

// ---------------------------------------------------------------- colors

export function parseColor(value: string): Rgba | null {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(value.trim());
  if (!match) return null;
  const alphaText = match[4];
  const alpha =
    alphaText === undefined ? 1 : alphaText.endsWith("%") ? parseFloat(alphaText) / 100 : parseFloat(alphaText);
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha };
}

export function toCss({ r, g, b, a }: Rgba): string {
  const channel = (value: number) => Math.round(Math.min(255, Math.max(0, value)));
  return a >= 1
    ? `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`
    : `rgba(${channel(r)}, ${channel(g)}, ${channel(b)}, ${Math.round(a * 1000) / 1000})`;
}

const toLinear = (value: number) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const fromLinear = (value: number) => {
  const c = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return c * 255;
};

export function toOklch({ r, g, b }: Rgba): Oklch {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const A = c * Math.cos((h * Math.PI) / 180);
  const B = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

/** Converts back to sRGB, lowering chroma until the color fits the gamut. */
export function fromOklch(color: Oklch, alpha = 1): Rgba {
  const inGamut = (channels: number[]) => channels.every((v) => v >= -0.0001 && v <= 1.0001);
  let channels = oklchToLinear(color);
  if (!inGamut(channels)) {
    let low = 0;
    let high = color.c;
    for (let i = 0; i < 16; i += 1) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToLinear({ ...color, c: mid }))) low = mid;
      else high = mid;
    }
    channels = oklchToLinear({ ...color, c: low });
  }
  const [r, g, b] = channels.map((v) => fromLinear(Math.min(1, Math.max(0, v)))) as [number, number, number];
  return { r, g, b, a: alpha };
}

export function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrast(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Light backgrounds become dark; already dark ones stay. Saturated colors keep more of their brightness. */
export function darkenBackground(color: Rgba): Rgba {
  const o = toOklch(color);
  if (o.l <= 0.42) return color;
  const saturated = o.c > 0.08;
  const l = saturated ? clamp(o.l * 0.72, 0.3, 0.55) : 0.2 + (1 - o.l) * 0.45;
  return fromOklch({ l, c: saturated ? o.c * 0.9 : o.c * 0.75, h: o.h }, color.a);
}

/** Dark text becomes light; light text stays. Either way it ends up readable on `background`. */
export function lightenText(color: Rgba, background: Rgba): Rgba {
  const o = toOklch(color);
  let candidate: Oklch = o.l >= 0.62 ? o : { l: 0.94 - o.l * 0.32, c: Math.min(o.c, 0.13), h: o.h };
  const backgroundIsDark = luminance(background) < 0.18;
  for (let i = 0; i < 12 && contrast(fromOklch(candidate), background) < 4.5; i += 1) {
    candidate = { ...candidate, l: clamp(candidate.l + (backgroundIsDark ? 0.04 : -0.06), 0, 1) };
  }
  return fromOklch(candidate, color.a);
}

export function darkenBorder(color: Rgba): Rgba {
  const o = toOklch(color);
  const l = o.l > 0.6 ? 0.34 : 0.78 - o.l * 0.3;
  return fromOklch({ l, c: o.c * 0.8, h: o.h }, color.a);
}

// ------------------------------------------------------------- detection

/** Whether the mail's own CSS brings dark mode styles. */
export function declaresDarkMode(html: string): boolean {
  return /prefers-color-scheme\s*:\s*dark/i.test(html) || /color-scheme\s*:[^;}"]*\bdark\b/i.test(html);
}

/**
 * Makes the mail's color scheme media queries match what we render,
 * independent of how the web engine resolves them inside a frame.
 */
export function forceColorSchemeQueries(html: string, dark: boolean): string {
  const always = "(min-width: 0px)";
  const never = "(max-width: -1px)";
  return html
    .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, dark ? always : never)
    .replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi, dark ? never : always);
}

export interface Measurements {
  area: number;
  imageArea: number;
  backgroundImageArea: number;
  /** Colored or dark background blocks larger than a small share of the mail. */
  blocks: { area: number; hue: number; chroma: number; lightness: number }[];
}

export type AutoDecision = "darken" | "original";

/** Plain mails get recolored; mails that are mostly design stay as the sender made them. */
export function decide({ area, imageArea, backgroundImageArea, blocks }: Measurements): AutoDecision {
  if (area <= 0) return "darken";
  if (backgroundImageArea / area > 0.15) return "original";
  if (imageArea / area > 0.45) return "original";
  const designed = blocks.filter((block) => block.chroma > 0.05 || block.lightness < 0.42);
  const designedShare = designed.reduce((sum, block) => sum + block.area, 0) / area;
  const hues = new Set(designed.filter((block) => block.chroma > 0.05).map((block) => Math.round(block.hue / 60) % 6));
  if (designedShare > 0.3 || hues.size >= 3) return "original";
  return "darken";
}

// ------------------------------------------------------------------ DOM

const SKIP_TAGS = new Set(["STYLE", "SCRIPT", "BR", "WBR", "META", "LINK", "TITLE", "HEAD"]);
const TRANSPARENT_IMAGE = /(\.(png|gif|svg|webp)(\?|#|$))|^data:image\/(png|gif|svg\+xml|webp)/i;

function htmlElements(root: HTMLElement): HTMLElement[] {
  return [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))].filter(
    (element) => element.namespaceURI === "http://www.w3.org/1999/xhtml" && !SKIP_TAGS.has(element.tagName),
  );
}

function rectArea(element: Element): number {
  const rect = element.getBoundingClientRect();
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function hasBackgroundImage(style: CSSStyleDeclaration) {
  return style.backgroundImage !== "" && style.backgroundImage !== "none";
}

export function measure(root: HTMLElement): Measurements {
  const view = root.ownerDocument.defaultView!;
  const area = rectArea(root);
  let imageArea = 0;
  let backgroundImageArea = 0;
  const blocks: Measurements["blocks"] = [];
  const counted = new Set<Element>();

  for (const element of htmlElements(root)) {
    if (element === root) continue;
    if (element.tagName === "IMG") {
      imageArea += rectArea(element);
      continue;
    }
    const style = view.getComputedStyle(element);
    const parentCounted = element.parentElement !== null && counted.has(element.parentElement);
    if (hasBackgroundImage(style)) {
      if (!parentCounted) backgroundImageArea += rectArea(element);
      counted.add(element);
      continue;
    }
    if (parentCounted) counted.add(element);
    const background = parseColor(style.backgroundColor);
    if (!background || background.a < 0.5) continue;
    const elementArea = rectArea(element);
    if (elementArea < area * 0.015) continue;
    const o = toOklch(background);
    if (o.c > 0.05 || o.l < 0.42) blocks.push({ area: elementArea, hue: o.h, chroma: o.c, lightness: o.l });
  }
  return {
    area,
    imageArea: Math.min(imageArea, area),
    backgroundImageArea: Math.min(backgroundImageArea, area),
    blocks,
  };
}

/** Recolors a rendered mail for the dark theme. Reads everything first, then writes, to avoid layout thrashing. */
export function darkenDocument(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const view = doc.defaultView!;
  const elements = htmlElements(root);
  const styles = new Map(elements.map((element) => [element, view.getComputedStyle(element)] as const));

  const protectedElements = new Set<Element>();
  const originalBackground = new Map<Element, Rgba>();
  for (const element of elements) {
    const style = styles.get(element)!;
    if ((element.parentElement && protectedElements.has(element.parentElement)) || hasBackgroundImage(style)) {
      // Text on a background image or gradient was designed for it.
      protectedElements.add(element);
      continue;
    }
    const background = parseColor(style.backgroundColor);
    if (background && background.a > 0) originalBackground.set(element, background);
  }

  const nearest = (element: Element, map: Map<Element, Rgba>, fallback: Rgba): Rgba => {
    for (let current = element.parentElement; current; current = current.parentElement) {
      const found = map.get(current);
      if (found) return found;
      if (current === root) break;
    }
    return fallback;
  };

  const newBackground = new Map<Element, Rgba>();
  for (const element of elements) {
    const original = originalBackground.get(element);
    if (!original) continue;
    let darkened = darkenBackground(original);
    // Keep blocks (cards, buttons) distinguishable from what's behind them.
    const parentOriginal = nearest(element, originalBackground, WHITE);
    const parentNew = nearest(element, newBackground, DARK_SURFACE);
    if (contrast(original, parentOriginal) >= 1.25 && contrast(darkened, parentNew) < 1.25) {
      const o = toOklch(darkened);
      darkened = fromOklch({ ...o, l: clamp(o.l + 0.12, 0, 1) }, darkened.a);
    }
    newBackground.set(element, darkened);
  }

  const writes: (() => void)[] = [];
  for (const element of elements) {
    if (protectedElements.has(element)) continue;
    const style = styles.get(element)!;
    const background = newBackground.get(element);
    if (background) writes.push(() => element.style.setProperty("background-color", toCss(background), "important"));

    const text = parseColor(style.color);
    if (text) {
      const behind = background ?? nearest(element, newBackground, DARK_SURFACE);
      const color = lightenText(text, background && background.a >= 1 ? background : behind);
      writes.push(() => element.style.setProperty("color", toCss(color), "important"));
    }

    for (const side of ["top", "right", "bottom", "left"] as const) {
      if (style.getPropertyValue(`border-${side}-style`) === "none") continue;
      const border = parseColor(style.getPropertyValue(`border-${side}-color`));
      if (border && border.a > 0) {
        const color = toCss(darkenBorder(border));
        writes.push(() => element.style.setProperty(`border-${side}-color`, color, "important"));
      }
    }

    // Transparent logos with dark ink would vanish on a dark background.
    if (element.tagName === "IMG" && TRANSPARENT_IMAGE.test(element.getAttribute("src") ?? "")) {
      writes.push(() => {
        element.style.setProperty("background-color", "rgba(255, 255, 255, 0.92)", "important");
        element.style.setProperty("border-radius", "3px");
      });
    }
  }

  for (const write of writes) write();
  doc.documentElement.style.setProperty("color-scheme", "dark");
  doc.body.style.setProperty("background", toCss(DARK_SURFACE), "important");
  doc.body.style.setProperty("color", "#f8f2f6", "important");
}
