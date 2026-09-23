import { useQuery } from "@tanstack/react-query";
import { backend } from "@/backend/backend";
import type { Account, CalendarInfo } from "@/backend/types";
import { queryKeys } from "@/lib/queries";

// The app holds several mailboxes (the webmail only one), so calendars come grouped by the
// account they belong to.

export interface AccountCalendars {
  accountId: string;
  /** The account's own name, e.g. "Private", or its address. */
  name: string;
  calendars: CalendarInfo[];
}

/** The calendars by account, in the order of the accounts; each keeps its own order. */
export function groupByAccount(calendars: CalendarInfo[], accounts: Account[]): AccountCalendars[] {
  const order = new Map(accounts.map((account, index) => [account.id, index]));
  const groups = new Map<string, AccountCalendars>();
  for (const calendar of calendars) {
    let group = groups.get(calendar.accountId);
    if (!group) {
      const account = accounts.find((a) => a.id === calendar.accountId);
      group = {
        accountId: calendar.accountId,
        name: account?.name || account?.email || calendar.accountId,
        calendars: [],
      };
      groups.set(calendar.accountId, group);
    }
    group.calendars.push(calendar);
  }
  const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  return [...groups.values()].sort((a, b) => rank(a.accountId) - rank(b.accountId));
}

/** Where the calendars of each account come from, and why an account has none. */
export function useCalendarAccounts() {
  return useQuery({ queryKey: queryKeys.calendarAccounts, queryFn: () => backend().calendarAccounts() });
}

/** The account new calendars go to unless picked otherwise: the one of the default calendar. */
export function defaultCalendarAccount(calendars: CalendarInfo[], accountIds: string[]): string | undefined {
  const preferred = calendars.find((calendar) => calendar.isDefault && accountIds.includes(calendar.accountId));
  return preferred?.accountId ?? accountIds[0];
}
