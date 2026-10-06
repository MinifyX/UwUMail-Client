# UwUMail on the iPhone

The same app and the same engine as everywhere else, built for iOS by the
[`iOS` workflow](../.github/workflows/ios.yml). This page is about what that
build is, how it gets onto a phone, and what iOS doesn't let UwUMail do.

## What CI builds

Every run on `main` produces two things, built side by side on two Mac runners:

| Artifact | File | What it is |
| --- | --- | --- |
| `UwUMail-iOS-<commit>` | `UwUMail-<version>-unsigned.ipa` | The app for a real iPhone, **without any signature** (released as `UwUMail-ios.ipa`) |
| `UwUMail-iOS-simulator-<commit>` | `UwUMail-simulator.tar.gz` | The same app for the iOS simulator, used by the smoke test |

The Xcode project is not in this repository. `tauri ios init` generates it on
the runner for every build, so there is no generated Xcode folder to keep in
sync. Only what Tauri needs to generate it lives here:
`apps/desktop/src-tauri/tauri.ios.conf.json` and `Info.ios.plist`.

After the build the workflow boots a simulator, installs UwUMail, starts it and
checks that the engine comes up and the web view draws its first screen
(`scripts/ios-smoke.sh`), then starts it once more to check the background
refresh (below). Screenshots of that run are in the smoke artifact. Pull
requests that touch the app build and smoke-test the simulator app only.

On a tag and when started by hand, the job `testflight` signs the same IPA for
the App Store and uploads it to **TestFlight** — see [app-store.md](app-store.md).

## Why the IPA is unsigned

The IPA on the releases page leaves CI with no signature at all — iOS refuses
to install it as it is. The signed one goes to TestFlight only
([app-store.md](app-store.md)); until UwUMail is in the App Store, the way onto
your own phone without TestFlight is a sideloading tool that signs the app with
your own free Apple ID right before it installs it.

1. Download `UwUMail-ios.ipa` from the
   [releases page](https://github.com/MinifyX/UwUMail-Client/releases). Every
   release carries the IPA the iOS workflow built and tried for that commit.
   (For something newer than the last release: the `UwUMail-iOS-…` artifact of
   a workflow run on `main`, unzipped.)
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

Working: the mail engine, accounts, sign-in with Microsoft (Outlook.com and
Microsoft 365), IMAP and JMAP sync, sending, offline store
and search, the phone layout, swipe actions, Face ID as the app lock, haptics,
notifications for mail that arrives while UwUMail runs, passwords in the iOS
keychain, attachments saved into UwUMail's folder in the Files app.

Not there:

- **New mail while the app rests comes when iOS says so.** iOS gives no app a
  service that keeps running, so there is nothing like the Android foreground
  service. UwUMail asks iOS for background refresh (`BGAppRefreshTask`
  `app.uwumail.refresh`, `src-tauri/src/ios_refresh.rs`): whenever it goes into
  the background it asks to be woken at the earliest 15 minutes later, and on a
  wake-up every account looks for mail once (at most 25 seconds) and new mail
  rings as a local notification. iOS decides when — it learns when you use the
  app, and skips it in Low Power Mode or with Settings → General → Background App
  Refresh off. Real push would need APNs and a server.
- **Attachments only open inside UwUMail.** Pictures, PDFs and text show in the
  viewer; handing a file to another app needs iOS' share sheet, which isn't
  wired up yet. "Save" puts the file into UwUMail's folder in the Files app
  ("On My iPhone → UwUMail").
- **No printing.** The web view on the phone can't; that will come with the
  share sheet.
- **Google sign-in only with luck.** Microsoft comes back to the app through
  `app.uwumail://oauth` ([oauth.md](oauth.md#phones)); Google only allows a
  loopback redirect, and iOS pauses UwUMail while Safari is in front. Add Gmail
  with an app password.
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

`pnpm tauri ios build` wants an Apple development team for the export step at
the end; the app is finished before that. That is what CI takes:

```bash
bash scripts/ios-build.sh 0.2.0-dev out
```

One thing to know when a dependency is added: on iOS, Cargo builds a static
library and Xcode does the linking, so `cargo:rustc-link-lib=framework=…` from a
crate's build script never reaches the linker. The frameworks have to be listed
in `tauri.ios.conf.json` under `bundle > iOS > frameworks` instead — that's why
`SystemConfiguration` is in there, for the DNS resolver's system settings,
`Vision` for reading the text in pictures (`crates/uwumail-ocr`) and
`BackgroundTasks` for the background refresh. A
missing one shows up as "Undefined symbols for architecture arm64".
