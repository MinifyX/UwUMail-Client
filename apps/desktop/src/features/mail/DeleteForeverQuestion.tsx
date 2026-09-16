import { NyuScene } from "@/components/nyu/scenes";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { answerDeleteForever, useDeleteForever } from "@/state/deleteForever";

/** Nyu asks once before mail in the trash goes for good. */
export function DeleteForeverQuestion() {
  const { t } = useT();
  const pending = useDeleteForever((s) => s.pending);
  const cancel = () => answerDeleteForever(false);

  return (
    <Dialog open={pending !== null} onClose={cancel} width="sm">
      {pending && (
        <div className="flex flex-col items-center gap-3 px-6 pt-2 pb-6 text-center">
          <NyuScene name="goodbye" className="w-40" />
          <h2 className="text-[18px] font-extrabold text-balance">
            {t("deleteForever.title", { count: pending.count })}
          </h2>
          <p className="text-[13px] text-muted">{t("deleteForever.body", { count: pending.count })}</p>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Button variant="danger" autoFocus onClick={() => answerDeleteForever(true)}>
              {t("deleteForever.confirm")}
            </Button>
            <Button variant="ghost" onClick={cancel}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
