// How mailboxes and folders are arranged, as it follows the account (lib/settingsSync): which
// mailboxes the unified views leave out, which folders the unified inbox takes in, the order of
// the mailboxes, and favorite and hidden folders. Mailboxes go by address, folders by address and
// path (`FolderRef`), since ids differ from device to device.

import type { Account, Folder, MailboxView } from "@/backend/types";
import { folderDisplayPath } from "@/features/rules/folderPath";
import type { FolderRef } from "@/state/settings";

type RefAccount = Pick<Account, "id" | "email" | "protocol">;

/** The address a mailbox goes by in synced settings: its own, lower case. */
export function accountAddress(account: Pick<Account, "email">): string {
  return account.email.trim().toLowerCase();
}

/**
 * How a synced setting names a folder: its IMAP path, or for JMAP (whose folder path is the
 * mailbox id, different on every device) the mailbox names from the top joined by "/".
 */
export function syncFolderPath(folder: Folder, folders: readonly Folder[], protocol: Account["protocol"]): string {
  return protocol === "jmap" ? folderDisplayPath(folder, [...folders], (f) => f.name) : folder.path;
}

/** The account's folder a synced path names, if this device knows it. */
export function folderBySyncPath(
  path: string,
  accountId: string,
  folders: readonly Folder[],
  protocol: Account["protocol"],
): Folder | undefined {
  const own = folders.filter((folder) => folder.accountId === accountId);
  return own.find((folder) => syncFolderPath(folder, own, protocol) === path);
}

export function folderRefOf(
  folder: Folder,
  account: Pick<Account, "email" | "protocol">,
  folders: readonly Folder[],
): FolderRef {
  return { account: accountAddress(account), folder: syncFolderPath(folder, folders, account.protocol) };
}

export function sameRef(a: FolderRef, b: FolderRef): boolean {
  return a.account === b.account && a.folder === b.folder;
}

export function hasRef(refs: readonly FolderRef[], ref: FolderRef): boolean {
  return refs.some((each) => sameRef(each, ref));
}

/** The list with `ref` added, or taken out when `on` is false. */
export function withRef(refs: readonly FolderRef[], ref: FolderRef, on: boolean): FolderRef[] {
  const others = refs.filter((each) => !sameRef(each, ref));
  return on ? [...others, ref] : others;
}

/** The folders here that the refs point at, in the refs' order. Refs of other devices' mailboxes are skipped. */
export function resolveRefs(
  refs: readonly FolderRef[],
  accounts: readonly RefAccount[],
  folders: readonly Folder[],
): Folder[] {
  const found: Folder[] = [];
  for (const ref of refs) {
    for (const account of accounts) {
      if (accountAddress(account) !== ref.account) continue;
      const folder = folderBySyncPath(ref.folder, account.id, folders, account.protocol);
      if (folder && !found.includes(folder)) found.push(folder);
    }
  }
  return found;
}

/** Whether the unified views leave the mailbox out. */
export function hiddenFromUnified(account: Pick<Account, "email">, hidden: readonly string[]): boolean {
  return hidden.includes(accountAddress(account));
}

/**
 * The mailboxes a unified view shows: the ones on screen without those left out. Undefined when
 * that is every mailbox (the engine then needs no list).
 */
export function unifiedAccountIds<T extends Pick<Account, "id" | "email">>(
  visible: readonly T[],
  every: readonly T[],
  hidden: readonly string[],
): string[] | undefined {
  const shown = visible.filter((account) => !hiddenFromUnified(account, hidden));
  return shown.length === every.length ? undefined : shown.map((account) => account.id);
}

/** Whether a view gathers mail of several mailboxes, so leaving mailboxes out applies. */
export function isUnified(view: MailboxView): view is Extract<MailboxView, { kind: "unified" }> {
  return view.kind === "unified";
}

/** Whether the unified view takes in the extra folders (the inbox and its unread view). */
export function takesExtraFolders(view: MailboxView): boolean {
  return view.kind === "unified" && (view.role === "inbox" || view.role === "unread");
}

/** Unread mail of the unified inbox: the inboxes and extra folders of the mailboxes it shows. */
export function unifiedUnread(
  folders: readonly Folder[],
  accountIds: readonly string[],
  extraFolderIds: readonly string[],
): number {
  return folders
    .filter((f) => accountIds.includes(f.accountId) && (f.role === "inbox" || extraFolderIds.includes(f.id)))
    .reduce((sum, f) => sum + f.unread, 0);
}

/**
 * Mailboxes in the chosen order: those named in `order` first, as named; the others after them in
 * their usual order. Several mailboxes with the same address keep their order among themselves.
 */
export function orderAccounts<T extends Pick<Account, "email">>(accounts: readonly T[], order: readonly string[]): T[] {
  if (order.length === 0) return [...accounts];
  const rank = (account: T) => {
    const index = order.indexOf(accountAddress(account));
    return index < 0 ? order.length : index;
  };
  return accounts
    .map((account, index) => ({ account, index }))
    .sort((a, b) => rank(a.account) - rank(b.account) || a.index - b.index)
    .map(({ account }) => account);
}

/** At most this many addresses in the order (the server's limit). */
export const ORDER_MAX = 200;

/**
 * The order after moving the mailbox at `from` to `to` of the shown ones (`shown`: their
 * addresses, as on screen). Addresses of mailboxes not on this device stay, behind them.
 */
export function moveInOrder(shown: readonly string[], from: number, to: number, order: readonly string[]): string[] {
  const next = [...new Set(shown)];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) {
    return [...next, ...order.filter((address) => !next.includes(address))].slice(0, ORDER_MAX);
  }
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return [...next, ...order.filter((address) => !next.includes(address))].slice(0, ORDER_MAX);
}

/** What a list takes in: its mailboxes (undefined: all of them) and the extra folders of the unified inbox. */
export interface ListScope {
  accountIds: string[] | undefined;
  includeFolderIds: string[] | undefined;
}

/**
 * The scope of a list of `view`. `visible` are the mailboxes on screen; `filtered` tells whether
 * that is fewer than all (workspaces on). The unified views also leave out the hidden mailboxes and
 * the unified inbox takes in the extra folders.
 */
export function scopeFor(
  view: MailboxView,
  {
    accounts,
    visible,
    filtered,
    folders,
    hidden,
    extra,
  }: {
    accounts: readonly RefAccount[];
    visible: readonly RefAccount[];
    filtered: boolean;
    folders: readonly Folder[];
    hidden: readonly string[];
    extra: readonly FolderRef[];
  },
): ListScope {
  const onScreen = filtered ? visible.map((account) => account.id) : undefined;
  if (!isUnified(view)) return { accountIds: onScreen, includeFolderIds: undefined };
  const accountIds = hidden.length === 0 ? onScreen : unifiedAccountIds(visible, accounts, hidden);
  const ids = takesExtraFolders(view) ? resolveRefs(extra, accounts, folders).map((folder) => folder.id) : [];
  return { accountIds, includeFolderIds: ids.length > 0 ? ids : undefined };
}
