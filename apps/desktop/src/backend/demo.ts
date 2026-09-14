import { BackendError, type Backend } from "./backend";
import { buildFolders, buildMessages, DEMO_ACCOUNTS, welcomeMessage } from "./demo-data";
import type {
  Account,
  Address,
  BackendEvent,
  Contact,
  DiscoveredSettings,
  FlagChange,
  Folder,
  Message,
  NewAccount,
  OutgoingMessage,
  ThreadDetail,
  ThreadPage,
  ThreadQuery,
  ThreadSummary,
} from "./types";

const OAUTH_DOMAINS: Record<string, "microsoft" | "google"> = {
  "gmail.com": "google",
  "googlemail.com": "google",
  "outlook.com": "microsoft",
  "hotmail.com": "microsoft",
  "live.com": "microsoft",
  "outlook.de": "microsoft",
};

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
    };
    this.accounts.push(account);
    this.folders.push(...buildFolders(account.id, lang()));
    this.emit({ type: "mail:changed", accountId: account.id });
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

  async send(outgoing: OutgoingMessage) {
    await wait(900);
    if (outgoing.to.length + outgoing.cc.length + outgoing.bcc.length === 0) {
      throw new BackendError("invalid_input", "No recipients");
    }
    const account = this.accounts.find((a) => a.id === outgoing.accountId);
    if (!account) throw new BackendError("not_found", "Account not found");
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
    };
  }
}
