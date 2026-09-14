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
- Spacing on a 4px grid; list rows 72px (Simple) / 44px (Pro).
- Shadows only for floating layers (menus, composer window, toasts).

## Layouts

| | Simple | Pro |
| --- | --- | --- |
| Columns | List · Reader | Folders · List · Reader |
| Folders | Behind the menu button, pill filters on top | Always visible tree with accounts |
| Rows | Avatar, sender, subject, two-line preview | One line, no avatar |
| Keyboard | Basics (`c`, `/`, `Esc`) | Everything, plus command palette `Mod+K` |

The first start asks which layout to use; Settings → Appearance switches it.

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
4. **Always both.** Every string has a neutral key. The playful variant is the
   same key with the `_playful` suffix and is optional.

| Situation | Neutral | Playful |
| --- | --- | --- |
| Empty inbox | You're all caught up | Inbox zero! Time for tea (っ˘ω˘ς) |
| Sent | Message sent | Off it goes ✉︎ ~ |
| Offline | You're offline. Showing saved mail | No internet (・_・;) Showing what I saved for you |
| Deleted | Moved to trash | Bye bye (｡•́︿•̀｡) |

German strings follow the same rules and use "du".
