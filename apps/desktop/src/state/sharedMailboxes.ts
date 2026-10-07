import { create } from "zustand";
import type { Account } from "@/backend/types";

/** What the shared-mailbox dialogs are open for: adding one under an account, or removing a mailbox. */
export type SharedMailboxRequest = { kind: "add"; parent: Account } | { kind: "remove"; account: Account };

interface SharedMailboxState {
  request: SharedMailboxRequest | null;
  open: (request: SharedMailboxRequest) => void;
  close: () => void;
}

export const useSharedMailboxes = create<SharedMailboxState>()((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

/**
 * Whether shared mailboxes can be added under this account: a Microsoft 365 work account, or a
 * JMAP login whose server shares mailboxes (there "adding" brings back one removed before); never
 * a shared one.
 */
export function takesSharedMailboxes(
  account: Pick<Account, "auth" | "protocol" | "parentId" | "sharedSearch">,
): boolean {
  const kind = account.auth === "microsoft" || account.protocol === "jmap";
  return kind && !account.parentId && account.sharedSearch !== undefined;
}

/** Whether mail of `accountId` may only be read: a read-only shared mailbox. */
export function isReadOnly(
  accounts: readonly Pick<Account, "id" | "readOnly">[],
  accountId: string | undefined,
): boolean {
  return accounts.some((account) => account.id === accountId && account.readOnly === true);
}

/** The shared mailboxes nested under `parentId`, in their order. */
export function sharedOf<T extends Pick<Account, "parentId">>(accounts: readonly T[], parentId: string): T[] {
  return accounts.filter((account) => account.parentId === parentId);
}

/**
 * Accounts with their shared mailboxes grouped under them. A shared mailbox whose account isn't in
 * the list (another workspace, say) stands on its own.
 */
export function nestAccounts<T extends Pick<Account, "id" | "parentId">>(
  accounts: readonly T[],
): { account: T; shared: T[] }[] {
  const ids = new Set(accounts.map((account) => account.id));
  return accounts
    .filter((account) => !account.parentId || !ids.has(account.parentId))
    .map((account) => ({ account, shared: accounts.filter((other) => other.parentId === account.id) }));
}
