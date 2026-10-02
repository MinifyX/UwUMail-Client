# OAuth sign-in (Microsoft and Google)

Microsoft no longer accepts passwords for IMAP/SMTP on Outlook.com and
Microsoft 365, and Google only accepts app passwords. UwUMail therefore signs
in through the provider's website (OAuth 2.0 authorization code flow with
PKCE and a loopback redirect). The user's password never passes through
UwUMail; only a refresh token is stored, in the OS keychain.

Each build needs client ids registered with the providers. They are compiled
in from environment variables:

| Variable | Provider |
| --- | --- |
| `UWUMAIL_MICROSOFT_CLIENT_ID` | Microsoft (Outlook.com, Hotmail, Microsoft 365) |
| `UWUMAIL_GOOGLE_CLIENT_ID` | Google |
| `UWUMAIL_GOOGLE_CLIENT_SECRET` | Google (not confidential for desktop apps) |

Without them the app still works for all other mailboxes and shows a clear
message for Microsoft and Google addresses. In GitHub Actions, set them as
repository secrets with the same names.

## Microsoft

The official builds use their own Entra app, **UwUMail-Client**; its client id
is the repository secret `UWUMAIL_MICROSOFT_CLIENT_ID`, which the desktop,
Android, iOS and release workflows pass to the build. To register your own:

1. [Microsoft Entra admin center](https://entra.microsoft.com) → App
   registrations → New registration.
2. Name it (the official one is `UwUMail-Client`), supported account types
   **"Accounts in any organizational directory and personal Microsoft
   accounts"**, so Outlook.com and Hotmail work next to Microsoft 365.
3. Authentication → Add a platform → **"Mobile and desktop applications"**,
   redirect URIs:
   - `http://localhost` — desktop. Any port on localhost is allowed for this
     platform, the app listens on a free one for the moment of the sign-in.
   - `app.uwumail://oauth` — Android and iOS, where the browser comes back to
     the app through this link (see [Phones](#phones)).
4. Authentication → Advanced settings → **Allow public client flows: Yes**.
5. API permissions → the list already holds Microsoft Graph `User.Read`.
   Add the rest in two rounds:
   1. **Add a permission → Microsoft APIs → Microsoft Graph → Delegated
      permissions**. Type each name into the search box and tick it:
      `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`,
      `Calendars.ReadWrite`, `Calendars.ReadWrite.Shared`, `Contacts.ReadWrite`,
      `Contacts.ReadWrite.Shared` (and `User.Read`, if it isn't there yet).
      Click **Add permissions**.
   2. **Add a permission → APIs my organization uses** → search
      **Office 365 Exchange Online** → **Delegated permissions** → open
      **EWS** → tick `EWS.AccessAsUser.All` → **Add permissions**.

   The list should now show eleven delegated permissions: nine under
   Microsoft Graph, `EWS.AccessAsUser.All` under Office 365 Exchange Online.
   (Older guides pick IMAP and SMTP under "Office 365 Exchange Online"; the
   Graph entries are the same grants.) The app asks for the mail scopes as
   `https://outlook.office.com/IMAP.AccessAsUser.All` and
   `https://outlook.office.com/SMTP.Send`, which is how IMAP and SMTP want the
   token, and for the calendar and contact scopes as
   `https://graph.microsoft.com/Calendars.ReadWrite` and so on; that is
   expected. "Grant admin consent for …" on this page only covers your own
   tenant; everyone else consents at sign-in (see below).
6. Copy the **Application (client) ID** into `UWUMAIL_MICROSOFT_CLIENT_ID`
   (repository secret for CI, environment variable for a local build).

No client secret is needed; the app is a public client. The client id isn't
secret either, it ends up in every build.

### Microsoft 365 and Exchange Online

Company mailboxes are not called `outlook.com`, so UwUMail asks Entra ID whether
a domain belongs to a tenant: every verified domain serves an OpenID
configuration under
`login.microsoftonline.com/<domain>/v2.0/.well-known/openid-configuration`, and
every other domain answers with an error. Autodiscover v2 is no help here, as
it stopped answering for IMAP and SMTP. The MX record decides when it names a
provider, which keeps a company that only uses Entra for sign-in on its real
mail host; a spam filter in front of Microsoft 365 hides the MX, and the tenant
lookup is what still finds those. Recognised mailboxes get Exchange Online's
fixed hosts, `outlook.office365.com:993` and `smtp.office365.com:587`.

When that lands wrong — a hybrid setup, an on-premises Exchange, a domain whose
autoconfig file says otherwise — the setup dialog switches between Microsoft and
a password by hand, in both directions.

Two tenant settings decide whether it can work at all, and neither is ours to
change. IMAP is per mailbox (`Set-CASMailbox -Identity <address> -ImapEnabled $true`),
SMTP submission is per mailbox and per tenant
(`Set-CASMailbox -Identity <address> -SmtpClientAuthenticationDisabled $false`,
`Set-TransportConfig -SmtpClientAuthenticationDisabled $false`). Security defaults in
Entra switch SMTP submission off on their own. UwUMail recognises both refusals
and says which command an administrator needs, instead of blaming a password.

Basic authentication for SMTP submission is on its way out: disabled by default
for existing tenants at the end of December 2026, unavailable for tenants
created after that, with a removal date to be announced in the second half of
2027. OAuth is unaffected, and IMAP itself is not being retired.

A shared mailbox has no sign-in of its own. Add it under its own address and
give "Sign in as" the address that has access to it: the sign-in page then asks
for that person, and their token opens the shared address over XOAUTH2.

### Calendars and contacts

Calendars and contacts of Microsoft sign-ins come from Microsoft Graph v1.0
(`graph.microsoft.com`): the own calendars and the ones others shared, events
over `calendarView` with recurring ones expanded, and contact folders with
their contacts, all read and written. Shared mailboxes use
`/users/<address>/…` with the token of the person who signs in for them; that
needs `Calendars.ReadWrite.Shared` and `Contacts.ReadWrite.Shared` and the
person's access to the mailbox in Exchange.

Microsoft hands out one access token per resource: the sign-in asks for
everything at once (mail, EWS and Graph scopes), the code is redeemed for the
mail token, and the stored refresh token buys a separate Graph token when the
calendar or the contacts open. Microsoft may answer a refresh with a new
refresh token; UwUMail always keeps the newest.

Mailboxes added before UwUMail asked for calendars and contacts have a refresh
token without them. Mail keeps working; the calendar, the contacts and the
mailbox's settings say "Sign in again to see calendar and contacts", with a
button that runs the sign-in once more. A company that allowed UwUMail for
everyone by admin consent has to allow it once more for the new permissions
(the same `adminconsent` page as below); until then UwUMail explains that an
administrator has to agree, and mail still works.

### Who can sign in, and who needs their IT first

Personal Microsoft accounts work the moment a client id exists. Company
mailboxes are a different story, and it is worth being plain about why.

Since November 2020, Entra hands the decision to an administrator whenever a
multi-tenant app asks for more than signing in and reading a profile, and its
publisher is not verified. Mailbox access is squarely in that category. The
step-up is on by default in every tenant, so the person signing in sees
"AADSTS90094: needs permission ... that only an admin can grant" rather than a
consent screen.

Publisher verification would lift that, but it needs a verified Microsoft AI
Cloud Partner Program account as a partner global account, an app registered in
a work or school tenant (one registered with a personal Microsoft account can
never be verified), and a DNS-verified publisher domain. UwUMail has none of
these, and is not going to: it is a hobby project, not a company.

So UwUMail does the next best thing. After a refused Microsoft sign-in it offers
the page where an administrator allows the app for their whole company,
`login.microsoftonline.com/<domain>/adminconsent?client_id=<id>`, ready to send to
whoever runs the tenant. One click there and everyone in that company can sign
in. Thunderbird asks its users to do the same thing, by hand, through a support
article.

Tenants that switch user consent off entirely always need that admin step, no
matter how verified an app is. That one is not ours to solve.

### Phones

A phone pauses UwUMail while the browser is in front, so nothing would answer
on a loopback port. On Android and iOS the engine is told
`Engine::use_oauth_app_link("app.uwumail://oauth")`, and Microsoft sends the
browser there instead:

- **Android**: `AndroidManifest.xml` has an intent filter for
  `app.uwumail://oauth`; `Launch.kt` passes the URL to `Engine::finish_sign_in`.
- **iOS**: `Info.ios.plist` registers the URL scheme `app.uwumail`
  (`CFBundleURLTypes`); Safari asks once whether to open UwUMail, and
  `ios.rs` hands the opened URL (`RunEvent::Opened`) to `Engine::finish_sign_in`.

`finish_sign_in` only accepts that link and hands it to the sign-in that is
waiting. The sign-in checks `state` and uses PKCE, so a forged link can't
complete it; it is ignored and the sign-in keeps waiting for its own link, like
the loopback listener on desktop ignores requests with the wrong `state`.

Personal accounts and Microsoft 365 work the same way on the phone, including
the admin consent page after a refused company sign-in.

Google's desktop clients only take a loopback redirect, never an app link, so
Google keeps the loopback on phones too (`oauth::takes_app_link`). On Android
that works while UwUMail keeps running behind the browser; iOS usually pauses
the app too soon, so Gmail on the iPhone is best added with an app password.

## Google

1. [Google Cloud console](https://console.cloud.google.com) → project picker →
   **New project** (or pick the existing one).
2. **APIs & Services → Library**: search **Google Calendar API** → **Enable**.
   Back to the Library, search **People API** → **Enable**. Without these two,
   mail works but calendars and contacts answer "API not enabled", which
   UwUMail shows as a hint to this page.
3. **Google Auth Platform** (formerly *APIs & Services → OAuth consent
   screen*) → **Get started**: app name, support email, audience
   **External**, contact email, agree, **Create**.
4. **Google Auth Platform → Data Access → Add or remove scopes**. Tick, or
   paste under *Manually add scopes*:
   - `https://mail.google.com/`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/contacts`

   → **Update** → **Save**.
5. **Google Auth Platform → Audience → Test users → Add users**: every Google
   address that may sign in while the app is in *Testing*.
6. **Google Auth Platform → Clients → Create client → Desktop app** → name it
   → **Create**.
7. Copy client id and secret into `UWUMAIL_GOOGLE_CLIENT_ID` and
   `UWUMAIL_GOOGLE_CLIENT_SECRET`.

While the app is in *Testing*, only up to 100 listed test users can sign in,
and Google lets their refresh tokens expire after seven days, after which
the mailbox has to be signed in again. `https://mail.google.com/` is a restricted
scope: publishing the app for everyone requires Google's verification
including a security assessment; the calendar and contacts scopes are
"sensitive" and need the (lighter) verification as well. Until then, Gmail
users can add their mailbox with an
[app password](https://support.google.com/accounts/answer/185833) and the
regular password flow.

Google has one token for everything. Calendars come from Calendar API v3
(recurring events expanded with `singleEvents=true`, the "Birthdays" calendar
of the contacts left out, since UwUMail makes its own), contacts from the
People API as one address book ("Contacts"; contact labels aren't separate
address books). Gmail accounts added before calendars and contacts were asked
for get the same "Sign in again" hint as Microsoft ones.
