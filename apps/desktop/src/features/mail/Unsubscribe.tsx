import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { backend } from "@/backend/backend";
import type { Message } from "@/backend/types";
import { NyuScene } from "@/components/nyu/scenes";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Toggle } from "@/components/ui/Field";
import { useT } from "@/i18n";
import { displayName } from "@/lib/format";
import { unsubscribeMail } from "@/lib/unsubscribe";
import { requestOpenLink } from "@/state/links";
import { toast } from "@/state/toasts";
import { announceMove } from "@/state/undo";
import { useUi } from "@/state/ui";

/** "Unsubscribe" next to the sender of a newsletter, with a question first. */
export function UnsubscribeButton({ message }: { message: Message }) {
  const { t } = useT();
  const [asking, setAsking] = useState(false);
  if (!message.unsubscribe) return null;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setAsking(true)} className="h-7 px-2.5 text-[12.5px]">
        {t("reader.unsubscribe")}
      </Button>
      <Dialog open={asking} onClose={() => setAsking(false)} width="sm">
        {asking && <UnsubscribeQuestion message={message} onDone={() => setAsking(false)} />}
      </Dialog>
    </>
  );
}

function UnsubscribeQuestion({ message, onDone }: { message: Message; onDone: () => void }) {
  const { t } = useT();
  const client = useQueryClient();
  const [archive, setArchive] = useState(true);
  const [busy, setBusy] = useState(false);
  const name = displayName(message.from);
  // The engine tries a One-Click request first and sends a mail when that is missing or fails, so
  // whenever a usable mailto address is there the dialog names it: the mail goes out under the
  // reader's name to an address the newsletter picked.
  const byMail = message.unsubscribe?.mailto ? unsubscribeMail(message.unsubscribe.mailto) : null;
  const oneClick = message.unsubscribe?.oneClick ?? false;
  const pageOnly = !oneClick && !byMail;

  const unsubscribe = async () => {
    setBusy(true);
    try {
      const outcome = await backend().unsubscribe(message.id);
      if (outcome.kind === "openPage") {
        // The page comes from the mail like any link in it, so it goes through the same question.
        if (requestOpenLink(outcome.url, "") === "opened") toast(t("toast.unsubscribePage", { name }));
      } else {
        toast(t("toast.unsubscribed", { name }), "success");
      }
      if (archive) {
        const ids = await backend().inboxMessagesFrom(message.from.email);
        if (ids.length > 0) {
          useUi.getState().selectThread(null);
          announceMove(await backend().archive(ids), t("toast.unsubscribeArchived", { count: ids.length }), () =>
            client.invalidateQueries(),
          );
        }
      }
      onDone();
    } catch (reason) {
      toast(
        t("toast.unsubscribeFailed", { reason: reason instanceof Error ? reason.message : String(reason) }),
        "error",
      );
      setBusy(false);
    } finally {
      await client.invalidateQueries();
    }
  };

  return (
    <div className="flex flex-col items-center gap-3 px-6 pt-2 pb-6 text-center">
      <NyuScene name="pick" className="w-40" />
      <h2 className="text-[18px] font-extrabold text-balance">{t("unsubscribe.title", { name })}</h2>
      <p className="text-[13px] text-muted">{pageOnly ? t("unsubscribe.bodyPage") : t("unsubscribe.body")}</p>
      {byMail && (
        <p className="text-[13px] text-muted">
          {t(oneClick ? "unsubscribe.mailToFallback" : "unsubscribe.mailTo", { address: byMail.address })}
        </p>
      )}
      <div className="w-full rounded-2xl bg-canvas px-4 py-1 text-left">
        <Toggle checked={archive} onChange={setArchive} label={t("unsubscribe.archive")} />
      </div>
      <div className="flex flex-wrap justify-center gap-2 pt-1">
        <Button variant="primary" busy={busy} autoFocus onClick={() => void unsubscribe()}>
          {t("reader.unsubscribe")}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
