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

1. [Microsoft Entra admin center](https://entra.microsoft.com) → App
   registrations → New registration.
2. Name `UwUMail`, supported account types **"Accounts in any organizational
   directory and personal Microsoft accounts"**.
3. Platform **"Mobile and desktop applications"**, redirect URIs
   `http://localhost` (desktop; any port on localhost is allowed for this
   platform) and `app.uwumail://oauth` (Android, where the browser comes back to
   the app through this link).
4. Authentication → Advanced → **Allow public client flows: Yes**.
5. API permissions → Add → APIs my organization uses → search
   **"Office 365 Exchange Online"** → Delegated →
   `IMAP.AccessAsUser.All` and `SMTP.Send`. Add `offline_access` from
   Microsoft Graph.
6. Copy the **Application (client) ID** into `UWUMAIL_MICROSOFT_CLIENT_ID`.

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

On Android the engine is told `Engine::use_oauth_app_link("app.uwumail://oauth")`;
the activity that receives the link passes the URL to `Engine::finish_sign_in`,
which only accepts that link and hands it to the sign-in that is waiting. The
sign-in checks `state` and uses PKCE, so a forged link can't complete it; it is
ignored and the sign-in keeps waiting for its own link, like the loopback
listener on desktop ignores requests with the wrong `state`.

## Google

1. [Google Cloud console](https://console.cloud.google.com) → create a
   project → **APIs & Services → OAuth consent screen**: External, add the
   scope `https://mail.google.com/`.
2. **Credentials → Create credentials → OAuth client ID → Desktop app**.
3. Copy client id and secret into `UWUMAIL_GOOGLE_CLIENT_ID` and
   `UWUMAIL_GOOGLE_CLIENT_SECRET`.

While the consent screen is in *Testing*, only up to 100 listed test users
can sign in. `https://mail.google.com/` is a restricted scope: publishing the
app for everyone requires Google's verification including a security
assessment. Until then, Gmail users can add their mailbox with an
[app password](https://support.google.com/accounts/answer/185833) and the
regular password flow.
