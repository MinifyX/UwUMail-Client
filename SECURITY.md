# Security

## Supported versions

UwUMail is young, so only the newest release gets security fixes: the latest stable version and the latest beta.
Installed apps update themselves; please keep updates on.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Instead, use GitHub's
[private vulnerability reporting](https://github.com/MinifyX/UwUMail-Client/security/advisories/new), or contact
the maintainer [@MinifyX](https://github.com/MinifyX) privately and ask for a secure channel.

Helpful to include:

- the UwUMail version and operating system,
- what an attacker can achieve and what they need for it (for example "sending a mail" or "same Wi-Fi"),
- the smallest steps or sample mail that show it.

Once a fix is released, we're happy to credit you in the release notes if you'd like.

## What counts

Especially interesting: anything a **received mail** can do beyond showing content (running code, reading files
or other mail, leaking the password, bypassing the image blocker or the attachment warning), weaknesses in sign-in
and TLS handling, and anything that lets an update install something that isn't an official, signed UwUMail
release.

Out of scope: problems that need malware already running as the same user, missing code signing (known, see the
audit), and social engineering that doesn't involve a flaw in UwUMail.

## Audits

- [September 2026 — 0.2.0-beta.1](docs/security-audit.md)
