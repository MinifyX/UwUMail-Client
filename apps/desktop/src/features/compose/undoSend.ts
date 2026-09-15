import { backend } from "@/backend/backend";
import type { OutgoingMessage } from "@/backend/types";
import { translate } from "@/i18n";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";

/** Puts a message back into the composer, e.g. after undoing or failing to send it. */
export function composeAgain(message: OutgoingMessage) {
  const mode = message.inReplyTo ? "reply" : "new";
  useUi.getState().openCompose({
    mode,
    restore: {
      mode,
      accountId: message.accountId,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      html: message.html,
      inReplyTo: message.inReplyTo,
      draftKey: message.draftKey,
      // Saved again as a draft right away, so nothing depends on this window staying open.
      savedToServer: false,
    },
    attachments: message.attachments,
  });
}

/** Takes a queued mail back and opens it again. */
export async function undoSend(sendId: string) {
  try {
    const message = await backend().cancelSend(sendId);
    composeAgain(message);
    toast(translate("toast.sendUndone"));
  } catch {
    toast(translate("toast.undoTooLate"), "error");
  }
}
