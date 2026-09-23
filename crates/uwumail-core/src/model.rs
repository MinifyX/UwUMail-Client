//! Data shapes shared with the UI. Keep in sync with
//! `apps/desktop/src/backend/types.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountColor {
    Pink,
    Violet,
    Sky,
    Mint,
    Amber,
    Coral,
}

impl AccountColor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pink => "pink",
            Self::Violet => "violet",
            Self::Sky => "sky",
            Self::Mint => "mint",
            Self::Amber => "amber",
            Self::Coral => "coral",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "violet" => Self::Violet,
            "sky" => Self::Sky,
            "mint" => Self::Mint,
            "amber" => Self::Amber,
            "coral" => Self::Coral,
            _ => Self::Pink,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthKind {
    Password,
    Microsoft,
    Google,
}

impl AuthKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Microsoft => "microsoft",
            Self::Google => "google",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "microsoft" => Self::Microsoft,
            "google" => Self::Google,
            _ => Self::Password,
        }
    }
}

/// How UwUMail talks to a mailbox: IMAP for reading plus SMTP for sending, or JMAP for both.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    Imap,
    Jmap,
}

impl Protocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Imap => "imap",
            Self::Jmap => "jmap",
        }
    }

    pub fn parse(value: &str) -> Self {
        if value == "jmap" { Self::Jmap } else { Self::Imap }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum AccountStatus {
    Idle,
    Syncing {
        #[serde(skip_serializing_if = "Option::is_none")]
        progress: Option<f32>,
    },
    Offline,
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub email: String,
    pub display_name: String,
    pub color: AccountColor,
    pub auth: AuthKind,
    pub status: AccountStatus,
    pub protocol: Protocol,
    /// Protocols this account can switch to.
    pub protocols: Vec<Protocol>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderRole {
    Inbox,
    Sent,
    Drafts,
    Archive,
    Trash,
    Junk,
}

impl FolderRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inbox => "inbox",
            Self::Sent => "sent",
            Self::Drafts => "drafts",
            Self::Archive => "archive",
            Self::Trash => "trash",
            Self::Junk => "junk",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "inbox" => Self::Inbox,
            "sent" => Self::Sent,
            "drafts" => Self::Drafts,
            "archive" => Self::Archive,
            "trash" => Self::Trash,
            "junk" => Self::Junk,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub path: String,
    pub role: Option<FolderRole>,
    /// The folder this one is nested in, if any.
    pub parent_id: Option<String>,
    /// False for containers that only hold other folders.
    pub selectable: bool,
    pub unread: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Address {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub email: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UnifiedRole {
    Inbox,
    Unread,
    Flagged,
    Drafts,
    Sent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum MailboxView {
    Unified { role: UnifiedRole },
    Folder { account_id: String, folder_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ListFilter {
    All,
    Unread,
    Flagged,
    Attachments,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadQuery {
    pub view: MailboxView,
    pub filter: ListFilter,
    #[serde(default)]
    pub search: Option<String>,
    pub conversations: bool,
    /// Only mail from these mailboxes, e.g. the business ones; every mailbox when left out.
    #[serde(default)]
    pub account_ids: Option<Vec<String>>,
    #[serde(default)]
    pub cursor: Option<String>,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub account_ids: Vec<String>,
    pub subject: String,
    pub participants: Vec<Address>,
    pub snippet: String,
    pub last_date: String,
    pub message_count: u32,
    pub unread_count: u32,
    pub flagged: bool,
    pub has_attachments: bool,
    /// Somewhere in the conversation is an unsent draft.
    pub has_draft: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPage {
    pub threads: Vec<ThreadSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageFlags {
    pub seen: bool,
    pub flagged: bool,
    pub answered: bool,
    pub draft: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    pub inline: bool,
    /// For images the HTML shows through `cid:`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_id: Option<String>,
}

/// How a mailing list says to unsubscribe (List-Unsubscribe, RFC 2369 and 8058).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unsubscribe {
    /// The HTTPS link takes a POST without any page (List-Unsubscribe-Post).
    pub one_click: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mailto: Option<String>,
}

/// What unsubscribing did.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UnsubscribeOutcome {
    /// UwUMail unsubscribed on its own (one click or a mail).
    Done,
    /// The sender only offers a web page; the app opens it.
    OpenPage { url: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub thread_id: String,
    pub account_id: String,
    pub folder_id: String,
    pub from: Address,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    /// Blind copies, only known for mail sent from this account.
    #[serde(default)]
    pub bcc: Vec<Address>,
    pub reply_to: Vec<Address>,
    pub subject: String,
    pub date: String,
    pub flags: MessageFlags,
    pub snippet: String,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub has_remote_content: bool,
    pub attachments: Vec<Attachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsubscribe: Option<Unsubscribe>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetail {
    pub thread: ThreadSummary,
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct FlagChange {
    #[serde(default)]
    pub seen: Option<bool>,
    #[serde(default)]
    pub flagged: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AttachmentSource {
    /// The file's content. There is deliberately no "read this path" variant:
    /// the page could otherwise send any file on the disk.
    Base64 { data: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingAttachment {
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    pub source: AttachmentSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingMessage {
    pub account_id: String,
    pub to: Vec<Address>,
    #[serde(default)]
    pub cc: Vec<Address>,
    #[serde(default)]
    pub bcc: Vec<Address>,
    pub subject: String,
    pub html: String,
    pub text: String,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub attachments: Vec<OutgoingAttachment>,
    /// The Message-ID of the draft this was written in. Saving replaces that draft; sending removes it.
    #[serde(default)]
    pub draft_key: Option<String>,
    /// Which of the account's addresses it comes from; the account's own when empty.
    #[serde(default)]
    pub from_email: Option<String>,
}

/// An address a mailbox can send from: its own, aliases the server knows (JMAP), or ones added by hand.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    /// The account id for the mailbox's own address.
    pub id: String,
    pub account_id: String,
    pub email: String,
    pub name: String,
    /// The mailbox's own address; it can be renamed but not removed.
    pub primary: bool,
    /// Comes from the mail server and is managed there.
    pub from_server: bool,
}

/// A signature for one sender address. There can be several; one may be the default for new
/// mail and one for replies.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    /// Empty when saving a new one.
    #[serde(default)]
    pub id: String,
    pub email: String,
    pub name: String,
    pub html: String,
    #[serde(default)]
    pub for_new: bool,
    #[serde(default)]
    pub for_replies: bool,
}

/// The settings a UwUMail server keeps for one login, shared by the webmail and the apps
/// (`UserSettings`, see UwUMail-Server docs/jmap-settings.md). Values are untrusted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSettings {
    /// Changes with every write.
    pub state: String,
    pub values: serde_json::Map<String, serde_json::Value>,
}

/// How a write to the shared settings went. A request that didn't get through is an error instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSettingsSaved {
    pub ok: bool,
    /// The new state after a write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// The JMAP error when it didn't work, e.g. `stateMismatch` or `invalidProperties`.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "type")]
    pub kind: Option<String>,
    /// The refused keys of `invalidProperties`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub properties: Vec<String>,
}

/// The mail rules of an account: the Sieve script called "UwUMail" on its UwUMail server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailRules {
    /// `None` when there is no such script yet.
    pub script: Option<String>,
    /// Whether it's the script the server runs.
    pub active: bool,
}

/// A calendar of one account. Its id starts with the account id, so ids are unique across accounts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInfo {
    pub id: String,
    pub account_id: String,
    pub name: String,
    /// `#rrggbb`.
    pub color: Option<String>,
    pub is_default: bool,
    pub is_visible: bool,
    pub sort_order: i64,
    pub may_write: bool,
    pub may_delete: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Weekday {
    Mo,
    Tu,
    We,
    Th,
    Fr,
    Sa,
    Su,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Frequency {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

/// How an event repeats, as far as the editor can say it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recurrence {
    pub frequency: Frequency,
    pub interval: u32,
    /// Weekly only.
    pub by_day: Option<Vec<Weekday>>,
    /// `YYYY-MM-DD`, inclusive, local.
    pub until: Option<String>,
    pub count: Option<u32>,
}

/// One occurrence of an event, in the viewer's wall time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarOccurrence {
    /// Occurrence id; its own for each instance of a series.
    pub id: String,
    /// The stored event (the whole series for repeating ones).
    pub event_id: String,
    pub account_id: String,
    pub calendar_id: String,
    pub title: String,
    pub description: String,
    pub location: String,
    pub all_day: bool,
    /// `YYYY-MM-DDTHH:mm:ss` in the viewer's zone.
    pub start: String,
    /// Exclusive; all-day events end at the next day's midnight.
    pub end: String,
    /// The event's own zone; none for all-day and floating events.
    pub time_zone: Option<String>,
    pub recurrence: Option<Recurrence>,
    /// False when the stored rule says more than [`Recurrence`] can.
    pub recurrence_editable: bool,
    pub recurrence_id: Option<String>,
    pub read_only: bool,
    pub color: Option<String>,
}

/// An event as the editor fills it in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInput {
    pub calendar_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub location: String,
    pub all_day: bool,
    /// Wall time in `time_zone`; all-day events give dates at midnight, the end exclusive.
    pub start: String,
    pub end: String,
    /// The device's IANA zone for timed events; none for all-day ones.
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub recurrence: Option<Recurrence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventDeleteScope {
    Occurrence,
    Series,
}

/// `null` given for a field, as opposed to leaving it out.
fn present<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarPatch {
    #[serde(default)]
    pub name: Option<String>,
    /// `Some(None)` removes the color.
    #[serde(default, deserialize_with = "present")]
    pub color: Option<Option<String>>,
    #[serde(default)]
    pub is_visible: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCalendar {
    #[serde(default)]
    pub account_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
}

/// Where an account's calendars come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CalendarSource {
    /// JMAP Calendars on a UwUMail server.
    Jmap,
    Caldav,
}

/// Whether an account has calendars, and from where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarAccount {
    pub account_id: String,
    /// None when the account has no calendar here (e.g. signed in with Microsoft or Google).
    pub source: Option<CalendarSource>,
    /// The CalDAV address typed in by hand, if any.
    pub caldav_url: Option<String>,
    /// Why there's no calendar, when there isn't.
    pub problem: Option<String>,
}

/// A blocked sender: on this device, or on the UwUMail server of one account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedSender {
    /// An address or `@domain`; on a server also an IP address, network or host name.
    pub entry: String,
    /// The account whose server keeps the entry; none for the app's own list.
    pub account_id: Option<String>,
    /// The entry's id on that server.
    pub server_id: Option<String>,
}

/// A message that was moved, with the folder it came from, so the move can be undone.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovedMessage {
    pub id: String,
    pub from_folder_id: String,
}

/// A message waiting for its "undo send" time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedSend {
    pub id: String,
    pub send_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDraft {
    pub draft_key: String,
    pub saved_at: String,
}

/// A draft from the Drafts folder, ready to continue writing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftContent {
    pub account_id: String,
    /// The address it was written from, if that's one of the account's.
    pub from_email: Option<String>,
    pub draft_key: Option<String>,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub subject: String,
    pub html: String,
    /// The local id of the message this draft answers, if it is still around.
    pub in_reply_to: Option<String>,
    pub attachments: Vec<OutgoingAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used: Option<String>,
    pub times_contacted: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    Tls,
    Starttls,
    None,
}

impl Security {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tls => "tls",
            Self::Starttls => "starttls",
            Self::None => "none",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "starttls" => Self::Starttls,
            "none" => Self::None,
            _ => Self::Tls,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerSettings {
    pub host: String,
    pub port: u16,
    pub security: Security,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OAuthProvider {
    Microsoft,
    Google,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiscoverySource {
    Ispdb,
    Autoconfig,
    /// Recognised as a Microsoft mailbox, personal or in a company tenant.
    Microsoft,
    Srv,
    Mx,
    Guess,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSettings {
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth: Option<OAuthProvider>,
    pub imap: ServerSettings,
    pub smtp: ServerSettings,
    pub username: String,
    pub source: DiscoverySource,
    /// The JMAP session URL, when the server offers JMAP.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jmap: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAccount {
    pub display_name: String,
    pub email: String,
    pub auth: AuthKind,
    #[serde(default)]
    pub password: Option<String>,
    pub imap: ServerSettings,
    pub smtp: ServerSettings,
    pub username: String,
    pub color: AccountColor,
    #[serde(default)]
    pub protocol: Protocol,
    #[serde(default)]
    pub jmap_url: Option<String>,
    /// The address to sign in with, when it is not the mailbox itself. A shared
    /// mailbox has no sign-in of its own: someone with access to it signs in as
    /// themselves, and their token then opens the shared address. Only used
    /// while adding the mailbox; the refresh token carries it afterwards.
    #[serde(default)]
    pub sign_in_as: Option<String>,
}

/// Events pushed to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum EngineEvent {
    #[serde(rename = "mail:changed", rename_all = "camelCase")]
    MailChanged { account_id: String },
    #[serde(rename = "mail:received", rename_all = "camelCase")]
    MailReceived { account_id: String, message_ids: Vec<String> },
    #[serde(rename = "account:status", rename_all = "camelCase")]
    AccountStatus { account_id: String, status: AccountStatus },
    /// A queued message went out.
    #[serde(rename = "send:done", rename_all = "camelCase")]
    SendDone { send_id: String, account_id: String },
    /// A queued message couldn't be sent; it was kept as a draft where possible.
    #[serde(rename = "send:failed", rename_all = "camelCase")]
    SendFailed { send_id: String, account_id: String, reason: String, message: Box<OutgoingMessage> },
    /// The shared settings of a UwUMail account may have changed; `state` when the server said which.
    #[serde(rename = "settings:changed", rename_all = "camelCase")]
    SettingsChanged {
        account_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        state: Option<String>,
    },
    /// Calendars or events may have changed (JMAP push, or a change made here).
    #[serde(rename = "calendar:changed")]
    CalendarChanged {},
}

impl EngineEvent {
    pub fn name(&self) -> &'static str {
        match self {
            Self::MailChanged { .. } => "mail:changed",
            Self::MailReceived { .. } => "mail:received",
            Self::AccountStatus { .. } => "account:status",
            Self::SendDone { .. } => "send:done",
            Self::SendFailed { .. } => "send:failed",
            Self::SettingsChanged { .. } => "settings:changed",
            Self::CalendarChanged {} => "calendar:changed",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn views_match_the_ui_json() {
        let unified: MailboxView = serde_json::from_str(r#"{"kind":"unified","role":"inbox"}"#).unwrap();
        assert!(matches!(unified, MailboxView::Unified { role: UnifiedRole::Inbox }));

        let folder: MailboxView =
            serde_json::from_str(r#"{"kind":"folder","accountId":"a1","folderId":"f1"}"#).unwrap();
        assert!(matches!(folder, MailboxView::Folder { ref account_id, .. } if account_id == "a1"));
    }

    #[test]
    fn thread_queries_limit_mailboxes_only_when_asked() {
        let view = r#""view":{"kind":"unified","role":"inbox"},"filter":"all","conversations":true,"limit":50"#;
        let every: ThreadQuery = serde_json::from_str(&format!("{{{view}}}")).unwrap();
        assert_eq!(every.account_ids, None);

        let some: ThreadQuery = serde_json::from_str(&format!(r#"{{{view},"accountIds":["a1"]}}"#)).unwrap();
        assert_eq!(some.account_ids, Some(vec!["a1".to_string()]));
    }

    #[test]
    fn calendar_shapes_match_the_ui_json() {
        let changed = serde_json::to_string(&EngineEvent::CalendarChanged {}).unwrap();
        assert_eq!(changed, r#"{"type":"calendar:changed"}"#);

        // Leaving the color out keeps it, null removes it.
        let keep: CalendarPatch = serde_json::from_str(r#"{"name":"Work"}"#).unwrap();
        assert_eq!(keep.color, None);
        let remove: CalendarPatch = serde_json::from_str(r#"{"color":null}"#).unwrap();
        assert_eq!(remove.color, Some(None));
        let set: CalendarPatch = serde_json::from_str(r##"{"color":"#ff66aa","isVisible":false}"##).unwrap();
        assert_eq!(set.color, Some(Some("#ff66aa".into())));
        assert_eq!(set.is_visible, Some(false));

        let input: EventInput = serde_json::from_str(
            r#"{"calendarId":"a:c","title":"Yoga","description":"","location":"","allDay":false,
                "start":"2026-09-24T18:00:00","end":"2026-09-24T19:00:00","timeZone":"Europe/Berlin",
                "recurrence":{"frequency":"weekly","interval":1,"byDay":["th"],"until":null,"count":null}}"#,
        )
        .unwrap();
        assert_eq!(input.recurrence.unwrap().by_day, Some(vec![Weekday::Th]));
        let scope: EventDeleteScope = serde_json::from_str(r#""series""#).unwrap();
        assert_eq!(scope, EventDeleteScope::Series);
    }

    #[test]
    fn events_serialize_like_the_ui_expects() {
        let event = EngineEvent::MailReceived { account_id: "a1".into(), message_ids: vec!["m1".into()] };
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            r#"{"type":"mail:received","accountId":"a1","messageIds":["m1"]}"#
        );
        let status = AccountStatus::Error { message: "nope".into() };
        assert_eq!(serde_json::to_string(&status).unwrap(), r#"{"state":"error","message":"nope"}"#);
    }
}
