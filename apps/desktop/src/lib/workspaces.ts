// Private and business workspaces: every mailbox belongs to one of them, and
// while the feature is on the app only shows the active workspace's mailboxes.

import type { Folder } from "@/backend/types";
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
