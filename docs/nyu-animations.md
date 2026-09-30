# Nyu animations

Nyu, the envelope cat, reacts to what happens in the mail: short scenes (cameos) in a corner
of the window, Nyu thinking while the AI assistant works, and small idle movements in the
empty-state pictures. Everything lives in `apps/desktop/src/components/nyu/`, ported from the
webmail (UwUMail-Webmail, same file names and scenes); only the call sites listed under
"Triggers" and the few differences under "Differences from the webmail" are the app's own.

## Rules

- Short: a cameo lasts 1.3–2 s, then goes by itself. One replaces the other, nothing queues.
- Never in the way: the stage is `position: fixed`, `pointer-events: none` on itself and every
  SVG part, `aria-hidden`. It never moves the layout. Below dialogs (`z-index: 45`), above the
  content; bottom right on wide screens, above the Write button on phones (Android and iOS),
  clear of the bottom safe area.
- Light: inline SVG and CSS keyframes, no images, no animation library. The cameo drawings and
  their CSS (`Cameos.tsx`, `cameos.css`) are a lazy chunk, fetched while the web view is idle
  once Nyu may move; nothing is fetched while the setting is off.
- On-model: all scenes reuse `Nyu`, `Paw`, `Sticker` (white die-cut edge), `Letter`, `Heart`,
  `Star`, `Shadow` and the `NYU` palette from `Nyu.tsx`/`scenes.tsx`, drawn on the scenes'
  320 × 220 canvas with Nyu at 0.4 scale, 6 px outlines and an 18 px sticker edge.

## Setting

Settings → Appearance → **Nyu animations**: `on` (default) / `reduced` / `off`. It is
`Settings.nyuAnimations`, one setting for the whole app and every mailbox in it, UwUMail or
not, kept on the device with the other settings (`uwumail.settings`). Like the other settings
that follow the account, it syncs with the UwUMail account chosen under Settings → Mailboxes
(`settingsSyncAccount`, see `state/accountSync.ts`) as the settings-extension key
`nyu.animations` (`"on" | "reduced" | "off"`, see `lib/settingsSync.ts`), the same key the
webmail uses. Without a UwUMail account it simply stays on the device.

`level.ts` resolves it into a `NyuLevel`:

| setting | general animations resolve to reduced (setting "Off", or "System" + `prefers-reduced-motion: reduce`) | level     |
| ------- | ----------------------------------------------------------------------------------------------------- | --------- |
| on      | no                                                                                                    | `full`    |
| on      | yes                                                                                                   | `reduced` |
| reduced | any                                                                                                   | `reduced` |
| off     | any                                                                                                   | `off`     |

The app has no server brand that could hide the mascot, so unlike the webmail's `level.ts` there
is no `mascot` input.

- `full`: everything moves.
- `reduced`: no movement at all. Cameos with meaning (sent, archived, trashed, deleted, birthday,
  contact, night) appear as a still picture for at most 1.4 s; decorative ones (peek, photos)
  stay away. Idle loops, blinking and the logo hop stop. `NyuThinking` is a still picture.
- `off`: no cameos; `NyuThinking` shows its `fallback` (the old dots / spinner). Empty states
  keep their still illustration.

`prefers-reduced-motion` comes from the operating system through the web view (Windows, macOS,
Linux, Android "Remove animations", iOS "Reduce Motion").

`useApplyNyuLevel()` (called once in `App`) writes the level to `<html data-nyu="…">`; `nyu.css`
stops every animation inside `.nyu-host` for `reduced` and `off`. Use `useNyuLevel()` in
components and `currentNyuLevel()` outside React.

## Components

| File                        | What                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `level.ts`                  | `resolveNyuLevel`, `useNyuLevel`, `currentNyuLevel`, `useApplyNyuLevel`                                                                                                         |
| `cameo.ts`                  | cameo store (zustand) and API: `playNyu(name, { key?, hat? })`, `playFirstNyu(choices)`, `finishNyu(id)`, the `CAMEOS` table (duration, shown when reduced, priority, cooldown) |
| `occasions.ts`              | pure rules: `isBirthdayToday`, `contactFor`, `photoCount`, `openCameos(mail, contacts, now)`; re-exports `isLateNight`, `seasonalHat`                                          |
| `NyuStage.tsx`              | mount once near the root (`App`); lazy-loads `Cameos.tsx` and shows the current cameo                                                                                           |
| `Cameos.tsx` + `cameos.css` | the cameo drawings and their keyframes (lazy chunk)                                                                                                                             |
| `hats.tsx`                  | `NyuHat`: party hat, Santa hat, nightcap, in Nyu's own coordinates (pass as `front`); the `Hat` type, `isLateNight`, `seasonalHat`                                            |
| `NyuThinking.tsx`           | `<NyuThinking size="md" \| "sm" fallback={…} />` for AI loading states                                                                                                          |
| `scenes.tsx`                | the empty-state scenes, now with idle movement (`nyu-zzz`, `nyu-steam`, `nyu-sweep`, `nyu-wonder`) and the nightcap on the inbox-zero scene late at night                       |

### Cameos

| Name       | Picture                                                              | Duration | Reduced | Priority | Cooldown                |
| ---------- | -------------------------------------------------------------------- | -------- | ------- | -------- | ----------------------- |
| `peek`     | Nyu pops up holding a letter, eyes read left to right (seasonal hat) | 1.3 s    | hidden  | 0        | 12 s                    |
| `photos`   | sparkly-eyed Nyu with a camera, flash, a polaroid slides out         | 1.5 s    | hidden  | 1        | 1 min                   |
| `night`    | Nyu in a nightcap sways under the moon, zzz                          | 1.8 s    | still   | 1        | 45 min                  |
| `friend`   | happy Nyu squishes, hearts float up                                  | 1.6 s    | still   | 1        | 5 min per sender        |
| `sent`     | letter winds up and flies off along a dashed trail, Nyu waves        | 1.8 s    | still   | 2        | –                       |
| `archived` | letter drops into a box, flaps close, heart stamp, Nyu hops          | 1.5 s    | still   | 2        | –                       |
| `trashed`  | bin lid opens, letter drops in, Nyu waves goodbye                    | 1.5 s    | still   | 2        | –                       |
| `deleted`  | bin lid slams with a puff, sad Nyu                                   | 1.7 s    | still   | 2        | –                       |
| `birthday` | cheering Nyu in a party hat, confetti burst                          | 2 s      | still   | 3        | once per sender and day |

A cameo is ignored while one of higher priority is still on, while its key is cooling down,
or while the tab is hidden. Each one's resting pose (no animation) is the key picture, which is
what `reduced` shows; all parts animate over the cameo's whole time (`--nyu-cameo-ms`).

## Triggers

| Situation                                | Where (app, `apps/desktop/src/`)                                                                                                                                                                                                 | Call                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Mail sent (also during the undo time)    | `features/compose/Composer.tsx` right after the mail was handed over (sent or queued for undo)                                                                                                                                   | `playNyu("sent")`                                                                     |
| Archived                                 | `lib/queries.ts` `useMessageActions().archive` (list, reader, phone reader, swipe, selection); `features/shell/commands.ts` ("e")                                                                                                 | `playNyu("archived")`                                                                 |
| Moved to trash / deleted for good        | `lib/queries.ts` `trashMail`                                                                                                                                                                                                     | `playNyu("trashed")` / `playNyu("deleted")`                                           |
| Mail opened                              | `features/mail/nyuOnOpen.ts` `useNyuOnOpen(detail)`, called in `ThreadReader` and `MobileReader` once per conversation                                                                                                            | `playFirstNyu(openCameos(…))`                                                         |
| AI working                               | `features/assist/ComposeAssist.tsx` `Thinking` (compose, summary, spam check), `features/dates/EventsBar.tsx` "Check with AI" and `features/assist/settings/LabelSettings.tsx` "Label recent mail" via `Button busyIndicator` | `<NyuThinking fallback={dots} />`, `<NyuThinking size="sm" fallback={<Spinner />} />` |
| Inbox zero / empty search / errors       | `EmptyState` scenes `inbox` (sleepy), `search` (magnifier sweeps, "?" wobbles), `loadError` (puzzled, "?" wobbles)                                                                                                               | CSS only                                                                              |

`openCameos` orders the scenes for an opened mail, and `playFirstNyu` plays the first that may
play: sender's birthday today (contact from the address book, 29 Feb on the 28th in other
years) → the mail was unread and the sender is a contact (the webmail has no favourites, so
"someone in the address book" is the favourite/frequent contact) → photos attached (non-inline
`image/*`, not SVG/icons) → late at night (23:00–04:59 local) → a peek, wearing a Santa hat
from 1 to 26 December and a party hat on 31 December and 1 January. The sender is the newest
message in the conversation not written by one of the own mailboxes (every account in the app,
UwUMail or IMAP); "new" is the read state as the conversation first arrived, before opening it
marked it read.

Contacts: the contacts already loaded (after the contacts view, the contact card or the birthday
import) or else `backend().knownContacts()`, the Tauri command `list_contact_cards` with
`look: false`: it reads the address books of the mailboxes whose source is known (JMAP Contacts
of a UwUMail account, CardDAV found earlier or typed in) and never starts a CardDAV search for a
foreign IMAP mailbox, which still waits until the contacts are opened. Nothing is read while Nyu
is off. The scene waits for the accounts and these contacts, at most 2.5 s, then plays with what
it has. The demo backend returns its sample address book (Noah's birthday is 30 September).

`Button` has an optional `busyIndicator` (and an exported `Spinner`), so any AI button can show
`<NyuThinking size="sm" fallback={<Spinner />} />` instead of the ring while busy.

## Differences from the webmail

- No brand: `resolveNyuLevel(setting, motion, systemReduced)` without the `mascot` input.
- `hats.tsx` holds `Hat`, `isLateNight` and `seasonalHat` instead of `cameo.ts`/`occasions.ts`,
  because the installer (`apps/setup`) shares `scenes.tsx` and `nyu.css` via its `@nyu` alias and
  cannot import the app's settings or `@/lib/…`; `scenes.tsx` may only import `Nyu.tsx` and
  `hats.tsx`. `cameo.ts` and `occasions.ts` re-export them, so the API is the same.
- Contacts through `knownContacts()` (see above), and the open scene waits for them.
- Sending plays in `Composer.tsx` (the app has no `announceSent`).
- AI labels ("Label recent mail" in the assistant settings) thinks with Nyu too.

When the webmail's scenes change, copy `Cameos.tsx`, `cameos.css`, the Nyu part of `nyu.css`
and the tests, and keep the differences above. Tests: `components/nyu/occasions.test.ts`,
`cameo.test.ts`, `level.test.ts`, `Nyu.test.tsx`, `features/mail/nyuOnOpen.test.tsx`,
`state/settings.test.ts`, `lib/settingsSync.test.ts`; `known_contact_cards` in the core's
contacts tests.
