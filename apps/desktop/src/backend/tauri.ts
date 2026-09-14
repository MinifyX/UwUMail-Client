import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { BackendError, type Backend, type BackendErrorCode } from "./backend";
import type {
  Account,
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

const EVENT_NAMES = ["mail:changed", "mail:received", "account:status"] as const;

export class TauriBackend implements Backend {
  readonly kind = "tauri";

  listAccounts() {
    return call<Account[]>("list_accounts");
  }

  discoverSettings(email: string) {
    return call<DiscoveredSettings>("discover_settings", { email });
  }

  addAccount(account: NewAccount) {
    return call<Account>("add_account", { account });
  }

  removeAccount(accountId: string) {
    return call<void>("remove_account", { accountId });
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
    return call<void>("archive_messages", { messageIds });
  }

  trash(messageIds: string[]) {
    return call<void>("trash_messages", { messageIds });
  }

  send(message: OutgoingMessage) {
    return call<void>("send_message", { message });
  }

  searchContacts(query: string) {
    return call<Contact[]>("search_contacts", { query });
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
