import { backend } from "@/backend/backend";
import { translate } from "@/i18n";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";

/** Opens a draft from the Drafts folder in the composer, to keep writing it. */
export async function openDraftMessage(messageId: string) {
  try {
    const draft = await backend().openDraft(messageId);
    const mode = draft.inReplyTo ? "reply" : "new";
    useUi.getState().openCompose({
      mode,
      restore: {
        mode,
        accountId: draft.accountId,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        html: draft.html,
        inReplyTo: draft.inReplyTo ?? undefined,
        draftKey: draft.draftKey ?? undefined,
        fromEmail: draft.fromEmail ?? undefined,
        savedToServer: true,
      },
      attachments: draft.attachments,
    });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    toast(translate("toast.draftOpenFailed", { reason: message }), "error");
  }
}

/**
 * The draft of a conversation in the Drafts folder, opened in the composer.
 *
 * Only a message that really is a draft: whatever else sits in that conversation is somebody
 * else's mail, and a draft is opened into the composer itself, where the reader's frame and its
 * rules are not around it. The whole conversation is asked for, so the draft is in the list even
 * when a newer message arrived after it.
 */
export async function openDraftThread(threadId: string) {
  try {
    const detail = await backend().getThread(threadId, true);
    const draft = [...detail.messages].reverse().find((message) => message.flags.draft);
    if (draft) await openDraftMessage(draft.id);
    else toast(translate("toast.draftGone"), "error");
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    toast(translate("toast.draftOpenFailed", { reason: message }), "error");
  }
}
