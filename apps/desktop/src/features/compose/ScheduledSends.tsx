import { useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Clock, PenLine, Send, Server, Smartphone, TriangleAlert, Undo2, WifiOff } from "lucide-react";
import { useState } from "react";
import { backend } from "@/backend/backend";
import type { ScheduledSend, SendLaterInfo } from "@/backend/types";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Badge } from "@/components/ui/Pill";
import { useT } from "@/i18n";
import { displayName } from "@/lib/format";
import { useAccounts } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { SendLaterDialog } from "./SendLater";
import { editScheduled, formatSendTime, scheduledKeys, useScheduledSends } from "./scheduled";

/** "Scheduled" in the folder list, while mail waits for its time. */
export function ScheduledNavItem() {
  const { t } = useT();
  const { data: later = [] } = useScheduledSends();
  const [open, setOpen] = useState(false);
  if (later.length === 0 && !open) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group flex h-9 w-full items-center gap-3 rounded-xl px-3 text-left text-[13.5px] text-ink/85 transition-colors hover:bg-pink-tint/50"
      >
        <Clock className="size-[17px] shrink-0 text-muted" strokeWidth={2} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t("nav.scheduled")}</span>
        <Badge count={later.length} />
      </button>
      <ScheduledDialog open={open} sends={later} onClose={() => setOpen(false)} />
    </>
  );
}

interface ScheduledDialogProps {
  open: boolean;
  sends: ScheduledSend[];
  onClose: () => void;
}

/** The list of scheduled mail: when each goes, and a new time, send now, edit or don't send. */
export function ScheduledDialog({ open, sends, onClose }: ScheduledDialogProps) {
  const { t } = useT();
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ entry: ScheduledSend; info: SendLaterInfo } | null>(null);

  /** Runs one action on one entry, says how it went and reads the list again. */
  const act = async (entry: ScheduledSend, run: () => Promise<void>, done?: string) => {
    setBusy(entry.id);
    try {
      await run();
      if (done) toast(done, "success");
    } catch (reason) {
      toast(t("scheduled.failed", { reason: reason instanceof Error ? reason.message : String(reason) }), "error");
    } finally {
      setBusy(null);
      await client.invalidateQueries({ queryKey: scheduledKeys.list });
    }
  };

  const changeTime = (entry: ScheduledSend) =>
    void act(entry, async () => {
      const info = await backend().sendLaterInfo(entry.accountId);
      setMoving({ entry, info: { ...info, kind: entry.kind } });
    });

  return (
    <>
      <Dialog open={open && !moving} onClose={onClose} title={t("scheduled.title")} width="md">
        <ScheduledList
          sends={sends}
          busy={busy}
          onEdit={(entry) => {
            onClose();
            void editScheduled(entry);
          }}
          onStop={(entry) => void act(entry, () => backend().stopScheduled(entry), t("scheduled.stopped"))}
          onSendNow={(entry) => void act(entry, () => backend().sendScheduledNow(entry), t("scheduled.sentNow"))}
          onChangeTime={changeTime}
        />
      </Dialog>
      {moving && (
        <SendLaterDialog
          open
          info={moving.info}
          initial={new Date(moving.entry.sendAt)}
          confirmLabel={t("scheduled.reschedule")}
          onClose={() => setMoving(null)}
          onPick={(sendAt) => {
            const { entry } = moving;
            setMoving(null);
            void act(
              entry,
              () => backend().rescheduleSend(entry, sendAt),
              t("scheduled.rescheduled", { time: formatSendTime(sendAt) }),
            );
          }}
        />
      )}
    </>
  );
}

interface ScheduledListProps {
  sends: ScheduledSend[];
  busy: string | null;
  onEdit: (entry: ScheduledSend) => void;
  onStop: (entry: ScheduledSend) => void;
  onSendNow: (entry: ScheduledSend) => void;
  onChangeTime: (entry: ScheduledSend) => void;
}

export function ScheduledList({ sends, busy, onEdit, onStop, onSendNow, onChangeTime }: ScheduledListProps) {
  const { t, i18n } = useT();
  const { data: accounts = [] } = useAccounts();
  const several = new Set(sends.map((entry) => entry.accountId)).size > 1 || accounts.length > 1;

  if (sends.length === 0) {
    return <p className="px-6 pt-2 pb-6 text-[13.5px] text-muted">{t("scheduled.empty")}</p>;
  }

  return (
    <div className="flex flex-col gap-3 px-6 pt-1 pb-6">
      <p className="text-[13px] text-muted">{t("scheduled.desc")}</p>
      <ul className="flex flex-col gap-2">
        {sends.map((entry) => {
          const account = accounts.find((a) => a.id === entry.accountId);
          const local = entry.kind === "local";
          return (
            <li
              key={`${entry.kind}:${entry.id}`}
              className="flex flex-col gap-2 rounded-2xl border border-hairline p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-semibold">{entry.subject || t("reader.noSubject")}</p>
                <p className="truncate text-[12.5px] text-muted">
                  {t("scheduled.to", { names: entry.to.map(displayName).join(", ") })}
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-[12.5px] font-semibold text-pink-ink">
                  <Clock className="size-3.5 shrink-0" aria-hidden />
                  {new Date(entry.sendAt).toLocaleString(i18n.language, { dateStyle: "full", timeStyle: "short" })}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-muted">
                  {local ? (
                    <Smartphone className="size-3.5 shrink-0" aria-hidden />
                  ) : (
                    <Server className="size-3.5 shrink-0" aria-hidden />
                  )}
                  <span>{t(local ? "scheduled.onDevice" : "scheduled.onServer")}</span>
                  {several && account && <span className="truncate">· {account.email}</span>}
                </p>
                {entry.held && (
                  <p className="mt-1 flex items-start gap-1.5 text-[12px] text-danger">
                    <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                    <span>
                      {t(entry.held === "unsure" ? "scheduled.heldUnsure" : "scheduled.heldFailed", {
                        reason: entry.heldReason ?? "",
                      })}
                    </span>
                  </p>
                )}
                {entry.retrying && (
                  <p className="mt-1 flex items-center gap-1.5 text-[12px] text-danger">
                    <WifiOff className="size-3.5 shrink-0" aria-hidden />
                    {t("scheduled.retrying", { time: formatSendTime(entry.sendAt) })}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" icon={PenLine} disabled={busy !== null} onClick={() => onEdit(entry)}>
                  {t("scheduled.edit")}
                </Button>
                <Button size="sm" icon={CalendarClock} disabled={busy !== null} onClick={() => onChangeTime(entry)}>
                  {t("scheduled.reschedule")}
                </Button>
                <Button size="sm" icon={Send} disabled={busy !== null} onClick={() => onSendNow(entry)}>
                  {t("scheduled.sendNow")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Undo2}
                  busy={busy === entry.id}
                  disabled={busy !== null}
                  onClick={() => onStop(entry)}
                >
                  {t("scheduled.stop")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
