import type { Account } from "@/backend/types";

/** What a mailbox is called in UwUMail: its own name, or its address when it has none. */
export function accountLabel(account: Pick<Account, "name" | "email">): string {
  return account.name?.trim() || account.email;
}

/** Whether the mailbox has a name of its own, other than its address. */
export function hasOwnName(account: Pick<Account, "name" | "email">): boolean {
  const name = account.name?.trim();
  return Boolean(name) && name!.toLowerCase() !== account.email.toLowerCase();
}

/** A shared mailbox under its account: its own name, else the name the server gives it, else its address. */
export function sharedMailboxLabel(account: Pick<Account, "name" | "email" | "displayName">): string {
  return hasOwnName(account) ? account.name.trim() : account.displayName || account.email;
}
