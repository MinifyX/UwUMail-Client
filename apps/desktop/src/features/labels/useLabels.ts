import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { backend } from "@/backend/backend";
import type { AssistLabel, LabelOverlap } from "@/backend/types";
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

/** How long typing rests before the overlap check asks the scope. */
export const OVERLAP_DELAY = 400;

/**
 * The labels of `scope` one called `name` with `description` would overlap with (`id` is the
 * label being edited), asked a moment after typing rests. Nothing while it's off or the name is
 * empty; a failed check warns of nothing.
 */
export function useLabelOverlap(
  scope: string,
  name: string,
  description: string,
  id: string | undefined,
  enabled: boolean,
): LabelOverlap[] {
  const query = enabled && name.trim() ? JSON.stringify([scope, name.trim(), description.trim(), id ?? null]) : null;
  const [result, setResult] = useState<{ query: string; overlaps: LabelOverlap[] } | null>(null);
  useEffect(() => {
    if (!query) return;
    let live = true;
    const [wantedScope, wantedName, wantedDescription, wantedId] = JSON.parse(query) as [
      string,
      string,
      string,
      string | null,
    ];
    const timer = setTimeout(() => {
      backend()
        .checkLabelOverlap(wantedScope, wantedName, wantedDescription, wantedId ?? undefined)
        .then(
          (overlaps) => live && setResult({ query, overlaps }),
          () => live && setResult({ query, overlaps: [] }),
        );
    }, OVERLAP_DELAY);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  // A result for older text doesn't show once the text changed.
  return query && result?.query === query ? result.overlaps : [];
}
