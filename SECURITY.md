# Security

UwUMail is a hobby project that I build in my spare time, almost entirely with AI (Claude). Security reports are
very welcome and come first when I get to them, but I can't promise response times.

## Supported versions

Only the newest release gets security fixes: the latest stable version and the latest beta.
Installed apps update themselves; please keep updates on.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Instead, use GitHub's
[private vulnerability reporting](https://github.com/MinifyX/UwUMail-Client/security/advisories/new), or contact
me ([@MinifyX](https://github.com/MinifyX)) privately and ask for a secure channel.

Helpful to include:

- the UwUMail version and operating system (Windows, macOS, Linux or Android),
- what an attacker can achieve and what they need for it (for example "sending a mail" or "same Wi-Fi"),
- the smallest steps or sample mail that show it.

Please give me the chance to ship a fix before publishing details. Once it's out, I'm happy to credit you in the
release notes if you'd like.

## What counts

Especially interesting: anything a **received mail** can do beyond showing content (running code, reading files
or other mail, leaking the password, bypassing the image blocker or the attachment warning), weaknesses in sign-in
and TLS handling, anything that lets an update install something that isn't an official, signed UwUMail
release, and on Android anything another app can make UwUMail do or read, or a way past the app lock.

Out of scope: problems that need malware already running as the same user, missing code signing (known, see the
audit), and social engineering that doesn't involve a flaw in UwUMail.

## Audits

Both audits were done with Claude, not by an independent security firm.

- [September 2026 — 0.2.0-beta.1](docs/security-audit.md)
- [September 2026 — Android app and later changes](docs/security-audit.md#addendum--the-android-app-and-changes-after-020-beta1)
