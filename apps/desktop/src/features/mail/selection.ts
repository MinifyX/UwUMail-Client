import { useQueryClient } from "@tanstack/react-query";
import { backend } from "@/backend/backend";
import type { Message } from "@/backend/types";
import { translate } from "@/i18n";
import { queryKeys, useMessageActions } from "@/lib/queries";
import { useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";
import { moveBack, rememberUndo } from "@/state/undo";
import { useUi } from "@/state/ui";

/** Drag data of mail list rows: the thread ids as JSON. */
export const THREAD_DRAG_TYPE = "application/x-uwumail-threads";

const ids = (messages: Message[]) => messages.map((message) => message.id);

/** Opens "Move to…" for these messages; `onMoved` runs once they moved. */
export function requestMove(messages: Message[], onMoved?: () => void) {
  if (messages.length === 0) return;
  useUi.getState().openMove({
    messageIds: ids(messages),
    accountIds: [...new Set(messages.map((message) => message.accountId))],
    onMoved,
  });
}

/** Blocks an address or @domain, on the account's UwUMail server where there is one, and puts these messages into junk, with undo. */
export async function blockSender(entry: string, accountId: string, messageIds: string[], refresh: () => unknown) {
  try {
    const blocked = await backend().blockSender(entry, accountId);
    const moved = await backend().markSpam(messageIds, true);
    const undo = () => {
      void backend()
        .unblockSender(blocked)
        .then(() => moveBack(moved))
        .then(() => toast(translate("toast.unblocked", { entry: blocked.entry })))
        .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), "error"))
        .finally(() => void refresh());
    };
    rememberUndo(undo);
    const text = blocked.serverId ? "toast.blockedOnServer" : "toast.blocked";
    toast(translate(text, { entry: blocked.entry }), "success", undefined, {
      duration: 8000,
      action: { label: translate("toast.undo"), run: undo },
    });
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    await refresh();
  }
}

/** Actions on several conversations of the list at once. */
export function useSelectionActions() {
  const client = useQueryClient();
  const actions = useMessageActions();
  const conversations = useSettings((s) => s.conversations);

  const messagesOf = async (threadIds: string[]) => {
    const details = await Promise.all(
      threadIds.map((id) =>
        client.fetchQuery({
          queryKey: [...queryKeys.thread, id, conversations],
          queryFn: () => backend().getThread(id, conversations),
          staleTime: 30_000,
        }),
      ),
    );
    return details.flatMap((detail) => detail.messages);
  };

  return {
    messagesOf,
    archive: async (threadIds: string[]) => actions.archive(ids(await messagesOf(threadIds))),
    trash: async (threadIds: string[]) => actions.trash(await messagesOf(threadIds)),
    spam: async (threadIds: string[], spam: boolean) => actions.spam(ids(await messagesOf(threadIds)), spam),
    read: async (threadIds: string[], seen: boolean) => actions.setFlags(ids(await messagesOf(threadIds)), { seen }),
    flag: async (threadIds: string[], flagged: boolean) =>
      actions.setFlags(ids(await messagesOf(threadIds)), { flagged }),
    move: async (threadIds: string[], onMoved?: () => void) => requestMove(await messagesOf(threadIds), onMoved),
  };
}
