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
    pub reply_to: Vec<Address>,
    pub subject: String,
    pub date: String,
    pub flags: MessageFlags,
    pub snippet: String,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub has_remote_content: bool,
    pub attachments: Vec<Attachment>,
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
}

impl EngineEvent {
    pub fn name(&self) -> &'static str {
        match self {
            Self::MailChanged { .. } => "mail:changed",
            Self::MailReceived { .. } => "mail:received",
            Self::AccountStatus { .. } => "account:status",
            Self::SendDone { .. } => "send:done",
            Self::SendFailed { .. } => "send:failed",
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
