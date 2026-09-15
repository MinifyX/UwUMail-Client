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
3. Tag `v<version>` and push the tag. The release workflow does the rest.

If GitHub can't run the workflow, publish the Windows setup from a PC instead: with the tag checked out,
run `pnpm release`. It needs the update signing key, either as `TAURI_SIGNING_PRIVATE_KEY` +
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` or as a folder with `uwumail-update.key` and `PASSWORT.txt` in
`UWUMAIL_UPDATE_KEY_DIR`. It waits until the release and the update feed are online and checks them.

Versions with a suffix (`-beta.1`) go to the Beta channel only; plain versions go to everyone.
