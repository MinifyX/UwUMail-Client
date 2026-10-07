# UwUMail Privacy Policy

*Last updated: 2026-10-07* · [Deutsche Fassung weiter unten](#datenschutzerklärung-für-uwumail)

UwUMail is an open-source mail, calendar and contacts app for Windows, macOS, Linux, Android, iPhone and iPad,
developed by Lorin (MinifyX) as a hobby project. This policy covers the UwUMail app. It does not cover the mail
servers, AI providers or other services you connect to it; their own privacy policies apply.

## The short version

- **The developer receives no data from you.** UwUMail has no account with the developer, no telemetry, no
  analytics, no crash reporting, no advertising and no tracking.
- Your mail, contacts, calendars and settings are stored **on your device**. The app talks only to the services
  you set up and to the few services listed below, each for a stated purpose.
- The source code is public at <https://github.com/MinifyX/UwUMail-Client>, so every statement here can be checked.

## Data stored on your device

- **Mailbox data** in a local database in the app's private data folder: account settings, folders, mail
  (headers, and bodies within the offline period you choose, 90 days by default), contacts, calendars,
  signatures, blocked senders, your labels and the examples you taught them, and AI assistant settings and usage
  counters. Attachments you open and sender pictures are cached in the same folder.
- **Passwords, sign-in tokens** (Microsoft, Google) and **AI provider API keys** are kept in the system's secure
  storage: the Keychain on macOS and iOS, Credential Manager on Windows, the Secret Service keyring on Linux, and
  on Android encrypted with a key held in the Android Keystore. They are never written to the database or logs.
- **Display preferences** (theme, font, layout and similar) are kept in the app's local web storage.
- **Removing a mailbox** in the app deletes its stored mail, cached attachments and saved password or token. On
  desktop, the UwUMail setup offers to delete all mail, settings and saved passwords when uninstalling; on phones,
  uninstalling the app removes its data.

## Network connections

UwUMail connects to:

- **Your mail providers**: the IMAP, SMTP, JMAP, CalDAV and CardDAV servers of the accounts you add. For accounts
  you sign in with Microsoft or Google, their sign-in pages and APIs (Microsoft Graph and Exchange Online; Google
  Gmail, Calendar and People) are used to read and change your mail, calendars, contacts and contact photos.
- **Account setup lookups**, only while you add an account: the configuration files of your mail domain (the
  domain's autoconfig file receives your address, as is customary), Mozilla's Thunderbird provider database
  (autoconfig.thunderbird.net, receives the domain only), Microsoft's sign-in discovery for the domain, DNS
  records (MX, SRV) and the usual server names of the domain.
- **Sender pictures** (switchable under Settings, on by default): if one of your accounts is on a UwUMail server,
  that server is asked for the picture of a sender's address. Otherwise, for company senders only, UwUMail looks
  up the domain's BIMI logo (DNS) and the icon of the domain's website. Only the domain is contacted (never the
  address), once per domain, and the result is cached for 30 days, so a sender cannot tell which mail you read.
  Addresses at mail providers (such as Gmail or GMX) never get a picture this way.
- **Remote images in mail** are blocked by default and load only when you allow them. They are then fetched by
  your UwUMail server (for its accounts) or by the app, through a privacy proxy if you set one, never by the mail
  view directly. The privacy proxy is also used for sender pictures.
- **Unsubscribe**: one-click unsubscribe requests are sent only when you click "Unsubscribe".
- **Settings sync** (optional): if you choose a UwUMail account as sync account, some settings and your
  signatures are stored on that UwUMail server so they follow you to other devices.
- **Updates**: the desktop and Android versions downloaded from GitHub check
  `raw.githubusercontent.com/MinifyX/UwUMail-Client` for new versions (shortly after start and every six hours)
  and download signed updates from GitHub. This can be switched off. Apps from the App Store are updated by the
  App Store and make no such checks.
- **Push on Android** (optional): for JMAP servers that support it, your mail server sends encrypted change
  notifications through the UnifiedPush distributor you chose on your device.
- **AI cost estimates**, only when an AI provider is set up and costs are shown: public price lists
  (LiteLLM's list on GitHub, OpenRouter's model list) and the European Central Bank's exchange rates. No personal
  data is sent with these requests.

Like any network request, these connections reveal your IP address to the server contacted.

## Text recognition in pictures

To find appointments in pictures (for example a poster in a mail), text is recognized on your device with the
operating system's own engine: Apple Vision on macOS and iOS, Windows OCR on Windows, and Google's ML Kit on
Android (via Google Play services, which downloads the recognition model; the recognition itself runs on the
device). For accounts on a UwUMail server, that server reads the pictures instead. Not available on Linux.

## AI assistant (optional)

The AI assistant is **off until you set up a provider**. Before the first request goes to a provider, UwUMail asks
for your consent for that provider; you can withdraw it at any time under Settings → AI assistant.

- **Where requests go**: for accounts on a UwUMail server with an assistant, to that server, which uses the
  provider its administrator chose (or your own provider there). For all other accounts, from your device directly
  to the provider you added: OpenAI, Anthropic, Google Gemini, Mistral, OpenRouter, or a model on your own computer
  or network (Ollama or another OpenAI-compatible server). If you let a UwUMail server handle the AI for your
  other mailboxes, the needed mail content is sent to that server for each request.
- **What is sent**, only for the feature you use and cut to size; no attachments, no pictures, no other mail:
  - *Write, rewrite, translate*: your instruction, the draft, the subject, the mail you are replying to, your name
    and address and the date.
  - *Summaries*: text, subject, date, names and addresses of the mail or of up to 20 mails of a conversation.
  - *Spam check*: the mail's text, subject, links and header lines, plus facts such as authentication results.
  - *Appointments*: the mail's text, plus text recognized from its pictures (not the pictures).
  - *Labels*: the start of the mail plus the names and descriptions of your labels. *Auto-labels* (off by
    default) do this for new mail in the background.
- API keys stay in your system's secure storage and are sent only to their provider.
- What the provider does with the data is governed by its own terms and privacy policy. For mail that must not
  leave your network, use a local model.

## Permissions on phones and tablets

- **Notifications**: to tell you about new mail and reminders. They are created on the device.
- **Background activity**: Android keeps checking for mail in a background service; iOS lets the app check for
  mail from time to time in the background and shows local notifications. On iOS no push service is used.
- **Camera** (iOS): only when you take a photo for a contact or your profile picture.
- **Face ID / biometrics**: for the optional app lock. The check is done by the operating system; UwUMail never
  sees biometric data.

## Apple and Google

If you install UwUMail from Apple's App Store, Apple may share crash reports and usage statistics with the
developer only if you agreed to share them with app developers in your device settings. That is Apple's feature
and governed by Apple's privacy policy; UwUMail itself sends nothing.

## Children

UwUMail is a general-purpose mail app. It is not directed at children and collects no data about anyone.

## Your rights

The developer stores no personal data about you, so there is nothing the developer could hand out, correct or
delete. Your data lives on your device, where you can delete it at any time, and with the mail, AI and other
providers you chose; requests about the data they hold go to them.

## Changes and contact

Changes to this policy are published in the repository and on this page with a new date.

Questions and privacy requests: **<privacy@minifyx.de>**. Public questions can also go to
<https://github.com/MinifyX/UwUMail-Client/issues>; security problems as described in
<https://github.com/MinifyX/UwUMail-Client/blob/main/SECURITY.md>.

---

# Datenschutzerklärung für UwUMail

*Stand: 07.10.2026*

UwUMail ist eine quelloffene App für Mail, Kalender und Kontakte für Windows, macOS, Linux, Android, iPhone und
iPad, entwickelt von Lorin (MinifyX) als Hobbyprojekt. Diese Erklärung gilt für die App UwUMail. Sie gilt nicht für
die Mailserver, KI-Anbieter und anderen Dienste, die du damit verbindest; dafür gelten deren eigene
Datenschutzerklärungen.

## Kurz gesagt

- **Der Entwickler bekommt keine Daten von dir.** Es gibt kein Konto beim Entwickler, keine Telemetrie, keine
  Nutzungsstatistik, keine Absturzberichte, keine Werbung und kein Tracking.
- Deine Mails, Kontakte, Kalender und Einstellungen liegen **auf deinem Gerät**. Die App spricht nur mit den
  Diensten, die du einrichtest, und mit den wenigen unten genannten Diensten, jeweils für den genannten Zweck.
- Der Quellcode ist öffentlich unter <https://github.com/MinifyX/UwUMail-Client>, jede Aussage hier lässt sich
  also nachprüfen.

## Was auf deinem Gerät gespeichert wird

- **Postfachdaten** in einer lokalen Datenbank im privaten Datenordner der App: Kontoeinstellungen, Ordner, Mails
  (Kopfzeilen und Inhalte innerhalb des Offline-Zeitraums, den du wählst, standardmäßig 90 Tage), Kontakte,
  Kalender, Signaturen, blockierte Absender, deine Labels und die Beispiele, mit denen du sie angelernt hast, sowie
  Einstellungen und Verbrauchszähler des KI-Assistenten. Geöffnete Anhänge und Absenderbilder werden im selben
  Ordner zwischengespeichert.
- **Passwörter, Anmelde-Tokens** (Microsoft, Google) und **API-Schlüssel von KI-Anbietern** liegen im sicheren
  Speicher des Systems: im Schlüsselbund unter macOS und iOS, in der Anmeldeinformationsverwaltung unter Windows,
  im Secret-Service-Schlüsselbund unter Linux und unter Android verschlüsselt mit einem Schlüssel aus dem Android
  Keystore. In der Datenbank oder in Logs stehen sie nie.
- **Darstellungseinstellungen** (Design, Schrift, Layout und Ähnliches) liegen im lokalen Webspeicher der App.
- **Entfernst du ein Postfach** in der App, werden seine gespeicherten Mails, zwischengespeicherten Anhänge und das
  gespeicherte Passwort bzw. Token gelöscht. Auf dem Computer bietet das UwUMail-Setup beim Deinstallieren an,
  alle Mails, Einstellungen und gespeicherten Passwörter zu löschen; auf Handys entfernt das Deinstallieren die
  Daten der App.

## Netzwerkverbindungen

UwUMail verbindet sich mit:

- **Deinen Mail-Anbietern**: den IMAP-, SMTP-, JMAP-, CalDAV- und CardDAV-Servern der Konten, die du hinzufügst.
  Bei Konten, mit denen du dich bei Microsoft oder Google anmeldest, werden deren Anmeldeseiten und Schnittstellen
  (Microsoft Graph und Exchange Online; Google Gmail, Calendar und People) genutzt, um deine Mails, Kalender,
  Kontakte und Kontaktfotos zu lesen und zu ändern.
- **Abfragen bei der Kontoeinrichtung**, nur während du ein Konto hinzufügst: die Konfigurationsdateien deiner
  Mail-Domain (die Autoconfig-Datei der Domain bekommt, wie üblich, deine Adresse), die Anbieter-Datenbank von
  Mozilla Thunderbird (autoconfig.thunderbird.net, bekommt nur die Domain), Microsofts Anmelde-Erkennung für die
  Domain, DNS-Einträge (MX, SRV) und die üblichen Servernamen der Domain.
- **Absenderbilder** (in den Einstellungen abschaltbar, standardmäßig an): Liegt eines deiner Konten auf einem
  UwUMail-Server, wird dieser Server nach dem Bild zur Absenderadresse gefragt. Sonst sucht UwUMail, nur bei
  Firmenabsendern, das BIMI-Logo der Domain (DNS) und das Icon der Website der Domain. Kontaktiert wird nur die
  Domain (nie die Adresse), einmal pro Domain, und das Ergebnis wird 30 Tage zwischengespeichert, damit ein
  Absender nicht erkennen kann, welche Mail du liest. Adressen bei Mail-Anbietern (etwa Gmail oder GMX) bekommen
  auf diesem Weg nie ein Bild.
- **Externe Bilder in Mails** sind standardmäßig blockiert und laden erst, wenn du es erlaubst. Dann holt sie dein
  UwUMail-Server (für seine Konten) oder die App, über einen Datenschutz-Proxy, falls du einen eingestellt hast,
  nie die Mailansicht selbst. Der Datenschutz-Proxy gilt auch für Absenderbilder.
- **Abmelden von Newslettern**: Abmeldungen per Ein-Klick werden nur gesendet, wenn du auf „Abmelden“ klickst.
- **Einstellungs-Sync** (optional): Wählst du ein UwUMail-Konto als Sync-Konto, werden einige Einstellungen und
  deine Signaturen auf diesem UwUMail-Server gespeichert, damit sie dir auf andere Geräte folgen.
- **Updates**: Die Versionen für Computer und Android, die von GitHub geladen wurden, fragen
  `raw.githubusercontent.com/MinifyX/UwUMail-Client` nach neuen Versionen (kurz nach dem Start und alle sechs
  Stunden) und laden signierte Updates von GitHub. Das lässt sich abschalten. Apps aus dem App Store werden über
  den App Store aktualisiert und fragen nicht selbst nach.
- **Push unter Android** (optional): Bei JMAP-Servern, die es unterstützen, schickt dein Mailserver
  verschlüsselte Änderungsmeldungen über den UnifiedPush-Verteiler, den du auf deinem Gerät gewählt hast.
- **KI-Kostenschätzungen**, nur wenn ein KI-Anbieter eingerichtet ist und Kosten angezeigt werden: öffentliche
  Preislisten (die Liste von LiteLLM auf GitHub, die Modellliste von OpenRouter) und die Wechselkurse der
  Europäischen Zentralbank. Dabei werden keine personenbezogenen Daten übertragen.

Wie bei jeder Netzwerkverbindung sieht der jeweilige Server deine IP-Adresse.

## Texterkennung in Bildern

Um Termine in Bildern zu finden (etwa ein Plakat in einer Mail), wird Text auf deinem Gerät mit der Erkennung des
Betriebssystems gelesen: Apple Vision unter macOS und iOS, Windows-Texterkennung unter Windows und Googles ML Kit
unter Android (über die Google-Play-Dienste, die das Erkennungsmodell herunterladen; die Erkennung selbst läuft auf
dem Gerät). Bei Konten auf einem UwUMail-Server liest stattdessen dieser Server die Bilder. Unter Linux nicht
verfügbar.

## KI-Assistent (optional)

Der KI-Assistent ist **aus, bis du einen Anbieter einrichtest**. Bevor die erste Anfrage an einen Anbieter geht,
fragt UwUMail dich nach deiner Einwilligung für diesen Anbieter; du kannst sie jederzeit unter Einstellungen →
KI-Assistent widerrufen.

- **Wohin Anfragen gehen**: Bei Konten auf einem UwUMail-Server mit Assistent an diesen Server, der den Anbieter
  nutzt, den sein Administrator gewählt hat (oder deinen eigenen Anbieter dort). Bei allen anderen Konten direkt von
  deinem Gerät an den Anbieter, den du hinzugefügt hast: OpenAI, Anthropic, Google Gemini, Mistral, OpenRouter
  oder ein Modell auf deinem eigenen Rechner oder in deinem Netz (Ollama oder ein anderer OpenAI-kompatibler
  Server). Lässt du einen UwUMail-Server die KI für deine anderen Postfächer übernehmen, wird der nötige
  Mailinhalt bei jeder Anfrage an diesen Server geschickt.
- **Was gesendet wird**, nur für die Funktion, die du nutzt, und gekürzt; keine Anhänge, keine Bilder, keine
  anderen Mails:
  - *Schreiben, Umformulieren, Übersetzen*: deine Anweisung, der Entwurf, der Betreff, die Mail, auf die du
    antwortest, dein Name und deine Adresse sowie das Datum.
  - *Zusammenfassungen*: Text, Betreff, Datum, Namen und Adressen der Mail oder von bis zu 20 Mails eines
    Verlaufs.
  - *Spam-Prüfung*: Text, Betreff, Links und Kopfzeilen der Mail sowie Fakten wie Ergebnisse der
    Absenderprüfung.
  - *Termine*: der Text der Mail und der aus ihren Bildern erkannte Text (nicht die Bilder).
  - *Labels*: der Anfang der Mail sowie Namen und Beschreibungen deiner Labels. *Auto-Labels* (standardmäßig
    aus) tun das im Hintergrund für neue Mails.
- API-Schlüssel bleiben im sicheren Speicher deines Systems und gehen nur an ihren Anbieter.
- Was der Anbieter mit den Daten macht, regeln seine eigenen Bedingungen und seine Datenschutzerklärung. Für Mails,
  die dein Netz nicht verlassen sollen, nutze ein lokales Modell.

## Berechtigungen auf Handys und Tablets

- **Mitteilungen**: um dich über neue Mails und Erinnerungen zu informieren. Sie entstehen auf dem Gerät.
- **Hintergrundaktivität**: Android prüft in einem Hintergrunddienst weiter auf neue Mails; iOS lässt die App ab
  und zu im Hintergrund nach Mails sehen und zeigt lokale Mitteilungen. Unter iOS wird kein Push-Dienst genutzt.
- **Kamera** (iOS): nur wenn du ein Foto für einen Kontakt oder dein Profilbild aufnimmst.
- **Face ID / Biometrie**: für die optionale App-Sperre. Die Prüfung übernimmt das Betriebssystem; UwUMail
  bekommt keine biometrischen Daten.

## Apple und Google

Installierst du UwUMail aus Apples App Store, kann Apple dem Entwickler Absturzberichte und Nutzungsstatistiken
nur dann bereitstellen, wenn du in den Geräteeinstellungen zugestimmt hast, sie mit App-Entwicklern zu teilen. Das
ist eine Funktion von Apple und unterliegt Apples Datenschutzerklärung; UwUMail selbst sendet nichts.

## Kinder

UwUMail ist eine allgemeine Mail-App. Sie richtet sich nicht an Kinder und sammelt über niemanden Daten.

## Deine Rechte

Der Entwickler speichert keine personenbezogenen Daten über dich, es gibt also nichts, was er herausgeben,
berichtigen oder löschen könnte. Deine Daten liegen auf deinem Gerät, wo du sie jederzeit löschen kannst, und bei
den Mail-, KI- und sonstigen Anbietern, die du gewählt hast; Anfragen zu den Daten dort richtest du an sie.

## Änderungen und Kontakt

Änderungen dieser Erklärung werden im Repository und auf dieser Seite mit neuem Datum veröffentlicht.

Fragen und Anliegen zum Datenschutz: **<privacy@minifyx.de>**. Öffentliche Fragen gehen auch als Issue unter
<https://github.com/MinifyX/UwUMail-Client/issues>; Sicherheitsprobleme wie in
<https://github.com/MinifyX/UwUMail-Client/blob/main/SECURITY.md> beschrieben.
