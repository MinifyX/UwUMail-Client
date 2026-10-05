import { BackendError, backend } from "@/backend/backend";
import type { DraftContent } from "@/backend/types";
import { translate } from "@/i18n";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { clearLocalDraft } from "./localDraft";

/** Opens a draft from the Drafts folder in the composer, to keep writing it. */
export async function openDraftMessage(messageId: string) {
  try {
    openDraftContent(await backend().openDraft(messageId));
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    toast(translate("toast.draftOpenFailed", { reason: message }), "error");
  }
}

/**
 * Brings back, as the bar above the write button, a draft whose copy on this device was reduced to
 * its id once it reached the Drafts folder (see localDraft). A draft that is gone meanwhile (sent or
 * deleted elsewhere) is forgotten; when the account can't be reached the id stays for next time.
 */
export async function reopenSavedDraft(messageId: string) {
  let draft: DraftContent;
  try {
    draft = await backend().openDraft(messageId);
  } catch (reason) {
    const gone = reason instanceof BackendError && (reason.code === "not_found" || reason.code === "invalid_input");
    if (gone && !useUi.getState().compose) clearLocalDraft();
    return;
  }
  if (useUi.getState().compose) return;
  openDraftContent(draft);
  useUi.getState().setComposeMinimized(true);
}

/** Puts a draft read back from the account into the composer. */
export function openDraftContent(draft: DraftContent) {
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
