// Private and business workspaces: every mailbox belongs to one of them, and
// while the feature is on the app only shows the active workspace's mailboxes.

import type { Folder, Identity } from "@/backend/types";
import type { Workspace } from "@/state/settings";

export const WORKSPACES: readonly Workspace[] = ["private", "business"];

/** Mailboxes not marked as business are private, including ones added later. */
export function workspaceOf(accountId: string, businessAccounts: readonly string[]): Workspace {
  return businessAccounts.includes(accountId) ? "business" : "private";
}

/** The mailboxes of one workspace, in their usual order. */
export function inWorkspace<T extends { id: string }>(
  accounts: readonly T[],
  workspace: Workspace,
  businessAccounts: readonly string[],
): T[] {
  return accounts.filter((account) => workspaceOf(account.id, businessAccounts) === workspace);
}

/** Unread mail in the inboxes of each workspace. */
export function unreadInboxes(folders: readonly Folder[], businessAccounts: readonly string[]) {
  const unread: Record<Workspace, number> = { private: 0, business: 0 };
  for (const folder of folders) {
    if (folder.role === "inbox") unread[workspaceOf(folder.accountId, businessAccounts)] += folder.unread;
  }
  return unread;
}

/** The given workspace's mailboxes first, then the others, each keeping its order. */
export function activeFirst<T extends { id: string }>(
  accounts: readonly T[],
  active: Workspace,
  businessAccounts: readonly string[],
): T[] {
  const other = active === "private" ? "business" : "private";
  return [...inWorkspace(accounts, active, businessAccounts), ...inWorkspace(accounts, other, businessAccounts)];
}

/** Addresses to send from, grouped by workspace with the active one first; empty groups are left out. */
export function sendersByWorkspace(
  senders: readonly Identity[],
  active: Workspace,
  businessAccounts: readonly string[],
): { workspace: Workspace; senders: Identity[] }[] {
  const order: Workspace[] = active === "private" ? ["private", "business"] : ["business", "private"];
  return order
    .map((workspace) => ({
      workspace,
      senders: senders.filter((sender) => workspaceOf(sender.accountId, businessAccounts) === workspace),
    }))
    .filter((group) => group.senders.length > 0);
}
