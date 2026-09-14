/**
 * @uwumail/addon-sdk — the API an addon uses inside its sandbox.
 *
 *   import { uwu } from "@uwumail/addon-sdk";
 *   uwu.commands.on("greet", async ({ messageId }) => { … });
 */

import { AddonError, isHostMessage, PROTOCOL_VERSION, type CallMessage, type HostMessage } from "./protocol";

export * from "./manifest";
export * from "./protocol";

export interface Address {
  name?: string;
  email: string;
}

export interface AddonAccount {
  id: string;
  name: string;
  email: string;
  color: string;
}

export interface AddonFolder {
  id: string;
  accountId: string;
  name: string;
  role: "inbox" | "sent" | "drafts" | "archive" | "trash" | "junk" | null;
  unread: number;
  total: number;
}

export interface AddonMessage {
  id: string;
  threadId: string;
  accountId: string;
  folderId: string;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  date: string;
  flags: { seen: boolean; flagged: boolean; answered: boolean };
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
}

export interface Draft {
  accountId: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
}

export interface AppInfo {
  version: string;
  apiVersion: number;
  locale: string;
  tone: "playful" | "neutral";
  theme: "light" | "dark";
}

export interface CommandContext {
  messageId?: string;
  threadId?: string;
}

export interface EventMap {
  "messages.received": { accountId: string; messageIds: string[] };
  "message.opened": { messageId: string };
  "compose.beforeSend": { draft: Draft };
  "schedule.fired": { id: string; payload: unknown };
  "app.toneChanged": { tone: AppInfo["tone"] };
  "app.themeChanged": { theme: AppInfo["theme"] };
}

type Handler<T> = (payload: T) => unknown;

class Bridge {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private listeners = new Map<string, Set<Handler<unknown>>>();

  constructor(private readonly target: Window | null) {
    if (typeof window === "undefined") return;
    window.addEventListener("message", (event) => {
      // Only the embedding app may talk to us.
      if (event.source !== this.target || !isHostMessage(event.data)) return;
      this.receive(event.data);
    });
  }

  call<T>(method: string, ...params: unknown[]): Promise<T> {
    if (!this.target) return Promise.reject(new AddonError("internal", "Not running inside UwUMail"));
    const id = this.nextId++;
    const message: CallMessage = { uwu: PROTOCOL_VERSION, kind: "call", id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      // The host checks event.source, so the target origin can be "*": our frame has an opaque origin.
      this.target!.postMessage(message, "*");
    });
  }

  on(name: string, handler: Handler<unknown>): () => void {
    const set = this.listeners.get(name) ?? new Set();
    set.add(handler);
    this.listeners.set(name, set);
    return () => set.delete(handler);
  }

  private receive(message: HostMessage) {
    if (message.kind === "result") {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.ok) waiting.resolve(message.value);
      else waiting.reject(new AddonError(message.error?.code ?? "internal", message.error?.message ?? "Unknown error"));
      return;
    }
    for (const handler of this.listeners.get(message.name) ?? []) {
      Promise.resolve(handler(message.payload)).catch((error: unknown) =>
        console.error(`[uwu] ${message.name} handler failed`, error),
      );
    }
  }
}

const bridge = new Bridge(typeof window !== "undefined" && window.parent !== window ? window.parent : null);

export const uwu = {
  app: {
    info: () => bridge.call<AppInfo>("app.info"),
  },
  storage: {
    get: <T = unknown>(key: string) => bridge.call<T | undefined>("storage.get", key),
    set: (key: string, value: unknown) => bridge.call<void>("storage.set", key, value),
    delete: (key: string) => bridge.call<void>("storage.delete", key),
    keys: () => bridge.call<string[]>("storage.keys"),
  },
  ui: {
    toast: (message: string) => bridge.call<void>("ui.toast", message),
    openPanel: (panelId: string) => bridge.call<void>("ui.openPanel", panelId),
    confirm: (options: { title: string; body?: string; confirm?: string }) =>
      bridge.call<boolean>("ui.confirm", options),
  },
  commands: {
    on: (commandId: string, handler: Handler<CommandContext>) =>
      bridge.on(`command:${commandId}`, handler as Handler<unknown>),
  },
  events: {
    on: <K extends keyof EventMap>(name: K, handler: Handler<EventMap[K]>) =>
      bridge.on(name, handler as Handler<unknown>),
  },
  accounts: {
    list: () => bridge.call<AddonAccount[]>("accounts.list"),
  },
  folders: {
    list: (accountId?: string) => bridge.call<AddonFolder[]>("folders.list", accountId),
  },
  messages: {
    list: (query: { folderId?: string; unread?: boolean; limit?: number }) =>
      bridge.call<AddonMessage[]>("messages.list", query),
    get: (messageId: string) => bridge.call<AddonMessage>("messages.get", messageId),
    search: (text: string) => bridge.call<AddonMessage[]>("messages.search", text),
    setFlags: (ids: string[], flags: { seen?: boolean; flagged?: boolean }) =>
      bridge.call<void>("messages.setFlags", ids, flags),
    move: (ids: string[], folderId: string) => bridge.call<void>("messages.move", ids, folderId),
    delete: (ids: string[]) => bridge.call<void>("messages.delete", ids),
    send: (draft: Draft) => bridge.call<void>("messages.send", draft),
  },
  compose: {
    getDraft: () => bridge.call<Draft | null>("compose.getDraft"),
    updateDraft: (patch: Partial<Draft>) => bridge.call<void>("compose.updateDraft", patch),
    insertText: (text: string) => bridge.call<void>("compose.insertText", text),
  },
  contacts: {
    list: (query: string) => bridge.call<Address[]>("contacts.list", query),
  },
  notifications: {
    show: (options: { title: string; body?: string }) => bridge.call<void>("notifications.show", options),
  },
  schedule: {
    at: (date: Date | string, payload: unknown) =>
      bridge.call<string>("schedule.at", new Date(date).toISOString(), payload),
    cancel: (id: string) => bridge.call<void>("schedule.cancel", id),
    list: () => bridge.call<{ id: string; at: string; payload: unknown }[]>("schedule.list"),
  },
  clipboard: {
    writeText: (text: string) => bridge.call<void>("clipboard.writeText", text),
  },
  net: {
    fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
      bridge.call<{ status: number; headers: Record<string, string>; body: string }>("net.fetch", url, init),
  },
};

export type Uwu = typeof uwu;
