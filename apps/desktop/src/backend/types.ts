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

/** IMAP for reading plus SMTP for sending, or JMAP for both. */
export type Protocol = "imap" | "jmap";

export interface Account {
  id: string;
  name: string;
  email: string;
  displayName: string;
  color: AccountColor;
  auth: AuthKind;
  status: AccountStatus;
  protocol: Protocol;
  /** Protocols this account can switch to. */
  protocols: Protocol[];
}

/** An address a mailbox can send from. */
export interface Identity {
  /** The account id for the mailbox's own address. */
  id: string;
  accountId: string;
  email: string;
  name: string;
  /** The mailbox's own address: can be renamed, not removed. */
  primary: boolean;
  /** Comes from the mail server and is managed there. */
  fromServer: boolean;
}

/** A signature for one sender address; one can be the default for new mail and one for replies. */
export interface Signature {
  /** Empty when saving a new one. */
  id: string;
  email: string;
  name: string;
  html: string;
  forNew: boolean;
  forReplies: boolean;
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
  /** Only mail from these mailboxes, e.g. the business ones; every mailbox when left out. */
  accountIds?: string[];
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
  /** Somewhere in the conversation is an unsent draft. */
  hasDraft: boolean;
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
  /** For images the HTML shows through `cid:`. */
  contentId?: string;
}

/** How a newsletter says to unsubscribe. */
export interface Unsubscribe {
  /** The HTTPS link takes one POST, no page. */
  oneClick: boolean;
  url?: string;
  mailto?: string;
}

export type UnsubscribeOutcome = { kind: "done" } | { kind: "openPage"; url: string };

export interface Message {
  id: string;
  threadId: string;
  accountId: string;
  folderId: string;
  from: Address;
  to: Address[];
  cc: Address[];
  /** Blind copies; only known for mail sent from this account (and missing in older caches). */
  bcc?: Address[];
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
  unsubscribe?: Unsubscribe;
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
  source: { kind: "base64"; data: string };
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
  /** The draft this was written in: saving replaces it, sending removes it. */
  draftKey?: string;
  /** One of the account's addresses; its own when left out. */
  fromEmail?: string;
}

/** A blocked sender: in this app, or on the UwUMail server of one account. */
export interface BlockedSender {
  /** An address or `@domain`; on a server also an IP address, network or host name. */
  entry: string;
  /** The account whose server keeps the entry; null for the app's own list. */
  accountId: string | null;
  serverId: string | null;
}

/** A moved message and the folder it came from, for undoing. */
export interface MovedMessage {
  id: string;
  fromFolderId: string;
}

/** A mail waiting for its "undo send" time. */
export interface QueuedSend {
  id: string;
  sendAt: string;
}

export interface DraftSaveResult {
  draftKey: string;
  savedAt: string;
}

/** A draft from the Drafts folder, ready to continue writing. */
export interface DraftContent {
  accountId: string;
  fromEmail: string | null;
  draftKey: string | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  /** The local id of the message it answers, if that is still around. */
  inReplyTo: string | null;
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
  source: "ispdb" | "autoconfig" | "microsoft" | "srv" | "mx" | "guess";
  /** The JMAP session URL, when the server offers JMAP. */
  jmap?: string;
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
  protocol: Protocol;
  jmapUrl?: string;
  /**
   * The address to sign in with, when it is not the mailbox itself: a shared
   * mailbox is opened by someone who has access to it.
   */
  signInAs?: string;
}

/** What a mailto: link asks for. */
export interface MailtoDraft {
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  body: string;
}

/** A new UwUMail version, downloaded and waiting for a restart. */
export interface UpdateInfo {
  version: string;
  notes?: string | null;
}

// ----- Calendar (identical in the webmail's src/backend/types.ts) -----

export interface CalendarInfo {
  id: string;
  accountId: string;
  name: string;
  color: string | null;
  isDefault: boolean;
  isVisible: boolean;
  sortOrder: number;
  mayWrite: boolean;
  mayDelete: boolean;
}

export type Weekday = "mo" | "tu" | "we" | "th" | "fr" | "sa" | "su";

export interface Recurrence {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval: number; // >= 1
  byDay: Weekday[] | null; // weekly only
  until: string | null; // "YYYY-MM-DD", inclusive, local
  count: number | null;
}

export interface CalendarOccurrence {
  id: string; // occurrence id (synthetic for instances of a series)
  eventId: string; // id of the stored event (base event for series)
  accountId: string;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  start: string; // local wall time in the viewer's zone "YYYY-MM-DDTHH:mm:ss"
  end: string; // exclusive, same format (all-day: next day T00:00:00)
  timeZone: string | null; // the event's own zone; null for all-day/floating
  recurrence: Recurrence | null; // the series rule, null if not recurring
  recurrenceEditable: boolean; // false when the stored rule is more than Recurrence can say
  recurrenceId: string | null;
  readOnly: boolean; // no write right or not the origin
  color: string | null;
}

export interface EventInput {
  calendarId: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  start: string; // wall time in timeZone; all-day: dates at T00:00:00, end exclusive
  end: string;
  timeZone: string | null; // IANA of the device when timed; null when all-day
  recurrence: Recurrence | null; // untouched when recurrenceEditable was false
}

export type EventDeleteScope = "occurrence" | "series";

/** Where an account's calendars come from (client only). */
export interface CalendarAccount {
  accountId: string;
  /** JMAP calendars on a UwUMail server, CalDAV, or null when the account has no calendar here. */
  source: "jmap" | "caldav" | null;
  /** The CalDAV address typed in by hand, if any. */
  caldavUrl: string | null;
  /** Why there's no calendar, when there isn't (e.g. a Microsoft or Google sign-in). */
  problem: string | null;
}

export type BackendEvent =
  | { type: "mail:changed"; accountId: string }
  | { type: "mail:received"; accountId: string; messageIds: string[] }
  | { type: "account:status"; accountId: string; status: AccountStatus }
  | { type: "send:done"; sendId: string; accountId: string }
  | { type: "send:failed"; sendId: string; accountId: string; reason: string; message: OutgoingMessage }
  | { type: "compose:mailto" }
  /** The shared settings of a UwUMail account may have changed; `state` when the server said which. */
  | { type: "settings:changed"; accountId: string; state?: string }
  /** Calendars or events may have changed (JMAP push for Calendar/CalendarEvent, or a change made here). */
  | { type: "calendar:changed" }
  | ({ type: "update:ready" } & UpdateInfo);
