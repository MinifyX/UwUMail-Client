import { BackendError, type Backend } from "./backend";
import { isDangerous } from "@/lib/attachments";
import { demoAttachmentBlob } from "./demo-attachments";
import { buildFolders, buildMessages, DEMO_ACCOUNTS, welcomeMessage } from "./demo-data";
import { demoSenderPicture } from "./demo-pictures";
import type {
  Account,
  AttachmentContent,
  Address,
  BackendEvent,
  Contact,
  DiscoveredSettings,
  DraftContent,
  DraftSaveResult,
  FlagChange,
  Folder,
  MailtoDraft,
  Message,
  NewAccount,
  OutgoingMessage,
  Protocol,
  SenderPicture,
  ThreadDetail,
  ThreadPage,
  ThreadQuery,
  ThreadSummary,
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
  private messages: Message[] = buildMessages(lang());
  private listeners = new Set<(event: BackendEvent) => void>();
  private nextId = 1000;
  private attachmentUrls = new Map<string, string>();
  private mailtoTaken = false;
  /** Draft key → the demo message that holds the draft, and what the composer sent. */
  private drafts = new Map<string, { messageId: string; draft: OutgoingMessage }>();

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
        providerName: "Outlook.com",
        oauth,
        imap: { host: "outlook.office365.com", port: 993, security: "tls" },
        smtp: { host: "smtp.office365.com", port: 587, security: "starttls" },
        username: email,
        source: "ispdb",
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
    if (input.auth === "password" && input.password === "wrong") {
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

  async listThreads(query: ThreadQuery): Promise<ThreadPage> {
    await wait(120);
    const matching = this.messages.filter((m) => this.inView(m, query) && this.matchesFilter(m, query));
    const groups = new Map<string, Message[]>();
    for (const message of matching) {
      const key = query.conversations ? message.threadId : `m:${message.id}`;
      const list = groups.get(key) ?? [];
      list.push(message);
      groups.set(key, list);
    }
    const threads = [...groups.entries()]
      .map(([id, list]) => this.summarize(id, query.conversations ? this.threadMessages(list[0]!.threadId) : list))
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
      : this.threadMessages(threadId);
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
    this.moveToRole(messageIds, "archive");
  }

  async trash(messageIds: string[]) {
    this.moveToRole(messageIds, "trash");
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
      from: { name: account.displayName, email: account.email },
      to: draft.to,
      cc: draft.cc,
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
      from: { name: account.displayName, email: account.email },
      to: outgoing.to,
      cc: outgoing.cc,
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

  async saveAttachment(attachmentId: string) {
    const file = await this.getAttachment(attachmentId);
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

  private moveToRole(messageIds: string[], role: "archive" | "trash") {
    for (const message of this.messages) {
      if (messageIds.includes(message.id)) message.folderId = `${message.accountId}:${role}`;
    }
    this.emitChanged(messageIds);
  }

  private roleOf(message: Message) {
    return this.folders.find((f) => f.id === message.folderId)?.role ?? null;
  }

  private inView(message: Message, query: ThreadQuery) {
    const { view } = query;
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

  private threadMessages(threadId: string) {
    return this.messages
      .filter((m) => m.threadId === threadId && this.roleOf(m) !== "trash")
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
