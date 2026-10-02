/**
 * The font the app and the mails use (Settings → Appearance → Font). Kept on this device only.
 *
 * The interface gets the font through `--font-ui` on <html>; the web fonts are declared in
 * styles/fonts.css. Mails are shown in a sandboxed frame that can't see the app's fonts and only
 * loads fonts from `data:` URLs, so the chosen one is handed in as a `data:` @font-face (loaded on
 * demand, once; see `mailFontFaces`).
 */

export const FONT_CHOICES = ["uwu", "rubik", "dmsans", "system"] as const;
export type FontChoice = (typeof FONT_CHOICES)[number];

/** What happens to the fonts a sender wrote into an HTML mail. */
export const SENDER_FONT_CHOICES = ["replace", "keep"] as const;
export type SenderFonts = (typeof SENDER_FONT_CHOICES)[number];

const SYSTEM_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif';

/** The family list for each choice; web fonts fall back to the system's. */
export const FONT_STACKS: Record<FontChoice, string> = {
  uwu: `"UwU Sans", ${SYSTEM_STACK}`,
  rubik: `"Rubik Variable", ${SYSTEM_STACK}`,
  dmsans: `"DM Sans Variable", ${SYSTEM_STACK}`,
  system: SYSTEM_STACK,
};

/** The names the picker shows (font names stay untranslated). */
export const FONT_NAMES: Record<Exclude<FontChoice, "system">, string> = {
  uwu: "UwU Sans",
  rubik: "Rubik",
  dmsans: "DM Sans",
};

/**
 * A little tighter than the fonts are set, for interface text. UwU Sans (Atkinson Hyperlegible) is
 * spaced generously for reading; the others are fine as they come.
 */
export const FONT_TRACKING: Record<FontChoice, string> = {
  uwu: "-0.008em",
  rubik: "0em",
  dmsans: "-0.004em",
  system: "0em",
};

export function isFontChoice(value: unknown): value is FontChoice {
  return (FONT_CHOICES as readonly unknown[]).includes(value);
}

export function isSenderFonts(value: unknown): value is SenderFonts {
  return (SENDER_FONT_CHOICES as readonly unknown[]).includes(value);
}

/** Puts the chosen font on the whole interface at once. */
export function applyUiFont(choice: FontChoice, root: HTMLElement = document.documentElement) {
  root.style.setProperty("--font-ui", FONT_STACKS[choice]);
  root.style.setProperty("--tracking-ui", FONT_TRACKING[choice]);
  root.dataset.font = choice;
}

// --- mail frames ---------------------------------------------------------------------------------

/** The family name the mail frame knows the chosen font by (see lib/mailFonts). */
export const MAIL_FAMILY = "uwu-mail-font";

interface Face {
  src: string;
  unicodeRange?: string;
}

// Unicode ranges as @fontsource declares them for its two Latin files.
const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

const inline = (module: { default: string }) => module.default;

/** `?inline` turns each file into its own lazily loaded `data:` URL module. */
const LOADERS: Record<Exclude<FontChoice, "system">, () => Promise<Face[]>> = {
  uwu: async () => [{ src: inline(await import("@/assets/fonts/UwUSans[wght].woff2?inline")) }],
  rubik: async () => {
    const [latin, ext] = await Promise.all([
      import("@fontsource-variable/rubik/files/rubik-latin-wght-normal.woff2?inline"),
      import("@fontsource-variable/rubik/files/rubik-latin-ext-wght-normal.woff2?inline"),
    ]);
    return [
      { src: inline(latin), unicodeRange: LATIN },
      { src: inline(ext), unicodeRange: LATIN_EXT },
    ];
  },
  dmsans: async () => {
    const [latin, ext] = await Promise.all([
      import("@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2?inline"),
      import("@fontsource-variable/dm-sans/files/dm-sans-latin-ext-wght-normal.woff2?inline"),
    ]);
    return [
      { src: inline(latin), unicodeRange: LATIN },
      { src: inline(ext), unicodeRange: LATIN_EXT },
    ];
  },
};

const faces = new Map<FontChoice, string>();
const loading = new Map<FontChoice, Promise<string>>();

function faceRules(list: Face[]) {
  return list
    .map(
      (face) =>
        `@font-face{font-family:"${MAIL_FAMILY}";src:url(${face.src}) format("woff2");font-weight:100 900;font-style:normal;font-display:block${face.unicodeRange ? `;unicode-range:${face.unicodeRange}` : ""}}`,
    )
    .join("\n");
}

/**
 * The @font-face rules for the frame, if they're loaded already ("" for the system font, which
 * needs none). `null` while the font still loads; `loadMailFont` brings it.
 */
export function mailFontFaces(choice: FontChoice): string | null {
  if (choice === "system") return "";
  return faces.get(choice) ?? null;
}

export function loadMailFont(choice: FontChoice): Promise<string> {
  if (choice === "system") return Promise.resolve("");
  const done = faces.get(choice);
  if (done !== undefined) return Promise.resolve(done);
  let pending = loading.get(choice);
  if (!pending) {
    pending = LOADERS[choice]().then(
      (list) => {
        const rules = faceRules(list);
        faces.set(choice, rules);
        loading.delete(choice);
        return rules;
      },
      (error: unknown) => {
        loading.delete(choice);
        throw error;
      },
    );
    loading.set(choice, pending);
  }
  return pending;
}

/** For tests: pretend a font's rules are loaded. */
export function primeMailFont(choice: FontChoice, rules: string) {
  faces.set(choice, rules);
}

/** The family list the frame uses for the chosen font. */
export function mailStack(choice: FontChoice) {
  return choice === "system" ? SYSTEM_STACK : `"${MAIL_FAMILY}", ${SYSTEM_STACK}`;
}
