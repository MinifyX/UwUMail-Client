import { BackendError, type Backend } from "./backend";
import { isDangerous } from "@/lib/attachments";
import type { SaveOutcome } from "@/lib/settingsSyncQueue";
import { demoAttachmentBlob } from "./demo-attachments";
import { DemoCalendar } from "./demo-calendar";
import { buildFolders, buildMessages, DEMO_ACCOUNTS, welcomeMessage } from "./demo-data";
import { demoSenderPicture } from "./demo-pictures";
import { demoRulesScript, demoValidateSieve } from "./demo-rules";
import type {
  BlockedSender,
  Account,
  AttachmentContent,
  Address,
  BackendEvent,
  Contact,
  DiscoveredSettings,
  DraftContent,
  DraftSaveResult,
  EventDeleteScope,
  EventInput,
  FlagChange,
  Folder,
  Identity,
  MailtoDraft,
  MovedMessage,
  Message,
  NewAccount,
  OutgoingMessage,
  Protocol,
  QueuedSend,
  SenderPicture,
  Signature,
  ThreadDetail,
  ThreadPage,
  ThreadQuery,
  ThreadSummary,
  UnsubscribeOutcome,
  UpdateInfo,
} from "./types";

const OAUTH_DOMAINS: Record<string, "microsoft" | "google"> = {
  "gmail.com": "google",
  "googlemail.com": "google",
  "outlook.com": "microsoft",
  "hotmail.com": "microsoft",
  "live.com": "microsoft",
  "outlook.de": "microsoft",
};

/** Demo domains that pretend to offer JMAP. */
const JMAP_DOMAINS = ["fastmail.com", "fastmail.fm", "uwumail.dev", "stalwart.example"];

const DEMO_FREEMAIL = new Set(["gmail.com", "gmx.de", "web.de", "outlook.com", "icloud.com", "posteo.de", "proton.me"]);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Like the engine: conversations the trash lists hold only their trashed messages. */
const TRASHED_THREAD = "trash:";

function lang(): "de" | "en" {
  return navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
}

function uniqueAddresses(addresses: Address[]): Address[] {
  const seen = new Set<string>();
  return addresses.filter((a) => {
    const key = a.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** In-memory engine with sample data. Used by `pnpm dev` in a normal browser. */
export class DemoBackend implements Backend {
  readonly kind = "demo";

  private accounts: Account[] = structuredClone(DEMO_ACCOUNTS);
  private folders: Folder[] = DEMO_ACCOUNTS.flatMap((a) => buildFolders(a.id, lang()));
  // Newsletters and offers carry a List-Unsubscribe like the real ones.
  private messages: Message[] = buildMessages(lang()).map((message) =>
    /newsletter|aktion|offer|deal/i.test(message.subject)
      ? {
          ...message,
          unsubscribe: {
            oneClick: true,
            url: "https://pixelparts.example/unsubscribe",
            mailto: "mailto:leave@pixelparts.example?subject=unsubscribe",
          },
        }
      : message,
  );
  private listeners = new Set<(event: BackendEvent) => void>();
  private nextId = 1000;
  private attachmentUrls = new Map<string, string>();
  private mailtoTaken = false;
  /** Draft key → the demo message that holds the draft, and what the composer sent. */
  private drafts = new Map<string, { messageId: string; draft: OutgoingMessage }>();
  private blocked: BlockedSender[] = [];
  private signatures: Signature[] = [
    {
      id: "sig-demo",
      email: DEMO_ACCOUNTS[0]!.email,
      name: lang() === "de" ? "Lang" : "Long",
      html:
        lang() === "de"
          ? "<p>Liebe Grüße<br><b>Mini</b> · UwUMail-Team</p>"
          : "<p>Kind regards<br><b>Mini</b> · UwUMail team</p>",
      forNew: true,
      forReplies: true,
    },
  ];
  private identities: Identity[] = [
    {
      id: "id-studio",
      accountId: DEMO_ACCOUNTS[0]!.id,
      email: "hallo@uwumail.dev",
      name: "Mini vom Studio",
      primary: false,
      fromServer: true,
    },
  ];
  private queued = new Map<string, { timer: ReturnType<typeof setTimeout>; message: OutgoingMessage }>();

  constructor() {
    setTimeout(() => {
      const message = welcomeMessage(lang(), `msg-${this.nextId++}`);
      this.messages.push(message);
      this.emit({ type: "mail:received", accountId: message.accountId, messageIds: [message.id] });
      this.emit({ type: "mail:changed", accountId: message.accountId });
    }, 20_000);
  }

  async listAccounts() {
    await wait(80);
    return structuredClone(this.accounts);
  }

  async listIdentities(): Promise<Identity[]> {
    await wait(60);
    const own = this.accounts.map((a) => ({
      id: a.id,
      accountId: a.id,
      email: a.email,
      name: a.displayName,
      primary: true,
      fromServer: false,
    }));
    return structuredClone(own.flatMap((o) => [o, ...this.identities.filter((i) => i.accountId === o.accountId)]));
  }

  async addIdentity(accountId: string, email: string, name: string): Promise<Identity> {
    await wait(120);
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) throw new BackendError("not_found", "Account not found");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      throw new BackendError("invalid_input", `"${email}" isn't a valid email address.`);
    }
    const taken = [account.email, ...this.identities.filter((i) => i.accountId === accountId).map((i) => i.email)];
    if (taken.some((e) => e.toLowerCase() === email.trim().toLowerCase())) {
      throw new BackendError("invalid_input", "This address is already set up.");
    }
    const identity = {
      id: `id-${this.nextId++}`,
      accountId,
      email: email.trim(),
      name: name.trim(),
      primary: false,
      fromServer: false,
    };
    this.identities.push(identity);
    return structuredClone(identity);
  }

  async renameIdentity(identityId: string, name: string) {
    await wait(80);
    const account = this.accounts.find((a) => a.id === identityId);
    if (account) account.displayName = name.trim();
    const identity = this.identities.find((i) => i.id === identityId);
    if (identity) identity.name = name.trim();
  }

  async removeIdentity(identityId: string) {
    await wait(80);
    this.identities = this.identities.filter((i) => i.id !== identityId);
  }

  async listSignatures() {
    await wait(60);
    return structuredClone(this.signatures);
  }

  async saveSignature(signature: Signature) {
    await wait(120);
    const saved = { ...signature, id: signature.id || `sig-${this.nextId++}` };
    const email = saved.email.toLowerCase();
    this.signatures = this.signatures.map((s) =>
      s.email.toLowerCase() === email && s.id !== saved.id
        ? { ...s, forNew: saved.forNew ? false : s.forNew, forReplies: saved.forReplies ? false : s.forReplies }
        : s,
    );
    const index = this.signatures.findIndex((s) => s.id === saved.id);
    if (index >= 0) this.signatures[index] = saved;
    else this.signatures.push(saved);
    return structuredClone(saved);
  }

  async deleteSignature(signatureId: string) {
    await wait(80);
    this.signatures = this.signatures.filter((s) => s.id !== signatureId);
  }

  async putSyncedSignature(signature: Signature) {
    await wait(40);
    const index = this.signatures.findIndex((s) => s.id === signature.id);
    if (index >= 0) this.signatures[index] = structuredClone(signature);
    else this.signatures.push(structuredClone(signature));
    return structuredClone(signature);
  }

  /** The JMAP demo mailbox plays a UwUMail server with the settings extension, in memory. */
  private userSettings = new Map<string, { state: number; values: Record<string, unknown> }>();

  async settingsSyncAccounts() {
    await wait(120);
    return this.accounts.filter((account) => account.protocol === "jmap").map((account) => account.id);
  }

  async loadUserSettings(accountId: string) {
    await wait(60);
    const settings = this.userSettings.get(accountId) ?? { state: 0, values: {} };
    return { state: String(settings.state), values: structuredClone(settings.values) };
  }

  async saveUserSettings(accountId: string, patch: Record<string, unknown>, ifInState?: string): Promise<SaveOutcome> {
    await wait(80);
    const current = this.userSettings.get(accountId) ?? { state: 0, values: {} };
    if (ifInState !== undefined && ifInState !== String(current.state)) return { ok: false, type: "stateMismatch" };
    const values = { ...current.values };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete values[key];
      else values[key] = structuredClone(value);
    }
    const state = current.state + 1;
    this.userSettings.set(accountId, { state, values });
    this.emit({ type: "settings:changed", accountId, state: String(state) });
    return { ok: true, state: String(state) };
  }

  /** The JMAP demo mailbox plays a UwUMail server with Sieve: one rules script per account, in memory. */
  private rules = new Map<string, { script: string | null; active: boolean }>([
    ["acc-private", { script: demoRulesScript(lang()), active: true }],
  ]);

  async ruleAccounts() {
    await wait(100);
    return this.accounts.filter((account) => account.protocol === "jmap").map((account) => account.id);
  }

  async mailRulesAvailable(accountId?: string) {
    const accounts = await this.ruleAccounts();
    return accountId ? accounts.includes(accountId) : accounts.length > 0;
  }

  private rulesAccount(accountId?: string) {
    const account = accountId
      ? this.accounts.find((a) => a.id === accountId)
      : this.accounts.find((a) => a.protocol === "jmap");
    if (!account) throw new BackendError("not_supported", "None of your mailboxes can keep mail rules.");
    if (account.protocol !== "jmap") {
      throw new BackendError("not_supported", "Mail rules need a mailbox on a UwUMail server.");
    }
    return account.id;
  }

  async mailRules(accountId?: string) {
    await wait(150);
    return structuredClone(this.rules.get(this.rulesAccount(accountId)) ?? { script: null, active: false });
  }

  async saveMailRules(script: string, accountId?: string) {
    await wait(250);
    const id = this.rulesAccount(accountId);
    const problem = demoValidateSieve(script);
    if (problem) throw new BackendError("invalid_input", problem);
    this.rules.set(id, { script, active: true });
  }

  async validateMailRules(script: string, accountId?: string) {
    await wait(200);
    this.rulesAccount(accountId);
    return demoValidateSieve(script);
  }

  async microsoftAdminConsentUrl(email: string): Promise<string> {
    const domain = email.split("@")[1]?.toLowerCase() ?? "common";
    return `https://login.microsoftonline.com/${domain}/adminconsent?client_id=demo`;
  }

  async discoverSettings(email: string): Promise<DiscoveredSettings> {
    await wait(700);
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain || !email.includes("@")) throw new BackendError("invalid_input", "Not an email address");
    const oauth = OAUTH_DOMAINS[domain];
    if (oauth === "google") {
      return {
        email,
        providerName: "Google Mail",
        oauth,
        imap: { host: "imap.gmail.com", port: 993, security: "tls" },
        smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
        username: email,
        source: "ispdb",
      };
    }
    if (oauth === "microsoft") {
      return {
        email,
        providerName: "Microsoft 365",
        oauth,
        imap: { host: "outlook.office365.com", port: 993, security: "tls" },
        smtp: { host: "smtp.office365.com", port: 587, security: "starttls" },
        username: email,
        source: "microsoft",
      };
    }
    if (JMAP_DOMAINS.includes(domain)) {
      return {
        email,
        providerName: domain.startsWith("fastmail") ? "Fastmail" : undefined,
        imap: { host: `imap.${domain}`, port: 993, security: "tls" },
        smtp: { host: `smtp.${domain}`, port: 465, security: "tls" },
        username: email,
        source: "autoconfig",
        jmap: domain.startsWith("fastmail")
          ? "https://api.fastmail.com/jmap/session"
          : `https://${domain}/.well-known/jmap`,
      };
    }
    return {
      email,
      imap: { host: `imap.${domain}`, port: 993, security: "tls" },
      smtp: { host: `smtp.${domain}`, port: 465, security: "tls" },
      username: email,
      source: "guess",
    };
  }

  async addAccount(input: NewAccount) {
    await wait(1200);
    // The browser demo has no OAuth round trip: the desktop app opens the
    // provider's page and listens on loopback for the answer. Pretending it
    // worked would show a mailbox that no sign-in stands behind.
    if (input.auth !== "password") {
      throw new BackendError("not_supported", "Signing in with a provider needs the desktop app.");
    }
    if (input.password === "wrong") {
      throw new BackendError("auth_failed", "The server rejected the password.");
    }
    const account: Account = {
      id: `acc-${this.nextId++}`,
      name: input.email.split("@")[1] ?? input.email,
      email: input.email,
      displayName: input.displayName,
      color: input.color,
      auth: input.auth,
      status: { state: "idle" },
      protocol: input.protocol,
      protocols: input.jmapUrl && input.auth === "password" ? ["imap", "jmap"] : ["imap"],
    };
    this.accounts.push(account);
    this.folders.push(...buildFolders(account.id, lang()));
    this.emit({ type: "mail:changed", accountId: account.id });
    return structuredClone(account);
  }

  async setAccountProtocol(accountId: string, protocol: Protocol) {
    await wait(900);
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) throw new BackendError("not_found", "This mailbox no longer exists.");
    if (!account.protocols.includes(protocol)) {
      throw new BackendError("invalid_input", "This mailbox can't use that protocol.");
    }
    account.protocol = protocol;
    this.emit({ type: "mail:changed", accountId });
    return structuredClone(account);
  }

  async removeAccount(accountId: string) {
    this.accounts = this.accounts.filter((a) => a.id !== accountId);
    this.folders = this.folders.filter((f) => f.accountId !== accountId);
    this.messages = this.messages.filter((m) => m.accountId !== accountId);
    this.emit({ type: "mail:changed", accountId });
  }

  async syncNow(accountId?: string) {
    const targets = this.accounts.filter((a) => !accountId || a.id === accountId);
    for (const account of targets) {
      account.status = { state: "syncing" };
      this.emit({ type: "account:status", accountId: account.id, status: account.status });
    }
    await wait(900);
    for (const account of targets) {
      account.status = { state: "idle" };
      this.emit({ type: "account:status", accountId: account.id, status: account.status });
    }
  }

  async listFolders(accountId?: string) {
    await wait(60);
    return this.folders
      .filter((f) => !accountId || f.accountId === accountId)
      .map((folder) => {
        const inFolder = this.messages.filter((m) => m.folderId === folder.id);
        return { ...folder, total: inFolder.length, unread: inFolder.filter((m) => !m.flags.seen).length };
      });
  }

  private calendar = new DemoCalendar(lang(), () => this.emit({ type: "calendar:changed" }));

  async calendars() {
    await wait(100);
    return this.calendar.calendars().filter((c) => this.accounts.some((a) => a.id === c.accountId));
  }

  async calendarsAvailable() {
    return (await this.calendarAccounts()).some((account) => account.source !== null);
  }

  async calendarAccounts() {
    await wait(80);
    return this.calendar.accounts(this.accounts.map((a) => a.id));
  }

  async setCalDavUrl(accountId: string) {
    await wait(80);
    if (!this.accounts.some((a) => a.id === accountId)) throw new BackendError("not_found", "Account not found");
    throw new BackendError("not_supported", "The demo has no CalDAV server.");
  }

  async createCalendar(input: { accountId?: string; name: string; color: string | null }) {
    await wait(150);
    return this.calendar.createCalendar(input);
  }

  async updateCalendar(id: string, patch: { name?: string; color?: string | null; isVisible?: boolean }) {
    await wait(100);
    this.calendar.updateCalendar(id, patch);
  }

  async deleteCalendar(id: string) {
    await wait(150);
    this.calendar.deleteCalendar(id);
  }

  async setDefaultCalendar(id: string) {
    await wait(80);
    this.calendar.setDefaultCalendar(id);
  }

  /** Demo events are floating, so the viewer's zone changes nothing. */
  async calendarEvents(from: string, to: string, _timeZone?: string) {
    await wait(150);
    return this.calendar.occurrences(from, to);
  }

  async createEvent(input: EventInput) {
    await wait(150);
    return this.calendar.createEvent(input);
  }

  async updateEvent(eventId: string, input: EventInput, occurrenceStart?: string) {
    await wait(150);
    this.calendar.updateEvent(eventId, input, occurrenceStart);
  }

  async deleteEvent(occurrenceId: string, scope: EventDeleteScope) {
    await wait(120);
    this.calendar.deleteEvent(occurrenceId, scope);
  }

  async createFolder(input: { accountId?: string; name: string; parentId: string | null }) {
    await wait(150);
    const parent = input.parentId ? this.folders.find((f) => f.id === input.parentId) : undefined;
    if (input.parentId && !parent) throw new BackendError("not_found", "The parent folder no longer exists.");
    const accountId =
      parent?.accountId ?? input.accountId ?? (this.accounts.length === 1 ? this.accounts[0]!.id : null);
    if (!accountId || !this.accounts.some((a) => a.id === accountId)) {
      throw new BackendError("invalid_input", "Pick the mailbox for the new folder.");
    }
    if (parent && input.accountId && parent.accountId !== input.accountId) {
      throw new BackendError("invalid_input", "The parent folder belongs to another mailbox.");
    }
    const name = this.cleanFolderName(input.name, accountId, parent?.id ?? null);
    const id = `${accountId}:f${this.nextId++}`;
    this.folders.push({
      id,
      accountId,
      name,
      path: parent ? `${parent.path}/${name}` : name,
      role: null,
      parentId: parent?.id ?? null,
      selectable: true,
      unread: 0,
      total: 0,
    });
    this.emit({ type: "mail:changed", accountId });
    return id;
  }

  async renameFolder(folderId: string, name: string) {
    await wait(120);
    const folder = this.ownFolder(folderId, "System folders like the inbox or the trash keep their names.");
    const clean = this.cleanFolderName(name, folder.accountId, folder.parentId, folder.id);
    const oldPath = folder.path;
    folder.name = clean;
    folder.path = [...oldPath.split("/").slice(0, -1), clean].join("/");
    for (const inside of this.folders) {
      if (inside.accountId === folder.accountId && inside.path.startsWith(`${oldPath}/`)) {
        inside.path = folder.path + inside.path.slice(oldPath.length);
      }
    }
    this.emit({ type: "mail:changed", accountId: folder.accountId });
  }

  async deleteFolder(folderId: string) {
    await wait(150);
    const folder = this.ownFolder(folderId, "System folders like the inbox or the trash can't be deleted.");
    if (this.folders.some((f) => f.parentId === folderId)) {
      throw new BackendError("invalid_input", "This folder still has folders inside. Move or delete those first.");
    }
    const trash = `${folder.accountId}:trash`;
    for (const message of this.messages) if (message.folderId === folderId) message.folderId = trash;
    this.folders = this.folders.filter((f) => f.id !== folderId);
    this.emit({ type: "mail:changed", accountId: folder.accountId });
  }

  async emptyFolder(folderId: string) {
    await wait(200);
    const folder = this.folders.find((f) => f.id === folderId);
    if (!folder) throw new BackendError("not_found", "This folder no longer exists.");
    if (folder.role !== "trash" && folder.role !== "junk") {
      throw new BackendError("invalid_input", "Only the trash and the junk folder can be emptied.");
    }
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => m.folderId !== folderId);
    this.emit({ type: "mail:changed", accountId: folder.accountId });
    return before - this.messages.length;
  }

  /** A folder people made themselves; system folders stay as they are. */
  private ownFolder(folderId: string, systemFolder: string) {
    const folder = this.folders.find((f) => f.id === folderId);
    if (!folder) throw new BackendError("not_found", "This folder no longer exists.");
    if (folder.role) throw new BackendError("invalid_input", systemFolder);
    return folder;
  }

  /** Like the engine: trimmed, not empty, not too long, no "/" or control characters, not taken next to it. */
  private cleanFolderName(name: string, accountId: string, parentId: string | null, except?: string) {
    const clean = name.trim();
    if (!clean) throw new BackendError("invalid_input", "Enter a name for the folder.");
    if ([...clean].length > 200)
      throw new BackendError("invalid_input", "Folder names can have at most 200 characters.");
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(clean)) {
      throw new BackendError("invalid_input", "Folder names can't contain line breaks or control characters.");
    }
    if (clean.includes("/")) throw new BackendError("invalid_input", 'Folder names can\'t contain "/".');
    const taken = this.folders.some(
      (f) =>
        f.accountId === accountId &&
        f.parentId === parentId &&
        f.id !== except &&
        f.name.toLowerCase() === clean.toLowerCase(),
    );
    if (taken) throw new BackendError("invalid_input", `There's already a folder called "${clean}" here.`);
    return clean;
  }

  async listThreads(query: ThreadQuery): Promise<ThreadPage> {
    await wait(120);
    const matching = this.messages.filter((m) => this.inView(m, query) && this.matchesFilter(m, query));
    const { view } = query;
    const trash = view.kind === "folder" && this.folders.find((f) => f.id === view.folderId)?.role === "trash";
    const groups = new Map<string, Message[]>();
    for (const message of matching) {
      const key = query.conversations ? `${trash ? TRASHED_THREAD : ""}${message.threadId}` : `m:${message.id}`;
      const list = groups.get(key) ?? [];
      list.push(message);
      groups.set(key, list);
    }
    const threads = [...groups.entries()]
      .map(([id, list]) =>
        this.summarize(id, query.conversations ? this.threadMessages(list[0]!.threadId, trash) : list),
      )
      .sort((a, b) => b.lastDate.localeCompare(a.lastDate));
    const offset = query.cursor ? Number(query.cursor) : 0;
    const page = threads.slice(offset, offset + query.limit);
    const next = offset + query.limit;
    return { threads: page, nextCursor: next < threads.length ? String(next) : undefined };
  }

  async getThread(threadId: string, conversations: boolean): Promise<ThreadDetail> {
    await wait(90);
    const list = threadId.startsWith("m:")
      ? this.messages.filter((m) => m.id === threadId.slice(2))
      : threadId.startsWith(TRASHED_THREAD)
        ? this.threadMessages(threadId.slice(TRASHED_THREAD.length), true)
        : this.threadMessages(threadId, false);
    if (list.length === 0) throw new BackendError("not_found", "Thread not found");
    const messages = conversations || threadId.startsWith("m:") ? list : list.slice(-1);
    return { thread: this.summarize(threadId, list), messages: structuredClone(messages) };
  }

  async setFlags(messageIds: string[], change: FlagChange) {
    for (const message of this.messages) {
      if (!messageIds.includes(message.id)) continue;
      if (change.seen !== undefined) message.flags.seen = change.seen;
      if (change.flagged !== undefined) message.flags.flagged = change.flagged;
    }
    this.emitChanged(messageIds);
  }

  async archive(messageIds: string[]) {
    return this.moveToRole(messageIds, "archive");
  }

  async trash(messageIds: string[]) {
    return this.moveToRole(messageIds, "trash");
  }

  async deleteForever(messageIds: string[]) {
    await wait(120);
    const doomed = new Set(
      this.messages.filter((m) => messageIds.includes(m.id) && this.roleOf(m) === "trash").map((m) => m.id),
    );
    this.emitChanged([...doomed]);
    this.messages = this.messages.filter((m) => !doomed.has(m.id));
    return doomed.size;
  }

  async moveMessages(messageIds: string[], folderId: string) {
    await wait(120);
    const folder = this.folders.find((f) => f.id === folderId);
    if (!folder) throw new BackendError("not_found", "This folder no longer exists.");
    const moved: MovedMessage[] = [];
    for (const message of this.messages) {
      if (!messageIds.includes(message.id) || message.folderId === folderId) continue;
      if (message.accountId !== folder.accountId) {
        throw new BackendError("invalid_input", "Mail can only move to folders of its own mailbox.");
      }
      moved.push({ id: message.id, fromFolderId: message.folderId });
      message.folderId = folderId;
    }
    this.emitChanged(messageIds);
    return moved;
  }

  async markSpam(messageIds: string[], spam: boolean) {
    return this.moveToRole(messageIds, spam ? "junk" : "inbox");
  }

  async unsubscribe(messageId: string): Promise<UnsubscribeOutcome> {
    await wait(700);
    const message = this.messages.find((m) => m.id === messageId);
    if (!message?.unsubscribe) throw new BackendError("invalid_input", "This mail has no way to unsubscribe.");
    for (const other of this.messages) {
      if (other.from.email === message.from.email) delete other.unsubscribe;
    }
    return { kind: "done" };
  }

  async inboxMessagesFrom(email: string) {
    await wait(60);
    return this.messages
      .filter((m) => m.from.email.toLowerCase() === email.toLowerCase() && this.roleOf(m) === "inbox")
      .map((m) => m.id);
  }

  async blockedSenders() {
    await wait(40);
    return [...this.blocked];
  }

  async blockSender(entry: string, accountId?: string) {
    await wait(80);
    const normalized = entry.trim().toLowerCase();
    if (!/^(@[^@\s]+\.[^@\s]+|[^@\s]+@[^@\s]+\.[^@\s]+)$/.test(normalized)) {
      throw new BackendError("invalid_input", `"${entry}" isn't an address or @domain.`);
    }
    // The demo's JMAP mailbox plays a UwUMail server that keeps the list itself.
    const onServer = this.accounts.find((account) => account.id === accountId)?.protocol === "jmap";
    const existing = this.blocked.find(
      (sender) => sender.entry === normalized && sender.accountId === (onServer ? accountId : null),
    );
    if (existing) return existing;
    const sender: BlockedSender = {
      entry: normalized,
      accountId: onServer ? accountId! : null,
      serverId: onServer ? `l${this.nextId++}` : null,
    };
    this.blocked.push(sender);
    return sender;
  }

  async unblockSender(sender: BlockedSender) {
    await wait(60);
    this.blocked = this.blocked.filter(
      (other) => !(other.entry === sender.entry && other.accountId === sender.accountId),
    );
  }

  async queueSend(message: OutgoingMessage, delaySeconds: number): Promise<QueuedSend> {
    if (message.to.length + message.cc.length + message.bcc.length === 0) {
      throw new BackendError("invalid_input", "No recipients");
    }
    const id = `send-${this.nextId++}`;
    const timer = setTimeout(() => {
      this.queued.delete(id);
      void this.send(message).then(
        () => this.emit({ type: "send:done", sendId: id, accountId: message.accountId }),
        (reason: unknown) =>
          this.emit({
            type: "send:failed",
            sendId: id,
            accountId: message.accountId,
            reason: reason instanceof Error ? reason.message : String(reason),
            message,
          }),
      );
    }, delaySeconds * 1000);
    this.queued.set(id, { timer, message });
    return { id, sendAt: new Date(Date.now() + delaySeconds * 1000).toISOString() };
  }

  async cancelSend(sendId: string) {
    const entry = this.queued.get(sendId);
    if (!entry) throw new BackendError("invalid_input", "This mail is already on its way.");
    clearTimeout(entry.timer);
    this.queued.delete(sendId);
    return entry.message;
  }

  async saveDraft(draft: OutgoingMessage): Promise<DraftSaveResult> {
    await wait(350);
    const account = this.accounts.find((a) => a.id === draft.accountId);
    if (!account) throw new BackendError("not_found", "Account not found");
    const draftKey = draft.draftKey ?? `demo-${this.nextId++}@${account.email.split("@")[1] ?? "uwumail.dev"}`;
    this.removeDraftMessage(draftKey);
    const original = draft.inReplyTo ? this.messages.find((m) => m.id === draft.inReplyTo) : undefined;
    const id = `msg-${this.nextId++}`;
    this.messages.push({
      id,
      threadId: original?.threadId ?? `thr-${id}`,
      accountId: account.id,
      folderId: `${account.id}:drafts`,
      from: this.senderOf(account, draft.fromEmail),
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      replyTo: [],
      subject: draft.subject,
      date: new Date().toISOString(),
      flags: { seen: true, flagged: false, answered: false, draft: true },
      snippet: draft.text.slice(0, 140),
      bodyHtml: draft.html,
      bodyText: draft.text,
      hasRemoteContent: false,
      attachments: draft.attachments.map((a, i) => ({
        id: `att-${id}-${i}`,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        inline: false,
      })),
    });
    this.drafts.set(draftKey, { messageId: id, draft: { ...draft, draftKey } });
    this.emit({ type: "mail:changed", accountId: account.id });
    return { draftKey, savedAt: new Date().toISOString() };
  }

  async deleteDraft(accountId: string, draftKey: string) {
    await wait(150);
    this.removeDraftMessage(draftKey);
    this.emit({ type: "mail:changed", accountId });
  }

  async openDraft(messageId: string): Promise<DraftContent> {
    await wait(200);
    const entry = [...this.drafts.values()].find((d) => d.messageId === messageId);
    const message = this.messages.find((m) => m.id === messageId);
    if (!message) throw new BackendError("not_found", "This draft no longer exists.");
    const draft = entry?.draft;
    return {
      accountId: message.accountId,
      fromEmail: draft?.fromEmail ?? null,
      draftKey: draft?.draftKey ?? null,
      to: message.to,
      cc: message.cc,
      bcc: draft?.bcc ?? [],
      subject: message.subject,
      html: message.bodyHtml ?? message.bodyText ?? "",
      inReplyTo: draft?.inReplyTo ?? null,
      attachments: draft?.attachments ?? [],
    };
  }

  private senderOf(account: Account, fromEmail?: string): Address {
    const identity = this.identities.find(
      (i) => i.accountId === account.id && i.email.toLowerCase() === fromEmail?.toLowerCase(),
    );
    return identity
      ? { name: identity.name || account.displayName, email: identity.email }
      : { name: account.displayName, email: account.email };
  }

  private removeDraftMessage(draftKey: string) {
    const entry = this.drafts.get(draftKey);
    if (!entry) return;
    this.messages = this.messages.filter((m) => m.id !== entry.messageId);
    this.drafts.delete(draftKey);
  }

  async send(outgoing: OutgoingMessage) {
    await wait(900);
    if (outgoing.to.length + outgoing.cc.length + outgoing.bcc.length === 0) {
      throw new BackendError("invalid_input", "No recipients");
    }
    const account = this.accounts.find((a) => a.id === outgoing.accountId);
    if (!account) throw new BackendError("not_found", "Account not found");
    if (outgoing.draftKey) this.removeDraftMessage(outgoing.draftKey);
    const original = outgoing.inReplyTo ? this.messages.find((m) => m.id === outgoing.inReplyTo) : undefined;
    const id = `msg-${this.nextId++}`;
    if (original) original.flags.answered = true;
    this.messages.push({
      id,
      threadId: original?.threadId ?? `thr-${id}`,
      accountId: account.id,
      folderId: `${account.id}:sent`,
      from: this.senderOf(account, outgoing.fromEmail),
      to: outgoing.to,
      cc: outgoing.cc,
      bcc: outgoing.bcc,
      replyTo: [],
      subject: outgoing.subject,
      date: new Date().toISOString(),
      flags: { seen: true, flagged: false, answered: false, draft: false },
      snippet: outgoing.text.slice(0, 140),
      bodyHtml: outgoing.html,
      bodyText: outgoing.text,
      hasRemoteContent: false,
      attachments: outgoing.attachments.map((a, i) => ({
        id: `att-${id}-${i}`,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        inline: false,
      })),
    });
    this.emit({ type: "mail:changed", accountId: account.id });
  }

  async getAttachment(attachmentId: string): Promise<AttachmentContent> {
    await wait(250);
    const attachment = this.messages.flatMap((m) => m.attachments).find((a) => a.id === attachmentId);
    if (!attachment) throw new BackendError("not_found", "This attachment no longer exists.");
    let url = this.attachmentUrls.get(attachmentId);
    if (!url) {
      url = URL.createObjectURL(demoAttachmentBlob(attachment.filename, attachment.mimeType));
      this.attachmentUrls.set(attachmentId, url);
    }
    return {
      url,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      dangerous: isDangerous(attachment.filename),
    };
  }

  async openAttachment(attachmentId: string) {
    const file = await this.getAttachment(attachmentId);
    // Stands in for the engine's native warning dialog.
    if (file.dangerous && !window.confirm(`"${file.filename}" can run programs. Open anyway?`)) return false;
    window.open(file.url, "_blank", "noopener,noreferrer");
    return true;
  }

  async saveMessage(messageId: string) {
    const message = this.messages.find((m) => m.id === messageId);
    if (!message) throw new BackendError("not_found", "This message no longer exists.");
    const eml = [
      `From: ${message.from.name ?? ""} <${message.from.email}>`,
      `To: ${message.to.map((a) => a.email).join(", ")}`,
      `Subject: ${message.subject}`,
      `Date: ${new Date(message.date).toUTCString()}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      message.bodyHtml ?? message.bodyText ?? "",
    ].join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([eml], { type: "message/rfc822" }));
    link.download = `${message.subject || "Mail"}.eml`;
    link.click();
    return true;
  }

  async saveAttachment(attachmentId: string) {
    const file = await this.getAttachment(attachmentId);
    // Stands in for the engine's native warning dialog, as when opening.
    if (file.dangerous && !window.confirm(`"${file.filename}" can run programs. Save anyway?`)) return false;
    const link = document.createElement("a");
    link.href = file.url;
    link.download = file.filename;
    link.click();
    return true;
  }

  async getSenderPicture(email: string): Promise<SenderPicture | null> {
    await wait(150);
    return demoSenderPicture(email);
  }

  async clearSenderPictures() {
    await wait(100);
  }

  async fetchMailImage(): Promise<Blob | null> {
    // The demo's images are embedded; remote ones can only be read where their server allows it.
    return null;
  }

  async companyDomain(email: string) {
    // Good enough for made-up addresses; the real engine uses the public suffix list.
    const labels = (email.split("@")[1] ?? "").toLowerCase().split(".").filter(Boolean);
    const domain = labels.slice(-2).join(".");
    return labels.length < 2 || DEMO_FREEMAIL.has(domain) ? null : domain;
  }

  async searchContacts(query: string): Promise<Contact[]> {
    const q = query.trim().toLowerCase();
    const counts = new Map<string, Contact>();
    for (const message of this.messages) {
      for (const address of [message.from, ...message.to, ...message.cc]) {
        if (this.accounts.some((a) => a.email === address.email)) continue;
        const key = address.email.toLowerCase();
        const existing = counts.get(key);
        if (existing) existing.timesContacted += 1;
        else counts.set(key, { name: address.name, email: address.email, timesContacted: 1, lastUsed: message.date });
      }
    }
    return [...counts.values()]
      .filter((c) => !q || c.email.toLowerCase().includes(q) || c.name?.toLowerCase().includes(q))
      .sort((a, b) => b.timesContacted - a.timesContacted)
      .slice(0, 8);
  }

  async setRunInBackground() {}

  async setUpdateChannel() {}

  async setUpdateChecks() {}

  imageProxy() {
    // No app to fetch through; the demo's remote pictures point at hosts that never answer.
    return null;
  }

  async setPrivacyProxy() {}

  async updateStatus(): Promise<UpdateInfo | null> {
    return null;
  }

  /** Pretends a new version was found, so the update hint can be seen in the browser. */
  async checkForUpdates(): Promise<UpdateInfo | null> {
    await wait(1200);
    const update: UpdateInfo = {
      version: "0.2.0",
      notes: JSON.stringify({
        de: "- Eigener Installer mit Nyu\n- Updates kommen jetzt von selbst\n- UwUMail kann im Infobereich weiterlaufen",
        en: "- UwUMail's own installer with Nyu\n- Updates now arrive by themselves\n- UwUMail can keep running in the notification area",
      }),
    };
    this.emit({ type: "update:ready", ...update });
    return update;
  }

  async installUpdate() {
    window.location.reload();
  }

  async takeMailto(): Promise<MailtoDraft | null> {
    // Try it in the browser: open the demo with ?mailto=mailto:someone@example.com
    const link = new URLSearchParams(window.location.search).get("mailto");
    if (!link?.toLowerCase().startsWith("mailto:") || this.mailtoTaken) return null;
    this.mailtoTaken = true;
    const [recipients = "", query = ""] = link.slice(7).split("?");
    const params = new URLSearchParams(query);
    const addresses = (value: string | null) =>
      (value ?? "")
        .split(",")
        .map((email) => email.trim())
        .filter((email) => email.includes("@"))
        .map((email) => ({ email }));
    return {
      to: [...addresses(decodeURIComponent(recipients)), ...addresses(params.get("to"))],
      cc: addresses(params.get("cc")),
      bcc: addresses(params.get("bcc")),
      subject: params.get("subject") ?? "",
      body: params.get("body") ?? "",
    };
  }

  subscribe(listener: (event: BackendEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: BackendEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private emitChanged(messageIds: string[]) {
    const accounts = new Set(this.messages.filter((m) => messageIds.includes(m.id)).map((m) => m.accountId));
    for (const accountId of accounts) this.emit({ type: "mail:changed", accountId });
  }

  private moveToRole(messageIds: string[], role: "archive" | "trash" | "junk" | "inbox") {
    const moved: MovedMessage[] = [];
    for (const message of this.messages) {
      const target = `${message.accountId}:${role}`;
      if (!messageIds.includes(message.id) || message.folderId === target) continue;
      moved.push({ id: message.id, fromFolderId: message.folderId });
      message.folderId = target;
    }
    this.emitChanged(messageIds);
    return moved;
  }

  private roleOf(message: Message) {
    return this.folders.find((f) => f.id === message.folderId)?.role ?? null;
  }

  private inView(message: Message, query: ThreadQuery) {
    const { view } = query;
    if (query.accountIds && !query.accountIds.includes(message.accountId)) return false;
    if (view.kind === "folder") return message.folderId === view.folderId;
    const role = this.roleOf(message);
    switch (view.role) {
      case "inbox":
        return role === "inbox";
      case "unread":
        return role === "inbox" && !message.flags.seen;
      case "flagged":
        return message.flags.flagged && role !== "trash";
      case "drafts":
        return role === "drafts";
      case "sent":
        return role === "sent";
    }
  }

  private matchesFilter(message: Message, query: ThreadQuery) {
    if (query.filter === "unread" && message.flags.seen) return false;
    if (query.filter === "flagged" && !message.flags.flagged) return false;
    if (query.filter === "attachments" && message.attachments.length === 0) return false;
    const search = query.search?.trim().toLowerCase();
    if (!search) return true;
    return [message.subject, message.from.name ?? "", message.from.email, message.bodyText ?? ""]
      .join("\n")
      .toLowerCase()
      .includes(search);
  }

  private threadMessages(threadId: string, trashed: boolean) {
    return this.messages
      .filter((m) => m.threadId === threadId && (this.roleOf(m) === "trash") === trashed)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private summarize(id: string, list: Message[]): ThreadSummary {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    const last = sorted[sorted.length - 1]!;
    const firstSubject = sorted[0]!.subject;
    return {
      id,
      accountIds: [...new Set(sorted.map((m) => m.accountId))],
      subject: firstSubject,
      participants: uniqueAddresses(sorted.map((m) => m.from)),
      snippet: last.snippet,
      lastDate: last.date,
      messageCount: sorted.length,
      unreadCount: sorted.filter((m) => !m.flags.seen).length,
      flagged: sorted.some((m) => m.flags.flagged),
      hasAttachments: sorted.some((m) => m.attachments.length > 0),
      hasDraft: sorted.some((m) => m.flags.draft),
    };
  }
}
