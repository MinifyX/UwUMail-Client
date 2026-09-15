import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { backend } from "@/backend/backend";
import type { FlagChange, ListFilter, MailboxView, Message, ThreadSummary } from "@/backend/types";
import { useT } from "@/i18n";
import { useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { useUpdates } from "@/state/updates";
import { composeAgain } from "@/features/compose/undoSend";

export const queryKeys = {
  accounts: ["accounts"] as const,
  folders: ["folders"] as const,
  threads: ["threads"] as const,
  thread: ["thread"] as const,
  identities: ["identities"] as const,
  signatures: ["signatures"] as const,
};

export function useAccounts() {
  return useQuery({ queryKey: queryKeys.accounts, queryFn: () => backend().listAccounts() });
}

/** Every address the mailboxes can send from. */
export function useIdentities() {
  return useQuery({ queryKey: queryKeys.identities, queryFn: () => backend().listIdentities() });
}

export function useSignatures() {
  return useQuery({ queryKey: queryKeys.signatures, queryFn: () => backend().listSignatures() });
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

/** Actions on a whole thread straight from the list, without opening it first. */
export function useThreadActions() {
  const client = useQueryClient();
  const actions = useMessageActions();

  const withMessages = async (thread: ThreadSummary, act: (messages: Message[]) => Promise<void>) => {
    const { conversations } = useSettings.getState();
    try {
      const detail = await client.fetchQuery({
        queryKey: [...queryKeys.thread, thread.id, conversations],
        queryFn: () => backend().getThread(thread.id, conversations),
      });
      await act(detail.messages);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };
  // Like the shortcuts: a thread that goes away hands the selection to the next one.
  const moveOnIfOpen = (thread: ThreadSummary) => {
    const ui = useUi.getState();
    if (ui.selectedThreadId === thread.id) ui.selectRelative(1);
    if (useUi.getState().selectedThreadId === thread.id) ui.selectThread(null);
  };
  const ids = (messages: Message[]) => messages.map((message) => message.id);

  return {
    archive: (thread: ThreadSummary) =>
      withMessages(thread, (messages) => {
        moveOnIfOpen(thread);
        return actions.archive(ids(messages));
      }),
    trash: (thread: ThreadSummary) =>
      withMessages(thread, (messages) => {
        moveOnIfOpen(thread);
        return actions.trash(ids(messages));
      }),
    toggleRead: (thread: ThreadSummary) =>
      withMessages(thread, (messages) => {
        if (thread.unreadCount > 0) return actions.setFlags(ids(messages), { seen: true });
        // An open thread would mark itself as read again right away.
        if (useUi.getState().selectedThreadId === thread.id) useUi.getState().selectThread(null);
        return actions.setFlags(ids(messages.slice(-1)), { seen: false });
      }),
    toggleFlag: (thread: ThreadSummary) =>
      withMessages(thread, (messages) => actions.setFlags(ids(messages), { flagged: !thread.flagged })),
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
          // The open conversation too: a reply or a draft may have joined it. Unchanged data keeps its objects.
          void client.invalidateQueries({ queryKey: queryKeys.thread });
          void client.invalidateQueries({ queryKey: queryKeys.folders });
          break;
        case "send:done":
          toast(t("toast.sent"), "success", "sent");
          void client.invalidateQueries({ queryKey: queryKeys.threads });
          break;
        case "send:failed":
          toast(t("toast.sendFailedKept", { reason: event.reason }), "error", undefined, {
            duration: 15_000,
            action: { label: t("toast.open"), run: () => composeAgain(event.message) },
          });
          void client.invalidateQueries({ queryKey: queryKeys.threads });
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
