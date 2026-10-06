import { Button, Field, Icon, ICONS, TextInput } from "@uwusuite/design";
import { useState } from "react";
import type { SendLaterInfo } from "@/backend/types";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { isIos } from "@/lib/device";
import { fromLocalInput, sendLaterPresets, sendLaterProblem, toLocalInput } from "@/lib/sendLater";

interface SendLaterDialogProps {
  open: boolean;
  /** Where the mail waits (the UwUMail server or this device) and how far ahead it may go. */
  info: SendLaterInfo;
  /** A time to start from, e.g. a scheduled mail's own when it gets a new one. */
  initial?: Date;
  /** The button that confirms; "Schedule" by default. */
  confirmLabel?: string;
  onClose: () => void;
  onPick: (sendAt: string) => void;
}

/**
 * Picks when a mail goes: a quick choice, or any date and time within what the mailbox can hold.
 * For mailboxes without a UwUMail server it says that UwUMail has to run at that time.
 */
export function SendLaterDialog({ open, onClose, ...rest }: SendLaterDialogProps) {
  const { t } = useT();
  return (
    <Dialog open={open} onClose={onClose} title={t("compose.later.title")} width="sm">
      {open && <SendLaterForm onClose={onClose} {...rest} />}
    </Dialog>
  );
}

function SendLaterForm({ info, initial, confirmLabel, onClose, onPick }: Omit<SendLaterDialogProps, "open">) {
  const { t, i18n } = useT();
  const [now] = useState(() => new Date());
  const presets = sendLaterPresets(now);
  const [value, setValue] = useState(() => toLocalInput(initial ?? presets[0]?.at ?? now));
  const [tried, setTried] = useState(false);
  const chosen = fromLocalInput(value);
  const maxDelay = info.maxDelaySeconds;
  const problem = sendLaterProblem(chosen, maxDelay, new Date());
  const local = info.kind === "local";
  const format = (date: Date) =>
    date.toLocaleString(i18n.language, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const problemKey = problem === "tooFar" && local ? "tooFarLocal" : problem;

  return (
    <form
      className="flex flex-col gap-4 px-6 pt-2 pb-6"
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        if (problem || !chosen) return;
        onPick(chosen.toISOString());
      }}
    >
      <ul className="flex flex-col gap-1">
        {presets.map(({ preset, at }) => (
          <li key={preset}>
            <button
              type="button"
              onClick={() => onPick(at.toISOString())}
              className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[13.5px] hover:bg-pink-tint/60"
            >
              <Icon icon={ICONS.time} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate font-semibold">{t(`compose.later.${preset}`)}</span>
              <span className="shrink-0 text-[12.5px] text-muted">{format(at)}</span>
            </button>
          </li>
        ))}
      </ul>
      <Field
        label={t("compose.later.pick")}
        error={
          tried && problemKey
            ? t(`compose.later.problem.${problemKey}`, { days: Math.floor(maxDelay / 86400) })
            : undefined
        }
      >
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
      <p
        className="flex gap-2 rounded-xl bg-pink-tint/40 px-3 py-2.5 text-[12.5px] text-muted"
        data-testid="later-where"
      >
        {local ? (
          <Icon icon={ICONS.device} className="mt-0.5 shrink-0" />
        ) : (
          <Icon icon={ICONS.server} className="mt-0.5 shrink-0" />
        )}
        <span>{t(local ? (isIos ? "compose.later.localIos" : "compose.later.local") : "compose.later.server")}</span>
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary">
          {confirmLabel ?? t("compose.later.schedule")}
        </Button>
      </div>
    </form>
  );
}
