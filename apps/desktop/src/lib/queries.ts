import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { backend } from "@/backend/backend";
import type { FlagChange, ListFilter, MailboxView, ThreadSummary } from "@/backend/types";
import { useT } from "@/i18n";
import { useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { useUpdates } from "@/state/updates";

export const queryKeys = {
  accounts: ["accounts"] as const,
  folders: ["folders"] as const,
  threads: ["threads"] as const,
  thread: ["thread"] as const,
};

export function useAccounts() {
  return useQuery({ queryKey: queryKeys.accounts, queryFn: () => backend().listAccounts() });
}

export function useFolders() {
  return useQuery({ queryKey: queryKeys.folders, queryFn: () => backend().listFolders() });
}

const PAGE_SIZE = 50;

export function useThreads(view: MailboxView, filter: ListFilter, search: string) {
  const conversations = useSettings((s) => s.conversations);
  return useInfiniteQuery({
    queryKey: [...queryKeys.threads, view, filter, search, conversations],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      backend().listThreads({ view, filter, search, conversations, cursor: pageParam, limit: PAGE_SIZE }),
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: (previous) => previous,
  });
}

/** A downloaded attachment. Files stay cached for the whole session. */
export function useAttachment(attachmentId: string | null) {
  return useQuery({
    queryKey: ["attachment", attachmentId],
    queryFn: () => backend().getAttachment(attachmentId!),
    enabled: attachmentId !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/** One lookup per domain per session; the engine caches the files for 30 days. */
export function useSenderPicture(email: string) {
  const enabled = useSettings((s) => s.senderPictures);
  const domain = email.includes("@") ? email.slice(email.lastIndexOf("@") + 1).toLowerCase() : "";
  const { data } = useQuery({
    queryKey: ["senderPicture", domain],
    queryFn: () => backend().getSenderPicture(email),
    enabled: enabled && domain !== "",
    staleTime: Infinity,
    gcTime: 60 * 60 * 1000,
    retry: false,
  });
  return enabled ? (data ?? null) : null;
}

/** Main domain of a company address; null for people at mail providers. */
export function useCompanyDomain(email: string) {
  const { data } = useQuery({
    queryKey: ["companyDomain", email.toLowerCase()],
    queryFn: () => backend().companyDomain(email),
    staleTime: Infinity,
    retry: false,
  });
  return data ?? null;
}

export function useThread(threadId: string | null) {
  const conversations = useSettings((s) => s.conversations);
  return useQuery({
    queryKey: [...queryKeys.thread, threadId, conversations],
    queryFn: () => backend().getThread(threadId!, conversations),
    enabled: threadId !== null,
  });
}

function useInvalidateMail() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.threads }),
      client.invalidateQueries({ queryKey: queryKeys.thread }),
      client.invalidateQueries({ queryKey: queryKeys.folders }),
    ]);
}

/** Actions on messages with cache invalidation and friendly feedback. */
export function useMessageActions() {
  const { t } = useT();
  const invalidate = useInvalidateMail();

  const run = async (action: () => Promise<void>, success?: string) => {
    try {
      await action();
      if (success) toast(success, "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      await invalidate();
    }
  };

  return {
    setFlags: (ids: string[], change: FlagChange) => run(() => backend().setFlags(ids, change)),
    archive: (ids: string[]) => run(() => backend().archive(ids), t("toast.archived")),
    trash: (ids: string[]) => run(() => backend().trash(ids), t("toast.trashed")),
    refresh: () => run(() => backend().syncNow()),
  };
}

/** Keeps queries fresh when the engine reports changes. Mount once. */
export function useBackendEvents() {
  const client = useQueryClient();
  const { t } = useT();
  const runInBackground = useSettings((s) => s.runInBackground);
  const updateChannel = useSettings((s) => s.updateChannel);

  useEffect(() => {
    void backend().setRunInBackground(runInBackground);
  }, [runInBackground]);

  useEffect(() => {
    void backend().setUpdateChannel(updateChannel);
  }, [updateChannel]);

  useEffect(() => {
    void backend()
      .updateStatus()
      .then((update) => update && useUpdates.getState().setReady(update));
  }, []);

  useEffect(() => {
    // A mailto: link opened UwUMail, now or while it was already running.
    const openMailto = async () => {
      const draft = await backend().takeMailto();
      if (draft) useUi.getState().openCompose({ mode: "new", ...draft });
    };
    void openMailto();
    return backend().subscribe((event) => {
      switch (event.type) {
        case "compose:mailto":
          void openMailto();
          break;
        case "update:ready":
          useUpdates.getState().setReady({ version: event.version, notes: event.notes });
          break;
        case "mail:changed":
          void client.invalidateQueries({ queryKey: queryKeys.threads });
          void client.invalidateQueries({ queryKey: queryKeys.folders });
          break;
        case "mail:received":
          toast(t("toast.newMail", { count: event.messageIds.length }), "info");
          break;
        case "account:status":
          void client.invalidateQueries({ queryKey: queryKeys.accounts });
          break;
      }
    });
  }, [client, t]);
}

export function flattenThreads(pages: { threads: ThreadSummary[] }[] | undefined): ThreadSummary[] {
  return pages?.flatMap((page) => page.threads) ?? [];
}
