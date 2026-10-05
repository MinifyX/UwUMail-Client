import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { backend } from "@/backend/backend";
import type { ScheduledReceipt, ScheduledRef } from "@/backend/types";
import { i18n, translate } from "@/i18n";
import { toast } from "@/state/toasts";
import { composeAgain } from "./undoSend";

export const scheduledKeys = {
  list: ["scheduled"] as const,
  info: (accountId: string) => ["sendLaterInfo", accountId] as const,
};

/**
 * Mail waiting for its time: this device's outbox and what UwUMail servers hold. Read again when
 * the engine says something changed, and now and then for what other devices scheduled.
 */
export function useScheduledSends() {
  const client = useQueryClient();
  useEffect(
    () =>
      backend().subscribe((event) => {
        if (event.type === "scheduled:changed" || event.type === "send:done" || event.type === "send:failed") {
          void client.invalidateQueries({ queryKey: scheduledKeys.list });
        }
      }),
    [client],
  );
  return useQuery({
    queryKey: scheduledKeys.list,
    queryFn: () => backend().scheduledSends(),
    refetchInterval: 5 * 60_000,
  });
}

/** Where a mailbox's mail sent later waits, and how far ahead it may go. */
export function useSendLaterInfo(accountId: string) {
  return useQuery({
    queryKey: scheduledKeys.info(accountId),
    queryFn: () => backend().sendLaterInfo(accountId),
    enabled: accountId !== "",
    staleTime: 5 * 60_000,
  });
}

/** A time as the toasts and the list say it: "Tue, 6 Oct, 08:00". */
export function formatSendTime(iso: string): string {
  return new Date(iso).toLocaleString(i18n.language, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Takes a scheduled mail back into the composer. */
export async function editScheduled(scheduled: ScheduledRef) {
  try {
    composeAgain(await backend().editScheduled(scheduled));
    toast(translate("toast.sendUndone"));
  } catch (error) {
    toast(translate("scheduled.failed", { reason: reason(error) }), "error");
  }
}

/** Says when a mail just scheduled goes, with a way to take it back. */
export function announceScheduled(receipt: ScheduledReceipt, accountId: string) {
  toast(translate("toast.scheduled", { time: formatSendTime(receipt.sendAt) }), "success", undefined, {
    duration: 8000,
    action: {
      label: translate("toast.undo"),
      run: () => void editScheduled({ id: receipt.id, accountId, kind: receipt.kind }),
    },
  });
}
