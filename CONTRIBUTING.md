# Contributing to UwUMail

Thanks for wanting to help! (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧

## Ground rules

- Be kind. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
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

Security issues: please don't open a public issue. Email
security@uwumail.app (until that exists: the maintainer listed on GitHub).

## Licensing

By contributing you agree that your contribution is licensed under GPL-3.0
(app and core) or MIT (`packages/addon-sdk`), matching the files you change.
