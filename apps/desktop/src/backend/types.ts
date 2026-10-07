// Shapes shared by the UI and the mail engine. The Rust side serializes the
// same structures with serde (camelCase), see crates/uwumail-core/src/model.rs.

import type { DomainSignatureOverview } from "@/lib/domainSignatures";

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
  /**
   * For a shared mailbox: the account whose sign-in opens it (Microsoft 365), or whose login the
   * mail server shares it with (JMAP). Listed right after it.
   */
  parentId?: string;
  /**
   * For a Microsoft 365 work account: how the search for its shared mailboxes went. A JMAP account
   * has `done` once its server said it shares mailboxes.
   */
  sharedSearch?: SharedSearch;
  /** A shared mailbox the mail server shares with its parent's login: it comes and goes with the server. */
  serverShared?: boolean;
  /** Such a shared mailbox may only be read: no moving, deleting or flagging. */
  readOnly?: boolean;
}

/**
 * The search for a Microsoft 365 account's shared mailboxes: not yet, done, refused because the
 * sign-in predates the Exchange permission (signing in again helps), or Microsoft didn't answer.
 */
export type SharedSearch = "pending" | "done" | "needsSignIn" | "unavailable";

export interface SharedSearchResult {
  state: SharedSearch;
  /** The mailboxes this search added. */
  added: Account[];
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

/** One account's signatures per domain on its UwUMail server (lib/domainSignatures). */
export interface AccountDomainSignatures {
  accountId: string;
  overview: DomainSignatureOverview;
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
  | { kind: "folder"; accountId: string; folderId: string }
  /** Mail with a label, in every folder but trash and junk of the mailboxes the label belongs to. */
  | { kind: "label"; scope: string; labelId: string; keyword: string; accountIds: string[] };

/**
 * A label as a filter: its keyword, on mail of the mailboxes whose label it is. Labels live per
 * UwUMail account (on its server) or on this device for every other mailbox, so the same keyword
 * elsewhere may be a different label.
 */
export interface LabelRef {
  keyword: string;
  accountIds: string[];
}

/** How much mail carries a label, like a folder's counts. */
export interface LabelCount {
  total: number;
  unread: number;
}

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
  /** Label filters that must all hold; one holds when any of its labels is on the mail. */
  labels?: LabelRef[][];
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
  /**
   * The own keywords of its messages (lower case, without the `$` system ones), e.g. the labels
   * the AI assistant set. Missing where the engine keeps none.
   */
  keywords?: string[];
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

/** The way left besides the one click: a mail to the header's address, or the sender's page. */
export type UnsubscribeFallback = "mail" | "page" | null;

export type UnsubscribeOutcome =
  | { kind: "done" }
  | { kind: "openPage"; url: string }
  /** The one click was sent and the sender's side didn't take it; nothing else was done. */
  | { kind: "oneClickFailed"; reason: string; fallback: UnsubscribeFallback };

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
  /** Its own keywords (lower case, without the `$` system ones), e.g. AI assistant labels. */
  keywords?: string[];
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

/** Where a mailbox's mail sent later waits: held by its UwUMail server, or in this device's outbox. */
export type ScheduledKind = "server" | "local";

/** What "send later" can do for a mailbox. */
export interface SendLaterInfo {
  kind: ScheduledKind;
  /** How far ahead a time may be, in seconds. */
  maxDelaySeconds: number;
}

/** A mail waiting for its time, on the UwUMail server or in this device's outbox. */
export interface ScheduledSend {
  id: string;
  accountId: string;
  kind: ScheduledKind;
  /** When it goes (ISO 8601). */
  sendAt: string;
  subject: string;
  to: Address[];
  /** Its time passed but its server couldn't be reached; it is tried again at `sendAt`. */
  retrying?: boolean;
  /**
   * It waits for the person and doesn't go on its own: it couldn't be sent and Drafts couldn't
   * take it (`failed`), or sending broke off when it may have gone out (`unsure`). A new time or
   * "send now" sends it again.
   */
  held?: "failed" | "unsure";
  /** Why it is held. */
  heldReason?: string;
}

/** Which scheduled mail an action is about. */
export type ScheduledRef = Pick<ScheduledSend, "id" | "accountId" | "kind">;

/** What scheduling handed back. */
export interface ScheduledReceipt {
  id: string;
  kind: ScheduledKind;
  sendAt: string;
}

export interface DraftSaveResult {
  draftKey: string;
  savedAt: string;
  /**
   * The saved version's message id, to open it again (see `openDraft`). Missing when the server
   * didn't say where it went: then the composer keeps its full copy on this device.
   */
  messageId?: string | null;
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
/**
 * The picture for an address: a person's photo (a contact's, or their own profile picture), which
 * fills the avatar; a company's brand logo (fills it too, unless it is see-through); or a website
 * icon, which sits on a plain background.
 */
export interface SenderPicture {
  url: string;
  kind: "photo" | "logo" | "icon";
}

/** How a sender picture is looked up. */
export interface SenderPictureLookup {
  /** Only what is known without asking another server: a UwUMail server's own pictures, or the cache. */
  local?: boolean;
  /** Only a company's logo, never a person's picture. */
  logo?: boolean;
  /** Ask again instead of taking the remembered answer, after pictures changed. */
  fresh?: boolean;
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
  /** `mailserver`: the MX host answered with its own autoconfig file. */
  source: "ispdb" | "autoconfig" | "microsoft" | "srv" | "mx" | "mailserver" | "guess";
  /** The JMAP session URL, when the server offers JMAP. */
  jmap?: string;
  /**
   * The server that gets the password, when only the domain's MX record (plain DNS) led to it and it
   * lies on another site than the address. Setup shows it, never only under "advanced".
   */
  viaMx?: string;
  /** The JMAP server is a UwUMail server that makes an app password through a browser sign-in. */
  uwumailLogin?: boolean;
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
  /** What the mailbox is called in UwUMail; the address when left out. */
  accountName?: string;
  /**
   * Sign in with UwUMail instead of a password: the server makes an app password with this name
   * for this device (needs `jmapUrl` and `DiscoveredSettings.uwumailLogin`).
   */
  appPasswordName?: string;
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
  /** A birthdays calendar made from the contacts: read-only, its events open their contact. */
  isBirthdays?: boolean;
  /**
   * Kept only on this device (the birthdays calendar the app makes for a mailbox whose server has
   * none): its colour and visibility are this device's; it can't be renamed or deleted.
   */
  isLocal?: boolean;
  /** Whether it can be shared with people of its UwUMail server (its owner, with the right to). */
  mayShare?: boolean;
  /** For a calendar someone else shared: who did. */
  sharedBy?: { email: string; name: string } | null;
  /** Person id → "read", "write" or "all", for a calendar shared with people of the server. */
  sharedWith?: Record<string, ShareLevel> | null;
}

/** How much a person may do in a shared calendar. */
export type ShareLevel = "read" | "write" | "all";

/** Someone on the same UwUMail server, to share a calendar with. */
export interface Person {
  id: string;
  name: string;
  email: string;
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
  /** Who takes part, the organizer first (at most 50); empty or missing without participants. */
  participants?: EventParticipant[];
  /** An event of a birthdays calendar: whose date it is, and how old or how many years. */
  birthday?: OccurrenceBirthday | null;
}

/** Someone who takes part in an event, with their answer. */
export interface EventParticipant {
  name: string;
  /** Lower case; empty where the event names no address. */
  email: string;
  status: ParticipationStatus;
  organizer: boolean;
}

/** What a birthdays calendar event is for (the server's `uwuBirthday`, or the app's own). */
export interface OccurrenceBirthday {
  contactId: string;
  kind: "birth" | "wedding" | "other";
  /** The label of an "other" date ("Kennenlerntag"). */
  label: string | null;
  name: string;
  /** The year it happened; null when the card doesn't say. */
  year: number | null;
  /** The age (or years) on this occurrence; null without a year or in the year itself. */
  age: number | null;
}

/** A contact's reminder of their birthday and anniversary: days before, at a time of day ("09:00"). */
export interface BirthdayReminder {
  daysBefore: number;
  time: string;
}

/** What birthdays can do for an account. */
export interface BirthdayFeatures {
  accountId: string;
  /** Its server keeps the birthdays calendar and per-contact reminders (a UwUMail server). */
  server: boolean;
  /** Birthday events of its calendars can be moved into its contacts. */
  import: boolean;
}

/** How a birthday event of another calendar fits the contacts (see Backend.scanBirthdays). */
export type BirthdayMatch = "matched" | "known" | "conflict" | "ambiguous" | "unmatched";

/** A birthday found as an event in one of the calendars, with the contacts it may belong to. */
export interface BirthdayCandidate {
  eventId: string;
  calendarId: string;
  title: string;
  /** The name read from the title. */
  name: string;
  /** "YYYY-MM-DD", or "--MM-DD" without a year. */
  birthday: string;
  /** The event can be deleted afterwards (not in a subscribed or read-only calendar). */
  mayDeleteEvent: boolean;
  match: BirthdayMatch;
  /** The contacts it may belong to, the match first. */
  contacts: { contactId: string; name: string; birthday: string | null }[];
}

export interface BirthdayScan {
  candidates: BirthdayCandidate[];
  /** There were more than one scan looks at. */
  truncated: boolean;
}

/** What to do with one found birthday: into a contact, or into a new one with this name. */
export type BirthdayImportEntry =
  { eventId: string; contactId: string; overwrite?: boolean } | { eventId: string; newContactName: string };

export interface BirthdayImportResult {
  imported: { eventId: string; contactId: string; created: boolean; eventDeleted: boolean }[];
  failed: { eventId: string; reason: string }[];
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
  /**
   * JMAP calendars on a UwUMail server, CalDAV, Microsoft Graph (`microsoft`), Google Calendar
   * (`google`), or null when the account has no calendar here.
   */
  source: "jmap" | "caldav" | "microsoft" | "google" | null;
  /** The CalDAV address typed in by hand, if any. */
  caldavUrl: string | null;
  /** Why there's no calendar, when there isn't. */
  problem: string | null;
  /** False while only a search for a CalDAV server could tell; that waits until the calendar opens. */
  checked: boolean;
  /** A Microsoft or Google sign-in from before calendars were asked for: signing in again fixes it. */
  needsSignIn?: boolean;
}

/** An answer to an invitation (iTIP `PARTSTAT`), as the webmail names them. */
export type ParticipationStatus = "needs-action" | "accepted" | "tentative" | "declined";

/** What a scheduling mail says it is (its iCalendar METHOD). */
export type SchedulingMethod = "request" | "cancel" | "reply" | "other";

/** Someone an invitation names, with their answer. */
export interface SchedulingPerson {
  email: string;
  name: string | null;
  status: ParticipationStatus;
}

/**
 * Where an invitation's event is kept and who tells the organizer the answer: the UwUMail server,
 * Microsoft or Google themselves; for `calendar` (the mailbox's CalDAV calendar) and `device` (the
 * calendar "Invitations" on this device) the app, by mail (client only).
 */
export type InvitePlace = "server" | "microsoft" | "google" | "calendar" | "device";

/** The invitation, cancellation or answer a mail carries, with its event as the calendar has it (client only). */
export interface MailScheduling {
  /** "invitation" also for updates and cancellations; "reply" for an answer to the mailbox's own event. */
  kind: "invitation" | "reply";
  method: SchedulingMethod;
  title: string;
  /** UTC ("…Z"), a date for all-day events, or a wall time without zone. */
  start: string | null;
  end: string | null;
  allDay: boolean;
  location: string;
  /** Who invited: their name, else their address. */
  organizer: string | null;
  organizerEmail: string | null;
  /** The organizer first; at most 50. */
  attendees: SchedulingPerson[];
  moreAttendees: number;
  repeats: boolean;
  /** The one date of a series the mail is about, if it is about one. */
  occurrence: string | null;
  /**
   * The mail comes from who may say this: the organizer (for answers someone invited). An
   * unverified one is shown as such, and nothing is offered on its account (WEBMAIL-2).
   */
  verified: boolean;
  /** The mail's From address. */
  sender: string;
  /** The receiving server's Authentication-Results vouch for that address. */
  senderConfirmed: boolean;
  /** Invitations: the mailbox's answer as the calendar has it. Answers: the attendee's. */
  status: ParticipationStatus;
  attendee: string | null;
  attendeeEmail: string | null;
  cancelled: boolean;
  /** How the mail stands to the calendar's copy: "outdated" when the calendar has a newer one. */
  revision: "new" | "same" | "update" | "outdated";
  inCalendar: boolean;
  place: InvitePlace;
  canAnswer: boolean;
  canComment: boolean;
  /** The cancelled event (or date) can be taken out of the calendar. */
  canRemove: boolean;
}

/** An address book of one account (JMAP Contacts, or a CardDAV address book). */
export interface AddressBookInfo {
  id: string;
  accountId: string;
  name: string;
  isDefault: boolean;
  sortOrder: number;
  /** False for address books shared read-only (over CardDAV). */
  mayWrite: boolean;
  mayDelete: boolean;
}

/** Where an email address, phone number or postal address belongs. */
export type ContactKind = "home" | "work" | "other";

/** One entry of a contact; `id` is the entry's key in the card, empty for a new one. */
export interface ContactEmail {
  id: string;
  address: string;
  kind: ContactKind;
}

export interface ContactPhone {
  id: string;
  number: string;
  kind: ContactKind | "mobile";
}

export interface ContactPostal {
  id: string;
  street: string;
  postcode: string;
  locality: string;
  region: string;
  country: string;
  kind: ContactKind;
}

/** A contact as the contacts view shows it: the parts of the card the editor knows. */
export interface ContactRecord {
  id: string;
  accountId: string;
  addressBookId: string;
  /** The name to show: the full name, else given and surname, else the organization or the email. */
  displayName: string;
  given: string;
  surname: string;
  organization: string;
  title: string;
  emails: ContactEmail[];
  phones: ContactPhone[];
  addresses: ContactPostal[];
  /** "YYYY-MM-DD", or "--MM-DD" when the year isn't known. */
  birthday: string | null;
  /** The wedding anniversary, the same way. */
  anniversary?: string | null;
  /** Reminders of the birthday and anniversary (a UwUMail server rings them); none by default. */
  reminders?: BirthdayReminder[];
  note: string;
  /** A picture to show (a data: or https: URL). */
  photo: string | null;
  /**
   * Microsoft or Google keep a photo for this contact apart from it; `contactPhoto` fetches it
   * when the contact opens.
   */
  remotePhoto?: boolean;
  /** A group rather than a person; groups are shown but not edited. */
  isGroup: boolean;
}

/** What the contact editor saves. Entries keep their `id` so what the editor doesn't show stays. */
export interface ContactInput {
  addressBookId: string;
  given: string;
  surname: string;
  organization: string;
  title: string;
  emails: ContactEmail[];
  phones: ContactPhone[];
  addresses: ContactPostal[];
  /** Left as it was when `birthdayChanged` is false. */
  birthday: string | null;
  birthdayChanged: boolean;
  /** Left as it was when `anniversaryChanged` isn't true. */
  anniversary?: string | null;
  anniversaryChanged?: boolean;
  /** Left as they were when undefined. */
  reminders?: BirthdayReminder[];
  note: string;
  /** A new picture (a data: URL), null to remove it, undefined to leave it as it is. */
  photo?: string | null;
}

/** Where an account's address books come from (the app holds several mailboxes). */
export interface ContactsAccount {
  accountId: string;
  /**
   * JMAP Contacts on a UwUMail server, CardDAV, Microsoft Graph (`microsoft`), Google People
   * (`google`), or null when the account has no address books here.
   */
  source: "jmap" | "carddav" | "microsoft" | "google" | null;
  /** The CardDAV address typed in by hand, if any. */
  carddavUrl: string | null;
  /** Why there are no address books, when there aren't. */
  problem: string | null;
  /** False while only a search for a CardDAV server could tell; that waits until the contacts open. */
  checked: boolean;
  /** A Microsoft or Google sign-in from before contacts were asked for: signing in again fixes it. */
  needsSignIn?: boolean;
}

export type BackendEvent =
  | { type: "mail:changed"; accountId: string }
  | { type: "mail:received"; accountId: string; messageIds: string[] }
  | { type: "account:status"; accountId: string; status: AccountStatus }
  /** Mailboxes were added, removed or nested (shared mailboxes found or sorted under their account). */
  | { type: "accounts:changed" }
  | { type: "send:done"; sendId: string; accountId: string }
  | {
      type: "send:failed";
      sendId: string;
      accountId: string;
      reason: string;
      message: OutgoingMessage;
      /** It waits with the scheduled mail instead of in Drafts. */
      held?: boolean;
    }
  /** Mail sent later was scheduled, changed, stopped or sent. */
  | { type: "scheduled:changed" }
  | { type: "compose:mailto" }
  /** The shared settings of a UwUMail account may have changed; `state` when the server said which. */
  | { type: "settings:changed"; accountId: string; state?: string }
  /** Calendars or events may have changed (JMAP push for Calendar/CalendarEvent, or a change made here). */
  | { type: "calendar:changed" }
  /** Address books or contacts changed, here, on the server or on another device. */
  | { type: "contacts:changed" }
  /** The AI assistant's providers, settings or labels changed, here, on the server or on another device. */
  | { type: "assist:changed"; accountId?: string | null }
  | ({ type: "update:ready" } & UpdateInfo);

/** What the server found out about one remote picture of a mail, see `Backend.imageSizes`. */
export interface RemoteImageSize {
  /** The picture's address as the mail has it, not the server's proxy address. */
  url: string;
  /** Pixels; null while the picture loads fine but its size is unknown. */
  width: number | null;
  height: number | null;
  /** The picture can't be had: a dead host, an error, or not a picture. */
  failed: boolean;
}

/**
 * Asks the server for the sizes of a mail's remote pictures. `onSize` runs once per address as
 * soon as the server knows, in any order; the promise settles when every address is answered or
 * the server gave up. It rejects when the server can't be asked at all.
 */
export type ImageSizeProbe = (
  urls: string[],
  onSize: (size: RemoteImageSize) => void,
  signal: AbortSignal,
) => Promise<void>;

/** The text in a mail's pictures: read by a UwUMail server, or by the system's OCR for other mailboxes. */
export interface ImageTextResult {
  /** The app's message id. */
  emailId: string;
  /** Nothing can read pictures here (no OCR on the server or this system); `images` is then empty. */
  unavailable: boolean;
  images: ImageText[];
  /** Pictures the server left out, e.g. too big or too many. */
  skipped: number;
}

export interface ImageText {
  /** `cid:<content-id>` for an embedded picture, `blob:<blobId>` for an attached one, else the https URL. */
  source: string;
  text: string;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------------------------
// AI assistant (UwUMail Server's `urn:uwumail:jmap:assist`, see the server's docs/jmap-assist.md).
// UwUMail accounts ask their server; every other mailbox asks the providers set up on this device,
// from the Rust side (never from this page).

/** The scope id of the providers, settings, labels and usage kept on this device. */
export const DEVICE_ASSIST_SCOPE = "device";

/**
 * Where the assistant's providers, settings, labels and usage live: a UwUMail account's server
 * (its `urn:uwumail:jmap:assist`), or this device for every other mailbox.
 */
export interface AssistScope {
  /** The UwUMail account's id, or `DEVICE_ASSIST_SCOPE`. */
  id: string;
  kind: "server" | "device";
  /** The UwUMail account for a server scope; null for this device. */
  accountId: string | null;
  /** The mailboxes it serves: the UwUMail account, or every mailbox without an assistant of its own. */
  accountIds: string[];
  options: AssistOptions;
}

/**
 * Where the AI assistant would send a mail's content (App Review 5.1.2(i)): a provider set up on
 * this device or a UwUMail server's assistant. A provider on this computer is none.
 */
export interface AiDestination {
  /** `provider:<id>` or `server:<account id>`. */
  destination: string;
  /** The provider's kind (`openai`, `ollama`, …) or `uwumailServer`. */
  kind: string;
  /** The provider's name, or the UwUMail mailbox whose server it is. */
  name: string;
  /** Where it goes (host, and port when not the default). */
  host: string;
}

/** A destination with whether the person agreed to it already. */
export interface AiDestinationState extends AiDestination {
  granted: boolean;
}

/** A consent the person gave, for the settings. */
export interface AiConsent extends AiDestination {
  /** Unix seconds. */
  grantedAt: number;
}

/** A piece of a streamed answer, as the engine hands it to the page. */
export type AssistStreamEvent = { kind: "subject"; subject: string } | { kind: "delta"; text: string };

/** What the assistant does, as the server names it. */
export type AssistFeature = "compose" | "summarize" | "spamCheck" | "extractEvents" | "autoLabels";

export const ASSIST_FEATURES: readonly AssistFeature[] = [
  "compose",
  "summarize",
  "spamCheck",
  "extractEvents",
  "autoLabels",
];

/**
 * Per feature, whether this person can use it right now. `autoLabels` means it *can* be switched
 * on; whether it is on is `AssistSettings.autoLabels`.
 */
export type AssistFeatures = Record<AssistFeature, boolean>;

/** What the server allows the person, from the own account's capability. */
export interface AssistOptions {
  features: AssistFeatures;
  /** People may add providers with their own keys. */
  mayAddProviders: boolean;
  /** Such a provider may point into the local network (Ollama on the LAN). */
  mayUsePrivateAddresses: boolean;
  maxProviders: number;
  maxLabels: number;
  /** How many conditions the rules of one label may have. */
  maxLabelConditions: number;
  maxInstructionChars: number;
  maxTextChars: number;
  /** A server's: the admin lets this person use its assistant for mail of the app's other accounts. */
  foreignMail: boolean;
  /**
   * This device's: the UwUMail accounts whose server may serve the other mailboxes' AI (their
   * `foreignMail`), see `AssistSettings.serverAssist`. Empty for a server scope.
   */
  foreignServers: string[];
  /** The base labels the scope knows; empty on servers before 0.22. */
  baseLabels: LabelBase[];
}

export type AssistProviderKind =
  "openai" | "anthropic" | "gemini" | "mistral" | "openrouter" | "ollama" | "openaiCompatible" | "chatgpt";

/** A way to reach a model: the admin's for the server, or the person's own with their key. */
export interface AssistProvider {
  id: string;
  name: string;
  kind: AssistProviderKind;
  scope: "server" | "personal";
  /** For `ollama` and `openaiCompatible`; null for server providers and fixed addresses. */
  baseUrl: string | null;
  hasKey: boolean;
  /** The last four characters of the key, like `…a1b2`. */
  keyHint: string | null;
  /** The model for writing. */
  model: string | null;
  /** The cheaper model for everything else; `model` when null. */
  fastModel: string | null;
  features: AssistFeature[];
  /** A server provider's daily limit per person. */
  quota: { requestsPerDay: number | null; tokensPerDay: number | null } | null;
  /** `chatgpt`: an unofficial way to use a ChatGPT subscription. */
  experimental: boolean;
  /** `chatgpt`: signed in; others: a key is stored or none is needed. */
  connected: boolean;
  /** Own providers: the price set by hand, USD per million tokens; null follows the known prices. */
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  /** What the default model costs as far as known; null when it isn't (or an older server). */
  price: AssistPrice | null;
}

/** A model's price in USD per million tokens, and where it comes from. */
export interface AssistPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  source: "auto" | "manual" | "free";
}

/** What something costs, in the currency asked for and in USD. */
export interface AssistCost {
  amount: number;
  /** ISO 4217, e.g. `EUR`. */
  currency: string;
  usd: number | null;
}

/** What may be set on an own provider. `apiKey` left out keeps the stored key, `""` removes it. */
export interface AssistProviderInput {
  name?: string;
  /** Only when it is made. */
  kind?: AssistProviderKind;
  baseUrl?: string | null;
  apiKey?: string;
  model?: string | null;
  fastModel?: string | null;
  /** USD per million tokens; null goes back to the known prices. */
  inputPricePerMillion?: number | null;
  outputPricePerMillion?: number | null;
}

export interface AssistModel {
  id: string;
  name: string;
}

/** The models a provider offers, and its settings (or the kind's suggestion). */
export interface AssistModels {
  models: AssistModel[];
  model: string | null;
  fastModel: string | null;
}

/** A model server running on this computer (Ollama, LM Studio), found on its default port. */
export interface LocalModelServer {
  kind: "ollama" | "openaiCompatible";
  /** The program's own name, shown as it is in every language. */
  name: string;
  /** The address a provider for it gets. */
  baseUrl: string;
  models: AssistModel[];
  /** This device has a provider at that address already. */
  added: boolean;
}

/** An address not saved as a provider yet, asked for its models. */
export interface AssistProbeInput {
  kind: AssistProviderKind;
  baseUrl: string;
  apiKey?: string | null;
}

/** The calls whose cost can be estimated before they are made. */
export type AssistEstimateMethod =
  "Assist/compose" | "Assist/summarize" | "Assist/spamCheck" | "Assist/extractEvents" | "AssistLabel/suggest";

/**
 * What one call would take, before it is made: `Assist/estimate` of the UwUMail server, or counted
 * on this device for other mailboxes. `*LeftToday` are null without a daily limit.
 */
export interface AssistEstimate {
  method: AssistEstimateMethod;
  /** Every call's prompt tokens together. */
  inputTokens: number;
  outputTokens: number;
  /** Thinking of reasoning models; 0 from an older server. */
  reasoningTokens: number;
  /** Input, output and reasoning of every call. */
  totalTokens: number;
  /** Pictures sent to the model. */
  imageCount: number;
  /** Every call to a model the request makes; empty from an older server. */
  calls: AssistEstimateCall[];
  /** Corrected by what recent real calls took. */
  calibrated: boolean;
  providerId: string | null;
  providerName: string | null;
  model: string | null;
  tokensLeftToday: number | null;
  requestsLeftToday: number | null;
  /** About what it costs; null where the price is unknown or hidden (or an older server). */
  cost: AssistEstimateCost | null;
}

/** One call to a model of an estimated request. */
export interface AssistEstimateCall {
  /** `main`, `pictures`, `chunk`, `retry`, … */
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  images: number;
  /** How likely the call is made, 0 to 1. */
  weight: number;
}

/** What an estimated request costs, with its worst case and parts (in `currency`) where known. */
export interface AssistEstimateCost extends AssistCost {
  max: { amount: number; usd: number | null } | null;
  parts: { input: number; output: number; reasoning: number; images: number; requests: number; other: number } | null;
}

/** OpenAI's device-code login for a `chatgpt` provider (experimental). */
export interface ChatgptLogin {
  userCode: string;
  verificationUri: string;
  /** Seconds between two polls. */
  interval: number;
  expiresAt: string | null;
}

export interface ChatgptPoll {
  status: "pending" | "connected" | "expired" | "failed";
  description: string | null;
}

/** A provider, and a model of it; `model` null means the provider's own for that feature. */
export interface AssistChoice {
  providerId: string;
  model: string | null;
}

/** What a feature really uses. */
export interface AssistEffective {
  providerId: string;
  providerName: string;
  model: string | null;
  scope: "server" | "personal";
}

export interface AssistSettings {
  /** What every feature uses unless it has its own choice. */
  default: AssistChoice | null;
  features: Record<AssistFeature, AssistChoice | null>;
  /** The model judges the labels of incoming mail (opt-in). */
  autoLabels: boolean;
  /** Labels go on incoming mail by their rules, detectors, learned senders and classifier, without a model. */
  nonAiLabels: boolean;
  /**
   * This device only: the UwUMail account whose server's assistant does every AI feature of the
   * other mailboxes instead of the providers set up here (their mail goes to that server); null
   * for none.
   */
  serverAssist: string | null;
  /** Per feature what will really be used, or null when nothing can. */
  effective: Record<AssistFeature, AssistEffective | null>;
}

/** A change of the settings: only what is named changes, per feature too. */
export interface AssistSettingsPatch {
  default?: AssistChoice | null;
  features?: Partial<Record<AssistFeature, AssistChoice | null>>;
  autoLabels?: boolean;
  nonAiLabels?: boolean;
  serverAssist?: string | null;
}

export interface AssistTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Who answered: comes with every answer of a model. */
export interface AssistAnswer {
  providerId: string;
  providerName: string;
  model: string | null;
  usage: AssistTokenUsage | null;
}

export type AssistComposeMode = "write" | "rewrite" | "adjust";

export type AssistPreset = "formal" | "casual" | "shorter" | "friendlier" | "clearer" | "proofread" | "translate";

export const ASSIST_PRESETS: readonly AssistPreset[] = [
  "formal",
  "casual",
  "shorter",
  "friendlier",
  "clearer",
  "proofread",
  "translate",
];

/** `Assist/compose`: a new text from an instruction, or the draft's text rewritten. */
export interface AssistComposeRequest {
  mode: AssistComposeMode;
  instruction?: string | null;
  preset?: AssistPreset | null;
  /** For `translate`: a language name or tag. */
  targetLanguage?: string | null;
  /** The draft as plain text; needed for `rewrite` and `adjust`. */
  text?: string | null;
  subject?: string | null;
  /** The mail being answered, as context. */
  replyToEmailId?: string | null;
  /** `write` only: also propose a subject. */
  wantSubject?: boolean;
  /** The UI language as a hint. */
  language?: string | null;
}

export interface AssistComposeResult extends AssistAnswer {
  text: string;
  /** A proposed subject, or null. */
  subject: string | null;
}

/** One mail, or a whole conversation. */
export interface AssistSummarizeRequest {
  emailId?: string | null;
  threadId?: string | null;
  language?: string | null;
}

export interface AssistSummary extends AssistAnswer {
  emailId: string | null;
  threadId: string | null;
  /** One or two sentences, then up to five lines starting with `- `. */
  summary: string;
}

/** What the text arrives in while the model writes (the stream endpoint). */
export interface AssistStreamHandlers {
  onSubject?: (subject: string) => void;
  /** The next piece of the text. */
  onDelta?: (text: string) => void;
  /** Aborting closes the request, which stops the model. */
  signal?: AbortSignal;
}

export type AssistVerdict = "legitimate" | "suspicious" | "spam" | "phishing";

/** What the server itself found about a mail, next to the model's opinion. */
export interface AssistSpamSignals {
  /** SPF, DKIM and DMARC as the server recorded them; null each when the mail came from no other server. */
  authentication: {
    spf: string | null;
    dkim: string | null;
    dmarc: string | null;
    fromDomain: string | null;
  };
  /** The spam filter's points and its limit for Junk; null when it did not look. */
  spamScore: number | null;
  spamThreshold: number | null;
  /** The rules that counted. */
  tests: string[];
  inJunk: boolean;
  sender: {
    address: string;
    earlierMessages: number;
    earlierInJunk: number;
    writtenTo: number;
    inContacts: boolean;
    /** When the first mail from it came (UTC), null when this is the first. */
    firstSeen: string | null;
  };
}

export interface AssistSpamCheck extends AssistAnswer {
  emailId: string;
  verdict: AssistVerdict;
  /** 0 to 1. */
  confidence: number;
  /**
   * What the model said when the server or the device moved it back into the range the facts allow
   * (see `facts.allowed`); absent when the verdict is the model's own.
   */
  modelVerdict?: AssistVerdict;
  reasons: string[];
  /**
   * The same reasons with what each rests on: a quote from the mail or one of the facts. Reasons
   * the mail does not back are not in here (only counted in `droppedReasons`).
   */
  reasonDetails: AssistSpamReason[];
  /** How many reasons of the model were left out because nothing in the mail backs them. */
  droppedReasons: number;
  /** What the server or the device weighed before the model said anything; null from older servers. */
  facts: AssistSpamFacts | null;
  signals: AssistSpamSignals;
}

/** A reason of the spam check and the evidence it cites. */
export interface AssistSpamReason {
  text: string;
  /** Words from the mail the reason rests on, as they stand there. */
  quote: string | null;
  /** The fact it rests on (`F3`), when it cites one. */
  fact: string | null;
}

/** How far the facts point towards spam, from "clean" to "spam". */
export type AssistSpamBand = "clean" | "leaningClean" | "unclear" | "leaningSpam" | "spam";

/** One fact that was weighed, by a stable code (`DMARC_PASS`, `LOOKALIKE_BRAND_FROM`, …). */
export interface AssistSpamEvidence {
  code: string;
  tone: "good" | "bad";
  /** How much it moved the score; positive is towards spam. */
  weight: number;
  /** What exactly was seen (a domain, a count); technical, not translated. */
  detail: string | null;
  /** Part of the phishing checks. */
  phishing: boolean;
}

/** The weighing of the facts: they decide the range, the model only explains within it. */
export interface AssistSpamFacts {
  score: number;
  band: AssistSpamBand;
  evidence: AssistSpamEvidence[];
  /** The verdicts the model could choose from. */
  allowed: AssistVerdict[];
  defaultVerdict: AssistVerdict;
}

/** Somebody an event names, with an address from the address book or the mail's headers. */
export interface AssistEventParticipant {
  name: string;
  email: string;
}

/**
 * An appointment, deadline or trip the model read out of a mail. `start` and `end` are JMAP
 * LocalDateTimes (`2026-10-06T09:30:00`); all-day events start at `T00:00:00` and end the day
 * after the last one. `timeZone` is null when the mail names none (use the person's).
 */
export interface AssistEvent {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string | null;
  location: string | null;
  description: string | null;
  /** Only ever an `https` address that is in the mail. */
  url: string | null;
  participants: AssistEventParticipant[];
  /** 0 to 1. */
  confidence: number;
  /** The text it was read from, as it stands in the mail. */
  quote: string;
}

export interface AssistEventsResult {
  events: AssistEvent[];
  /** Who answered; null where the backend doesn't say. */
  answer?: AssistAnswer | null;
}

/** A condition of a label's rules, see the server's docs/labels.md. */
export type LabelConditionField = "from" | "subject" | "text" | "hasAttachment";

export interface LabelCondition {
  field: LabelConditionField;
  /** `hasAttachment` takes "true" or "false". */
  value: string;
}

/** Conditions that put a label on new mail. */
export interface LabelRules {
  match: "all" | "any";
  conditions: LabelCondition[];
}

/** A built-in detector that puts a label on new mail. */
export type LabelDetector =
  "invoice" | "appointment" | "newsletter" | "shipping" | "account" | "personal" | "work" | "advertising";

export const LABEL_DETECTORS: readonly LabelDetector[] = [
  "invoice",
  "appointment",
  "newsletter",
  "shipping",
  "account",
  "personal",
  "work",
  "advertising",
];

/**
 * One of the eight fixed base labels every scope has: its definition is the server's (or this
 * device's) and can't be changed, its name, colour and automatic parts can.
 */
export type LabelBase =
  "invoice" | "shipping" | "appointment" | "newsletter" | "account" | "personal" | "work" | "advertising";
/** In the server's order. */
export const LABEL_BASES: readonly LabelBase[] = [
  "invoice",
  "shipping",
  "appointment",
  "newsletter",
  "account",
  "personal",
  "work",
  "advertising",
];

/** The person's own word for a kind of mail; set on mail as the keyword `keyword`. */
export interface AssistLabel {
  id: string;
  name: string;
  /** What belongs there: what the model reads. A base label's is its fixed definition. */
  description: string;
  keyword: string;
  /** Which base label it is; null for the person's own. */
  base: LabelBase | null;
  /** Put on automatically (detectors, senders, similar mail, classifier, model); off: only by hand. */
  auto: boolean;
  /** `#rrggbb`, or null for the default. */
  color: string | null;
  /** Conditions that put it on new mail; null for none. */
  rules: LabelRules | null;
  detector: LabelDetector | null;
  /** A sender whose mail got it by hand twice gets it on new mail. */
  learnSenders: boolean;
  /** The label's classifier may put it on new mail once it has learned enough. */
  classifier: boolean;
  /** Mail with it in any folder, and of that the unread; null where not known (an older server). */
  totalEmails: number | null;
  unreadEmails: number | null;
  /** Mails the classifier learned as having it (given by hand); it acts from 15 on. */
  examples: number;
  /** The person's own description a base label replaced when it adopted their label; null for none. */
  previousDescription: string | null;
}

export interface AssistLabelInput {
  name: string;
  description: string;
  color: string | null;
  rules?: LabelRules | null;
  detector?: LabelDetector | null;
  learnSenders?: boolean;
  classifier?: boolean;
  auto?: boolean;
}

/** A change to a label: what changes, and `previousDescription: null` to forget an adopted base label's earlier description, so the model no longer gets it as a hint. */
export type AssistLabelPatch = Partial<AssistLabelInput> & { previousDescription?: null };

/** How a label overlaps another: the same name, the meaning of a base label, or largely the same words. */
export type LabelOverlapKind = "name" | "meaning" | "words";

/** A label a new or changed one would overlap with (`AssistLabel/checkOverlap`). */
export interface LabelOverlap {
  id: string;
  name: string;
  base: LabelBase | null;
  kind: LabelOverlapKind;
  /** The words both share (for "words"). */
  words: string[];
}

/** One label's verdict of "Label again" (`AssistLabel/suggest`). */
export interface AssistLabelVerdict {
  labelId: string;
  name: string;
  /** One sentence why, written before the verdict. */
  reason: string;
  fits: boolean;
  /** The label is on the mail now. */
  isSet: boolean;
}

/** A new label the model proposes when none fits. */
export interface AssistNewLabel {
  name: string;
  description: string;
  color: string | null;
  reason: string;
}

export interface AssistLabelSuggestion extends AssistAnswer {
  emailId: string;
  verdicts: AssistLabelVerdict[];
  newLabels: AssistNewLabel[];
}

/**
 * Who put a label on: the model, or without one (the label's rules, a learned sender, a detector,
 * the classifier, or its likeness to the person's mails with the label).
 */
export type LabelSource = "ai" | "rule" | "sender" | "detector" | "classifier" | "similar";

/** A label put on a mail by itself, and why. */
export interface AssistLabelLogEntry {
  id: string;
  emailId: string;
  labelId: string;
  name: string;
  keyword: string;
  source: LabelSource;
  /** English, or the model's own words; `code` and `params` say it for a translation. */
  reason: string;
  /** `ai`, `rule`, `sender`, `classifier`, `similar`, or a detector's name; new ones may come. */
  code: string;
  params: Record<string, unknown>;
  createdAt: string;
  /** Taken off again, with undo or by removing the keyword. */
  undone: boolean;
  /** Who chose it, where the server says (newer servers). */
  providerName: string | null;
  model: string | null;
}

export interface AssistUsageDay {
  day: string;
  providerId: string;
  providerName: string;
  feature: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Thinking, apart from the answer; 0 from an older server. */
  reasoningTokens: number;
  /** Null where the price was unknown or is hidden (or an older server). */
  cost: AssistCost | null;
}

export interface AssistUsageToday {
  providerId: string;
  providerName: string;
  requests: number;
  tokens: number;
  requestsPerDay: number | null;
  tokensPerDay: number | null;
  cost: AssistCost | null;
}

export interface AssistUsage {
  days: AssistUsageDay[];
  today: AssistUsageToday[];
}

/**
 * A masked address: a random address for one website that delivers to the account (Fastmail's
 * MaskedEmail). `pending` ones wait for their first mail, `deleted` ones refuse mail for good.
 */
export type MaskedState = "pending" | "enabled" | "disabled" | "deleted";

export interface MaskedAddress {
  id: string;
  email: string;
  state: MaskedState;
  /** The site it is for, as an origin like `https://shop.example`; empty when not given. */
  forDomain: string;
  description: string;
  /** A link back to where it is used, e.g. a password manager's entry. */
  url: string | null;
  createdAt: string;
  /** When the latest mail to it arrived; null before the first. */
  lastMessageAt: string | null;
  /** Who made it, as the server says (`JMAP`, `Portal`, …). */
  createdBy: string;
}

/** What the server lets the account make masked addresses on. */
export interface MaskedOptions {
  /**
   * The domains a new one may go on; null when the server doesn't say (older servers), which
   * leaves the choice to it. Empty: nobody enabled masked addresses for the account.
   */
  domains: string[] | null;
  /** The one taken when none is named; null leaves it to the server. */
  defaultDomain: string | null;
}

/** A new masked address, made by hand and therefore `enabled` at once. */
export interface MaskedAddressInput {
  description: string;
  forDomain: string;
  url: string | null;
  /** Put in front of the random part: `a-z`, `0-9` and `_`, up to 64. */
  emailPrefix?: string;
  /** One of `MaskedOptions.domains`; the server's default when left out. */
  domain?: string;
}

export interface MaskedAddressPatch {
  /** Never back to `pending`. */
  state?: Exclude<MaskedState, "pending">;
  description?: string;
  forDomain?: string;
  url?: string | null;
}

/** Who sees the own profile picture: nobody, people of the same server, or everyone. */
export type PictureVisibility = "off" | "server" | "public";

export interface ProfilePicture {
  /** The stored picture as a data: URL; null without one. */
  url: string | null;
  visibility: PictureVisibility;
  /** Whether sent mail carries it (a Face header). */
  sendFace: boolean;
  updated: string | null;
}

export interface ProfilePictureOptions {
  /** Largest upload in bytes. */
  maxSize: number;
  /** False while an administrator switched public pictures off. */
  mayBePublic: boolean;
}

export interface ProfilePicturePatch {
  visibility?: PictureVisibility;
  sendFace?: boolean;
}

/** What a mailbox's UwUMail server keeps for the person; mailboxes without any are left out. */
export interface ServerAccountFeatures {
  accountId: string;
  masked: MaskedOptions | null;
  profile: ProfilePictureOptions | null;
}
