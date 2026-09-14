# Addons

Addons extend UwUMail without being able to break it or spy on it. They are
small web apps (HTML + JavaScript) that run in a sandbox and call a typed API.

> Status: this document is the specification the addon host is built against.
> API version: **1** (pre-release, may still change until UwUMail 1.0).

## Anatomy of an addon

An addon is a folder, shipped as a zip file with the extension `.uwuaddon`:

```
hello-uwu/
├── uwuaddon.json       manifest (required)
├── background.js       runs while the addon is enabled (optional)
├── panel.html          a sidebar panel (optional)
├── settings.html       the addon's settings page (optional)
├── icon.svg
└── locales/
    ├── en.json
    └── de.json
```

## Manifest

```json
{
  "$schema": "https://uwumail.app/schema/uwuaddon-1.json",
  "manifestVersion": 1,
  "id": "dev.example.hello-uwu",
  "version": "1.0.0",
  "name": { "en": "Hello UwU", "de": "Hallo UwU" },
  "description": { "en": "Says hi to new mail.", "de": "Begrüßt neue Mails." },
  "author": { "name": "Example Dev", "url": "https://example.dev" },
  "license": "MIT",
  "icon": "icon.svg",
  "engines": { "uwumail": ">=0.1.0" },

  "permissions": ["messages.read", "notifications"],
  "hosts": ["https://api.example.dev"],

  "background": "background.js",
  "contributes": {
    "commands": [
      { "id": "greet", "title": { "en": "Greet this mail", "de": "Diese Mail begrüßen" }, "shortcut": "Mod+Shift+H" }
    ],
    "messageActions": [{ "command": "greet", "icon": "hand" }],
    "composeActions": [],
    "panels": [
      { "id": "stats", "title": { "en": "Mail stats", "de": "Mail-Statistik" }, "icon": "chart-bar", "entry": "panel.html" }
    ],
    "settings": { "entry": "settings.html" }
  }
}
```

| Field | Rules |
| --- | --- |
| `id` | Reverse-DNS, lowercase, `[a-z0-9.-]`, globally unique, never changes |
| `version` | SemVer |
| `name`, `description` | A string or a map of locale → string; `en` is the fallback |
| `engines.uwumail` | SemVer range of compatible UwUMail versions |
| `permissions` | See below. Anything not listed is denied |
| `hosts` | HTTPS origins the addon may reach through `uwu.net.fetch`. Wildcards only as a leading `*.` |
| `contributes` | Declarative UI. The host renders these natively, so buttons always look like UwUMail |

Icons in `contributes` are [Lucide](https://lucide.dev/icons) names.

## Permissions

The user sees every permission in plain language before installing, and again
whenever an update asks for more.

| Permission | Allows | Risk shown to user |
| --- | --- | --- |
| *(none)* | Own storage, own settings page, declared buttons and panels, `uwu.ui.toast` | — |
| `accounts.read` | List mailboxes (name, address, color). Never credentials | low |
| `folders.read` | List folders and unread counts | low |
| `messages.read` | Read message headers and bodies | **high** |
| `messages.modify` | Change flags, move, archive, delete messages | **high** |
| `messages.send` | Send mail without opening the composer | **high** |
| `compose.write` | Read and change the draft in an open composer, hook into sending | medium |
| `contacts.read` | Read the address book | medium |
| `notifications` | Show system notifications | low |
| `schedule` | Wake the background script at a set time (snooze, send later) | low |
| `clipboard.write` | Put text on the clipboard | low |
| `hosts` (field) | Talk to the listed servers | medium, lists the hosts |

No permission ever exposes passwords, OAuth tokens, other addons' data, the
file system, or Tauri APIs.

## Runtime model

- Every addon entry (`background`, each panel, `settings`) runs in its own
  `<iframe sandbox="allow-scripts">`. The frame has an **opaque origin**: no
  cookies, no `localStorage`, no access to the app window or to other addons.
- The frame's Content-Security-Policy is `default-src 'none'` plus the addon's
  own scripts, styles and images. Direct `fetch` is blocked; network access
  goes through `uwu.net.fetch`, which the host performs only for `hosts`
  entries.
- The background frame starts when the addon is enabled and may be suspended
  when idle; persistent state belongs in `uwu.storage`.
- Panels and settings frames receive the current theme (colors, fonts, dark
  mode, tone) and the SDK applies it, so addon UI matches the app.

## The API (`@uwumail/addon-sdk`)

```ts
import { uwu } from "@uwumail/addon-sdk";

uwu.commands.on("greet", async ({ messageId }) => {
  const message = await uwu.messages.get(messageId);        // needs messages.read
  await uwu.notifications.show({ title: `Hi ${message.from.name}!` });
});

uwu.events.on("messages.received", async ({ messageIds }) => {
  const count = (await uwu.storage.get<number>("seen")) ?? 0;
  await uwu.storage.set("seen", count + messageIds.length);
});
```

### Namespaces

| Namespace | Methods | Permission |
| --- | --- | --- |
| `uwu.app` | `info()` → version, locale, tone, theme | — |
| `uwu.storage` | `get`, `set`, `delete`, `keys` (JSON values, 5 MB per addon) | — |
| `uwu.ui` | `toast(message)`, `openPanel(id)`, `confirm(options)` | — |
| `uwu.commands` | `on(commandId, handler)` | — |
| `uwu.events` | `on(event, handler)` | depends on event |
| `uwu.accounts` | `list()` | `accounts.read` |
| `uwu.folders` | `list(accountId?)` | `folders.read` |
| `uwu.messages` | `list(query)`, `get(id)`, `search(text)` | `messages.read` |
| | `setFlags(ids, flags)`, `move(ids, folderId)`, `delete(ids)` | `messages.modify` |
| | `send(draft)` | `messages.send` |
| `uwu.compose` | `getDraft()`, `updateDraft(patch)`, `insertText(text)` | `compose.write` |
| `uwu.contacts` | `list(query)` | `contacts.read` |
| `uwu.notifications` | `show({ title, body })` | `notifications` |
| `uwu.schedule` | `at(date, payload)`, `cancel(id)`, `list()` | `schedule` |
| `uwu.clipboard` | `writeText(text)` | `clipboard.write` |
| `uwu.net` | `fetch(url, init)` | `hosts` |

### Events

| Event | Payload | Permission |
| --- | --- | --- |
| `messages.received` | `{ accountId, messageIds }` | `messages.read` |
| `message.opened` | `{ messageId }` | `messages.read` |
| `compose.beforeSend` | `{ draft }` — return `{ cancel: true }` or a patched draft | `compose.write` |
| `schedule.fired` | `{ id, payload }` | `schedule` |
| `app.toneChanged` / `app.themeChanged` | `{ tone }` / `{ theme }` | — |

## Wire protocol

The SDK wraps a small JSON-RPC-like protocol over `postMessage`. Addon authors
never need it, but it is stable and documented for other languages:

```jsonc
// addon → host
{ "uwu": 1, "kind": "call", "id": 7, "method": "messages.get", "params": ["msg_123"] }
// host → addon
{ "uwu": 1, "kind": "result", "id": 7, "ok": true, "value": { /* … */ } }
{ "uwu": 1, "kind": "result", "id": 7, "ok": false, "error": { "code": "permission_denied", "message": "…" } }
// host → addon, unsolicited
{ "uwu": 1, "kind": "event", "name": "messages.received", "payload": { /* … */ } }
```

The host identifies the calling addon by the frame that sent the message
(`event.source`), never by anything inside the message.

Error codes: `permission_denied`, `not_found`, `invalid_params`,
`rate_limited`, `host_not_allowed`, `internal`.

## Distribution

- **Catalog:** [`MinifyX/UwUMail-Addons`](https://github.com/MinifyX/UwUMail-Addons)
  holds `catalog.json` with reviewed addons: id, version, download URL of the
  `.uwuaddon` release asset, its SHA-256, and the permissions it requests.
  The app installs from there with one click, verifies the checksum, and
  refuses the package if its manifest asks for different permissions than the
  catalog entry.
- **From file:** Settings → Addons → Install from file. Shows a
  "not reviewed" badge.
- **Development:** Settings → Addons → Load unpacked folder, with reload on
  change.

## Official addons (planned)

| Addon | Uses |
| --- | --- |
| Send later + Snooze | `messages.send`, `messages.modify`, `schedule` |
| PGP | `compose.write`, `messages.read` |
| AI helper (off by default, bring your own key or local model) | `messages.read`, `compose.write`, `hosts` |
| Templates + snippets | `compose.write` |
| Calendar (CalDAV, invitations) | `messages.read`, `hosts`, panel |
