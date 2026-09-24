# Prompt: Ausführlicher Sicherheitstest – UwUMail (Client, Server, Gateway, Release-Kette)

> Für Claude Code. Am besten in einem Ordner starten, in dem alle vier Repos nebeneinander liegen:
> `UwUMail` (Client), `UwUMail-android` (Worktree des Clients), `UwUMail-Server`,
> `UwUMail-Server-gateway` (Worktree des Servers, enthält Gateway + Tunnel).

---

Du bist ein erfahrener Security-Engineer und führst einen **ausführlichen, praktischen Sicherheitstest** für das gesamte UwUMail-Ökosystem durch. Ich bin der Eigentümer aller Repos und der Test-Infrastruktur und autorisiere den Test ausdrücklich für die unten genannten Ziele.

## 0. Rahmen und Regeln

**Ziele (in Scope):**

1. **Client** `UwUMail`: `crates/uwumail-core`, `crates/uwumail-android`, `apps/desktop` (React-UI + `src-tauri`), Android-Kotlin unter `src-tauri/gen/android`, `apps/setup` (Installer/Updater/Uninstaller), `packages/addon-sdk`, `addons/`. Der Worktree `UwUMail-android` gehört zur selben Codebasis — nur zusätzlich anschauen, falls er von `main` abweicht (`git -C UwUMail-android status`, `git log --oneline -20`).
2. **Server** `UwUMail-Server`: `crates/uwumail-smtp` (Empfang/Submission/Queue/DKIM/SPF/DMARC/MTA-STS/SRS/Forwarding/DSN), `uwumail-jmap` (JMAP + Methoden + Auth + Blob + Push), `uwumail-web` (JSON-API, Login, 2FA/WebAuthn, Sessions, Admin, Routes), `uwumail-store` (SQLite + Blobs + Migrationen + `security.rs` + `directory.rs`), `uwumail-server` (Config, TLS, ACME, HTTP, CLI), `web/` (React-Portal), `docker/`.
3. **Gateway** (im Worktree `UwUMail-Server-gateway`): `crates/uwumail-gateway` (VPS-Programm), `crates/uwumail-tunnel` (QUIC-Tunnel, Pairing-Code, Zertifikats-Pinning), `deploy/gateway` (systemd-Unit, `install.sh`, `gateway.toml`).
4. **Build- und Release-Kette** aller Repos: `.github/workflows/*`, `scripts/*` (`release*.mjs`, `deploy-gateway.sh`, `live-check.mjs`, `seed.sh`, `smoke.mjs`), Update-Feeds des Clients (`updates`-Branch, altes `MinifyX/UwUMail-Releases`), Container-Image (`docker/`), Signierung (minisign beim Client, Android-Keystore), `.gitleaks.toml`.
5. Abhängigkeiten (Cargo, pnpm, Gradle).

**Regeln:**

- **Aktive Tests nur gegen lokale Instanzen.** Client: `dev/mailserver.compose.yml` (GreenMail), `dev/stalwart.sh` (Stalwart). Server: `dev/compose.yaml` (startet zwei Server `a.test`/`b.test`, dann `dev/seed.sh` + `dev/smoke.mjs`). Gateway: lokal gegen einen lokalen Server pairen. Keine Angriffe auf Microsoft, Google, GitHub, Let's Encrypt, Cloudflare, Spamhaus, Port25-Verifier, Thunderbird-ISPDB oder irgendeine fremde Domain. Kein Versand echter Mail nach außen. Produktivsysteme (die Test-Instanz für meine echte Domain) nur nach ausdrücklicher Rückfrage.
- Keine echten Secrets anfassen, ausgeben oder committen. Gefundene Secrets nur mit Pfad + erste 4 Zeichen melden.
- Nichts pushen, keine Releases, keine Änderungen an Release-Branches, kein `deploy-gateway.sh` gegen echte VPS.
- Fixes erst nach dem Bericht und nur nach meiner Freigabe – dann jeweils mit Regressionstest.
- **Lies zuerst die vorhandene Doku und die bisherigen Audits**, sie sind dein Ausgangspunkt und deine Regressionsliste:
  - Client: `SECURITY.md`, `docs/security-audit.md` (inkl. Android-Addendum), `docs/architecture.md`, `docs/addons.md`, `docs/oauth.md`.
  - Server: `SECURITY.md`, `docs/security-audit.md`, `docs/architecture.md`, `docs/deployment.md`, `docs/configuration.md`.
  - Gateway: `docs/gateway.md`.
  Die dort dokumentierten Findings sind **Regressionsziele** — prüfe aktiv, ob jeder Fix noch greift und nicht umgehbar ist:
  - Client: H1–H3, M1–M8, L1–L10 sowie Android AM1–AM4, AL1–AL8.
  - Server: M1 (zweiter `From`/`Sender` bei Submission), M2 (Forwarding-Bestätigungs-Spam) und alle unter „What was checked and held up" genannten Schutzmaßnahmen.
  Die akzeptierten Risiken (Client I1–I11, AI1–AI8; Server „Known limits") nur neu bewerten, wenn sich die Lage geändert hat.

## 1. Vorgehen

1. **Recon:** pro Repo Architektur, Angriffsflächen und Vertrauensgrenzen auflisten. Grenzen: Mail-Inhalt → Parser → Sanitizer → WebView; WebView → Tauri-Commands; andere Android-Apps → Intents; anonymer Absender/Port 25 → SMTP-Session → Store; authentifizierter Nutzer → JMAP/Web-API → fremde Daten; Netzwerk → TLS/STARTTLS; Update-Feed → Updater; VPS/Gateway → Home-Server über QUIC; CI → Artefakte/Image.
2. **Threat Model je Komponente** (Angreifer: Mail-Absender, Netzwerk, bösartiger/kompromittierter Server, andere App auf dem Phone, Person mit entsperrtem Gerät, Supply Chain; beim Server zusätzlich anonymer Internet-Client und authentifizierter Nutzer gegen andere Nutzer/Admin; beim Gateway zusätzlich der kompromittierte VPS gegen den Home-Server).
3. **Statische Analyse:** manuelles Review der kritischen Pfade + Tools: `cargo audit`, `cargo deny` (falls verfügbar), `cargo clippy --all-targets -D warnings`, `pnpm audit --prod`, `eslint`, `semgrep` (Rust/TS/Kotlin-Regeln), `gitleaks` über die **gesamte Git-Historie** jedes Repos, `actionlint`/`zizmor` für Workflows, `hadolint` + `trivy` für die Container-/Dockerfiles.
4. **Dynamische Tests:** lokale Instanzen hochfahren, bösartige Test-Mails und -Requests bauen, gezielte Unit-/Integrationstests und Fuzzer schreiben (`cargo fuzz` für MIME-, IMAP-Antwort-, JMAP-JSON-, SMTP-Command/DATA-, Autoconfig-XML-, Tunnel-Frame-Parser).
5. **Bewerten, berichten, erst dann fixen.**

## 2. Client (`UwUMail`)

### 2.1 Bösartige eingehende Mail (Hauptangreifer)
- HTML-Sanitizing (`mime.rs`, ammonia-Allowlist): XSS über SVG, MathML, `<style>`/CSS (`url()`, `@import`, `expression`), `srcset`, `background`, `formaction`, Namespace-Tricks, kaputtes/verschachteltes HTML, Zeichensatz-Tricks (UTF-7, ISO-2022-JP), mXSS; Wrapper-vor-Sanitizing (L5).
- Iframe-Sandbox und CSP: Umgehung des Remote-Image-Blockers (CSS, `<link>`, Fonts, `meta refresh`, DNS-Prefetch), Tracking-Pixel; `cid:` → Blob-URL: kann eine Mail Anhänge anderer Mails referenzieren?
- Quoted HTML in Antwort/Weiterleitung (`lib/safeHtml.ts`, M2) — Ausbruch in die App-Seite.
- Header-Injection: CRLF in Namen, Betreff, Message-ID, References, `List-Unsubscribe` (L1); Bcc-Leaks in Antworten.
- `List-Unsubscribe`/One-Click-POST: SSRF ins lokale Netz, DNS-Rebinding, IDN/Punycode, Redirects (nur HTTPS + public domain?).
- Absenderbilder/BIMI (`pictures.rs`): SSRF, DNS-Rebinding (I6, L7), SVG-Inhalt, Größen-/Zeit-/Domainlimits.
- Links (`lib/links.ts`): Schemes (`javascript:`, `file:`, `ms-*:`, `tauri:`, `intent:`), Unicode/Homographen, Text≠Ziel-Warnung umgehbar (M6, L3)?
- Anhänge: Dateityp-Tarnung (H1), gefährliche Endungen inkl. RTL-Override/Trailing-Dots (L4, AL6), APK-Sonderfall (AM3), ADS (`name.txt:stream`), Pfad-Traversal im Dateinamen und über die Message-ID im Cache-Pfad `<app data>/attachments/<message id>/`.
- Parser-DoS: tief verschachteltes MIME, riesige Header, Zip-Bomben-Encodings, zyklische References beim Threading, FTS5-Query-Injection in der Suche.

### 2.2 WebView ↔ Rust-Brücke
- Alle Tauri-Commands in `src-tauri/src/lib.rs` inventarisieren: Eingabevalidierung, Pfade, `capabilities/*.json`-Scope, Asset-Protocol-Scope.
- Annahme „Skript in der App-Seite hat vollen Zugriff" (I10): H2 (Save-Path), H3 (beliebige Datei anhängen), M1 (native Gefahr-Warnung) auf Umgehungen prüfen.
- CSP der App-Seite, eingefrorener Prototyp, `postMessage`-Handler (Origin-Checks).
- Local-Storage-Einstellungen (`uwumail.settings`): kann eine manipulierte Einstellung Sicherheitsfunktionen abschalten (z. B. die „Always load"-Liste)?

### 2.3 Netzwerk, TLS, Anmeldung
- TLS überall erzwungen? STARTTLS-Stripping (IMAP/SMTP), Downgrade bei Fehlern, Zertifikats-/Hostname-Prüfung, `uwumail_core::tls` auf Android (AI1).
- Autoconfig/SRV/MX/ISPDB (`autoconfig.rs`, L8): gefälschte Antworten, die das Passwort an einen fremden Host lenken; JMAP-Discovery-Fallbacks; die Logik „announced API address unreachable → Origin der Session-URL" (könnte ein Server so das Ziel umlenken?).
- JMAP: Credential-Weitergabe bei Redirects (M5), Basic→Bearer-Fallback, EventSource, Blob-Downloads, Größenlimits.
- OAuth (`oauth.rs`): PKCE, `state`, Loopback-Listener (Port-Hijacking, L2), Deeplink `app.uwumail://oauth` auf Android, Token-Speicherung, kein Logging von Codes/Tokens.
- Secrets nie in DB, Logs, Crash-Reports, Local Storage oder UI-Fehlermeldungen.
- **Bösartiger Server gegen den Client:** manipulierte IMAP-Literal-Längen, UIDs, Ordnernamen (Pfad-/Steuerzeichen), IMAP-Command-Injection über Suche (AL7) und Ordnernamen, riesige JMAP-Antworten.

### 2.4 Lokale Daten und Senden
- SQLite: Injection, Migrationen, Dateiberechtigungen (I1).
- Drafts, Outbox, Undo-Send (`DELETE … RETURNING`): Races, doppelter Versand, Bcc-Leak im Draft.
- Absender-/Identitätsprüfung: Senden mit fremder From-Adresse möglich? Signatur-`data:`-Bilder → `multipart/related` (Injection über `data-uwu-signature`). Blocked Senders / Spam umgehbar?

### 2.5 Android
- Exportierte Activities/Services/Receiver/Provider im Manifest, Intent-Filter, `mailto:`/Share-Intents (AM2, AL4, AL5), FileProvider-Pfade, PendingIntents (mutable?).
- JNI-Brücke `UwuBridge`/`UwuNative`: Eingabevalidierung in beide Richtungen.
- App-Lock (AM1, AL1–AL3): Umgehung über Dialoge, Notifications, Deeplinks, Recents, Rotation/Prozess-Neustart, `RelaunchActivity`.
- Keystore-Nutzung (AI2), `allowBackup`/Data-Extraction-Rules, `usesCleartextTraffic`, Network-Security-Config, WebView-Settings (`setAllowFileAccess` etc.), Logcat-Leaks; APK-Handling und Downloads (AM3).
- Tools lokal auf dem gebauten APK: `apktool`, `jadx`, MobSF; optional `adb`-Intents im Emulator.

### 2.6 Windows-Installer und Updater
- `apps/setup`, `updates.rs`, `install.rs`: minisign-Prüfung inkl. TOCTOU zwischen Prüfung und Start (I4), Downgrade (M4), `pending.json` (M3), Feed-Parsing, Pfade/Version aus dem Feed, Zip/zstd-Entpacken (Traversal), DLL-Hijacking (M7), `--update --relaunch --wait-pid`-Argumente, `UWUMAIL_SETUP_SANDBOX` in Release-Builds deaktiviert?, Registry (`mailto`-Handler: Argument-Injection über `mailto:`-URL), Uninstaller aus Temp-Kopie.

### 2.7 Addon-System
- `packages/addon-sdk` und Host (`apps/desktop/src/addons`): Sandbox-Iframe mit opaquem Origin, `postMessage`-RPC, Permission-Checks im Host, `hosts`-Wildcards, `uwu.net.fetch`-SSRF, Manifest-Parsing, `.uwuaddon`-Zip (Traversal/Größen), Rechteeskalation bei Updates, Zugriff auf die Tauri-IPC-Brücke aus Frames (AI5, I11).

## 3. Server (`UwUMail-Server`)

### 3.1 SMTP-Empfang & Submission (`uwumail-smtp`)
- **Relay:** Port 25 lehnt Nicht-lokale ab; Submission verlangt Login und nur eigene Adressen. Adress-Tricks (Source-Routes, quoted locals, `%`-Hack, trailing dots, IP-Literale) prüfen — Regression zu „held up".
- **Absender-Spoofing (M1):** genau ein `From`, jedes `From`/`Sender` gegen `claimed_addresses`. Weitere Header-Kombis testen (doppelter `Sender`, `Resent-*`, adress-gruppen-Syntax, RFC-2047-encodete Adressen, Kommentare/Whitespace in Adressen).
- **SMTP-Smuggling & STARTTLS-Injection:** `smtp-proto`/`inbound.rs` mit `<LF>.<CR><LF>`, bare `<CR>`, BDAT-Chunking, Pipelining vor STARTTLS.
- **SPF/DKIM/DMARC (`checks.rs`, `dnscheck.rs`):** `enforce_dmarc_reject`, `trusted_relays`-Vertrauen (Received-Header-Parsing — kann ein Absender einen `trusted_relay` vortäuschen?), `Authentication-Results`-Stripping (nur eigener Hostname? Groß-/Kleinschreibung, Whitespace, gefälschter Hostname).
- **SRS & Forwarding (`srs.rs`, `forward.rs`):** HMAC-Konstantzeit, 21-Tage-Fenster, Annahme nur mit leerem Sender auf Port 25, Loop-Schutz (`Delivered-To`), kein Forward von Junk/Quarantäne, Bestätigungs-Spam-Throttle (M2).
- **Outbound/Queue (`outbound.rs`, `client.rs`, `queue.rs`):** Lease/Claim-Races, `max_lifetime`, MTA-STS-Enforcement (`mta_sts.rs`, `https.rs`) — SSRF beim Policy-Fetch, Cache-Poisoning, Zertifikatsprüfung; `delivery.routes`/Relay (Passwort-Handling).
- **Reports (`reports.rs`):** DMARC-/TLS-Report-Parser (XML/Zip/Gzip) — Zip-Bomben, XXE, Größenkappung, Zuordnung zur richtigen Domain, keine Ablage im Postfach.
- **DSN (`dsn.rs`):** Backscatter, Header-Injection in Bounce-Texte.
- Limits (`limiter.rs`, `max_message_size`, `max_recipients`, `max_connections`, `timeout`).

### 3.2 JMAP (`uwumail-jmap`)
- **Autorisierung / IDOR:** IDs sind Typbuchstabe + DB-Id (`m12`, `e34`, `t56`) und Blob-Hashes — kann ein Nutzer über geratene/fremde IDs auf fremde Mailboxen, Emails, Blobs (`b<sha>`, `p<sha>_<part>`), Identities oder Threads zugreifen? (`auth.rs`, `ids.rs`, `blob.rs`, alle `methods/*`).
- **Auth:** Basic→App-Password/Token, Scopes („mail"/„smtp"), Login-Cache-Invalidierung bei Credential-Wechsel, Throttle pro Netz (/64 bei IPv6).
- **Method-Chaining/Result-References, `Blob/upload`-Limits, `EmailSubmission/set` → `Smtp::submit`** (dieselben Sender-Checks wie SMTP?), Push/EventSource-Ressourcenverbrauch, JSON-DoS.

### 3.3 Web-Portal & API (`uwumail-web`, `web/`)
- **Sessions/CSRF:** `__Host-`/`Secure`/`HttpOnly`/`SameSite=Strict`, nur Hash gespeichert, `X-CSRF-Token` bei State-Changes, Re-Auth-Fenster (10 min) für sensible Änderungen.
- **2FA/WebAuthn (`webauthn.rs`):** Origin-/RP-ID-/Challenge-Prüfung (konstantzeit), Presence, Signatur, rückwärtslaufender Counter; TOTP (`security.rs`): einmalige Nutzung, Fensterbreite, Recovery-Codes (SHA-256, einmalig).
- **Access Control:** Admin-Routes nur mit Admin-Session (`routes/admin.rs`, `routes/security.rs`, `routes/domains.rs`, `routes/reports.rs`); Nutzer erreicht nur eigene Daten (`routes/account.rs`, `routes/mailbox.rs`, `routes/people.rs`, `routes/own.rs`). Mass Assignment, Parameter-Tampering.
- **OWASP:** Injection (SQL in `uwumail-store`), XSS im Portal, SSRF (Cloudflare-DNS-API `cloudflare.rs`, Health-/Delivery-Probes `health.rs`, ACME), Path-Traversal (Asset-Allow-List `assets.rs`), Security-Header/CSP, `trusted_proxies`/X-Forwarded-For-Spoofing (Login-Throttle aushebeln).
- **Setup (`routes/setup.rs`, `login.rs`):** Setup-Code (~59 bit) nur solange kein Admin, Throttle, keine Reaktivierung; Cloudflare-Token wird nicht gespeichert.

### 3.4 Storage (`uwumail-store`)
- SQL-Injection/Query-Bau (`query.rs`, `mutate.rs`, `mail.rs`), Migrationen (`migrations/*`), Blob-Refcounting/Trigger (`blobs.rs`), Passwort-Hashing (`password.rs`: Argon2id Hauptpasswort, SHA-256 App-Passwörter ~79 bit), `security.rs` (Auth-Kernlogik) und `directory.rs` (Accounts/Adressen) gezielt reviewen, Quota/Disk (`health.rs`).

### 3.5 Server-Binary & Container (`uwumail-server`, `docker/`, `compose.yaml`)
- Config-Overlay-Reihenfolge (Panel < File < Env), gelockte Keys, Relay-Passwort in DB vs. Env.
- ACME (`acme.rs`), TLS-Reload (`tls.rs`), self-signed-Fallback, HSTS nur mit echtem Zert.
- Container: distroless, uid 10001, read-only rootfs, `cap_drop: ALL` + nur `NET_BIND_SERVICE`, kein Image-Signing (bekannt) — prüfen, dass die Hardening-Claims stimmen; Dockerfile mit `hadolint`, Image mit `trivy`.

## 4. Gateway & Tunnel (`UwUMail-Server-gateway`)

Das Bedrohungsmodell hier ist speziell: **der VPS ist teils nicht vertrauenswürdig** (siehe `gateway.md` „Trust the VPS like the server").

- **Pairing/Code (`uwumail-tunnel/src/code.rs`, `identity.rs`, `verify.rs`):** One-Time-Token wirklich einmalig? Entropie des Codes, Zertifikats-Fingerprint-Pinning auf beiden Seiten, Downgrade/Verwechslung, Re-Pairing/`unpair`, was passiert bei falschem/abgelaufenem Token.
- **QUIC-Tunnel (`quic.rs`, `proto.rs`, `stream.rs`, `net.rs`, `client.rs`):** Frame-/Protokoll-Parser fuzzen, Stream-Multiplexing-Grenzen, injizierte/gefälschte Client-Adressen (der Gateway reicht die Client-IP an den Home-Server — kann der VPS beliebige IPs vortäuschen, um Login-Limits/SPF/Logs zu verfälschen? Das ist ein akzeptiertes Rest­risiko — bestätigen, dass nicht mehr geht, z. B. Auth-Bypass).
- **Gateway-Programm (`uwumail-gateway/src/*`):** `public.rs`/`outbound.rs` — Gateway darf ausgehend **nur** zu Mail-Ports (25/465/587) öffentlicher Adressen verbinden (kein offener SSRF-Proxy ins Internet oder in VPS-interne/private Netze); `limits.rs`/`state.rs` Ressourcen- und Verbindungslimits; `421`-Verhalten bei getrenntem Home-Server; TLS endet zu Hause, der Gateway sieht keine Passwörter — verifizieren, dass wirklich nur Bytes durchgereicht werden (kein STARTTLS-Terminieren auf dem VPS).
- **Deploy (`deploy/gateway/install.sh`, `.service`, `gateway.toml`, `scripts/deploy-gateway.sh`):** systemd-Härtung (User `uwumail-gateway`, Capabilities, `ProtectSystem`, `NoNewPrivileges` etc.), SSH-Deploy-Skript (Command-Injection über Variablen, Integrität des kopierten Binaries), Dateirechte unter `/var/lib`/`/etc`.

## 5. Supply Chain & CI (alle Repos)
- Workflows: gepinnte SHAs, `permissions:` minimal, `pull_request_target`/Script-Injection über `${{ github.event.* }}`, Secret-Exposition an Build-Skripte (Client AM4: Android-Keystore; Server: Registry-Push-Token), Artefakt-/Image-Integrität, Cache-Poisoning, Trivy-Gate, weekly re-scan.
- Release: Client `release*.mjs` (Versions-/Branch-Validierung, minisign-Schritte, `pnpm release` lokal, Feed-Branch-Schutz), Server Image-Publish (`ghcr.io`, Digest-Pinning), `.gitleaks.toml` je Repo prüfen (keine zu breiten Allowlists).
- Abhängigkeiten: bekannte CVEs, Typosquatting, Postinstall-Skripte, Gradle-Wrapper-Checksumme (AL8), Lockfile-Konsistenz (`Cargo.lock`, `pnpm-lock.yaml`).
- Git-Historie jedes Repos (inkl. der Worktree-Branches) auf versehentlich committete Secrets: minisign-Privatkey, Android-Keystore, OAuth-Client-Secret, Gateway-Key, Relay-Passwörter.

## 6. Ergebnis

Erstelle pro Codebasis einen Bericht im Stil des vorhandenen `docs/security-audit.md` (englisch, verständlich, **ohne Schritt-für-Schritt-Exploits**):

- `UwUMail/docs/security-audit-<JJJJ-MM>.md` (Client + Android),
- `UwUMail-Server/docs/security-audit-<JJJJ-MM>.md` (Server + Gateway/Tunnel),

und je eine private Notizdatei `security-test-notes.local.md` (in `.gitignore`) mit Reproschritten und PoCs.

Für jedes Finding:

| Feld | Inhalt |
| --- | --- |
| ID | `C-…` Client, `A-…` Android, `S-…` Server, `G-…` Gateway/Tunnel, `R-…` Release/CI |
| Schwere | Critical / High / Medium / Low / Informational (mit CVSS-3.1-Vektor) |
| Komponente + Datei:Zeile | |
| Angreifer & Voraussetzungen | z. B. „sendet eine Mail", „authentifizierter Nutzer", „gleiches WLAN", „kompromittierter VPS", „andere App auf dem Phone" |
| Auswirkung | Was genau erreicht wird |
| Nachweis | Test/Log/Beobachtung, lokal verifiziert: ja/nein |
| Empfohlener Fix | konkret, mit betroffenen Stellen |
| Regressionstest | Vorschlag für Unit-/Integrationstest |

Außerdem je Bericht:

- Tabelle „Regressionsprüfung alter Findings" (Client H/M/L + Android; Server M1/M2 + „held up"-Liste) mit Status *hält / umgehbar / nicht mehr anwendbar*.
- Liste neuer oder geänderter akzeptierter Risiken.
- Priorisierte Fix-Reihenfolge und was vor 1.0 bzw. vor „echter Mail" zwingend ist.
- Was **nicht** getestet werden konnte und warum (z. B. macOS, echte OAuth-Provider, echter VPS/Port 25).

Arbeite gründlich und lieber zu misstrauisch als zu optimistisch. Markiere Vermutungen klar als solche und bestätige Findings wo möglich mit einem lokalen Test. Frag nach, bevor du etwas tust, das außerhalb der lokalen Testumgebung wirkt.
