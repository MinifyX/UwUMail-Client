# Design

Clean, bright, soft — with a wink. Big rounded cards, hairline borders, pill
filters, generous whitespace, and one confident bubblegum pink.

UwUMail is built on the suite's design package
[@uwusuite/design](https://github.com/MinifyX/UwUSuite-Design): tokens and the
Tailwind theme, UwU Sans and the font picker, the components, the icon
vocabulary (`Icon` + `ICONS`), Nyu's parts, the title bar, the macOS menu bar
and the app icon tool. Its `docs/` are the rules (colors, type, components,
icons, window, macOS, app icons). This page only covers what is UwUMail's own.

## Colors and type

- Colors come from the package's tokens; components never use raw hex values.
  Account colors (for the unified inbox) come from a fixed, contrast-checked
  set: pink, violet, sky, mint, amber, coral.
- UwU Sans and the font picker come from the package. The choice also applies
  to mails, as a `data:` font inside the mail frame (`lib/mailFonts.ts`): a
  mail without a font gets ours, never the engine's Times. By default serif
  fonts are replaced with ours (Settings → Reading → Sender fonts); fonts that
  may be missing (Calibri, Aptos) fall back to ours. Monospace is never
  touched.
- Counts, dates and times in lists use tabular figures (`tabular-nums`).
- Mail list rows are rounded cards with a little gap and no dividers; hover and
  selection tint the whole card pink.

## Window

| | Windows, Linux | macOS | Android, iOS |
| --- | --- | --- | --- |
| Frame | None (`decorations: false`), the package's `TitleBar` | The system's title bar (`tauri.macos.conf.json`) | – |
| App actions | In the app (sidebar, command palette) | Also in the menu bar | In the app |
| Closing the window | Hides it into the tray with Settings → "Keep running in the background", otherwise quits | Hides it, UwUMail stays in the Dock | – |

- **Title bar** (`features/shell/WindowTitleBar.tsx`): Nyu and the word mark,
  a drag region, minimize, maximize and close. A double-click on the empty bar
  maximizes; Tauri's drag script does that, so the React handler is kept away
  (from UwUNotes). The close button calls `close()`, which reaches Rust's close
  handler (`src-tauri/src/background.rs`) like the system's button: with
  "keep running in the background" on, the window hides and the tray stays.
- **macOS** (`features/shell/useMacShell.ts`, the package's `docs/macos.md`):
  - The menu bar holds the same commands as the keys and the command palette
    (`features/shell/commands.ts`): UwUMail → Einstellungen … ⌘, and Nach
    Updates suchen …; Ablage → Neue E-Mail ⌘N, Neuer Termin, Neuer Kontakt;
    Bearbeiten → the system's items, Mails durchsuchen ⌘F, the last action
    undone; Darstellung → Mail ⌘1, Kalender ⌘2, Kontakte ⌘3, layout, theme,
    tone, Befehle … ⌘K; Postfach → Neue E-Mails abrufen ⇧⌘N, the unified
    folders; E-Mail → Antworten ⌘R, Allen antworten ⇧⌘R, Weiterleiten ⇧⌘F,
    archive, delete, move, label, spam, flag, unread; Fenster; Hilfe →
    shortcuts and links. Entries that need an open conversation are greyed out
    without one. German or English, as the app.
  - Every menu shortcut carries ⌘, and the in-app keys are single letters plus
    ⌘K, ⌘, and ⌘A, which do the same from either side. So a key never runs
    twice, and the menu never takes a plain key from a text field. Like the
    keys, the menu does nothing behind the app lock or while a dialog is open
    (except settings and the command palette).
  - ⌘W and the red light hide the window; a click on the Dock icon brings it
    back (`RunEvent::Reopen` in `desktop.rs`).
  - ⌘Q, Dock → Beenden, the menu bar icon's Beenden and logging out first save
    the open draft into the Drafts folder and send waiting settings
    (`lib/quit.ts`), then quit. The `uwu-macos` crate holds the quit meanwhile,
    ten seconds at most; the draft is also kept on the device every half
    second, so nothing typed is lost even then.
  - The menu bar icon is `tray-template.png`, a template macOS tints itself; a
    click opens its menu.
- **Shortcuts in tooltips** go through `withShortcut()` (`shortcutHint` in
  `lib/platform.ts`): `Senden (⌘↩)` on a Mac, `Senden (Strg+Enter)` elsewhere.

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
Phones use the same row and density inside their swipe rows; a long press selects
and covers the picture with a pink check.

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
  telecom app. It stays the icon for the website, GitHub, the Windows Store
  tiles and iOS; the macOS Dock gets it set into Apple's icon grid (824 of
  1024 px, superellipse, `icons/macos/icon-1024.png` to look at).
- **Taskbar icon.** On the Windows taskbar, in the tray and in Linux menus
  Nyu stands alone: upright, no tile, with the white die-cut edge so it reads
  on dark and light taskbars (`brand/uwumail-taskbar-icon.svg`). Up to 24 px,
  and in the tray, a simplified cut takes over with thicker outlines and no
  blush or inner ears (`uwumail-taskbar-icon-small.svg`).
- **Menu bar icon (macOS).** The mono symbol, black on transparent, outlines
  1.5 times as thick, on a square canvas (`brand/uwumail-tray-template.svg`).
- **Generating the icons.** `pnpm --filter @uwumail/desktop icons` runs the
  package's `uwu-icons --tray --mobile` and writes everything into
  `src-tauri/icons`: `icon.ico`, the desktop PNGs, `tray.png`,
  `tray-template.png`, the Store tiles, `icon.icns` and the iOS `AppIcon` set
  (CI copies it over the Xcode template, `.github/workflows/ios.yml`). Android
  keeps its adaptive icon as vector drawables with a monochrome layer for
  themed icons (`gen/android/app/src/main/res/drawable/ic_launcher_*.xml`,
  drawn by hand from the brand SVGs), so the script drops the PNG mipmaps
  `uwu-icons` writes as well.
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
