import { useQueryClient } from "@tanstack/react-query";
import { backend } from "@/backend/backend";
import type { ThreadSummary } from "@/backend/types";
import { queryKeys, useMessageActions } from "@/lib/queries";
import { useSettings } from "@/state/settings";
import type { SwipeAction } from "@/state/settings";

/** Swipe and selection actions work on whole conversations, so they first look up the messages. */
export function useThreadActions() {
  const client = useQueryClient();
  const conversations = useSettings((s) => s.conversations);
  const actions = useMessageActions();

  const messagesOf = async (threads: ThreadSummary[]) => {
    const details = await Promise.all(
      threads.map((thread) =>
        client.fetchQuery({
          queryKey: [...queryKeys.thread, thread.id, conversations],
          queryFn: () => backend().getThread(thread.id, conversations),
          staleTime: 30_000,
        }),
      ),
    );
    return details.flatMap((detail) => detail.messages);
  };

  const run = async (action: Exclude<SwipeAction, "none">, threads: ThreadSummary[]) => {
    const messages = await messagesOf(threads);
    const ids = messages.map((message) => message.id);
    switch (action) {
      case "read": {
        const anyUnread = threads.some((thread) => thread.unreadCount > 0);
        if (anyUnread) return actions.setFlags(ids, { seen: true });
        // Marking unread only needs the newest message of each conversation.
        const latest = threads.map((thread) => messages.filter((m) => m.threadId === thread.id).at(-1)?.id);
        return actions.setFlags(
          latest.filter((id): id is string => id !== undefined),
          { seen: false },
        );
      }
      case "flag": {
        const allFlagged = threads.every((thread) => thread.flagged);
        return actions.setFlags(ids, { flagged: !allFlagged });
      }
      case "archive":
        return actions.archive(ids);
      case "trash":
        return actions.trash(messages);
    }
  };

  return { run };
}
