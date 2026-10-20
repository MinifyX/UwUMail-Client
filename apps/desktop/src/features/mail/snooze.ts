import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { backend } from "@/backend/backend";
import type { Account, Folder, MailboxView, Message } from "@/backend/types";
import { i18n, translate } from "@/i18n";
import { queryKeys, useAccounts, useFolders } from "@/lib/queries";
import {
  accountAddress,
  dueSnoozes,
  findSnooze,
  folderBySyncPath,
  isSnoozedFolder,
  newSnoozeId,
  snoozedUntil,
  syncFolderPath,
  toUtc,
} from "@/lib/snooze";
import { type SnoozeEntry, useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";
import { moveBack, rememberUndo } from "@/state/undo";
import { useUi } from "@/state/ui";

/** How often a running device looks for snoozes that are due. */
const CHECK_EVERY_MS = 30_000;
/** How long a snooze that failed to come back waits before the next try. */
const RETRY_AFTER_MS = 60_000;

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function formatSnoozeTime(iso: string): string {
  return new Date(iso).toLocaleString(i18n.language, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The messages of a conversation that snoozing moves: what isn't a draft, sent mail or in the
 * trash; a conversation of only sent mail snoozes that.
 */
export function snoozable(messages: Message[], folders: Folder[]): Message[] {
  const role = (message: Message) => folders.find((folder) => folder.id === message.folderId)?.role ?? null;
  const kept = messages.filter((message) => !message.flags.draft && role(message) !== "drafts");
  const received = kept.filter((message) => role(message) !== "sent" && role(message) !== "trash");
  return received.length > 0 ? received : kept.filter((message) => role(message) !== "trash");
}

/** Opens "Snooze until…" for these messages; `onSnoozed` runs once they're away. */
export function requestSnooze(messages: Message[], onSnoozed?: () => void) {
  useUi.getState().openSnooze({ messages, onSnoozed });
}

function sameEntry(a: SnoozeEntry | undefined, b: SnoozeEntry): boolean {
  return !!a && a.account === b.account && a.messageId === b.messageId && a.folder === b.folder && a.until === b.until;
}

function withoutKeys(ids: string[], expected: Record<string, SnoozeEntry>) {
  const current = useSettings.getState().snoozes;
  const next = { ...current };
  let changed = false;
  for (const id of ids) {
    // Another device may have snoozed it again meanwhile; that snooze stays.
    if (sameEntry(next[id], expected[id]!)) {
      delete next[id];
      changed = true;
    }
  }
  if (changed) useSettings.getState().update({ snoozes: next });
}

/** Whether some of the mail lies in its mailbox's Snoozed folder. */
export function someSnoozed(messages: Pick<Message, "folderId">[], folders: Folder[]): boolean {
  return messages.some((message) => {
    const folder = folders.find((each) => each.id === message.folderId);
    return !!folder && isSnoozedFolder(folder);
  });
}

/** Snoozing and bringing back by hand. */
export function useSnooze() {
  const client = useQueryClient();
  const { data: accounts = [] } = useAccounts();
  const { data: folders = [] } = useFolders();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.threads }),
      client.invalidateQueries({ queryKey: queryKeys.thread }),
      client.invalidateQueries({ queryKey: queryKeys.folders }),
    ]);

  const pathOf = (account: Account, folderId: string | null | undefined) => {
    const own = folders.filter((folder) => folder.accountId === account.id);
    const folder = own.find((each) => each.id === folderId);
    return folder ? syncFolderPath(folder, own, account.protocol) : undefined;
  };
  const inboxPath = (account: Account) =>
    pathOf(account, folders.find((folder) => folder.accountId === account.id && folder.role === "inbox")?.id);

  /** Moves the mail into Snoozed and writes when it comes back; with undo. */
  const snooze = async (messages: Message[], until: Date, onSnoozed?: () => void) => {
    const chosen = snoozable(messages, folders);
    if (chosen.length === 0) return;
    try {
      const snoozed = await backend().snoozeMessages(chosen.map((message) => message.id));
      const before = useSettings.getState().snoozes;
      const next = { ...before };
      const written: Record<string, SnoozeEntry> = {};
      for (const moved of snoozed) {
        const account = accounts.find((each) => each.id === moved.accountId);
        if (!account) continue;
        const address = accountAddress(account);
        const existing = findSnooze(next, address, moved.headerId);
        const folder = pathOf(account, moved.folderId) ?? existing?.[1].folder ?? inboxPath(account);
        if (!folder) continue;
        const id = existing?.[0] ?? newSnoozeId();
        next[id] = { account: address, messageId: moved.headerId, folder, until: toUtc(until) };
        written[id] = next[id];
      }
      useSettings.getState().update({ snoozes: next });
      onSnoozed?.();
      const undo = () => {
        const current = { ...useSettings.getState().snoozes };
        for (const [id, entry] of Object.entries(written)) {
          if (!sameEntry(current[id], entry)) continue;
          if (before[id]) current[id] = before[id];
          else delete current[id];
        }
        useSettings.getState().update({ snoozes: current });
        const back = snoozed.flatMap((moved) =>
          moved.folderId ? [{ id: moved.id, fromFolderId: moved.folderId }] : [],
        );
        void moveBack(back)
          .then(() => toast(translate("toast.moveUndone")))
          .catch((error: unknown) => toast(reason(error), "error"))
          .finally(() => void refresh());
      };
      rememberUndo(undo);
      toast(translate("snooze.done", { time: formatSnoozeTime(until.toISOString()) }), "success", undefined, {
        duration: 8000,
        action: { label: translate("toast.undo"), run: undo },
      });
    } catch (error) {
      toast(translate("snooze.failed", { reason: reason(error) }), "error");
    } finally {
      await refresh();
    }
  };

  /** Brings snoozed mail back now, to where it came from (the inbox when that's unknown). */
  const unsnooze = async (messages: Message[], threadIds: string[] = []) => {
    try {
      const byFolder = new Map<string, Message[]>();
      for (const message of messages) {
        const folder = folders.find((each) => each.id === message.folderId);
        if (folder && isSnoozedFolder(folder)) {
          byFolder.set(folder.id, [...(byFolder.get(folder.id) ?? []), message]);
        }
      }
      const snoozes = useSettings.getState().snoozes;
      const done: string[] = [];
      for (const [folderId, list] of byFolder) {
        const rows = await backend().folderHeaderIds(folderId);
        const listIds = new Set([...threadIds, ...list.map((message) => `m:${message.id}`)]);
        const headers = new Set(rows.filter(([listId]) => listIds.has(listId)).map(([, header]) => header));
        const account = accounts.find((each) => each.id === list[0]!.accountId);
        if (!account) continue;
        for (const header of headers) {
          const entry = findSnooze(snoozes, accountAddress(account), header);
          const target = entry && folderBySyncPath(entry[1].folder, account.id, folders, account.protocol);
          const outcome = await backend().unsnooze(account.id, header, target?.id ?? null);
          if (entry && outcome !== "waiting") done.push(entry[0]);
        }
      }
      withoutKeys(done, snoozes);
      toast(translate("snooze.back"), "success");
    } catch (error) {
      toast(translate("snooze.failed", { reason: reason(error) }), "error");
    } finally {
      await refresh();
    }
  };

  return { snooze, unsnooze };
}

/**
 * Brings back what's due, on every running device: every half minute, and whenever the snoozes,
 * the accounts or their folders change (a settings sync among them). Only mailboxes this device
 * may write to take part; another device brought back what's gone, so its key goes too.
 */
export function useSnoozeRunner() {
  const client = useQueryClient();
  const snoozes = useSettings((s) => s.snoozes);
  const { data: accounts } = useAccounts();
  const { data: folders } = useFolders();
  const [tick, setTick] = useState(0);
  const busy = useRef(false);
  const retryAt = useRef(new Map<string, number>());

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), CHECK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!accounts || !folders || busy.current) return;
    const now = Date.now();
    const due = dueSnoozes(snoozes, new Date(now)).filter(([id]) => (retryAt.current.get(id) ?? 0) <= now);
    if (due.length === 0) return;
    busy.current = true;
    void (async () => {
      const done: string[] = [];
      for (const [id, entry] of due) {
        const account = accounts.find((each) => !each.readOnly && accountAddress(each) === entry.account);
        if (!account) continue;
        const target = folderBySyncPath(entry.folder, account.id, folders, account.protocol);
        try {
          const outcome = await backend().unsnooze(account.id, entry.messageId, target?.id ?? null);
          if (outcome === "waiting") retryAt.current.set(id, Date.now() + RETRY_AFTER_MS);
          else done.push(id);
        } catch {
          retryAt.current.set(id, Date.now() + RETRY_AFTER_MS);
        }
      }
      withoutKeys(done, Object.fromEntries(due));
      if (done.length > 0) {
        await Promise.all([
          client.invalidateQueries({ queryKey: queryKeys.threads }),
          client.invalidateQueries({ queryKey: queryKeys.folders }),
        ]);
      }
    })().finally(() => {
      busy.current = false;
    });
  }, [snoozes, accounts, folders, tick, client]);
}

/** For the rows of the Snoozed folder: when each one's snooze ends, by list id. */
export function useSnoozedRows(view: MailboxView): Map<string, string> | undefined {
  const { data: accounts = [] } = useAccounts();
  const { data: folders = [] } = useFolders();
  const snoozes = useSettings((s) => s.snoozes);
  const folder = view.kind === "folder" ? folders.find((each) => each.id === view.folderId) : undefined;
  const snoozedFolder = folder && isSnoozedFolder(folder) ? folder : undefined;
  const account = accounts.find((each) => each.id === snoozedFolder?.accountId);
  const { data: headers } = useQuery({
    queryKey: [...queryKeys.threads, "snoozedHeaders", snoozedFolder?.id],
    queryFn: () => backend().folderHeaderIds(snoozedFolder!.id),
    enabled: !!snoozedFolder,
    staleTime: 10_000,
  });
  if (!account || !headers) return undefined;
  return snoozedUntil(snoozes, accountAddress(account), headers);
}
