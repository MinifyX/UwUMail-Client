import { useQueries, useQuery } from "@tanstack/react-query";
import { backend } from "@/backend/backend";
import type { AssistLabel } from "@/backend/types";
import { labelRef, type LabelEntry } from "@/lib/labelFilter";
import { queryKeys, useVisibleAccounts } from "@/lib/queries";
import { useAssistScopes } from "../assist/useAssist";

/**
 * Every label the person has, with the mailboxes it belongs to: each UwUMail account's (kept on
 * its server) and this device's for the other mailboxes. Only scopes with a mailbox on screen
 * (the active workspace) count. The queries are the settings' own, so both stay in step.
 */
export function useLabelDirectory(): { entries: LabelEntry[]; loaded: boolean } {
  const { data: scopes = [], isSuccess } = useAssistScopes();
  const { accounts } = useVisibleAccounts();
  const visible = new Set(accounts.map((account) => account.id));
  const shown = scopes
    .map((scope) => ({ ...scope, accountIds: scope.accountIds.filter((id) => visible.has(id)) }))
    .filter((scope) => scope.accountIds.length > 0);
  const results = useQueries({
    queries: shown.map((scope) => ({
      queryKey: [...queryKeys.assistLabels, scope.id],
      queryFn: () => backend().assistLabels(scope.id),
      staleTime: 5 * 60_000,
    })),
  });
  const entries: LabelEntry[] = shown.flatMap((scope, index) =>
    (results[index]?.data ?? ([] as AssistLabel[])).map((label) => ({
      scope: scope.id,
      accountIds: scope.accountIds,
      label,
    })),
  );
  return { entries, loaded: isSuccess && results.every((result) => !result.isPending) };
}

/** The labels a mailbox's mail can carry. */
export function labelsFor(entries: readonly LabelEntry[], accountId: string): LabelEntry[] {
  return entries.filter((entry) => entry.accountIds.includes(accountId));
}

/** Totals and unread per label, refreshed with the folders' counts. */
export function useLabelCounts(entries: readonly LabelEntry[]) {
  const refs = entries.map(labelRef);
  return useQuery({
    queryKey: [...queryKeys.folders, "labelCounts", refs],
    queryFn: () => backend().labelCounts(refs),
    enabled: refs.length > 0,
    placeholderData: (previous) => previous,
  });
}

/** The labels a UwUMail account's server keeps, for its mail rules; none for other mailboxes. */
export function useAccountLabels(accountId: string) {
  const { data: scopes = [] } = useAssistScopes();
  const scope = scopes.find((each) => each.kind === "server" && each.accountIds.includes(accountId));
  return useQuery({
    queryKey: [...queryKeys.assistLabels, scope?.id],
    queryFn: () => backend().assistLabels(scope!.id),
    enabled: Boolean(scope),
    staleTime: 5 * 60_000,
  });
}
