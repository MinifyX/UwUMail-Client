import type {
  AccountDomainSignatures,
  LabelCount,
  LabelRef,
  BlockedSender,
  Account,
  SharedSearchResult,
  AddressBookInfo,
  AssistComposeRequest,
  AssistComposeResult,
  AssistEstimate,
  AssistEstimateMethod,
  AssistEventsResult,
  AssistFeatures,
  AssistLabel,
  AssistLabelInput,
  AssistLabelLogEntry,
  AssistLabelSuggestion,
  LabelBase,
  LabelOverlap,
  AssistModels,
  AssistProbeInput,
  AssistProvider,
  AssistProviderInput,
  AssistScope,
  AssistSettings,
  AssistSettingsPatch,
  AssistSpamCheck,
  AssistStreamHandlers,
  AssistSummarizeRequest,
  AssistSummary,
  AssistUsage,
  AttachmentContent,
  ChatgptLogin,
  ChatgptPoll,
  BackendEvent,
  BirthdayFeatures,
  BirthdayImportEntry,
  BirthdayImportResult,
  BirthdayScan,
  CalendarAccount,
  CalendarInfo,
  CalendarOccurrence,
  Contact,
  ContactInput,
  ContactRecord,
  ContactsAccount,
  DiscoveredSettings,
  DraftContent,
  DraftSaveResult,
  EventDeleteScope,
  EventInput,
  FlagChange,
  Folder,
  Identity,
  ImageSizeProbe,
  ImageTextResult,
  LocalModelServer,
  MailtoDraft,
  MovedMessage,
  NewAccount,
  OutgoingMessage,
  Protocol,
  QueuedSend,
  ScheduledReceipt,
  ScheduledRef,
  ScheduledSend,
  SendLaterInfo,
  SenderPicture,
  Signature,
  ThreadDetail,
  ThreadPage,
  ThreadQuery,
  UnsubscribeOutcome,
  UpdateInfo,
} from "./types";
import type { DomainSignatureChange } from "@/lib/domainSignatures";
import type { ImageProxy } from "@/lib/remoteImages";
import type { SaveOutcome } from "@/lib/settingsSyncQueue";

export type BackendErrorCode =
  | "auth_failed"
  | "connection_failed"
  | "not_found"
  | "invalid_input"
  | "not_supported"
  | "internal"
  /** An administrator switched IMAP off for this mailbox. */
  | "imap_disabled"
  /** This mailbox may not submit mail over SMTP. */
  | "smtp_disabled"
  /** A company tenant lets only an administrator allow UwUMail. */
  | "admin_consent_required"
  /** This build carries no client id for the provider. */
  | "oauth_not_configured"
  /** The sign-in lacks a permission it needs now (calendars, contacts): signing in again asks for it. */
  | "sign_in_again";

export class BackendError extends Error {
  readonly code: BackendErrorCode;

  constructor(code: BackendErrorCode, message: string) {
    super(message);
    this.name = "BackendError";
    this.code = code;
  }
}

/**
 * A refusal of the AI assistant, with the type its server (or this device) gave it:
 * `assistUnavailable` (switched off, or no provider may do it), `overQuota` (the day's limit is
 * used up), `providerFailed` (the model didn't give a usable answer; `retryAfter` seconds when it
 * named them), `notFound`, `forbidden`, `invalidArguments` or, for a refused create or update,
 * `invalidProperties`.
 */
export class AssistError extends BackendError {
  readonly type: string;
  /** The server's own words, for administrators more than for people. */
  readonly description: string | null;
  readonly retryAfter: number | null;
  /** For `invalidProperties`: the fields it names. */
  readonly properties: string[];

  constructor(
    type: string,
    description: string | null = null,
    extra: { retryAfter?: number | null; properties?: string[]; code?: BackendErrorCode } = {},
  ) {
    super(extra.code ?? assistErrorCode(type), description ?? type);
    this.name = "AssistError";
    this.type = type;
    this.description = description;
    this.retryAfter = extra.retryAfter ?? null;
    this.properties = extra.properties ?? [];
  }
}

function assistErrorCode(type: string): BackendErrorCode {
  switch (type) {
    case "assistUnavailable":
    case "unknownMethod":
    case "unknownCapability":
    case "accountNotSupportedByMethod":
      return "not_supported";
    case "notFound":
      return "not_found";
    case "providerFailed":
      return "connection_failed";
    case "forbidden":
    case "overQuota":
    case "invalidArguments":
    case "invalidProperties":
      return "invalid_input";
    default:
      return "internal";
  }
}

/** Everything the UI needs from the mail engine. */
export interface Backend {
  readonly kind: "tauri" | "demo";

  listAccounts(): Promise<Account[]>;
  /** Each mailbox's own address first, then its aliases. */
  listIdentities(): Promise<Identity[]>;
  addIdentity(accountId: string, email: string, name: string): Promise<Identity>;
  renameIdentity(identityId: string, name: string): Promise<void>;
  removeIdentity(identityId: string): Promise<void>;
  listSignatures(): Promise<Signature[]>;
  saveSignature(signature: Signature): Promise<Signature>;
  deleteSignature(signatureId: string): Promise<void>;
  /** Stores a signature from the settings sync as it came, whether or not its address is set up here. */
  putSyncedSignature(signature: Signature): Promise<Signature>;
  /**
   * Signatures per domain of every account whose UwUMail server has them
   * (`urn:uwumail:jmap:signatures`, lib/domainSignatures); unreachable ones are left out.
   */
  domainSignatures(): Promise<AccountDomainSignatures[]>;
  /** Sets or removes an account's signatures on its server, all or none; returns them after the change. */
  saveDomainSignatures(accountId: string, change: DomainSignatureChange): Promise<AccountDomainSignatures>;
  /** Accounts whose UwUMail server keeps settings for its apps; unreachable ones are left out. */
  settingsSyncAccounts(): Promise<string[]>;
  /** The settings an account's server keeps for all devices, see lib/settingsSync. */
  loadUserSettings(accountId: string): Promise<{ state: string; values: Record<string, unknown> }>;
  /** Sets keys (`null` removes); with `ifInState` only if nothing was written since. */
  saveUserSettings(accountId: string, patch: Record<string, unknown>, ifInState?: string): Promise<SaveOutcome>;
  /** Accounts whose UwUMail server runs mail rules (JMAP with Sieve scripts); unreachable ones are left out. */
  ruleAccounts(): Promise<string[]>;
  /** Whether the mailbox's server runs mail rules (see ruleAccounts); without an id, whether any does. */
  mailRulesAvailable(accountId?: string): Promise<boolean>;
  /** The Sieve script "UwUMail" and whether the server runs it; the first rules account when `accountId` is left out. */
  mailRules(accountId?: string): Promise<{ script: string | null; active: boolean; otherActive?: string | null }>;
  /** Uploads the script as "UwUMail" and makes it the active one. */
  saveMailRules(script: string, accountId?: string): Promise<void>;
  /** What the server finds wrong with the script (error text), or null when it can run it. */
  validateMailRules(script: string, accountId?: string): Promise<string | null>;
  discoverSettings(email: string): Promise<DiscoveredSettings>;
  /** The page an administrator opens to allow UwUMail for a whole company. */
  microsoftAdminConsentUrl(email: string): Promise<string>;
  addAccount(account: NewAccount): Promise<Account>;
  /** Removes a mailbox; a Microsoft account's shared mailboxes go with it unless `keepShared`. */
  removeAccount(accountId: string, options?: { keepShared?: boolean }): Promise<void>;
  /** Searches a Microsoft 365 account for its shared mailboxes now and adds the new ones. */
  findSharedMailboxes(accountId: string): Promise<SharedSearchResult>;
  /** Adds a shared mailbox by address under a Microsoft 365 account, after checking its sign-in opens it. */
  addSharedMailbox(accountId: string, email: string, displayName?: string): Promise<Account>;
  /** Signs in again in the browser (for a shared mailbox: its account), e.g. for a new permission. */
  signInAgain(accountId: string): Promise<Account>;
  /** Switches between IMAP/SMTP and JMAP; the mailbox syncs again from scratch. */
  setAccountProtocol(accountId: string, protocol: Protocol): Promise<Account>;
  syncNow(accountId?: string): Promise<void>;

  /** Whether any account has calendars (see calendarAccounts); without one the calendar stays hidden. */
  calendarsAvailable(): Promise<boolean>;
  /** Every calendar of every account that has some; ids start with the account id. */
  calendars(): Promise<CalendarInfo[]>;
  /** Per account: JMAP calendars, CalDAV, or why there's no calendar (e.g. Microsoft or Google sign-in). */
  calendarAccounts(): Promise<CalendarAccount[]>;
  /** A CalDAV address typed in by hand for an account; null goes back to finding it by itself. */
  setCalDavUrl(accountId: string, url: string | null): Promise<void>;
  createCalendar(input: { accountId?: string; name: string; color: string | null }): Promise<CalendarInfo>;
  updateCalendar(id: string, patch: { name?: string; color?: string | null; isVisible?: boolean }): Promise<void>;
  /** Removes its events too. */
  deleteCalendar(id: string): Promise<void>;
  setDefaultCalendar(id: string): Promise<void>;
  /** Occurrences in [from, to): wall times ("YYYY-MM-DDTHH:mm:ss") in `timeZone`, the viewer's IANA zone. */
  calendarEvents(from: string, to: string, timeZone: string): Promise<CalendarOccurrence[]>;
  /** Returns the event's id. */
  createEvent(input: EventInput): Promise<string>;
  /**
   * The whole series; only changed fields are patched. `occurrenceStart` is the start of the
   * occurrence the edit began from: a repeating event's start moves by as much as that
   * occurrence's start was moved, instead of jumping to its date.
   */
  updateEvent(eventId: string, input: EventInput, occurrenceStart?: string): Promise<void>;
  deleteEvent(occurrenceId: string, scope: EventDeleteScope): Promise<void>;
  /**
   * Per account: whether its server keeps birthdays (calendar and reminders), and whether birthday
   * events of its calendars can be moved into its contacts. Never searches for DAV servers.
   */
  birthdayFeatures(): Promise<BirthdayFeatures[]>;
  /** The birthday events of an account's calendars, each with the contacts it may belong to. */
  scanBirthdays(accountId: string): Promise<BirthdayScan>;
  /**
   * Moves found birthdays into the account's contacts; each event is deleted once its birthday is
   * in the contact, never when that failed. Events left out stay as they are.
   */
  importBirthdays(accountId: string, entries: BirthdayImportEntry[]): Promise<BirthdayImportResult>;

  /** Whether any account has address books (see contactsAccounts); without one the contacts stay hidden. */
  contactsAvailable(): Promise<boolean>;
  /** Per account: JMAP Contacts, CardDAV, or why there are no address books (e.g. Microsoft or Google sign-in). */
  contactsAccounts(): Promise<ContactsAccount[]>;
  /** A CardDAV address typed in by hand for an account; null goes back to finding it by itself. */
  setCardDavUrl(accountId: string, url: string | null): Promise<void>;
  /** Every address book of every account that has some; ids start with the account id. */
  addressBooks(): Promise<AddressBookInfo[]>;
  /** In the given account, or the first one that has address books. */
  createAddressBook(name: string, accountId?: string): Promise<AddressBookInfo>;
  renameAddressBook(id: string, name: string): Promise<void>;
  /** Removes the address book with its contacts. */
  deleteAddressBook(id: string): Promise<void>;
  setDefaultAddressBook(id: string): Promise<void>;
  /** Every contact of every address book. */
  contacts(): Promise<ContactRecord[]>;
  /**
   * The contacts of the accounts whose address books are known already; never searches for a
   * CardDAV server, so opening a mail may use it (Nyu's birthday and contact scenes).
   */
  knownContacts(): Promise<ContactRecord[]>;
  /** Returns the new contact's id. */
  createContact(input: ContactInput): Promise<string>;
  /** Changes what the editor shows and leaves the rest of the card as it is. */
  updateContact(id: string, input: ContactInput): Promise<void>;
  deleteContact(id: string): Promise<void>;

  listFolders(accountId?: string): Promise<Folder[]>;
  /** A new folder below `parentId`, or at the top of the mailbox (the only one when `accountId` is left out). Returns its id. */
  createFolder(input: { accountId?: string; name: string; parentId: string | null }): Promise<string>;
  /** System folders keep their names. */
  renameFolder(folderId: string, name: string): Promise<void>;
  /** Moves its mail into the trash first; refuses while folders are inside. */
  deleteFolder(folderId: string): Promise<void>;
  /** Trash and junk only: deletes everything in it for good. Returns how many messages went. */
  emptyFolder(folderId: string): Promise<number>;
  listThreads(query: ThreadQuery): Promise<ThreadPage>;
  getThread(threadId: string, conversations: boolean): Promise<ThreadDetail>;

  setFlags(messageIds: string[], change: FlagChange): Promise<void>;
  /** These return what moved and from where, for undoing. Mail already in that folder stays and isn't returned. */
  archive(messageIds: string[]): Promise<MovedMessage[]>;
  trash(messageIds: string[]): Promise<MovedMessage[]>;
  /** Deletes mail in the trash for good, on the server too; mail elsewhere stays. Returns how many went. */
  deleteForever(messageIds: string[]): Promise<number>;
  /** Into another folder of the same mailbox. */
  moveMessages(messageIds: string[], folderId: string): Promise<MovedMessage[]>;
  /** Spam goes into the junk folder; not spam back to the inbox. */
  markSpam(messageIds: string[], spam: boolean): Promise<MovedMessage[]>;
  /** The app's own blocked senders, then what each account keeps on its UwUMail server. New mail from them goes to junk. */
  blockedSenders(): Promise<BlockedSender[]>;
  /** One click or a mail where possible; otherwise the page to open. */
  unsubscribe(messageId: string): Promise<UnsubscribeOutcome>;
  /** Inbox mail from an address, e.g. a newsletter's earlier issues. */
  inboxMessagesFrom(email: string): Promise<string[]>;
  /** Blocks on the account's UwUMail server where there is one, otherwise in this app. */
  blockSender(entry: string, accountId?: string): Promise<BlockedSender>;
  unblockSender(sender: BlockedSender): Promise<void>;
  send(message: OutgoingMessage): Promise<void>;
  /** Sends after `delaySeconds` unless `cancelSend` comes first; the result arrives as send:done or send:failed. */
  queueSend(message: OutgoingMessage, delaySeconds: number): Promise<QueuedSend>;
  /** Takes a queued mail back and returns it for the composer. */
  cancelSend(sendId: string): Promise<OutgoingMessage>;
  /** Where this mailbox's mail sent later waits (its UwUMail server or this device) and how far ahead it may go. */
  sendLaterInfo(accountId: string): Promise<SendLaterInfo>;
  /** Sends at `sendAt` (ISO 8601): held by the UwUMail server, or in this device's outbox for every other mailbox. */
  sendLater(message: OutgoingMessage, sendAt: string): Promise<ScheduledReceipt>;
  /** Mail waiting for its time, soonest first. */
  scheduledSends(): Promise<ScheduledSend[]>;
  rescheduleSend(scheduled: ScheduledRef, sendAt: string): Promise<void>;
  sendScheduledNow(scheduled: ScheduledRef): Promise<void>;
  /** Stops it without opening it: it is a draft in Drafts again. */
  stopScheduled(scheduled: ScheduledRef): Promise<void>;
  /** Stops it and returns it for the composer, which saves it as a draft. */
  editScheduled(scheduled: ScheduledRef): Promise<OutgoingMessage>;
  /** Saves into the account's Drafts folder, replacing the draft's earlier version. */
  saveDraft(draft: OutgoingMessage): Promise<DraftSaveResult>;
  deleteDraft(accountId: string, draftKey: string): Promise<void>;
  openDraft(messageId: string): Promise<DraftContent>;

  /** Recipient suggestions: people from the address books first, then addresses learned from mail. */
  searchContacts(query: string): Promise<Contact[]>;

  /** Downloads the attachment on first use. */
  getAttachment(attachmentId: string): Promise<AttachmentContent>;
  /**
   * Opens it in the default app. For files that can run programs the engine
   * asks in a native dialog first; resolves to false when the user declines.
   */
  openAttachment(attachmentId: string): Promise<boolean>;
  /** Asks where to save it in a native dialog. Resolves to false when the user cancels. */
  saveAttachment(attachmentId: string): Promise<boolean>;
  /** The whole mail as an .eml file, where the user picks. False when cancelled. */
  saveMessage(messageId: string): Promise<boolean>;

  /** Brand logo or website icon for a company address; null for people and mail providers. */
  getSenderPicture(email: string): Promise<SenderPicture | null>;
  clearSenderPictures(): Promise<void>;
  /** A remote image of a mail, for dark mode to recolor; null where the page has to do without. */
  fetchMailImage(url: string): Promise<Blob | null>;
  /**
   * Where a mail's remote pictures load from, so their senders never see this device: the app
   * fetches them, through the account's UwUMail server or the privacy proxy. Null where there is
   * no app to do that (the demo); the pictures then load directly.
   */
  imageProxy(accountId: string): ImageProxy | null;
  /**
   * Finds out the sizes of a mail's remote pictures before they load, so each waits in its place
   * (see remotePictures.ts): the account's UwUMail server tells them, for other mailboxes the app
   * reads them from the pictures it fetches, and keeps those for the reader. Null where there is
   * nothing to ask; the pictures then load as they come.
   */
  imageSizes(accountId: string): ImageSizeProbe | null;
  /** The proxy remote pictures, sender pictures and one-click unsubscribes take; empty for none. */
  setPrivacyProxy(proxy: string): Promise<void>;
  /**
   * The text in a mail's pictures, e.g. for dates on a poster: a UwUMail account's server reads
   * them (`Email/imageText`), other mailboxes the system's OCR (macOS, iOS, Windows, Android;
   * `unavailable` on Linux). Remote pictures are only read when `remote` is true, which the reader
   * passes only once they may load.
   */
  imageText(messageId: string, remote: boolean): Promise<ImageTextResult>;
  /**
   * Per feature whether the AI assistant can do it now for this mailbox: its UwUMail server's
   * (`urn:uwumail:jmap:assist`) or the providers set up on this device. Null without an assistant,
   * and everything about it stays hidden.
   */
  assistFeatures(accountId: string): Promise<AssistFeatures | null>;
  /**
   * Appointments, deadlines and trips the assistant reads out of a mail, for "add to calendar".
   * With `includeImages` the text in its pictures is read too (where that works).
   */
  extractEvents(messageId: string, includeImages: boolean): Promise<AssistEventsResult>;
  /**
   * Where the assistant's settings live: one scope per UwUMail account whose server has the
   * assistant, and `"device"` (the providers set up on this device) for every other mailbox, when
   * there is one. Empty without mailboxes.
   */
  assistScopes(): Promise<AssistScope[]>;
  /** A server scope: the server's providers the person may use, then their own. The device: its own. */
  assistProviders(scope: string): Promise<AssistProvider[]>;
  /** Adds an own provider. Throws an `AssistError` (`forbidden`, `overQuota`, `invalidProperties`). */
  createAssistProvider(scope: string, input: AssistProviderInput): Promise<AssistProvider>;
  updateAssistProvider(scope: string, id: string, patch: AssistProviderInput): Promise<void>;
  deleteAssistProvider(scope: string, id: string): Promise<void>;
  /** Asks the provider for its models; doubles as a test of the key. */
  assistModels(scope: string, providerId: string): Promise<AssistModels>;
  /** The models at an Ollama or OpenAI-compatible address not saved yet (this device's scope only). */
  assistProbeModels(input: AssistProbeInput): Promise<AssistModels>;
  /** Ollama and LM Studio running on this computer, with their installed models. */
  assistLocalModels(): Promise<LocalModelServer[]>;
  /**
   * What a call to the assistant would take, for the tooltip on its button. `args` are what the
   * call itself gets (the app's ids); `accountId` the draft's or the mail's mailbox. Null when the
   * mailbox's UwUMail server is too old to say. `currency` (ISO 4217, EUR when left out) is what the
   * cost is given in.
   */
  assistEstimate(
    accountId: string,
    method: AssistEstimateMethod,
    args: Record<string, unknown>,
    currency?: string,
  ): Promise<AssistEstimate | null>;
  /** Starts the device-code sign-in of a server scope's `chatgpt` provider (experimental; not on this device). */
  chatgptLogin(scope: string, providerId: string): Promise<ChatgptLogin>;
  /** Whether that sign-in went through; ask every `interval` seconds while `pending`. */
  chatgptPoll(scope: string, providerId: string): Promise<ChatgptPoll>;
  assistSettings(scope: string): Promise<AssistSettings>;
  updateAssistSettings(scope: string, patch: AssistSettingsPatch): Promise<void>;
  /** What was used: per day (UTC) and feature, and today per provider with its limits; costs in `currency`. */
  assistUsage(scope: string, days?: number, currency?: string): Promise<AssistUsage>;
  assistLabels(scope: string): Promise<AssistLabel[]>;
  createAssistLabel(scope: string, input: AssistLabelInput): Promise<AssistLabel>;
  updateAssistLabel(scope: string, id: string, patch: Partial<AssistLabelInput>): Promise<void>;
  /** Also takes its keyword off every mail (on the server; on this device off the mail it labelled). */
  deleteAssistLabel(scope: string, id: string): Promise<void>;
  /** Makes a deleted base label again (the existing one when it is there). */
  restoreBaseLabel(scope: string, base: LabelBase, auto?: boolean): Promise<AssistLabel>;
  /**
   * Which labels one called `name` with `description` would overlap with; `id` is the label being
   * changed. Changes nothing; an older server without the check says none.
   */
  checkLabelOverlap(scope: string, name: string, description: string, id?: string): Promise<LabelOverlap[]>;
  /** Labels the model set, newest first: for these mails (message ids), or the latest. */
  assistLabelLog(scope: string, messageIds: string[] | null, limit?: number): Promise<AssistLabelLogEntry[]>;
  /** Takes labels the model set off again, by log entry. */
  undoAssistLabels(scope: string, logIds: string[]): Promise<void>;
  /**
   * "Label again": the model judges every label for one mail (also those on it) and, when none
   * fits, proposes up to two new ones. Changes nothing; the page applies what the person ticks.
   */
  suggestLabels(messageId: string, language?: string, suggestNew?: boolean): Promise<AssistLabelSuggestion>;
  /** Asks the model now for these mails (at most 20); label ids per message id. */
  applyAssistLabels(messageIds: string[]): Promise<Record<string, string[]>>;
  /** The newest mails of the scope's inboxes (for labelling mail that came before auto-labels). */
  recentInboxIds(scope: string, limit: number): Promise<string[]>;
  /**
   * Writes or rewrites a text for a draft of `accountId`; nothing goes into the draft. With
   * handlers the text arrives in pieces while the model writes it; the whole answer at the end.
   * `request.replyToEmailId` is a message id.
   */
  assistCompose(
    accountId: string,
    request: AssistComposeRequest,
    handlers?: AssistStreamHandlers,
  ): Promise<AssistComposeResult>;
  /** Summarizes a mail or a conversation (message or thread id), streaming like `assistCompose`. */
  assistSummarize(request: AssistSummarizeRequest, handlers?: AssistStreamHandlers): Promise<AssistSummary>;
  /** A second opinion on a mail, with what is known about it and its sender. */
  assistSpamCheck(messageId: string, language?: string): Promise<AssistSpamCheck>;
  /**
   * Sets (true) or takes off (false) own keywords, e.g. labels by hand. IMAP servers that don't
   * keep own keywords refuse with `not_supported`.
   */
  setKeywords(messageIds: string[], keywords: Record<string, boolean>): Promise<void>;
  /** Per label, how much mail outside trash and junk carries it, and how much of that is unread. */
  labelCounts(labels: LabelRef[]): Promise<LabelCount[]>;
  /** Main domain of a company address (`news.shop.example` → `shop.example`); null for mail providers. */
  companyDomain(email: string): Promise<string | null>;

  /** Whether closing the window keeps UwUMail running in the tray. */
  setRunInBackground(enabled: boolean): Promise<void>;
  /** The mailto: link UwUMail was opened with, handed out once. */
  takeMailto(): Promise<MailtoDraft | null>;

  setUpdateChannel(channel: "stable" | "beta"): Promise<void>;
  /** Whether UwUMail looks for new versions by itself. */
  setUpdateChecks(enabled: boolean): Promise<void>;
  /** A downloaded update waiting for a restart. */
  updateStatus(): Promise<UpdateInfo | null>;
  /** Looks for a new version and downloads it; null when UwUMail is up to date. */
  checkForUpdates(): Promise<UpdateInfo | null>;
  /** Restarts into the waiting update. */
  installUpdate(): Promise<void>;

  subscribe(listener: (event: BackendEvent) => void): () => void;
}

let instance: Backend | null = null;

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function loadBackend(): Promise<Backend> {
  if (instance) return instance;
  if (isTauri()) {
    const { TauriBackend } = await import("./tauri");
    instance = new TauriBackend();
  } else {
    const { DemoBackend } = await import("./demo");
    instance = new DemoBackend();
  }
  return instance;
}

export function backend(): Backend {
  if (!instance) throw new Error("Backend not loaded yet. Call loadBackend() first.");
  return instance;
}
