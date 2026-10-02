//! Shared mailboxes in Microsoft 365: finding the ones a person has access to.
//!
//! A shared mailbox has no sign-in of its own. Whoever has "full access" to it signs in as
//! themselves, and their token opens the shared address over IMAP and SMTP (docs/oauth.md).
//! Which shared mailboxes someone has is what Outlook learns from Exchange Autodiscover: the POX
//! answer lists them as `<AlternativeMailbox>` entries of type `Delegate`, as long as the
//! administrator left "automapping" on when granting access (the default). Mailboxes granted
//! without it are not listed anywhere a mail client can ask; they are added by address instead.
//!
//! Exchange Online is retiring EWS, and the POX endpoint belongs to it. Everything here is
//! therefore best effort: any answer that isn't a usable list means "nothing found", never an
//! error the mailbox itself would show.

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use crate::calendar::xml::{self, Element};

/// Exchange Online's Autodiscover (POX) endpoint.
pub const AUTODISCOVER_URL: &str = "https://outlook.office365.com/autodiscover/autodiscover.xml";

const REQUEST_SCHEMA: &str = "http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006";
const RESPONSE_SCHEMA: &str = "http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a";

/// Microsoft's tenant for personal accounts (outlook.com, hotmail.com, ...): they have no shared mailboxes.
pub const CONSUMER_TENANT: &str = "9188040d-6c67-4c5b-b112-36a304b66dad";

/// An Autodiscover answer lists a few mailboxes; anything bigger isn't one.
const MAX_ANSWER: usize = 512 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);

/// A shared or delegated mailbox Autodiscover listed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundMailbox {
    pub email: String,
    pub display_name: String,
}

/// What asking Autodiscover came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Discovery {
    /// The list, possibly empty.
    Found(Vec<FoundMailbox>),
    /// The token was refused (401/403): typically a sign-in from before UwUMail asked for
    /// Exchange access. Signing in again fixes it.
    NeedsSignIn,
    /// Anything else: Microsoft switched the endpoint off, the network, an answer we can't read.
    Unavailable,
}

/// The request body for `email`.
pub fn request_body(email: &str) -> String {
    let email = escape(email);
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="{REQUEST_SCHEMA}">
  <Request>
    <EMailAddress>{email}</EMailAddress>
    <AcceptableResponseSchema>{RESPONSE_SCHEMA}</AcceptableResponseSchema>
  </Request>
</Autodiscover>"#
    )
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The shared mailboxes in an Autodiscover answer: `None` when it isn't one we can read (an
/// error answer, a redirect, something else entirely).
///
/// Only `Delegate` entries count: shared mailboxes and other people's mailboxes the person has
/// full access to, the ones Outlook maps automatically. `Archive` (the person's own online
/// archive, not reachable over IMAP) and `TeamMailbox` (SharePoint site mailboxes, retired by
/// Microsoft and not reachable over IMAP either) are left out.
pub fn parse_answer(body: &[u8]) -> Option<Vec<FoundMailbox>> {
    let root = xml::parse(body).ok()?;
    if root.name != "Autodiscover" {
        return None;
    }
    let response = root.children.iter().find(|child| child.name == "Response")?;
    // An error answer, or "go ask somewhere else" (redirectAddr/redirectUrl): nothing to list.
    if response.namespace != RESPONSE_SCHEMA || response.child(RESPONSE_SCHEMA, "Account").is_none() {
        return None;
    }
    let mut entries = Vec::new();
    collect(response, &mut entries);
    let mut found: Vec<FoundMailbox> = Vec::new();
    for entry in entries {
        let text = |name: &str| entry.child(RESPONSE_SCHEMA, name).map(|e| e.trimmed_text().to_string());
        if !text("Type").is_some_and(|kind| kind.eq_ignore_ascii_case("Delegate")) {
            continue;
        }
        let Some(email) = text("SmtpAddress")
            .filter(|a| is_mailbox_address(a))
            .or_else(|| text("OwnerSmtpAddress").filter(|a| is_mailbox_address(a)))
        else {
            continue;
        };
        if found.iter().any(|f| f.email.eq_ignore_ascii_case(&email)) {
            continue;
        }
        let display_name = text("DisplayName").filter(|n| !n.is_empty()).unwrap_or_else(|| local_part(&email));
        found.push(FoundMailbox { email, display_name });
    }
    Some(found)
}

fn collect<'a>(element: &'a Element, into: &mut Vec<&'a Element>) {
    for child in &element.children {
        if child.is(RESPONSE_SCHEMA, "AlternativeMailbox") {
            into.push(child);
        } else {
            collect(child, into);
        }
    }
}

fn is_address(text: &str) -> bool {
    crate::autoconfig::split_email(text).is_ok()
}

/// An address a shared mailbox can have: a plain `local@domain`, nothing that could end a header
/// or command line or quote its way into one (it becomes an IMAP user, a sender, a Graph path).
pub fn is_mailbox_address(text: &str) -> bool {
    is_address(text)
        && text.len() <= 320
        && !text.chars().any(|c| c.is_control() || c.is_whitespace() || "<>\"(),;:\\[]".contains(c))
}

fn local_part(email: &str) -> String {
    email.split('@').next().unwrap_or(email).to_string()
}

/// The client for Autodiscover: the token only ever goes to the address asked, so no redirects.
fn client() -> Option<reqwest::Client> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Some(client.clone());
    }
    let client = crate::tls::http_client()
        .ok()?
        .user_agent(concat!("UwUMail/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .ok()?;
    Some(CLIENT.get_or_init(|| client).clone())
}

/// Asks Autodiscover at `url` which shared mailboxes `email` has, with an access token for
/// `outlook.office.com`. Never fails: see [`Discovery`].
pub async fn discover(url: &str, email: &str, access_token: &str) -> Discovery {
    let Some(http) = client() else { return Discovery::Unavailable };
    let request = http
        .post(url)
        .bearer_auth(access_token)
        .header("Content-Type", "text/xml; charset=utf-8")
        // Routes the request straight to the person's mailbox server.
        .header("X-AnchorMailbox", email)
        .body(request_body(email));
    let Ok(Ok(mut response)) = tokio::time::timeout(TIMEOUT, request.send()).await else {
        return Discovery::Unavailable;
    };
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Discovery::NeedsSignIn;
    }
    if !status.is_success() {
        return Discovery::Unavailable;
    }
    let mut body = Vec::new();
    loop {
        match tokio::time::timeout(TIMEOUT, response.chunk()).await {
            Ok(Ok(Some(chunk))) => {
                if body.len() + chunk.len() > MAX_ANSWER {
                    return Discovery::Unavailable;
                }
                body.extend_from_slice(&chunk);
            }
            Ok(Ok(None)) => break,
            _ => return Discovery::Unavailable,
        }
    }
    match parse_answer(&body) {
        Some(found) => Discovery::Found(found),
        None => Discovery::Unavailable,
    }
}

/// Who an access token belongs to, read from its claims. Microsoft's tokens for
/// `outlook.office.com` are JWTs; nothing here is trusted for anything but telling mailboxes
/// apart on this device, so the signature isn't checked.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TokenOwner {
    /// The person's sign-in address (`upn`, else `unique_name`, `preferred_username`, `email`).
    pub address: Option<String>,
    /// The Entra tenant id.
    pub tenant: Option<String>,
}

impl TokenOwner {
    pub fn is_personal(&self) -> bool {
        self.tenant.as_deref().is_some_and(|tenant| tenant.eq_ignore_ascii_case(CONSUMER_TENANT))
    }
}

pub fn token_owner(access_token: &str) -> TokenOwner {
    let Some(payload) = access_token.split('.').nth(1) else { return TokenOwner::default() };
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')) else { return TokenOwner::default() };
    let Ok(claims) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return TokenOwner::default() };
    let text = |name: &str| claims.get(name).and_then(|v| v.as_str()).map(str::trim).filter(|v| !v.is_empty());
    let address = ["upn", "unique_name", "preferred_username", "email"]
        .iter()
        .filter_map(|name| text(name))
        .find(|value| is_address(value))
        .map(|value| value.trim_start_matches("live.com#").to_string());
    TokenOwner { address, tenant: text("tid").map(String::from) }
}

/// Personal Microsoft addresses (outlook.com, hotmail.de, live.com, ...), which have no shared mailboxes.
pub fn is_personal_address(email: &str) -> bool {
    crate::autoconfig::split_email(email)
        .map(|(_, domain)| {
            crate::autoconfig::oauth_provider_for(&domain) == Some(crate::model::OAuthProvider::Microsoft)
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shaped like Exchange Online's answer, prefixes and all.
    const ANSWER: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <User>
      <DisplayName>Alex Muster</DisplayName>
      <LegacyDN>/o=ExchangeLabs/ou=Exchange Administrative Group/cn=Recipients/cn=alex</LegacyDN>
      <AutoDiscoverSMTPAddress>alex@contoso.example</AutoDiscoverSMTPAddress>
      <DeploymentId>00000000-0000-0000-0000-000000000000</DeploymentId>
    </User>
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <MicrosoftOnline>True</MicrosoftOnline>
      <Protocol>
        <Type>EXCH</Type>
        <Server>00000000-0000-0000-0000-000000000000@contoso.example</Server>
      </Protocol>
      <AlternativeMailbox>
        <Type>Archive</Type>
        <DisplayName>In-Place Archive - Alex Muster</DisplayName>
        <SmtpAddress>ExchangeGuid+00000000@contoso.example</SmtpAddress>
        <OwnerSmtpAddress>alex@contoso.example</OwnerSmtpAddress>
      </AlternativeMailbox>
      <AlternativeMailbox>
        <Type>Delegate</Type>
        <DisplayName>Team Vertrieb</DisplayName>
        <SmtpAddress>vertrieb@contoso.example</SmtpAddress>
        <OwnerSmtpAddress>vertrieb@contoso.example</OwnerSmtpAddress>
      </AlternativeMailbox>
      <AlternativeMailbox>
        <Type>TeamMailbox</Type>
        <DisplayName>Projekt X</DisplayName>
        <SmtpAddress>projektx@contoso.example</SmtpAddress>
      </AlternativeMailbox>
      <AlternativeMailbox>
        <Type>Delegate</Type>
        <DisplayName></DisplayName>
        <SmtpAddress>info@contoso.example</SmtpAddress>
      </AlternativeMailbox>
      <AlternativeMailbox>
        <Type>Delegate</Type>
        <DisplayName>Twice</DisplayName>
        <SmtpAddress>VERTRIEB@contoso.example</SmtpAddress>
      </AlternativeMailbox>
    </Account>
  </Response>
</Autodiscover>"#;

    #[test]
    fn reads_only_delegate_mailboxes() {
        let found = parse_answer(ANSWER.as_bytes()).unwrap();
        assert_eq!(
            found,
            vec![
                FoundMailbox { email: "vertrieb@contoso.example".into(), display_name: "Team Vertrieb".into() },
                FoundMailbox { email: "info@contoso.example".into(), display_name: "info".into() },
            ]
        );
    }

    #[test]
    fn reads_prefixed_namespaces_too() {
        let prefixed = r#"<a:Autodiscover xmlns:a="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006"
            xmlns:o="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
          <o:Response><o:Account><o:Action>settings</o:Action>
            <o:AlternativeMailbox><o:Type>delegate</o:Type><o:DisplayName>Support</o:DisplayName>
              <o:SmtpAddress>support@contoso.example</o:SmtpAddress></o:AlternativeMailbox>
          </o:Account></o:Response></a:Autodiscover>"#;
        let found = parse_answer(prefixed.as_bytes()).unwrap();
        assert_eq!(
            found,
            vec![FoundMailbox { email: "support@contoso.example".into(), display_name: "Support".into() }]
        );
        // The right names in the wrong namespace are something else.
        let foreign = prefixed.replace("outlook/responseschema/2006a", "other");
        assert_eq!(parse_answer(foreign.as_bytes()), None);
    }

    #[test]
    fn an_account_without_shared_mailboxes_lists_none() {
        let plain = r#"<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
          <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
            <Account><Action>settings</Action></Account></Response></Autodiscover>"#;
        assert_eq!(parse_answer(plain.as_bytes()), Some(vec![]));
    }

    #[test]
    fn error_answers_and_garbage_are_not_lists() {
        let error = r#"<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response>
    <Error Time="10:00:00.000" Id="1">
      <ErrorCode>500</ErrorCode>
      <Message>The email address can't be found.</Message>
    </Error>
  </Response>
</Autodiscover>"#;
        assert_eq!(parse_answer(error.as_bytes()), None);
        assert_eq!(parse_answer(b"<html><body>Sign in</body></html>"), None);
        assert_eq!(parse_answer(b"not xml at all <"), None);
        let entity = r#"<!DOCTYPE x [<!ENTITY e "boom">]><Autodiscover/>"#;
        assert_eq!(parse_answer(entity.as_bytes()), None, "no DOCTYPE, no entities");
    }

    #[test]
    fn the_request_names_the_address_and_the_answer_schema() {
        let body = request_body("alex&co@contoso.example");
        assert!(body.contains("<EMailAddress>alex&amp;co@contoso.example</EMailAddress>"), "{body}");
        assert!(body.contains(RESPONSE_SCHEMA));
        assert!(body.contains(&format!("xmlns=\"{REQUEST_SCHEMA}\"")));
    }

    fn jwt(claims: &str) -> String {
        format!("eyJhbGciOiJub25lIn0.{}.sig", URL_SAFE_NO_PAD.encode(claims))
    }

    #[test]
    fn reads_who_a_token_belongs_to() {
        let owner = token_owner(&jwt(r#"{"upn":"alex@contoso.example","tid":"t-1","unique_name":"x"}"#));
        assert_eq!(owner.address.as_deref(), Some("alex@contoso.example"));
        assert_eq!(owner.tenant.as_deref(), Some("t-1"));
        assert!(!owner.is_personal());

        let personal = token_owner(&jwt(&format!(
            r#"{{"unique_name":"live.com#mini@outlook.example","tid":"{CONSUMER_TENANT}"}}"#
        )));
        assert_eq!(personal.address.as_deref(), Some("mini@outlook.example"));
        assert!(personal.is_personal());

        assert_eq!(token_owner("opaque-token"), TokenOwner::default());
        assert_eq!(token_owner("a.!!!.c"), TokenOwner::default());
    }

    #[test]
    fn mailbox_addresses_are_plain() {
        assert!(is_mailbox_address("team.vertrieb+x@contoso.example"));
        for odd in ["a b@contoso.example", "a\r\nb@contoso.example", "\"a\"@contoso.example", "a<b>@contoso.example"] {
            assert!(!is_mailbox_address(odd), "{odd:?}");
        }
        let odd = ANSWER.replace("vertrieb@contoso.example</SmtpAddress>", "vert rieb@contoso.example</SmtpAddress>");
        let found = parse_answer(odd.as_bytes()).unwrap();
        // The owner's address stands in where the mailbox's own isn't usable.
        assert_eq!(found[0].email, "vertrieb@contoso.example");
    }

    #[test]
    fn personal_addresses_have_no_shared_mailboxes() {
        assert!(is_personal_address("mini@outlook.com"));
        assert!(is_personal_address("mini@hotmail.de"));
        assert!(!is_personal_address("alex@contoso.example"));
        assert!(!is_personal_address("not an address"));
    }
}
