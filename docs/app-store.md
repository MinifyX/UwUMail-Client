# UwUMail in the App Store (TestFlight)

[Deutsch weiter unten](#uwumail-im-app-store-testflight)

UwUMail comes in two forms on Apple's systems. The **GitHub builds** stay what they were: the
DMG with its setup for the Mac (updates itself) and the unsigned IPA for sideloading on the iPhone
([ios.md](ios.md)). The **App Store builds** are the same app, signed by the developer team and
uploaded to App Store Connect, one app for iPhone, iPad and Mac (bundle ID `app.uwumail`,
universal purchase). For now they go to **TestFlight only**: nothing has been submitted for
review, and nothing in CI ever submits.

Privacy policy: [PRIVACY.md](../PRIVACY.md), published as
<https://uwu.minifyx.de/uwumail/privacy> (also linked under Settings → About).

## What is different in the store builds

|                    | iPhone/iPad: sideload IPA     | iPhone/iPad: TestFlight               | Mac: DMG (GitHub)                     | Mac: App Store                                  |
| ------------------ | ----------------------------- | ------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| Bundle ID          | `app.uwumail`                 | `app.uwumail`                         | `app.uwumail.desktop`                 | `app.uwumail`                                   |
| Signed by          | whoever sideloads it          | Apple Distribution, App Store profile | ad hoc (no Developer ID)              | Apple Distribution + Mac Installer Distribution |
| Updates            | new IPA from the release page | TestFlight / App Store                | own updater (feature `self-update`)   | the store; no updater compiled in               |
| Cargo features     | default                       | default (the same build as sideload)  | default (`self-update`)               | `--no-default-features --features store`        |
| Sandbox            | iOS's                         | iOS's                                 | no                                    | yes, `macos/Entitlements.mas.plist`             |
| Default mail app   | —                             | —                                     | the setup, or Settings → Mail         | Settings → Mail                                 |
| Open at login      | —                             | —                                     | the setup's LaunchAgent (`--autostart`) | Settings → Mail (system login item, macOS 13+) |
| Privacy manifest   | `apple/PrivacyInfo.xcprivacy` | same                                  | —                                     | same, in `Contents/Resources`                   |
| Background refresh | `BGAppRefreshTask`            | same                                  | tray                                  | tray                                            |

The TestFlight IPA is the sideload IPA of the same run, signed afterwards: one build for both. The
iPhone has no update settings in either (a new version comes from wherever the app was
installed). The Mac App Store build knows it is one (`distribution` command, feature `store`): no
update settings, no "Check for Updates…" in the app menu.

### The Mac App Store build in the sandbox

- **No updater, no setup**: `tauri-plugin-updater`, the feed and the hand-over to the setup are
  not compiled in (`#[cfg(self_update)]`, set by `build.rs` from the feature). `scripts/build-mas.mjs`
  fails if the feed's address or `pkexec` is still in the program.
- **Entitlements** (`macos/Entitlements.mas.plist`): network client (mail servers, Microsoft,
  Google, sender pictures, the AI provider), network server (the loopback listener on 127.0.0.1
  that the Microsoft/Google sign-in comes back to, RFC 8252 — nothing else listens), user-selected
  files read/write (attachments to send, saving an attachment through the save panel). The
  Keychain items are the app's own and need no entitlement.
- **What the setup did, now in Settings → Mail** (`src/macos_system.rs`): "Make UwUMail the
  default" sets Launch Services' `mailto:` handler to the app's own bundle ID; "Open at login"
  registers the app as a login item (`SMAppService.mainAppService`, macOS 13+; macOS may ask for
  approval under System Settings → General → Login Items). A login item opens UwUMail with its
  window (it can't pass `--autostart`); closing the window keeps it in the menu bar as usual.
- **Data** lives in the container, `~/Library/Containers/app.uwumail/Data/Library/Application
Support/app.uwumail`, not where the DMG keeps it. Switching between the two means adding the
  accounts again.
- **Info.plist**: `Info.mas.plist` (the `mailto:` scheme, `ITSAppUsesNonExemptEncryption =
  false`), category `public.app-category.productivity` (from `bundle.category`), minimum macOS 11.
- **Version**: three numbers; `0.10.0-beta.2` goes up as `0.10.0`.

### Background refresh on iPhone and iPad

`src/ios_refresh.rs` registers `BGAppRefreshTask` `app.uwumail.refresh` while the app launches
(`BGTaskSchedulerPermittedIdentifiers` in `Info.ios.plist`, `UIBackgroundModes: fetch`), asks for
the next wake-up whenever UwUMail goes into the background (at the earliest 15 minutes later), and
on a wake-up runs one bounded round of the engine (`Engine::refresh_all`, at most 25 seconds):
every account's sync looks for mail once, a failing connection is retried once at once, and new
mail rings through the usual local notifications. iOS decides when it happens (it learns when the
app is used; none in Low Power Mode or with Background App Refresh off). Nothing goes through a push
service. Tested: the engine round in `crates/uwumail-core/tests/integration/jmap_push.rs`; on CI
the simulator smoke test checks that the task is registered at launch and runs the same round
(`UWUMAIL_REFRESH_NOW`), since the simulator never starts background tasks itself. On a device, in
Xcode's debugger:
`e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"app.uwumail.refresh"]`.

## How CI signs and uploads

| Platform    | Workflow → job           | Runs on                                | What it does                                                                                                                                                 |
| ----------- | ------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| iPhone/iPad | `ios.yml` → `app`        | main, tags, Run workflow; PRs: simulator only | builds the unsigned IPA and the simulator app, smoke-tests the latter                                                                                  |
| iPhone/iPad | `ios.yml` → `testflight` | `v*` tags, Run workflow                | takes the run's unsigned IPA, sets the build number, embeds the App Store profile and the privacy manifest, signs (`scripts/ios-sign.sh`), uploads with `altool`; artifact `UwUMail-iOS-appstore-<sha>` |
| Mac         | `mas.yml` → `build`      | tags, Run workflow, PRs touching it    | builds the universal store app, unsigned, and checks it (`scripts/build-mas.mjs`); reads the DMG build's Cargo cache                                          |
| Mac         | `mas.yml` → `testflight` | `v*` tags, Run workflow                | signs the app with its profile and entitlements, packs a signed `.pkg` (`build-mas.mjs --sign`), uploads it; artifact `UwUMail-mas-<sha>`                   |

Both signing jobs run on a fresh runner that builds and installs nothing, with a keychain of their
own that is deleted at the end (`scripts/apple-ci.sh`). The build jobs hold no signing secret (the
Mac build gets the OAuth client IDs that every build compiles in).

- **Build number** (`CFBundleVersion`): `<run number>.<attempt>` of the workflow (`ios.yml` for the
  iPhone, `mas.yml` for the Mac). It grows with every run and every re-run, separately per
  platform, as App Store Connect wants.
- **Bundle ID and profiles**: `scripts/asc.mjs` asks the App Store Connect API for the profile
  `UwUMail <iOS|macOS> App Store app.uwumail`, made for the certificate in the secret; a missing or
  invalid one is made anew in the same run, and the bundle ID is registered if it is missing
  (`node scripts/asc.mjs bundle`; done on 2026-10-06, platform universal, no capabilities — local
  notifications, background refresh and the app's own Keychain items need none).
- **Seeing the builds**: `node scripts/asc.mjs builds` lists the newest builds with their
  processing state (with `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_PATH` set). Processing takes 5–30
  minutes after the upload; Apple mails problems with a build.

Starting an upload by hand: Actions → **iOS** or **Mac App Store** → Run workflow → `main`.

### Secrets (MinifyX/UwUMail-Client)

| Secret                   | Content                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `APPLE_TEAM_ID`          | `7N8YX2CL7J`                                                                                  |
| `APPLE_ASC_KEY_ID`       | App Store Connect API key ID (team key, role App Manager)                                     |
| `APPLE_ASC_ISSUER_ID`    | its issuer ID                                                                                 |
| `APPLE_ASC_KEY_P8`       | the key itself (`AuthKey_….p8`, PEM)                                                          |
| `APPLE_DISTRIBUTION_P12` | base64 of a .p12 with the **Apple Distribution** certificate and its key (iOS and Mac)        |
| `APPLE_INSTALLER_P12`    | base64 of a .p12 with the **Mac Installer Distribution** certificate and its key (the `.pkg`) |
| `APPLE_P12_PASSWORD`     | the password of both .p12 (a trailing newline is ignored)                                     |

The certificates are the team's, shared with UwULock (they run out on 2027-10-06; renewing is
described in UwULock's docs/app-store.md). The profiles follow by themselves on the next run.

## What is left to click in App Store Connect

1. **Create the app record**: Apps → "+" → New App → platforms **iOS** and **macOS**, name
   "UwUMail", primary language, bundle ID **app.uwumail** (registered already), SKU e.g.
   `uwumail`, full access. Until it exists, the upload step fails with an error saying no app
   matches the bundle ID — everything before it (build, profile, signing) works already.
2. **TestFlight → Internal Testing**: make a group (e.g. "Ich"), add yourself, tick
   "Automatically distribute builds" — every processed build then shows up in the TestFlight app on
   iPhone, iPad and Mac.
3. **Export compliance**: answered in the build already (`ITSAppUsesNonExemptEncryption = false`
   on iOS and Mac: UwUMail only uses the encryption of TLS, as every mail app). If App Store
   Connect still asks: "None of the algorithms mentioned above".

## Later: publishing (not done now)

- **Store page** per platform: name "UwUMail", subtitle (e.g. "Cute mail for every mailbox"),
  description, keywords (100 characters), support URL (GitHub issues), marketing URL
  (<https://uwu.minifyx.de>), copyright "© 2026 MinifyX", category Productivity (secondary
  Utilities), privacy policy URL <https://uwu.minifyx.de/uwumail/privacy>.
- **App Privacy**: "Do you or your partners collect data?" → **No** ("Data Not Collected"): mail
  goes only between the device and the user's own servers, the AI assistant only to the provider
  the user set up and agreed to, nothing reaches the developer (matches `PrivacyInfo.xcprivacy`).
- **Age rating**: every answer "None"/"No" → 4+ (unrestricted web access: no; the app shows mail,
  not the web). **Price**: free. **Content rights**: no third-party content.
- **AI (guideline 5.1.2(i))**: the consent dialog names the provider and what is sent before the
  first send, per provider, revocable in Settings → AI assistant ([ai-assistant.md](ai-assistant.md)).
  Say so in the review notes.
- **Review notes and demo account**: App Review needs a mailbox to sign in to — a demo account on a
  UwUMail server (IMAP/JMAP) with a few mails, an invitation and a contact, plus the steps: "Add
  mailbox → e-mail … → password …". Mention that UwUMail is a client for the user's own mail
  accounts; the account lives on the user's mail server (account deletion, guideline 5.1.1(v):
  removing a mailbox in UwUMail deletes everything the app stored for it).
- **Screenshots** (PNG/JPEG, no transparency): iPhone 6.9" 1320×2868 (or 6.5" 1284×2778); iPad 13"
  2064×2752 (or 2048×2732) — needed because the app runs on iPad; Mac 16:10, one of 1280×800,
  1440×900, 2560×1600, 2880×1800.
- **Guidelines to keep in mind**: 2.5.2 (no downloading code — no updater in store builds), 2.5.4
  (background refresh only to look for mail), 4.8 (Sign in with Apple isn't needed: Microsoft and
  Google sign in to the user's own mailbox there, not to a UwUMail account), 5.1.1 (privacy policy).
- Google sign-in on iOS stays as it is (loopback redirect while iOS pauses the app; Gmail via app
  password) — mention it if App Review asks.

## Status (2026-10-06)

Both pipelines run through to the upload: the iPhone/iPad IPA (iPhone and iPad, privacy manifest,
background task declared) and the universal Mac `.pkg` are built, get their App Store profiles
from the API, are signed and packaged. The upload itself stops at
`Cannot determine the Apple ID from Bundle ID 'app.uwumail' and platform 'IOS'` (and `'MAC_OS'`):
App Store Connect has no app record for `app.uwumail` yet (step 1 under "What is left to click"). After creating it,
start Actions → iOS and Actions → Mac App Store → Run workflow → `main`.

## Not tried yet

No Mac and no iPhone were at hand while this was set up: the builds were made and signed on
GitHub's runners, but not started on a device. On the first TestFlight install:

- iPhone/iPad: add a mailbox, sign in with Microsoft, Face ID lock, notifications; leave the app
  in the background for a while and see whether new mail rings (Settings → General → Background
  App Refresh on); the iPad layout;
- Mac: the window comes up in the sandbox, signing in with Microsoft/Google comes back (loopback),
  an attachment can be attached and saved, "Make UwUMail the default" works and a `mailto:` link
  opens a draft, "Open at login" shows up under Login Items, no update settings anywhere.

---

# UwUMail im App Store (TestFlight)

UwUMail gibt es auf Apples Systemen zweimal. Die **GitHub-Builds** bleiben, wie sie sind: DMG
mit Setup für den Mac (aktualisiert sich selbst) und die unsignierte IPA zum Sideloaden aufs
iPhone. Die **App-Store-Builds** sind dieselbe App, vom Entwicklerteam signiert und zu App Store
Connect hochgeladen — eine App für iPhone, iPad und Mac (`app.uwumail`). Vorerst landen sie **nur
in TestFlight**: Zur Prüfung eingereicht ist nichts, und CI reicht nie etwas ein.

- **iPhone/iPad**: `ios.yml` → Job `testflight` (bei `v*`-Tags und per Run workflow) signiert die
  unsignierte IPA desselben Laufs mit Apple-Distribution-Zertifikat und App-Store-Profil und lädt
  sie hoch. Die App schaut per `BGAppRefreshTask` im Hintergrund nach neuer Mail und meldet sie
  mit lokalen Mitteilungen; wann, entscheidet iOS.
- **Mac**: `mas.yml` baut eine sandboxed Universal-App `app.uwumail` ohne Updater (Feature
  `store`), signiert sie auf einem frischen Runner, packt das `.pkg` und lädt es hoch.
  Standard-Mail-App und „Beim Anmelden öffnen“ stehen dort unter Einstellungen → Mail, weil es
  kein Setup gibt.
- **Version** `0.10.0-beta.2` → `0.10.0`; **Build-Nummer** = Laufnummer.Versuch des Workflows,
  pro Plattform steigend.
- **Bundle-ID** `app.uwumail` ist registriert (2026-10-06, über die API); das Profil holt bzw.
  erneuert `scripts/asc.mjs`. Die Zertifikate teilt sich das Team mit UwULock.
- **Datenschutz**: [PRIVACY.md](../PRIVACY.md), online unter
  <https://uwu.minifyx.de/uwumail/privacy>. KI-Funktionen fragen vor dem ersten Senden pro Anbieter
  ausdrücklich nach Zustimmung (widerrufbar unter Einstellungen → KI-Assistent).

**Noch zu klicken in App Store Connect:**

1. **App-Eintrag anlegen**: Apps → „+“ → Neue App → Plattformen **iOS** und **macOS**, Name
   „UwUMail“, Bundle-ID **app.uwumail**, SKU z. B. `uwumail`. Solange er fehlt, scheitert nur der
   Upload-Schritt (keine App zur Bundle-ID).
2. **TestFlight → Interne Tests**: Gruppe anlegen (z. B. „Ich“), dich hinzufügen, „Builds
   automatisch verteilen“ anhaken.
3. **Exportbestimmungen**: im Build beantwortet (`ITSAppUsesNonExemptEncryption = false`, nur TLS).

**Später, zum Veröffentlichen** (nicht jetzt): Store-Seite je Plattform, Datenschutz-URL und
„Keine Daten erfasst“, Altersfreigabe 4+, Prüfhinweise mit Demo-Postfach auf einem UwUMail-Server
und Hinweis auf die KI-Zustimmung, Screenshots (iPhone 6,9" 1320×2868, iPad 13" 2064×2752, Mac
2880×1800).
