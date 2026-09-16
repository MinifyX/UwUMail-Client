import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { BackendError, type Backend, type BackendErrorCode } from "./backend";
import type {
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

interface EngineError {
  code: BackendErrorCode;
  message: string;
}

function isEngineError(value: unknown): value is EngineError {
  return typeof value === "object" && value !== null && "code" in value && "message" in value;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (isEngineError(error)) throw new BackendError(error.code, error.message);
    throw new BackendError("internal", String(error));
  }
}

const EVENT_NAMES = [
  "mail:changed",
  "mail:received",
  "account:status",
  "send:done",
  "send:failed",
  "compose:mailto",
  "update:ready",
] as const;

export class TauriBackend implements Backend {
  readonly kind = "tauri";

  listAccounts() {
    return call<Account[]>("list_accounts");
  }

  listIdentities() {
    return call<Identity[]>("list_identities");
  }

  addIdentity(accountId: string, email: string, name: string) {
    return call<Identity>("add_identity", { accountId, email, name });
  }

  renameIdentity(identityId: string, name: string) {
    return call<void>("rename_identity", { identityId, name });
  }

  removeIdentity(identityId: string) {
    return call<void>("remove_identity", { identityId });
  }

  listSignatures() {
    return call<Signature[]>("list_signatures");
  }

  saveSignature(signature: Signature) {
    return call<Signature>("save_signature", { signature });
  }

  deleteSignature(signatureId: string) {
    return call<void>("delete_signature", { signatureId });
  }

  discoverSettings(email: string) {
    return call<DiscoveredSettings>("discover_settings", { email });
  }

  microsoftAdminConsentUrl(email: string) {
    return call<string>("microsoft_admin_consent_url", { email });
  }

  addAccount(account: NewAccount) {
    return call<Account>("add_account", { account });
  }

  removeAccount(accountId: string) {
    return call<void>("remove_account", { accountId });
  }

  setAccountProtocol(accountId: string, protocol: Protocol) {
    return call<Account>("set_account_protocol", { accountId, protocol });
  }

  syncNow(accountId?: string) {
    return call<void>("sync_now", { accountId: accountId ?? null });
  }

  listFolders(accountId?: string) {
    return call<Folder[]>("list_folders", { accountId: accountId ?? null });
  }

  listThreads(query: ThreadQuery) {
    return call<ThreadPage>("list_threads", { query });
  }

  getThread(threadId: string, conversations: boolean) {
    return call<ThreadDetail>("get_thread", { threadId, conversations });
  }

  setFlags(messageIds: string[], change: FlagChange) {
    return call<void>("set_flags", { messageIds, change });
  }

  archive(messageIds: string[]) {
    return call<MovedMessage[]>("archive_messages", { messageIds });
  }

  trash(messageIds: string[]) {
    return call<MovedMessage[]>("trash_messages", { messageIds });
  }

  moveMessages(messageIds: string[], folderId: string) {
    return call<MovedMessage[]>("move_messages", { messageIds, folderId });
  }

  markSpam(messageIds: string[], spam: boolean) {
    return call<MovedMessage[]>("mark_spam", { messageIds, spam });
  }

  unsubscribe(messageId: string) {
    return call<UnsubscribeOutcome>("unsubscribe", { messageId });
  }

  inboxMessagesFrom(email: string) {
    return call<string[]>("inbox_messages_from", { email });
  }

  blockedSenders() {
    return call<string[]>("blocked_senders");
  }

  blockSender(entry: string) {
    return call<string>("block_sender", { entry });
  }

  unblockSender(entry: string) {
    return call<void>("unblock_sender", { entry });
  }

  send(message: OutgoingMessage) {
    return call<void>("send_message", { message });
  }

  queueSend(message: OutgoingMessage, delaySeconds: number) {
    return call<QueuedSend>("queue_send", { message, delaySeconds });
  }

  cancelSend(sendId: string) {
    return call<OutgoingMessage>("cancel_send", { sendId });
  }

  saveDraft(draft: OutgoingMessage) {
    return call<DraftSaveResult>("save_draft", { draft });
  }

  deleteDraft(accountId: string, draftKey: string) {
    return call<void>("delete_draft", { accountId, draftKey });
  }

  openDraft(messageId: string) {
    return call<DraftContent>("open_draft", { messageId });
  }

  async getAttachment(attachmentId: string): Promise<AttachmentContent> {
    const file = await call<{ path: string; filename: string; mimeType: string; size: number; dangerous: boolean }>(
      "get_attachment",
      { attachmentId },
    );
    return {
      url: convertFileSrc(file.path),
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      dangerous: file.dangerous,
    };
  }

  openAttachment(attachmentId: string) {
    return call<boolean>("open_attachment", { attachmentId });
  }

  // On Android this saves to Downloads/UwUMail, elsewhere a native dialog asks where.
  saveMessage(messageId: string) {
    return call<boolean>("save_message", { messageId });
  }

  saveAttachment(attachmentId: string) {
    return call<boolean>("save_attachment", { attachmentId });
  }

  async getSenderPicture(email: string): Promise<SenderPicture | null> {
    const picture = await call<{ path: string; kind: SenderPicture["kind"] } | null>("get_sender_picture", { email });
    return picture && { url: convertFileSrc(picture.path), kind: picture.kind };
  }

  clearSenderPictures() {
    return call<void>("clear_sender_pictures");
  }

  companyDomain(email: string) {
    return call<string | null>("get_company_domain", { email });
  }

  searchContacts(query: string) {
    return call<Contact[]>("search_contacts", { query });
  }

  setRunInBackground(enabled: boolean) {
    return call<void>("set_run_in_background", { enabled });
  }

  takeMailto() {
    return call<MailtoDraft | null>("take_mailto");
  }

  setUpdateChannel(channel: "stable" | "beta") {
    return call<void>("set_update_channel", { channel });
  }

  updateStatus() {
    return call<UpdateInfo | null>("update_status");
  }

  checkForUpdates() {
    return call<UpdateInfo | null>("check_for_updates");
  }

  installUpdate() {
    return call<void>("install_update");
  }

  subscribe(listener: (event: BackendEvent) => void) {
    const unlisteners = EVENT_NAMES.map((name) =>
      listen<Omit<BackendEvent, "type">>(name, (event) => {
        listener({ type: name, ...event.payload } as BackendEvent);
      }),
    );
    return () => {
      for (const pending of unlisteners) void pending.then((unlisten) => unlisten());
    };
  }
}
