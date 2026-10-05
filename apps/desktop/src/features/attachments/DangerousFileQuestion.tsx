import { NyuScene } from "@/components/nyu/scenes";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { answerDangerousFile, useDangerousFile } from "@/state/dangerousFile";

/** Nyu asks once before a file that can run programs is opened or saved (browser demo; see state/dangerousFile). */
export function DangerousFileQuestion() {
  const { t } = useT();
  const pending = useDangerousFile((s) => s.pending);
  const cancel = () => answerDangerousFile(false);
  const open = pending?.action === "open";

  return (
    <Dialog open={pending !== null} onClose={cancel} width="sm">
      {pending && (
        <div className="flex flex-col items-center gap-3 px-6 pt-2 pb-6 text-center">
          <NyuScene name="loadError" className="w-40" />
          <h2 className="text-[18px] font-extrabold text-balance">
            {open ? t("attachment.dangerous.titleOpen") : t("attachment.dangerous.titleSave")}
          </h2>
          <p className="selectable text-[13.5px] font-semibold break-all">{pending.filename}</p>
          <p className="text-[13px] text-muted">{t("attachment.dangerous.body")}</p>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Button variant="ghost" onClick={cancel}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={() => answerDangerousFile(true)}>
              {open ? t("attachment.dangerOpen") : t("attachment.dangerSave")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
