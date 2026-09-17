import { NyuScene } from "@/components/nyu/scenes";
import { useT } from "@/i18n";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

interface ConfirmDiscardDialogProps {
  open: boolean;
  onDiscard: () => void;
  onKeepEditing: () => void;
}

/** Nyu double-checks before a form with unsaved input actually closes. */
export function ConfirmDiscardDialog({ open, onDiscard, onKeepEditing }: ConfirmDiscardDialogProps) {
  const { t } = useT();
  return (
    <Dialog open={open} onClose={onKeepEditing} width="sm">
      {open && (
        <div className="flex flex-col items-center gap-3 px-6 pt-2 pb-6 text-center">
          <NyuScene name="search" className="w-44" />
          <h2 className="text-[18px] font-extrabold text-balance">{t("discardChanges.title")}</h2>
          <p className="text-[13px] text-muted">{t("discardChanges.body")}</p>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Button variant="primary" autoFocus onClick={onKeepEditing}>
              {t("discardChanges.keepEditing")}
            </Button>
            <Button variant="danger" onClick={onDiscard}>
              {t("discardChanges.discard")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
