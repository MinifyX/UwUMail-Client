# Contributing to UwUMail

Thanks for wanting to help! (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧

## Please read this first

UwUMail is a hobby project I build for myself, just for fun (see
[Why this exists](README.md#why-this-exists)). That means:

- Issues and pull requests are welcome, but I might answer late or not at all,
  and I may say no to things I don't need or don't want in the app. No hard
  feelings either way.
- Want UwUMail to go somewhere else? Fork it, that's what the license is for.
- Almost all of the code here is written with AI (Claude), so using AI for
  your contribution is fine too. Just make sure it builds and the checks pass.

## Ground rules

- Be kind. This project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
- Code, comments, docs and commit messages are in English.
- User-facing strings go through i18n (`apps/desktop/src/i18n/locales`) with
  both an English and a German entry. Read the tone rules in
  [docs/design.md](docs/design.md#tone-of-voice).
- New core features need a reason why they can't be an addon
  (see [docs/vision.md](docs/vision.md)).

## Commits

[Conventional Commits](https://www.conventionalcommits.org/):
`feat(sync): …`, `fix(ui): …`, `docs: …`, `chore(ci): …`.
Scopes: `ui`, `core`, `sync`, `smtp`, `store`, `addons`, `sdk`, `ci`, `brand`.

## Before you open a pull request

```bash
pnpm typecheck && pnpm lint && pnpm test
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

Security issues: please don't open a public issue, see [SECURITY.md](SECURITY.md).

## Licensing

By contributing you agree that your contribution is licensed under GPL-3.0
(app and core) or MIT (`packages/addon-sdk`), matching the files you change.
