import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { backend } from "@/backend/backend";
import type {
  FlagChange,
  Folder,
  ListFilter,
  MailboxView,
  Message,
  MovedMessage,
  ThreadSummary,
} from "@/backend/types";
import { translate, useT } from "@/i18n";
import { inWorkspace } from "@/lib/workspaces";
import { useAccountSync } from "@/state/accountSync";
import { confirmDeleteForever } from "@/state/deleteForever";
import { useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";
import { announceMove } from "@/state/undo";
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
  calendars: ["calendars"] as const,
  calendarEvents: ["calendarEvents"] as const,
  calendarAccounts: ["calendarAccounts"] as const,
  addressBooks: ["addressBooks"] as const,
  contacts: ["contacts"] as const,
  contactsAccounts: ["contactsAccounts"] as const,
};

export function useAccounts() {
  return useQuery({ queryKey: queryKeys.accounts, queryFn: () => backend().listAccounts() });
}

/** The mailboxes on screen: all of them, or the active workspace's while private and business are apart. */
export function useVisibleAccounts() {
  const { data: accounts = [], isSuccess: loaded } = useAccounts();
  const workspaces = useSettings((s) => s.workspaces);
  const active = useSettings((s) => s.activeWorkspace);
  const businessAccounts = useSettings((s) => s.businessAccounts);
  const visible = workspaces ? inWorkspace(accounts, active, businessAccounts) : accounts;
  return {
    accounts: visible,
    loaded,
    /** For thread queries: left out while every mailbox shows, null until the mailboxes have loaded. */
    accountIds: !workspaces ? undefined : loaded ? visible.map((account) => account.id) : null,
  };
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
  const { accountIds } = useVisibleAccounts();
  return useInfiniteQuery({
    queryKey: [...queryKeys.threads, view, filter, search, conversations, accountIds],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      backend().listThreads({
        view,
        filter,
        search,
        conversations,
        accountIds: accountIds ?? undefined,
        cursor: pageParam,
        limit: PAGE_SIZE,
      }),
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: (previous) => previous,
    // With workspaces on, the list waits for the mailboxes instead of briefly showing none.
    enabled: accountIds !== null,
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

/** Lists, conversations and folder counts load again after mail changed. */
function invalidateMail(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.threads }),
    client.invalidateQueries({ queryKey: queryKeys.thread }),
    client.invalidateQueries({ queryKey: queryKeys.folders }),
  ]);
}

/** Whether all these messages lie in their mailbox's trash, where deleting means for good. */
export function inTrash(messages: Pick<Message, "folderId">[], folders: Folder[]) {
  return (
    messages.length > 0 &&
    messages.every((message) => folders.find((folder) => folder.id === message.folderId)?.role === "trash")
  );
}

/** A conversation that goes away hands the selection to the next one, or closes if it was the last. */
export function leaveThread(threadId: string) {
  const ui = useUi.getState();
  if (ui.selectedThreadId === threadId) ui.selectRelative(1);
  if (useUi.getState().selectedThreadId === threadId) ui.selectThread(null);
}

/**
 * Moves mail into the trash, with undo. Mail that already lies there goes for good, but only
 * after Nyu asked. `leave` runs right before either happens. Resolves whether the mail went.
 */
export async function trashMail(client: QueryClient, messages: Message[], leave?: () => void) {
  const ids = messages.map((message) => message.id);
  const refresh = () => invalidateMail(client);
  const fail = (error: unknown) => {
    toast(error instanceof Error ? error.message : String(error), "error");
    return false;
  };
  let forever: boolean;
  try {
    const folders = await client.ensureQueryData({
      queryKey: queryKeys.folders,
      queryFn: () => backend().listFolders(),
    });
    forever = inTrash(messages, folders);
  } catch (error) {
    return fail(error);
  }
  if (forever && !(await confirmDeleteForever(ids.length))) return false;
  leave?.();
  try {
    if (forever) {
      const count = await backend().deleteForever(ids);
      toast(translate("toast.deletedForever", { count }), "success");
    } else {
      announceMove(await backend().trash(ids), translate("toast.trashed"), refresh);
    }
    return true;
  } catch (error) {
    return fail(error);
  } finally {
    await refresh();
  }
}

/** Actions on messages with cache invalidation and friendly feedback. */
export function useMessageActions() {
  const { t } = useT();
  const client = useQueryClient();
  const invalidate = () => invalidateMail(client);

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

  /** Moves mail and offers to put it back (also with "z"). */
  const moveWithUndo = async (move: () => Promise<MovedMessage[]>, success: string) => {
    try {
      announceMove(await move(), success, invalidate);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      await invalidate();
    }
  };

  return {
    setFlags: (ids: string[], change: FlagChange) => run(() => backend().setFlags(ids, change)),
    archive: (ids: string[]) => moveWithUndo(() => backend().archive(ids), t("toast.archived")),
    /** Into the trash, or out of it for good after asking; see `trashMail`. */
    trash: (messages: Message[], leave?: () => void) => trashMail(client, messages, leave),
    move: (ids: string[], folder: { id: string; name: string }) =>
      moveWithUndo(() => backend().moveMessages(ids, folder.id), t("toast.moved", { folder: folder.name })),
    spam: (ids: string[], spam: boolean) =>
      moveWithUndo(() => backend().markSpam(ids, spam), t(spam ? "toast.markedSpam" : "toast.markedNotSpam")),
    refresh: () => run(() => backend().syncNow()),
  };
}

/** Actions on a whole thread straight from the list, without opening it first. */
export function useThreadActions() {
  const client = useQueryClient();
  const actions = useMessageActions();

  const withMessages = async (thread: ThreadSummary, act: (messages: Message[]) => Promise<unknown>) => {
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
  const ids = (messages: Message[]) => messages.map((message) => message.id);

  return {
    archive: (thread: ThreadSummary) =>
      withMessages(thread, (messages) => {
        leaveThread(thread.id);
        return actions.archive(ids(messages));
      }),
    /** Into junk (and the filter learns where the server does), or back out of it with `spam` false. */
    spam: (thread: ThreadSummary, spam: boolean) =>
      withMessages(thread, (messages) => {
        leaveThread(thread.id);
        return actions.spam(ids(messages), spam);
      }),
    trash: (thread: ThreadSummary) =>
      withMessages(thread, (messages) => actions.trash(messages, () => leaveThread(thread.id))),
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
  const updateChecks = useSettings((s) => s.updateChecks);
  const privacyProxy = useSettings((s) => s.privacyProxy);

  useEffect(() => {
    void backend().setRunInBackground(runInBackground);
  }, [runInBackground]);

  useEffect(() => {
    void backend().setUpdateChannel(updateChannel);
  }, [updateChannel]);

  useEffect(() => {
    void backend().setUpdateChecks(updateChecks);
  }, [updateChecks]);

  // Remote pictures wait for this before they go anywhere. A kept address was checked when it was
  // saved; should the app still turn it down, they stay away rather than leave without it.
  useEffect(() => {
    void backend()
      .setPrivacyProxy(privacyProxy)
      .catch(() => {});
  }, [privacyProxy]);

  // Signatures that came from another device through the settings sync.
  useEffect(
    () =>
      useAccountSync.subscribe((state, previous) => {
        if (state.signaturesTaken !== previous.signaturesTaken) {
          void client.invalidateQueries({ queryKey: queryKeys.signatures });
        }
      }),
    [client],
  );

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
        case "calendar:changed":
          void client.invalidateQueries({ queryKey: queryKeys.calendars });
          void client.invalidateQueries({ queryKey: queryKeys.calendarEvents });
          void client.invalidateQueries({ queryKey: queryKeys.calendarAccounts });
          void client.invalidateQueries({ queryKey: ["calendarsAvailable"] });
          break;
        case "contacts:changed":
          void client.invalidateQueries({ queryKey: queryKeys.addressBooks });
          void client.invalidateQueries({ queryKey: queryKeys.contacts });
          void client.invalidateQueries({ queryKey: queryKeys.contactsAccounts });
          void client.invalidateQueries({ queryKey: ["contactsAvailable"] });
          break;
      }
    });
  }, [client, t]);
}

export function flattenThreads(pages: { threads: ThreadSummary[] }[] | undefined): ThreadSummary[] {
  return pages?.flatMap((page) => page.threads) ?? [];
}
