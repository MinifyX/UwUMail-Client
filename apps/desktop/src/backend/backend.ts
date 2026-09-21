import type {
  BlockedSender,
  Account,
  AttachmentContent,
  BackendEvent,
  Contact,
  DiscoveredSettings,
  DraftContent,
  DraftSaveResult,
  FlagChange,
  Folder,
  Identity,
  MailtoDraft,
  MovedMessage,
  NewAccount,
  OutgoingMessage,
  Protocol,
  QueuedSend,
  SenderPicture,
  Signature,
  ThreadDetail,
  ThreadPage,
  ThreadQuery,
  UnsubscribeOutcome,
  UpdateInfo,
} from "./types";
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
  | "oauth_not_configured";

export class BackendError extends Error {
  readonly code: BackendErrorCode;

  constructor(code: BackendErrorCode, message: string) {
    super(message);
    this.name = "BackendError";
    this.code = code;
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
  /** Accounts whose UwUMail server keeps settings for its apps; unreachable ones are left out. */
  settingsSyncAccounts(): Promise<string[]>;
  /** The settings an account's server keeps for all devices, see lib/settingsSync. */
  loadUserSettings(accountId: string): Promise<{ state: string; values: Record<string, unknown> }>;
  /** Sets keys (`null` removes); with `ifInState` only if nothing was written since. */
  saveUserSettings(accountId: string, patch: Record<string, unknown>, ifInState?: string): Promise<SaveOutcome>;
  discoverSettings(email: string): Promise<DiscoveredSettings>;
  /** The page an administrator opens to allow UwUMail for a whole company. */
  microsoftAdminConsentUrl(email: string): Promise<string>;
  addAccount(account: NewAccount): Promise<Account>;
  removeAccount(accountId: string): Promise<void>;
  /** Switches between IMAP/SMTP and JMAP; the mailbox syncs again from scratch. */
  setAccountProtocol(accountId: string, protocol: Protocol): Promise<Account>;
  syncNow(accountId?: string): Promise<void>;

  listFolders(accountId?: string): Promise<Folder[]>;
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
  /** Saves into the account's Drafts folder, replacing the draft's earlier version. */
  saveDraft(draft: OutgoingMessage): Promise<DraftSaveResult>;
  deleteDraft(accountId: string, draftKey: string): Promise<void>;
  openDraft(messageId: string): Promise<DraftContent>;

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
  /** Main domain of a company address (`news.shop.example` → `shop.example`); null for mail providers. */
  companyDomain(email: string): Promise<string | null>;

  /** Whether closing the window keeps UwUMail running in the tray. */
  setRunInBackground(enabled: boolean): Promise<void>;
  /** The mailto: link UwUMail was opened with, handed out once. */
  takeMailto(): Promise<MailtoDraft | null>;

  setUpdateChannel(channel: "stable" | "beta"): Promise<void>;
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
