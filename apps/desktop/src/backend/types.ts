// Shapes shared by the UI and the mail engine. The Rust side serializes the
// same structures with serde (camelCase), see crates/uwumail-core/src/model.rs.

export type AccountColor = "pink" | "violet" | "sky" | "mint" | "amber" | "coral";

export const ACCOUNT_COLORS: readonly AccountColor[] = ["pink", "violet", "sky", "mint", "amber", "coral"];

export type AuthKind = "password" | "microsoft" | "google";

export type AccountStatus =
  | { state: "idle" }
  | { state: "syncing"; progress?: number }
  | { state: "offline" }
  | { state: "error"; message: string };

export interface Account {
  id: string;
  name: string;
  email: string;
  displayName: string;
  color: AccountColor;
  auth: AuthKind;
  status: AccountStatus;
}

export type FolderRole = "inbox" | "sent" | "drafts" | "archive" | "trash" | "junk";

export interface Folder {
  id: string;
  accountId: string;
  name: string;
  path: string;
  role: FolderRole | null;
  /** The folder this one is nested in. */
  parentId: string | null;
  /** False for containers that hold folders but no messages. */
  selectable: boolean;
  unread: number;
  total: number;
}

export interface Address {
  name?: string;
  email: string;
}

/** Where the message list is looking. */
export type MailboxView =
  | { kind: "unified"; role: "inbox" | "unread" | "flagged" | "drafts" | "sent" }
  | { kind: "folder"; accountId: string; folderId: string };

export type ListFilter = "all" | "unread" | "flagged" | "attachments";

export interface ThreadQuery {
  view: MailboxView;
  filter: ListFilter;
  search?: string;
  conversations: boolean;
  cursor?: string;
  limit: number;
}

export interface ThreadSummary {
  id: string;
  accountIds: string[];
  subject: string;
  participants: Address[];
  snippet: string;
  lastDate: string;
  messageCount: number;
  unreadCount: number;
  flagged: boolean;
  hasAttachments: boolean;
}

export interface ThreadPage {
  threads: ThreadSummary[];
  nextCursor?: string;
}

export interface MessageFlags {
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
}

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
}

export interface Message {
  id: string;
  threadId: string;
  accountId: string;
  folderId: string;
  from: Address;
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  subject: string;
  date: string;
  flags: MessageFlags;
  snippet: string;
  /** Already sanitized by the engine. Never contains scripts. */
  bodyHtml: string | null;
  bodyText: string | null;
  hasRemoteContent: boolean;
  attachments: Attachment[];
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: Message[];
}

export type FlagChange = Partial<Pick<MessageFlags, "seen" | "flagged">>;

export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  size: number;
  /** Base64 content, or a local path when running in the desktop shell. */
  source: { kind: "base64"; data: string } | { kind: "path"; path: string };
}

export interface OutgoingMessage {
  accountId: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  text: string;
  inReplyTo?: string;
  attachments: OutgoingAttachment[];
}

/** A locally available attachment file. `url` works in <img>, <video> and fetch. */
/** A company's brand logo (fills the avatar) or website icon (sits on a plain background). */
export interface SenderPicture {
  url: string;
  kind: "logo" | "icon";
}

export interface AttachmentContent {
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  /** The file type can run code when opened. */
  dangerous: boolean;
}

export interface Contact {
  name?: string;
  email: string;
  lastUsed?: string;
  timesContacted: number;
}

export type Security = "tls" | "starttls" | "none";

export interface ServerSettings {
  host: string;
  port: number;
  security: Security;
}

export interface DiscoveredSettings {
  email: string;
  providerName?: string;
  /** "microsoft" / "google" when the provider requires OAuth sign-in. */
  oauth?: Exclude<AuthKind, "password">;
  imap: ServerSettings;
  smtp: ServerSettings;
  username: string;
  source: "ispdb" | "autoconfig" | "srv" | "mx" | "guess";
}

export interface NewAccount {
  displayName: string;
  email: string;
  auth: AuthKind;
  password?: string;
  imap: ServerSettings;
  smtp: ServerSettings;
  username: string;
  color: AccountColor;
}

export type BackendEvent =
  | { type: "mail:changed"; accountId: string }
  | { type: "mail:received"; accountId: string; messageIds: string[] }
  | { type: "account:status"; accountId: string; status: AccountStatus };
