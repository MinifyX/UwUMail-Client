# Design

Clean, bright, soft — with a wink. Big rounded cards, hairline borders, pill
filters, generous whitespace, and one confident bubblegum pink.

## Color

All colors are CSS custom properties in
`apps/desktop/src/styles/tokens.css`. Components never use raw hex values.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--uwu-canvas` | `#f8f4f6` | `#141016` | App background |
| `--uwu-surface` | `#ffffff` | `#1c171f` | Lists, reader, cards |
| `--uwu-elevated` | `#fcf8fa` | `#241e28` | Hover rows, popovers |
| `--uwu-ink` | `#1c1420` | `#f8f2f6` | Primary text |
| `--uwu-muted` | `#716672` | `#b3a8b3` | Secondary text |
| `--uwu-hairline` | `#f2e8ee` | `#2c2430` | Dividers |
| `--uwu-border` | `#e9dde4` | `#3a3040` | Control borders |
| `--uwu-pink` | `#ff4d8d` | `#ff7fac` | **Brand.** Unread dots, badges, selection, focus, logo |
| `--uwu-pink-solid` | `#e11d74` | `#ff7fac` | Filled buttons with text |
| `--uwu-on-pink` | `#ffffff` | `#1c1420` | Text on `--uwu-pink-solid` |
| `--uwu-pink-ink` | `#a3154f` | `#ffa3c4` | Pink text on tinted backgrounds |
| `--uwu-pink-tint` | `#ffe4ef` | `#3a1a2a` | Selected pill, active row |
| `--uwu-pink-tint-strong` | `#ffd0e2` | `#4d2338` | Pressed / hovered tint |

**Why two pinks?** White text on `#ff4d8d` reaches only 3.1:1 contrast. Filled
buttons therefore use `#e11d74` (4.5:1, WCAG AA). The brighter brand pink
stays for everything that is not small text on a pink fill.

Account colors (for the unified inbox) come from a fixed, contrast-checked set:
pink, violet, sky, mint, amber, coral.

## Type

- **Manrope** (variable, bundled, no network) for everything.
- Sizes: 12 caption · 13 meta · 14 body/list · 16 reader body · 18 section ·
  22 title. Weights 400, 500, 600 (titles and sender names), 700 only for the
  wordmark.

## Shape and space

- Radius: 10px controls, 16px cards and panes, 999px pills and badges.
- Spacing on a 4px grid. Mail list rows are rounded cards with a little gap
  and no dividers; hover and selection tint the whole card pink.
- Shadows only for floating layers (menus, composer window, toasts).

## Layouts

| | Simple | Pro |
| --- | --- | --- |
| Columns | List · Reader | Folders · List · Reader |
| Folders | Behind the menu button, pill filters on top | Always visible tree with accounts |
| Rows | Picture (40px), sender, subject, two-line preview | Picture (36px), sender, subject, one-line preview |
| Keyboard | Basics (`c`, `/`, `Esc`) | Everything, plus command palette `Mod+K` |

The first start asks which layout to use; Settings → Appearance switches it.

Both layouts share the same row. Unread mail has a pink dot left of the picture,
bold sender and subject and a pink date. Hovering a row swaps the date for
quick actions (archive, delete, read/unread, flag); they are mouse-only because
the keyboard has `e`, `#`, `u` and `s`. Settings → Appearance → Mail list
switches between **Relaxed** (default, three lines) and **Compact** (28px
picture, subject and preview on one line).

Sender pictures that don't cover their circle sit padded on white, or on dark
grey when the logo itself is white or very light (`lib/pictureLook.ts`).

## Mail in dark mode

HTML mail is designed for white paper, so dark mode needs care
(`apps/desktop/src/features/mail/darkMode.ts`):

1. **The mail's own dark design wins.** If its CSS uses
   `prefers-color-scheme: dark` or `color-scheme`, UwUMail renders that and
   forces the media queries to match, independent of the web engine.
2. **Automatic** (default): after rendering, UwUMail measures the mail.
   Mails that are mostly background images (>15 %), images (>45 %) or
   colorful blocks (>30 % or three hue families) stay light as designed.
   Everything else is recolored.
3. **Recoloring** works in OKLCH: light backgrounds become dark, dark text
   becomes light, hues stay (a pink button stays pink), every text keeps
   at least 4.5:1 contrast, and blocks stay distinguishable from their
   background. Images are untouched; transparent PNG/GIF/SVG logos get a
   light backdrop so dark ink stays visible. Content on background images
   or gradients is left alone.
4. **The toggle** "☀ Light / ☾ Dark" in each message header (dark app theme
   only) overrides the result and is remembered per sender address.
   Settings → Reading sets the default (Automatic / Always light / Always
   dark) and resets remembered senders.

Plain-text mail always follows the app theme unless light is chosen. The
mail frame's `color-scheme` must always match its document, otherwise the
engine paints an opaque white canvas behind dark content.

## Nyu, the mascot

Nyu is an envelope cat: the flap is the face (UwU eyes, `w` mouth, blush),
two ears poke out on top. The app icon, the logo next to the wordmark and
every empty or error state use it. Sources live in `brand/` (icon, symbol,
mono symbol) and `apps/desktop/src/components/nyu/` (React).

- **Sticker style.** Plum outlines `#4B1D3F`, pink body `#FF6FA6`, light
  flap `#FFB8D3`, pastel props, a white die-cut edge. The colors are fixed
  artwork (`NYU` in `Nyu.tsx`) and stay the same in dark mode; the white
  edge keeps the outlines visible on dark backgrounds.
- **App icon.** Nyu slightly tilted on a pastel pink tile with two yellow
  sparkles and a heart. Never on a saturated pink tile, which reads as a
  telecom app. Regenerate the platform icons with
  `pnpm tauri icon ../../brand/uwumail-app-icon.svg` in `apps/desktop`
  (delete the generated `android/` and `ios/` folders).
- **Scenes** (`NyuScene`, 320 × 220): inbox zero, no search results, empty
  folder, nothing selected, no preview, no addons, welcome, setup done,
  message failed to load, offline, no account yet. `EmptyState` shows them at
  240 px, or 150 px with `compact` (Pro layout, dialogs). New scenes reuse
  `Nyu`, `Sticker` and the props in `scenes.tsx`, with a 6 px outline at
  0.4 scale.
- **Motion.** Nyu blinks in scenes, twitches its ears on hover, hops in the
  sidebar logo when new mail arrives (not on every sync) and flies off from
  the "sent" toast. Settings → Appearance → Animations (System / On / Off)
  resolves to `<html data-motion="full|reduced">` in `lib/theme.ts`; with
  `reduced`, all app animations collapse to 1 ms and Nyu stays still.
- **Name.** Nyu only appears by name in the playful tone ("Hi! I'm Nyu").
  The neutral tone keeps the pictures and says "UwUMail".

## Tone of voice

UwUMail is **playful by default**: kaomoji, warm little jokes, soft animations.
Settings → Tone → **Neutral** replaces the words, never the layout or colors.

Rules for playful copy:

1. **Information first.** The joke never replaces what happened or what to do.
   "Couldn't send (╥﹏╥) The server said the password is wrong." — not just a
   sad face.
2. **Short.** One kaomoji at most per message, never in buttons that act on
   data (Delete, Send) — those stay plain verbs.
3. **Kind.** Never mock the user; the app laughs at itself.
4. **Always both.** Every string lives in `locales/<lang>/neutral.json`. The
   playful variant goes under the same key in `locales/<lang>/playful.json`
   and is optional — missing keys fall back to neutral. A test makes sure
   German and English define the same keys in both files.

| Situation | Neutral | Playful |
| --- | --- | --- |
| Empty inbox | You're all caught up | Inbox zero! Time for tea (っ˘ω˘ς) |
| Sent | Message sent | Off it goes ✉︎ ~ |
| Offline | You're offline. Showing saved mail | No internet (・_・;) Showing what I saved for you |
| Deleted | Moved to trash | Bye bye (｡•́︿•̀｡) |

German strings follow the same rules and use "du".
