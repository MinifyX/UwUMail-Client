# UwUMail-Client

Tauri-2-Mailclient (Desktop, Android, iOS) mit eigener Mail-Engine; Plan: `docs/roadmap.md`, Aufbau: `docs/architecture.md`.

## Layout
- `crates/uwumail-core`: Mail-Engine (IMAP/SMTP/JMAP, Cache, Sync, Kontakte, Einladungen)
- `crates/uwumail-android`, `crates/uwumail-ocr`: Android-Anbindung, OCR
- `crates/uwumail-tnef`, `crates/uwumail-labels`: byte-identische Kopien aus UwUMail-Server, hier nicht ändern, sondern im Server ändern und neu kopieren; keine Abhängigkeit auf andere uwumail-Crates
- `apps/desktop` (UI `src/`, Shell `src-tauri/`) und `apps/setup` (Windows-Setup, `pnpm build:setup`): React/Vite/Vitest, pnpm-Workspace
- `dev/stalwart.sh`: Stalwart-Testserver für den JMAP-Integrationstest; `packaging/`: AUR und Android; `scripts/`: Release-, Store- und Smoke-Skripte

## Befehle
- Zusätzlich zu den CI-Befehlen aus `~/Projects/CLAUDE.md`: `pnpm format:check` (Root, Prettier mit Tailwind-Plugin) und `node --test "scripts/*.test.mjs"`
- Zweiter clippy-Lauf (MAS-Variante): `cargo clippy -p uwumail-desktop --no-default-features --features store --locked -- -D warnings`
- JMAP-Test: `dev/stalwart.sh`, dann `UWUMAIL_TEST_JMAP=http://127.0.0.1:8080 cargo test -p uwumail-core --test integration stalwart::`
- Gezielt: `pnpm --filter @uwumail/desktop test` bzw. `cargo test -p uwumail-core <filter>`
- Tauri-Crates (`apps/*/src-tauri`) nur per Docker prüfen, nicht auf diesem Host

## Fallen
- `apps/desktop/src-tauri/gen/android` ist generiert; `dist/` nie von Hand ändern
- Gemeinsame UI kommt aus `@uwusuite/design` (Release-Tarball, Integrity im Lockfile), dort ändern und Version anheben, hier nichts nachbauen
- Eigene Tauri-Configs je Plattform (`tauri.{macos,mas,ios,android}.conf.json`) bei Config-Änderungen mitpflegen
- Android-versionCode wird aus der Version berechnet (`docs/play-store.md`)

## Stand
- Änderungshistorie: `release-notes/<version>.json` (de/en), kein CHANGELOG; Hinweis für den nächsten Release steht in `release-notes/README.md`
- Plattformdoku: `docs/ios.md`, `docs/app-store.md`, `docs/play-store.md`, `docs/oauth.md`

## Release
- Workspace-Version in `Cargo.toml` anheben, `release-notes/<version>.json` anlegen (Workflow bricht ohne ab), Tag `v<version>`; Workflows: `release.yml`, `android.yml`, `ios.yml`, `mas.yml`, `play.yml`
- Windows-Setup lokal: `pnpm release` (`scripts/release.mjs`, braucht sauberen Tree mit gepushtem Tag und Signing-Key)

## Security
- Kritische Pfade: `crates/uwumail-tnef` (Parser), `crates/uwumail-core` (IMAP/SMTP/JMAP, OAuth, HTML-Sanitizing, Keystore), `crates/uwumail-ocr`, Mail-Frame und Tauri-Commands/Capabilities in `apps/desktop/src-tauri`
- Vor jedem Feature-Release den globalen Subagent `security-reviewer` über den Bereich seit dem letzten Tag laufen lassen; Ergebnis nach `docs/security-audit-<datum>.md` (Schema der vorhandenen Berichte)
