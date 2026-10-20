# UwUMail in Google Play (internal testing)

[Deutsch weiter unten](#uwumail-in-google-play-interner-test)

The **GitHub APK** stays what it was: arm64, signed with UwUMail's release key in `android.yml`,
published with every release. The **Play build** is the same app (`app.uwumail`) as an Android App
Bundle for arm64 and x86_64 (phones, tablets, Chromebooks), uploaded to the Play Console's
**internal testing** track on every `v*` tag. Nothing goes beyond the internal track, and nothing
in CI ever sends a release to review or production.

Both are signed with the same key: Play App Signing uses UwUMail's own release key (certificate
SHA-256 `de1cd496…e301`), so the app from Play and an APK from GitHub update each other.

## How CI builds, signs and uploads

| Workflow → job      | Runs on                | What it does                                                                                                                                   |
| ------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `play.yml` → `apk`  | `v*` tags, Run workflow, PRs touching it | builds the unsigned App Bundle (`tauri android build --aab`, arm64 + x86_64), checks both ABIs are in it; no signing secret                    |
| `play.yml` → `play` | after `apk`            | on a fresh runner that builds nothing: signs the bundle with `jarsigner`, checks the certificate, keeps it as artifact `UwUMail-Play-<sha>` (14 days), uploads it with `scripts/play.mjs` |

`play.yml` runs beside the release and the Android workflow, not in them: a problem with Play
never holds up a GitHub release. The `apk` job (named like android.yml's, same cache key) reads the
Rust and Gradle caches main saves, so only x86_64 and UwUMail itself compile again. Pushes to main
don't run it.

- **versionCode**: `10⁹ + major·10⁸ + minor·10⁶ + patch·10⁴ + n`, the same for the GitHub APK
  and the Play build (`node scripts/play.mjs version-code [--apk] <run>`); betas count as their
  version (`0.11.0-beta.4` → `0.11.0`).

  | Build                    | n                                          | 0.11.0, run 5   |
  | ------------------------ | ------------------------------------------ | --------------- |
  | GitHub APK (android.yml) | run number 1…7999, then from 1 again       | `1 011 000 005` |
  | Play (play.yml)          | 8000 + run number (1…1999)                 | `1 011 008 005` |

  So a Play build is always above every APK of its version and below every build of the next
  one, and the two update each other. Minor and patch go up to 99; the largest code, 10.99.99,
  is `2 099 999 999`, under Play's limit of 2 100 000 000 (and Android's int maximum). The base
  10⁹ lies above everything the old scheme (`major·10⁹ + minor·10⁷ + patch·10⁵ + run`) gave out,
  up to `110 050 002` (0.11.0-beta.4, internal testing), so no code ever sinks.
  Run numbers count for the whole repository, not per version. android.yml runs on every push to
  main (about 1200 a year in 2026), so its n wraps after 7999 instead of failing CI: only a
  version that is current right at the wrap gets one APK build below the previous one (fixed by
  its Play build or the next version). play.yml runs only on tags, Run workflow and PRs touching
  it; its run number 2000 is decades away, and from there `version-code` fails loudly (then move
  play.yml to a new workflow file, which counts from 1, or raise the base).
  Before uploading, `scripts/play.mjs` checks the new code is above every one Play has seen and
  stops otherwise. A re-run of only the `play` job reuses the bundle and its code; Play refuses it
  once that code is in.
- **What's new**: from `release-notes/<version>.json`, German for every `de-*` language of the
  store listing and English for every `en-*`, cut to Play's 500 characters at a line break.
- **Release status**: `completed` (testers get it right away). While the app is still a draft in
  the Play Console, Google only takes draft releases; the script then makes a draft release and
  leaves a notice. Roll it out by hand in that case.
- **Seeing the tracks**: `node scripts/play.mjs tracks` lists every track with its releases (with
  `PLAY_SERVICE_ACCOUNT_PATH` pointing to the service account's JSON key).

Starting an upload by hand: Actions → **Google Play** → Run workflow. Run from a tag, it uploads
that release. Run from `main`, an unreleased commit goes to the internal testers, signed with the
release key (Play needs the upload key; the JAR signature of a bundle isn't what devices install,
Play signs the APKs it delivers itself).

### Secrets (MinifyX/UwUMail-Client)

| Secret                               | Content                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `UWUMAIL_ANDROID_KEYSTORE_BASE64`    | the release keystore (PKCS12, alias `uwumail`), as for the APK                  |
| `UWUMAIL_ANDROID_KEYSTORE_PASSWORD`  | its password                                                                    |
| `UWUMAIL_PLAY_SERVICE_ACCOUNT_JSON`  | the Google Cloud service account's JSON key (see below)                         |

Without `UWUMAIL_PLAY_SERVICE_ACCOUNT_JSON` the `play` job still signs and keeps the bundle, and
only leaves a notice instead of uploading.

## Setting it up once in the Play Console

1. **Create the app**: Play Console → Create app → name "UwUMail", app, free. The package name
   comes with the first bundle: `app.uwumail`.
2. **Play App Signing with UwUMail's own key**, before the first upload (it can't be changed
   later): Test and release → App integrity → Play app signing → *Choose signing key* → **Use
   existing app signing key from Java keystore**. Download `pepk.jar` and the encryption key the
   page offers, then, with the release keystore at hand:

   ```bash
   java -jar pepk.jar --keystore=uwumail-android.p12 --alias=uwumail --output=uwumail-pepk.zip --include-cert --rsa-aes-encryption --encryption-key-path=encryption_public_key.pem
   ```

   Upload `uwumail-pepk.zip`. The **upload key** is the same key: CI signs with it. Delete the zip
   afterwards.
3. **First bundle by hand**: Google only lets the API upload once a bundle exists. Actions →
   Google Play → Run workflow (from the newest tag), download the artifact `UwUMail-Play-<sha>`,
   then Test and release → Testing → **Internal testing** → Create new release → upload the
   `.aab`. Under *Testers*, make an email list (e.g. "Ich") with your Google account and open the
   opt-in link on the phone.
4. **Service account**: in Google Cloud (any project, e.g. "uwumail-play") enable the **Google Play
   Android Developer API**, create a service account (no roles), and under Keys → Add key → JSON
   download its key. In the Play Console → Users and permissions → Invite new users, invite the
   service account's address, app permission for UwUMail: **Release apps to testing tracks** and
   **View app information**. Then:

   ```bash
   gh secret set UWUMAIL_PLAY_SERVICE_ACCOUNT_JSON -R MinifyX/UwUMail-Client < uwumail-play.json
   ```

   and delete the JSON file. From the next tag on, every release lands in internal testing.
5. **For the internal track** Google wants, before testers see a build: the store listing basics
   (app details, privacy policy <https://uwu.minifyx.de/uwumail/privacy>), Data safety ("no data
   collected or shared": mail only goes between the device and the user's servers, the AI assistant
   only to the provider the user set up), content rating questionnaire, target audience (18+),
   "contains ads: no".

## Later: beyond internal testing (not done now)

Closed or open testing, then production, need Google's review, screenshots (phone, 7" and 10"
tablet, Chromebook), a feature graphic of 1024×500, and for a new personal developer account 12
testers for 14 days in closed testing first. The track is one variable in `play.yml`
(`PLAY_TRACK`).

## Status (2026-10-20)

`play.yml` and `scripts/play.mjs` are in; the App Bundle, its signing and the upload haven't run on
GitHub yet. Steps 1–5 above are still to be clicked; until the secret exists, tags only produce
the signed bundle as an artifact.

---

# UwUMail in Google Play (interner Test)

Die **GitHub-APK** bleibt, wie sie ist (arm64, `android.yml`, bei jedem Release). Der
**Play-Build** ist dieselbe App `app.uwumail` als App Bundle für arm64 und x86_64. Bei jedem
`v*`-Tag landet er im Track **Interner Test** der Play Console, weiter nicht; CI reicht nichts zur
Prüfung oder Produktion ein. Play App Signing nutzt UwUMails eigenen Release-Key, deshalb
aktualisieren sich Play-App und GitHub-APK gegenseitig.

- **`play.yml`**: Job `apk` baut das unsignierte Bundle (liest den Cache von main), Job `play`
  signiert es auf einem frischen Runner mit `jarsigner`, prüft das Zertifikat, legt es als
  Artefakt `UwUMail-Play-<sha>` ab und lädt es mit `scripts/play.mjs` hoch. Läuft neben dem
  Release, hält ihn also nie auf.
- **versionCode** = `10⁹ + Major·10⁸ + Minor·10⁶ + Patch·10⁴ + n`, für APK und Play gleich:
  APK n = Laufnummer von `android.yml` (1…7999, danach wieder ab 1), Play n = 8000 + Laufnummer
  von `play.yml` (1…1999). Damit liegt der Play-Build immer über jeder APK derselben Version und
  unter der nächsten Version; Minor/Patch bis 99, höchster Code (10.99.99) `2 099 999 999` unter
  Plays Grenze. Die Basis 10⁹ liegt über allem aus dem alten Schema (bis `110 050 002`). Das
  Skript bricht ab, wenn der Code nicht über allen bisherigen liegt.
- **Neuigkeiten** aus `release-notes/<version>.json` (de/en, auf 500 Zeichen gekürzt).
- **Status** `completed`; solange die App in der Console noch ein Entwurf ist, legt das Skript den
  Release als Entwurf an.
- **Secret** `UWUMAIL_PLAY_SERVICE_ACCOUNT_JSON` (JSON-Schlüssel des Dienstkontos). Ohne ihn wird
  nur signiert und das Artefakt abgelegt.

**Einmal zu klicken:** App anlegen → vor dem ersten Upload Play App Signing mit dem vorhandenen
Schlüssel (PEPK, Befehl oben; Upload-Key = derselbe Schlüssel) → erstes Bundle aus dem Artefakt
von Hand in „Interner Test“ hochladen und Tester-Liste anlegen → Dienstkonto in Google Cloud
(Google Play Android Developer API, JSON-Schlüssel), in der Play Console mit „Apps in Test-Tracks
veröffentlichen“ und „App-Informationen ansehen“ einladen, Schlüssel als Secret setzen →
Store-Grunddaten, Datensicherheit, Einstufung, Zielgruppe ausfüllen.
