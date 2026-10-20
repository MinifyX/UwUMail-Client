// Changing how mailboxes and folders are arranged (lib/arrangement). Everything here is a synced
// setting, so it follows the account to the other devices.

import { useMemo } from "react";
import type { Account } from "@/backend/types";
import { accountAddress, hiddenFromUnified, moveInOrder, orderAccounts, resolveRefs, withRef } from "@/lib/arrangement";
import { useAccounts, useFolders } from "@/lib/queries";
import { type FolderRef, useSettings } from "@/state/settings";

type FolderList = "unifiedFolders" | "favoriteFolders" | "hiddenFolders";

/** Adds a folder (see `folderRefOf`) to one of the folder lists, or takes it out. */
export function setFolderListed(list: FolderList, ref: FolderRef, on: boolean) {
  const settings = useSettings.getState();
  settings.update({ [list]: withRef(settings[list], ref, on) });
}

/** Leaves a mailbox out of the unified views and their counts, or takes it back in. */
export function setHiddenFromUnified(account: Pick<Account, "email">, hide: boolean) {
  const settings = useSettings.getState();
  const address = accountAddress(account);
  const others = settings.unifiedHidden.filter((each) => each !== address);
  settings.update({ unifiedHidden: hide ? [...others, address] : others });
}

/** The mailboxes that are no shared mailbox inside another one, in the chosen order. */
export function topLevel<T extends Pick<Account, "id" | "email" | "parentId">>(
  accounts: readonly T[],
  order: readonly string[],
): T[] {
  const ids = new Set(accounts.map((account) => account.id));
  return orderAccounts(
    accounts.filter((account) => !account.parentId || !ids.has(account.parentId)),
    order,
  );
}

/**
 * Moves a mailbox to where `target` is, among all mailboxes (also those of the other workspace,
 * which keep their places).
 */
export function moveAccount(accounts: readonly Account[], moved: Account, target: Account) {
  const settings = useSettings.getState();
  const addresses = topLevel(accounts, settings.accountsOrder).map(accountAddress);
  const unique = [...new Set(addresses)];
  const next = moveInOrder(
    unique,
    unique.indexOf(accountAddress(moved)),
    unique.indexOf(accountAddress(target)),
    settings.accountsOrder,
  );
  settings.update({ accountsOrder: next });
}

/** What the unified inbox's counts leave out and take in besides the inboxes. */
export function useUnifiedTally() {
  const { data: accounts = [] } = useAccounts();
  const { data: folders = [] } = useFolders();
  const hidden = useSettings((s) => s.unifiedHidden);
  const extra = useSettings((s) => s.unifiedFolders);
  return useMemo(
    () => ({
      leftOut: accounts.filter((account) => hiddenFromUnified(account, hidden)).map((account) => account.id),
      extraFolderIds: resolveRefs(extra, accounts, folders).map((folder) => folder.id),
    }),
    [accounts, folders, hidden, extra],
  );
}
