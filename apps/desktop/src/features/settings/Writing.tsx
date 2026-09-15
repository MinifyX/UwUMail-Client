import { Segmented } from "@/components/ui/Field";
import { useT } from "@/i18n";
import { UNDO_SEND_CHOICES, useSettings } from "@/state/settings";
import { Row } from "./Row";

export function Writing() {
  const { t } = useT();
  const undoSendSeconds = useSettings((s) => s.undoSendSeconds);
  const update = useSettings((s) => s.update);
  return (
    <Row label={t("settings.undoSend")} description={t("settings.undoSendDesc")}>
      <Segmented
        label={t("settings.undoSend")}
        value={String(undoSendSeconds)}
        onChange={(value) => update({ undoSendSeconds: Number(value) as (typeof UNDO_SEND_CHOICES)[number] })}
        options={UNDO_SEND_CHOICES.map((seconds) => ({
          value: String(seconds),
          label: seconds === 0 ? t("settings.undoSendOff") : t("settings.seconds", { count: seconds }),
        }))}
      />
    </Row>
  );
}
