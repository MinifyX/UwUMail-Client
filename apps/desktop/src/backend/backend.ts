import type {
  Account,
  AttachmentContent,
  BackendEvent,
  Contact,
  DiscoveredSettings,
  FlagChange,
  Folder,
  NewAccount,
  OutgoingMessage,
  ThreadDetail,
  ThreadPage,
  ThreadQuery,
} from "./types";

export type BackendErrorCode =
  "auth_failed" | "connection_failed" | "not_found" | "invalid_input" | "not_supported" | "internal";

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
  discoverSettings(email: string): Promise<DiscoveredSettings>;
  addAccount(account: NewAccount): Promise<Account>;
  removeAccount(accountId: string): Promise<void>;
  syncNow(accountId?: string): Promise<void>;

  listFolders(accountId?: string): Promise<Folder[]>;
  listThreads(query: ThreadQuery): Promise<ThreadPage>;
  getThread(threadId: string, conversations: boolean): Promise<ThreadDetail>;

  setFlags(messageIds: string[], change: FlagChange): Promise<void>;
  archive(messageIds: string[]): Promise<void>;
  trash(messageIds: string[]): Promise<void>;
  send(message: OutgoingMessage): Promise<void>;

  searchContacts(query: string): Promise<Contact[]>;

  /** Downloads the attachment on first use. */
  getAttachment(attachmentId: string): Promise<AttachmentContent>;
  /** Opens it in the default app. Dangerous files need `confirmed`. */
  openAttachment(attachmentId: string, confirmed: boolean): Promise<void>;
  /** Asks where to save it. Resolves to false when the user cancels. */
  saveAttachment(attachmentId: string, filename: string): Promise<boolean>;

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
