# Release notes

One file per version, named after it: `0.2.0.json`, `0.2.0-beta.1.json`. The release workflow refuses to run
without it. The text appears under "What's new" in UwUMail's update hint and on the GitHub release page.

```json
{
  "de": "- Kurze, verständliche Punkte\n- Was Leute merken, nicht wie es gebaut ist",
  "en": "- Short, plain points\n- What people notice, not how it's built"
}
```

## Releasing a version

1. Set the version in `Cargo.toml` (workspace), `apps/desktop/src-tauri/tauri.conf.json`,
   `apps/setup/src-tauri/tauri.conf.json` and the `package.json` files.
2. Add `release-notes/<version>.json`.
3. Push the release commit to `main` and wait for the Android and iOS workflows of that commit (the release
   takes their APK and IPA).
4. Tag `v<version>` and push the tag. The release workflow does the rest: it builds the setups for Windows
   (x64 and ARM) and macOS (universal) and the Linux packages (x64 and arm64), tests each of them on a runner
   of its kind, signs what the updater downloads, and publishes them with the APK, the unsigned IPA and
   `SHA256SUMS.txt`. Then it updates the feeds and the AUR package `uwumail-bin` (once the
   `AUR_SSH_PRIVATE_KEY` secret exists; until then the job only leaves a notice). The files, all without the
   version in their name:
   - `UwUMail-windows-x64-setup.exe`, `UwUMail-windows-arm64-setup.exe`
   - `UwUMail-macos-universal.dmg`
   - `UwUMail-linux-x64.deb`, `UwUMail-linux-arm64.deb`, `UwUMail-linux-x64.rpm`, `UwUMail-linux-arm64.rpm`
   - `UwUMail-linux-x64-portable.tar.gz`, `UwUMail-linux-arm64-portable.tar.gz`
   - `UwUMail-android.apk`, `UwUMail-ios.ipa`
   - for the in-app updater only: `UwUMail-update-macos-universal`, `UwUMail-update-linux-x64.AppImage`

   Which file is for whom is in [docs/install.md](../docs/install.md). Installed apps check that an update's
   signature names the versioned file they expect (`UwUMail-Setup-<version>.exe`, ...), so the workflow signs
   a copy under that name and publishes the same bytes under the stable one (`scripts/release-feeds.mjs`).

If GitHub can't run the workflow, publish the Windows setup from a PC instead: with the tag checked out,
run `pnpm release`. That publishes Windows x64 only; ARM PCs, Macs and Linux PCs then skip this version. It needs the update signing key, either as `TAURI_SIGNING_PRIVATE_KEY` +
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` or as a folder with `uwumail-update.key` and `PASSWORT.txt` in
`UWUMAIL_UPDATE_KEY_DIR`. It waits until the release and the update feed are online and checks them.

Versions with a suffix (`-beta.1`) go to the Beta channel only; plain versions go to everyone.
