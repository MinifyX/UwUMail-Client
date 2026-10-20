import { Button, ICONS } from "@uwusuite/design";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";

/** Asked before sending when the text speaks of an attachment and none is there. */
export function AttachmentReminderDialog({
  open,
  onClose,
  onAttach,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  onAttach: () => void;
  onSend: () => void;
}) {
  const { t } = useT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("attachmentReminder.title")}
      width="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onSend}>
            {t("attachmentReminder.sendAnyway")}
          </Button>
          <Button variant="primary" icon={ICONS.attachment} autoFocus onClick={onAttach}>
            {t("attachmentReminder.attach")}
          </Button>
        </div>
      }
    >
      <p className="text-[14px]">{t("attachmentReminder.body")}</p>
    </Dialog>
  );
}
