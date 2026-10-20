import type { QueryClient } from "@tanstack/react-query";
import { backend } from "@/backend/backend";
import type { MailboxView, MarkReadScope } from "@/backend/types";
import { translate } from "@/i18n";
import { listScopeNow, queryKeys } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { rememberUndo } from "@/state/undo";

function refresh(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.threads }),
    client.invalidateQueries({ queryKey: queryKeys.thread }),
    client.invalidateQueries({ queryKey: queryKeys.folders }),
  ]);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** "Mark all as read" for a view: what its list shows, without the search and list filters. */
export function viewScope(client: QueryClient, view: MailboxView): MarkReadScope {
  const { accountIds, includeFolderIds } = listScopeNow(client, view);
  return { kind: "view", view, accountIds, includeFolderIds };
}

/** Marks everything unread in the scope as read, with "Undo" in the toast and on "z". */
export async function markAllRead(client: QueryClient, scope: MarkReadScope) {
  let ids: string[];
  try {
    ids = await backend().markAllRead(scope);
  } catch (error) {
    toast(message(error), "error");
    return;
  } finally {
    void refresh(client);
  }
  if (ids.length === 0) {
    toast(translate("markAllRead.nothing"), "info");
    return;
  }
  const undo = () => {
    void backend()
      .setFlags(ids, { seen: false })
      .then(() => toast(translate("toast.moveUndone")))
      .catch((error: unknown) => toast(message(error), "error"))
      .finally(() => void refresh(client));
  };
  rememberUndo(undo);
  toast(translate("markAllRead.done", { count: ids.length }), "success", undefined, {
    duration: 6000,
    action: { label: translate("toast.undo"), run: undo },
  });
}
