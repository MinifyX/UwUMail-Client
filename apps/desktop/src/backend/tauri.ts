import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AssistError, BackendError, type Backend, type BackendErrorCode } from "./backend";
import {
  answerOf,
  assistSettingsUpdate,
  labelCreate,
  labelUpdate,
  providerCreate,
  providerUpdate,
  toAppliedLabels,
  toAssistFeaturesOrNull,
  toAssistLabel,
  toAssistLabels,
  toAssistEstimate,
  toAssistModels,
  toAssistProvider,
  toAssistProviders,
  toAssistScopes,
  toAssistSettings,
  toChatgptLogin,
  toChatgptPoll,
  toComposeText,
  toEvents,
  toLabelLog,
  toSpamCheck,
  toSummaryText,
  toUsage,
  type Raw,
  toLocalModelServers,
} from "./assistConvert";
import type {
  BlockedSender,
  Account,
  AddressBookInfo,
  AssistComposeRequest,
  AssistComposeResult,
  AssistEstimateMethod,
  AssistProbeInput,
  AssistEventsResult,
  AssistLabelInput,
  AssistProviderInput,
  AssistSettingsPatch,
  AssistStreamEvent,
  AssistStreamHandlers,
  AssistSummarizeRequest,
  AssistSummary,
  AttachmentContent,
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
  RemoteImageSize,
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
import type { ImageProxy } from "@/lib/remoteImages";
import { cardFromInput, patchFromInput, toContactRecord, type JmapCard } from "./contacts";
import type { SaveOutcome } from "@/lib/settingsSyncQueue";

/** Where the app hands out a mail's remote pictures (`uwuimg:` in Rust), spelled for this platform. */
let picturesBase: string | null = null;
function pictures(): string {
  picturesBase ??= convertFileSrc("picture", "uwuimg");
  return picturesBase;
}

/** Numbers the page's picture size probes, so one can be stopped. */
let nextProbe = 0;

interface EngineError {
  code: BackendErrorCode;
  message: string;
  /** A refusal of the AI assistant, with the type its server (or this device) gave it. */
  assist?: { type?: unknown; retryAfter?: unknown; properties?: unknown } | null;
}

function isEngineError(value: unknown): value is EngineError {
  return typeof value === "object" && value !== null && "code" in value && "message" in value;
}

/** The engine's error as the page's: an `AssistError` where the assistant refused, else a `BackendError`. */
export function engineError(error: unknown): BackendError {
  if (!isEngineError(error)) return new BackendError("internal", String(error));
  const assist = error.assist;
  if (assist && typeof assist.type === "string") {
    const retryAfter =
      typeof assist.retryAfter === "number" && Number.isFinite(assist.retryAfter) ? assist.retryAfter : null;
    const properties = Array.isArray(assist.properties)
      ? assist.properties.filter((property): property is string => typeof property === "string")
      : [];
    return new AssistError(assist.type, error.message || null, { retryAfter, properties });
  }
  return new BackendError(error.code, error.message);
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw engineError(error);
  }
}

function aborted(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/**
 * A command of the assistant that can stream (`assist_compose`, `assist_summarize`): with handlers
 * the text comes in pieces through a Tauri channel while the model writes, and aborting asks the
 * engine to stop it (`assist_cancel`) and rejects at once with an `AbortError`, as a fetch does.
 * Without handlers the channel stays quiet and only the whole answer comes.
 */
export async function streamCall(
  command: string,
  args: Record<string, unknown>,
  handlers?: AssistStreamHandlers,
): Promise<unknown> {
  const signal = handlers?.signal;
  if (signal?.aborted) throw aborted();
  const streaming = handlers !== undefined && (handlers.onDelta !== undefined || handlers.onSubject !== undefined);
  const streamId = streaming ? crypto.randomUUID() : null;
  let done = false;
  const onEvent = new Channel<AssistStreamEvent>();
  onEvent.onmessage = (event) => {
    if (done || signal?.aborted) return;
    if (event.kind === "subject" && typeof event.subject === "string") handlers?.onSubject?.(event.subject);
    else if (event.kind === "delta" && typeof event.text === "string") handlers?.onDelta?.(event.text);
  };
  const answer = call<unknown>(command, { ...args, streamId, onEvent });
  if (!signal) return answer;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (done) return;
      done = true;
      if (streamId) void call<void>("assist_cancel", { streamId }).catch(() => undefined);
      reject(aborted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    answer.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (done) return;
        done = true;
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (done) return;
        done = true;
        reject(error);
      },
    );
  });
}

const EVENT_NAMES = [
  "mail:changed",
  "mail:received",
  "account:status",
  "send:done",
  "send:failed",
  "compose:mailto",
  "settings:changed",
  "calendar:changed",
  "contacts:changed",
  "update:ready",
  "assist:changed",
] as const;

export class TauriBackend implements Backend {
  readonly kind = "tauri";
  /** One question to the servers at a time, however many parts of the page ask. */
  private askingRuleAccounts: Promise<string[]> | null = null;

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

  putSyncedSignature(signature: Signature) {
    return call<Signature>("put_synced_signature", { signature });
  }

  settingsSyncAccounts() {
    return call<string[]>("settings_sync_accounts");
  }

  loadUserSettings(accountId: string) {
    return call<{ state: string; values: Record<string, unknown> }>("load_user_settings", { accountId });
  }

  async saveUserSettings(accountId: string, patch: Record<string, unknown>, ifInState?: string) {
    const saved = await call<{ ok: boolean; state?: string; type?: string; properties?: string[] }>(
      "save_user_settings",
      { accountId, changes: patch, ifInState: ifInState ?? null },
    );
    const outcome: SaveOutcome = saved.ok
      ? { ok: true, ...(saved.state ? { state: saved.state } : {}) }
      : { ok: false, type: saved.type ?? "serverFail", ...(saved.properties ? { properties: saved.properties } : {}) };
    return outcome;
  }

  ruleAccounts() {
    this.askingRuleAccounts ??= call<string[]>("rule_accounts").finally(() => {
      this.askingRuleAccounts = null;
    });
    return this.askingRuleAccounts;
  }

  async mailRulesAvailable(accountId?: string) {
    const accounts = await this.ruleAccounts();
    return accountId ? accounts.includes(accountId) : accounts.length > 0;
  }

  mailRules(accountId?: string) {
    return call<{ script: string | null; active: boolean }>("mail_rules", { accountId: accountId ?? null });
  }

  saveMailRules(script: string, accountId?: string) {
    return call<void>("save_mail_rules", { script, accountId: accountId ?? null });
  }

  validateMailRules(script: string, accountId?: string) {
    return call<string | null>("validate_mail_rules", { script, accountId: accountId ?? null });
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

  /**
   * Without searching for CalDAV servers, which asks the mail domain's website: an account only that
   * search could answer for counts until the calendar is opened and it runs.
   */
  async calendarsAvailable() {
    const accounts = await call<CalendarAccount[]>("calendar_accounts", { look: false });
    return accounts.some((account) => account.source !== null || !account.checked);
  }

  calendars() {
    return call<CalendarInfo[]>("list_calendars");
  }

  calendarAccounts() {
    return call<CalendarAccount[]>("calendar_accounts", { look: true });
  }

  setCalDavUrl(accountId: string, url: string | null) {
    return call<void>("set_caldav_url", { accountId, url });
  }

  createCalendar(input: { accountId?: string; name: string; color: string | null }) {
    return call<CalendarInfo>("create_calendar", {
      input: { accountId: input.accountId ?? null, name: input.name, color: input.color },
    });
  }

  updateCalendar(id: string, patch: { name?: string; color?: string | null; isVisible?: boolean }) {
    return call<void>("update_calendar", { calendarId: id, patch });
  }

  deleteCalendar(id: string) {
    return call<void>("delete_calendar", { calendarId: id });
  }

  setDefaultCalendar(id: string) {
    return call<void>("set_default_calendar", { calendarId: id });
  }

  calendarEvents(from: string, to: string, timeZone: string) {
    return call<CalendarOccurrence[]>("calendar_events", { from, to, timeZone });
  }

  createEvent(input: EventInput) {
    return call<string>("create_event", { input });
  }

  updateEvent(eventId: string, input: EventInput, occurrenceStart?: string) {
    return call<void>("update_event", { eventId, input, occurrenceStart: occurrenceStart ?? null });
  }

  deleteEvent(occurrenceId: string, scope: EventDeleteScope) {
    return call<void>("delete_event", { occurrenceId, scope });
  }

  birthdayFeatures() {
    return call<BirthdayFeatures[]>("birthday_features");
  }

  scanBirthdays(accountId: string) {
    return call<BirthdayScan>("scan_birthdays", { accountId });
  }

  importBirthdays(accountId: string, entries: BirthdayImportEntry[]) {
    return call<BirthdayImportResult>("import_birthdays", { accountId, entries });
  }

  /**
   * Without searching for CardDAV servers, which asks the mail domain's website: an account only that
   * search could answer for counts until the contacts are opened and it runs.
   */
  async contactsAvailable() {
    const accounts = await call<ContactsAccount[]>("contacts_accounts", { look: false });
    return accounts.some((account) => account.source !== null || !account.checked);
  }

  contactsAccounts() {
    return call<ContactsAccount[]>("contacts_accounts", { look: true });
  }

  setCardDavUrl(accountId: string, url: string | null) {
    return call<void>("set_carddav_url", { accountId, url });
  }

  addressBooks() {
    return call<AddressBookInfo[]>("list_address_books");
  }

  createAddressBook(name: string, accountId?: string) {
    return call<AddressBookInfo>("create_address_book", { accountId: accountId ?? null, name });
  }

  renameAddressBook(id: string, name: string) {
    return call<void>("rename_address_book", { addressBookId: id, name });
  }

  deleteAddressBook(id: string) {
    return call<void>("delete_address_book", { addressBookId: id });
  }

  setDefaultAddressBook(id: string) {
    return call<void>("set_default_address_book", { addressBookId: id });
  }

  async contacts() {
    const entries = await call<{ accountId: string; card: JmapCard }[]>("list_contact_cards");
    return entries.map((entry) => toContactRecord(entry.card, entry.accountId));
  }

  createContact(input: ContactInput) {
    return call<string>("create_contact_card", { addressBookId: input.addressBookId, card: cardFromInput(input) });
  }

  // The card as the server has it now, so only what the editor changed goes back.
  async updateContact(id: string, input: ContactInput) {
    const card = await call<JmapCard>("get_contact_card", { cardId: id });
    const patch = patchFromInput(card, input);
    if (Object.keys(patch).length === 0) return;
    await call<void>("update_contact_card", { cardId: id, patch });
  }

  deleteContact(id: string) {
    return call<void>("delete_contact_card", { cardId: id });
  }

  createFolder(input: { accountId?: string; name: string; parentId: string | null }) {
    return call<string>("create_folder", {
      accountId: input.accountId ?? null,
      name: input.name,
      parentId: input.parentId,
    });
  }

  renameFolder(folderId: string, name: string) {
    return call<void>("rename_folder", { folderId, name });
  }

  deleteFolder(folderId: string) {
    return call<void>("delete_folder", { folderId });
  }

  emptyFolder(folderId: string) {
    return call<number>("empty_folder", { folderId });
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

  deleteForever(messageIds: string[]) {
    return call<number>("delete_messages_forever", { messageIds });
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
    return call<BlockedSender[]>("blocked_senders");
  }

  blockSender(entry: string, accountId?: string) {
    return call<BlockedSender>("block_sender", { entry, accountId: accountId ?? null });
  }

  unblockSender(sender: BlockedSender) {
    return call<void>("unblock_sender", { sender });
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

  async fetchMailImage(url: string): Promise<Blob | null> {
    // A picture the reader already has from the app names its account and address.
    const base = `${pictures()}?`;
    const request = url.startsWith(base) ? new URLSearchParams(url.slice(base.length)) : null;
    const args = request
      ? { accountId: request.get("account"), url: request.get("url") ?? "" }
      : { accountId: null, url };
    const bytes = await call<ArrayBuffer>("fetch_mail_image", args);
    if (bytes.byteLength === 0) return null;
    // Raster formats are recognized by their bytes, SVG only by its type.
    const svg = /^\s*</.test(new TextDecoder().decode(bytes.slice(0, 64)));
    return new Blob([bytes], svg ? { type: "image/svg+xml" } : {});
  }

  companyDomain(email: string) {
    return call<string | null>("get_company_domain", { email });
  }

  imageText(messageId: string, remote: boolean) {
    return call<ImageTextResult>("image_text", { messageId, remote });
  }

  async assistFeatures(accountId: string) {
    return toAssistFeaturesOrNull(await call<unknown>("assist_features", { accountId }));
  }

  async extractEvents(messageId: string, includeImages: boolean): Promise<AssistEventsResult> {
    const raw = await call<Raw | null>("assist_extract_events", { messageId, includeImages });
    const answer = raw && typeof raw.answer === "object" && raw.answer !== null ? answerOf(raw.answer) : null;
    return { events: toEvents(raw), answer };
  }

  async assistScopes() {
    return toAssistScopes(await call<unknown>("assist_scopes"));
  }

  async assistProviders(scope: string) {
    return toAssistProviders(await call<unknown>("assist_providers", { scope }));
  }

  async createAssistProvider(scope: string, input: AssistProviderInput) {
    return toAssistProvider(await call<Raw>("assist_create_provider", { scope, input: providerCreate(input) }));
  }

  async updateAssistProvider(scope: string, id: string, patch: AssistProviderInput) {
    await call<void>("assist_update_provider", { scope, providerId: id, patch: providerUpdate(patch) });
  }

  async deleteAssistProvider(scope: string, id: string) {
    await call<void>("assist_delete_provider", { scope, providerId: id });
  }

  async assistModels(scope: string, providerId: string) {
    return toAssistModels(await call<unknown>("assist_models", { scope, providerId }));
  }

  async assistProbeModels(input: AssistProbeInput) {
    return toAssistModels(
      await call<unknown>("assist_probe_models", {
        input: { kind: input.kind, baseUrl: input.baseUrl, apiKey: input.apiKey ?? null },
      }),
    );
  }

  async assistLocalModels() {
    return toLocalModelServers(await call<unknown>("assist_local_models"));
  }

  async assistEstimate(accountId: string, method: AssistEstimateMethod, args: Record<string, unknown>) {
    return toAssistEstimate(await call<unknown>("assist_estimate", { accountId, method, arguments: args }), method);
  }

  async chatgptLogin(scope: string, providerId: string) {
    return toChatgptLogin(await call<unknown>("assist_chatgpt_login", { scope, providerId }));
  }

  async chatgptPoll(scope: string, providerId: string) {
    return toChatgptPoll(await call<unknown>("assist_chatgpt_poll", { scope, providerId }));
  }

  async assistSettings(scope: string) {
    return toAssistSettings(await call<unknown>("assist_settings", { scope }));
  }

  async updateAssistSettings(scope: string, patch: AssistSettingsPatch) {
    await call<void>("assist_update_settings", { scope, patch: assistSettingsUpdate(patch) });
  }

  async assistUsage(scope: string, days?: number) {
    return toUsage(await call<unknown>("assist_usage", { scope, days: days ?? null }));
  }

  async assistLabels(scope: string) {
    return toAssistLabels(await call<unknown>("assist_labels", { scope }));
  }

  async createAssistLabel(scope: string, input: AssistLabelInput) {
    return toAssistLabel(await call<Raw>("assist_create_label", { scope, input: labelCreate(input) }));
  }

  async updateAssistLabel(scope: string, id: string, patch: Partial<AssistLabelInput>) {
    await call<void>("assist_update_label", { scope, labelId: id, patch: labelUpdate(patch) });
  }

  async deleteAssistLabel(scope: string, id: string) {
    await call<void>("assist_delete_label", { scope, labelId: id });
  }

  async assistLabelLog(scope: string, messageIds: string[] | null, limit?: number) {
    return toLabelLog(await call<unknown>("assist_label_log", { scope, messageIds, limit: limit ?? null }));
  }

  async undoAssistLabels(scope: string, logIds: string[]) {
    await call<void>("assist_undo_labels", { scope, logIds });
  }

  async applyAssistLabels(messageIds: string[]) {
    return toAppliedLabels(await call<unknown>("assist_apply_labels", { messageIds }));
  }

  async recentInboxIds(scope: string, limit: number) {
    const ids = await call<unknown>("assist_recent_inbox", { scope, limit });
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  }

  async assistCompose(
    accountId: string,
    request: AssistComposeRequest,
    handlers?: AssistStreamHandlers,
  ): Promise<AssistComposeResult> {
    const raw = await streamCall("assist_compose", { accountId, request }, handlers);
    return { ...answerOf(raw), ...toComposeText(raw) };
  }

  async assistSummarize(request: AssistSummarizeRequest, handlers?: AssistStreamHandlers): Promise<AssistSummary> {
    const wanted = {
      emailId: request.emailId ?? null,
      threadId: request.threadId ?? null,
      language: request.language ?? null,
    };
    const raw = await streamCall("assist_summarize", { request: wanted }, handlers);
    const summary = toSummaryText(raw);
    return {
      ...answerOf(raw),
      emailId: summary.emailId ?? wanted.emailId,
      threadId: summary.threadId ?? wanted.threadId,
      summary: summary.summary,
    };
  }

  async assistSpamCheck(messageId: string, language?: string) {
    return toSpamCheck(await call<unknown>("assist_spam_check", { messageId, language: language ?? null }), messageId);
  }

  setKeywords(messageIds: string[], keywords: Record<string, boolean>) {
    return call<void>("set_keywords", { messageIds, keywords });
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

  setUpdateChecks(enabled: boolean) {
    return call<void>("set_update_checks", { enabled });
  }

  imageProxy(accountId: string): ImageProxy {
    const base = pictures();
    return (url) => `${base}?account=${encodeURIComponent(accountId)}&url=${encodeURIComponent(url)}`;
  }

  imageSizes(accountId: string): ImageSizeProbe {
    return async (urls, onSize, signal) => {
      if (signal.aborted || urls.length === 0) return;
      const probe = (nextProbe = (nextProbe + 1) % 0x7fffffff);
      const channel = new Channel<RemoteImageSize>();
      channel.onmessage = (size) => {
        if (!signal.aborted) onSize(size);
      };
      // Stops the fetching too, not only the listening: the mail was closed or waited long enough.
      const stop = () => void call<void>("cancel_image_sizes", { probe }).catch(() => {});
      signal.addEventListener("abort", stop, { once: true });
      try {
        await call<void>("image_sizes", { accountId, urls, probe, onSize: channel });
      } finally {
        signal.removeEventListener("abort", stop);
      }
    };
  }

  setPrivacyProxy(proxy: string) {
    return call<void>("set_privacy_proxy", { proxy });
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
