import { useQueryClient } from "@tanstack/react-query";
import { backend } from "@/backend/backend";
import type { Message } from "@/backend/types";
import { translate } from "@/i18n";
import { hasLabel, labelRef, type LabelEntry } from "@/lib/labelFilter";
import { queryKeys } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { assistErrorText } from "../assist/useAssist";
import { useSelectionActions } from "../mail/selection";

/** Whether a label is on none, some or all of these messages (only those it can be on count). */
export function labelState(messages: readonly Message[], entry: LabelEntry): "none" | "some" | "all" {
  const ref = labelRef(entry);
  const eligible = messages.filter((message) => ref.accountIds.includes(message.accountId));
  const on = eligible.filter((message) => hasLabel(message, ref)).length;
  return on === 0 ? "none" : on === eligible.length ? "all" : "some";
}

/**
 * Puts labels on mail or takes them off by hand: a label only goes on mail of its own mailboxes.
 * A hand change teaches sender learning and the classifier (the server's, or this device's).
 */
export function useLabelActions() {
  const client = useQueryClient();
  const selection = useSelectionActions();

  const refresh = () => {
    void client.invalidateQueries({ queryKey: queryKeys.threads });
    void client.invalidateQueries({ queryKey: queryKeys.thread });
    void client.invalidateQueries({ queryKey: queryKeys.folders });
    // A label's totals change with it, and a label made on the way joins the directory.
    void client.invalidateQueries({ queryKey: queryKeys.assistLabels });
  };

  /** Returns how many messages changed; 0 when none of them can carry the label. */
  const setOnMessages = async (messages: readonly Message[], entry: LabelEntry, on: boolean) => {
    const ref = labelRef(entry);
    const ids = messages
      .filter((message) => ref.accountIds.includes(message.accountId) && hasLabel(message, ref) !== on)
      .map((message) => message.id);
    if (ids.length === 0) return 0;
    try {
      await backend().setKeywords(ids, { [entry.label.keyword]: on });
    } catch (error) {
      toast(assistErrorText(error), "error");
      throw error;
    } finally {
      refresh();
    }
    return ids.length;
  };

  const setOnThreads = async (threadIds: readonly string[], entry: LabelEntry, on: boolean) => {
    const messages = await selection.messagesOf([...threadIds]);
    const eligible = messages.filter((message) => entry.accountIds.includes(message.accountId));
    if (eligible.length === 0) {
      toast(translate("labels.otherMailbox", { name: entry.label.name }), "error");
      return 0;
    }
    const changed = await setOnMessages(eligible, entry, on);
    toast(
      translate(on ? "labels.added" : "labels.removed", { name: entry.label.name, count: threadIds.length }),
      "success",
    );
    return changed;
  };

  return { setOnMessages, setOnThreads, messagesOf: selection.messagesOf, refresh };
}
