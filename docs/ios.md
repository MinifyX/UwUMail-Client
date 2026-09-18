# UwUMail on the iPhone

The same app and the same engine as everywhere else, built for iOS by the
[`iOS` workflow](../.github/workflows/ios.yml). This page is about what that
build is, how it gets onto a phone, and what iOS doesn't let UwUMail do.

## What CI builds

Every run on `main` (and on `feat/ios`) produces two things:

| Artifact | What it is |
| --- | --- |
| `UwUMail-<version>-unsigned.ipa` | The app for a real iPhone, **without any signature** |
| `UwUMail-simulator.tar.gz` | The same app for the iOS simulator, used by the smoke test |

The Xcode project is not in this repository. `tauri ios init` generates it on
the runner for every build, so there is no generated Xcode folder to keep in
sync. Only what Tauri needs to generate it lives here:
`apps/desktop/src-tauri/tauri.ios.conf.json` and `Info.ios.plist`.

After the build the workflow boots a simulator, installs UwUMail, starts it and
checks that the engine comes up and the web view draws its first screen
(`scripts/ios-smoke.sh`). Screenshots of that run are in the smoke artifact.

## Why the IPA is unsigned

Signing an app for a real iPhone needs an Apple certificate, and those come
with the Apple Developer Program (99 $ a year). UwUMail doesn't have one, so
the IPA leaves CI with no signature at all — iOS refuses to install it as it is.

The way around it, for your own phone: a sideloading tool signs the app with
your own free Apple ID right before it installs it.

1. Download the `UwUMail-iOS-…` artifact from the workflow run and unzip it.
2. Install [Sideloadly](https://sideloadly.io/) (Windows or macOS) or
   [AltStore](https://altstore.io/).
3. Plug in the iPhone, drag the `.ipa` into the tool, sign in with your Apple
   ID, and let it install.

What that costs you with a free Apple ID: the app stops working after **7 days**
and has to be installed again, and you can have at most **3** sideloaded apps on
the phone at a time. With a paid developer account the app lasts a year — that's
the only difference, and the reason the workflow builds an IPA and not something
tied to an account.

## What works, and what iOS doesn't allow

Working: the mail engine, accounts, IMAP and JMAP sync, sending, offline store
and search, the phone layout, swipe actions, Face ID as the app lock, haptics,
notifications for mail that arrives while UwUMail runs, passwords in the iOS
keychain, attachments saved into UwUMail's folder in the Files app.

Not there:

- **No mail while the app is closed.** iOS gives no app a service that keeps
  running, so there is nothing like the Android foreground service. Mail arrives
  while UwUMail is open. The app asks iOS for background refresh
  (`UIBackgroundModes: fetch`), but the Swift side that answers that wake-up is
  not written yet, and iOS decides when — or whether — it happens at all. Real
  push would need APNs, which needs a paid account and a server.
- **Attachments only open inside UwUMail.** Pictures, PDFs and text show in the
  viewer; handing a file to another app needs iOS' share sheet, which isn't
  wired up yet. "Save" puts the file into UwUMail's folder in the Files app
  ("On My iPhone → UwUMail").
- **No printing.** The web view on the phone can't; that will come with the
  share sheet.
- **No sign-in with Microsoft or Google.** The redirect back from the browser
  needs a URL scheme the app doesn't register yet. Password accounts work.
- **No in-app updates.** A new version comes from wherever you installed the
  app, which with a free Apple ID you do every 7 days anyway.
- **Profiles and apps from mail are refused.** `.mobileconfig`, `.ipa`,
  `.shortcut` and `.wf` can only be saved, never opened — a configuration
  profile can add certificates, a VPN or device management to a phone.

## Building it yourself

You need a Mac with Xcode:

```bash
pnpm install
pnpm --filter @uwumail/desktop exec vite build
pnpm tauri ios init --ci
pnpm tauri ios dev          # runs it in the simulator
```

`pnpm tauri ios build` wants an Apple development team. Without one, build the
same way CI does:

```bash
bash scripts/ios-build.sh 0.2.0-dev out
```
