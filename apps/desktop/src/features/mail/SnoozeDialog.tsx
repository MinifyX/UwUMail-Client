import { Button, Field, Icon, ICONS, TextInput } from "@uwusuite/design";
import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { fromLocalInput, toLocalInput } from "@/lib/sendLater";
import { snoozePresets } from "@/lib/snooze";
import { type SnoozeRequest, useUi } from "@/state/ui";
import { useSnooze } from "./snooze";

/** "Snooze until…": a quick choice, or any later date and time. */
export function SnoozeDialog() {
  const { t } = useT();
  const request = useUi((s) => s.snoozing);
  const close = useUi((s) => s.closeSnooze);
  return (
    <Dialog open={request !== null} onClose={close} title={t("snooze.title")} width="sm">
      {request && <SnoozeForm request={request} onClose={close} />}
    </Dialog>
  );
}

function SnoozeForm({ request, onClose }: { request: SnoozeRequest; onClose: () => void }) {
  const { t, i18n } = useT();
  const { snooze } = useSnooze();
  const [now] = useState(() => new Date());
  const presets = snoozePresets(now);
  const [value, setValue] = useState(() => toLocalInput(presets[0]?.at ?? now));
  const [tried, setTried] = useState(false);
  const chosen = fromLocalInput(value);
  const problem = !chosen ? "invalid" : chosen.getTime() <= now.getTime() ? "past" : null;
  const format = (date: Date) =>
    date.toLocaleString(i18n.language, { weekday: "short", hour: "2-digit", minute: "2-digit" });

  const pick = (until: Date) => {
    onClose();
    void snooze(request.messages, until, request.onSnoozed);
  };

  return (
    <form
      className="flex flex-col gap-4 px-6 pt-2 pb-6"
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        if (problem || !chosen || chosen.getTime() <= Date.now()) return;
        pick(chosen);
      }}
    >
      <ul className="flex flex-col gap-1">
        {presets.map(({ preset, at }) => (
          <li key={preset}>
            <button
              type="button"
              onClick={() => pick(at)}
              className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[13.5px] hover:bg-pink-tint/60 focus-visible:bg-pink-tint/60 focus-visible:outline-none"
            >
              <Icon icon={ICONS.time} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate font-semibold">{t(`snooze.preset.${preset}`)}</span>
              <span className="shrink-0 text-[12.5px] text-muted">{format(at)}</span>
            </button>
          </li>
        ))}
      </ul>
      <Field label={t("snooze.pick")} error={tried && problem ? t(`snooze.problem.${problem}`) : undefined}>
        {(id) => (
          <TextInput
            id={id}
            type="datetime-local"
            value={value}
            min={toLocalInput(now)}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary">
          {t("snooze.confirm")}
        </Button>
      </div>
    </form>
  );
}
