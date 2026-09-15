# UwUMail update feeds

Installed UwUMail apps look here for new versions. The release workflow
(`.github/workflows/release.yml` on `main`) writes these files; don't edit them by hand.

- `stable.json`, `beta.json`: Windows (Tauri updater format, signed setup)
- `android-stable.json`, `android-beta.json`: Android (APK with its SHA-256)

Versions with a suffix like `-beta.1` only go to the Beta feeds.
