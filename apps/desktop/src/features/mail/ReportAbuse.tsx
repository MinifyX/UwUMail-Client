import { useState } from "react";
import { backend } from "@/backend/backend";
import type { Message } from "@/backend/types";
import { ICONS } from "@uwusuite/design";
import { Button, Toggle } from "@uwusuite/design";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { abuseDestinations, type AbuseDestination } from "@/lib/report-abuse";
import { requestOpenLink } from "@/state/links";
import { toast } from "@/state/toasts";
import { announceMove } from "@/state/undo";
import { useUi } from "@/state/ui";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Reports abuse to the destination the message itself declares (X-Report-Abuse /
 * X-Complaints-To). Every value is attacker-controlled, so the dialog shows the
 * exact destination before anything happens; nothing is sent or opened silently.
 */
export function useReportAbuse(
  message: Message,
  onMarkSpam?: () => void,
): { reportItem: { icon: typeof ICONS.warning; label: string; onSelect: () => void } | null; dialog: React.ReactNode } {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const destinations = abuseDestinations(message.reportAbuse);
  const reportItem = destinations.length
    ? { icon: ICONS.warning, label: t("reader.reportAbuse"), onSelect: () => setOpen(true) }
    : null;
  return {
    reportItem,
    dialog: open ? (
      <ReportAbuseDialog
        message={message}
        destinations={destinations}
        onClose={() => setOpen(false)}
        onMarkSpam={onMarkSpam}
      />
    ) : null,
  };
}

function ReportAbuseDialog({
  message,
  destinations,
  onClose,
  onMarkSpam,
}: {
  message: Message;
  destinations: AbuseDestination[];
  onClose: () => void;
  onMarkSpam?: () => void;
}) {
  const { t } = useT();
  const client = useQueryClient();
  const [markSpam, setMarkSpam] = useState(true);
  const [busy, setBusy] = useState(false);

  const act = async (dest: AbuseDestination) => {
    setBusy(true);
    try {
      if (dest.kind === "url") {
        // A page from the mail is like any other link: the same guarded opener.
        if (requestOpenLink(dest.value, "") === "opened") toast(t("toast.reportAbusePage"), "success");
      } else {
        await navigator.clipboard.writeText(dest.value);
        toast(t("toast.reportAbuseCopied"), "success");
      }
      if (markSpam) {
        const moved = await backend().markSpam([message.id], true);
        useUi.getState().selectThread(null);
        if (moved.length) announceMove(moved, t("toast.reportAbuseSpammed"), () => client.invalidateQueries());
        onMarkSpam?.();
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={t("reportAbuse.title")} width="md">
      <div className="flex flex-col gap-3 px-6 py-4">
        <p className="text-[13px] text-muted">{t("reportAbuse.body")}</p>
        <div className="flex flex-col gap-2">
          {destinations.map((dest) => (
            <div key={`${dest.kind}:${dest.value}`} className="rounded-2xl bg-canvas px-4 py-3">
              <p className="text-[12px] font-semibold text-muted">
                {dest.kind === "url" ? t("reportAbuse.page") : t("reportAbuse.address")}
              </p>
              <p className="selectable font-mono text-[12px] break-all">{dest.value}</p>
              <Button size="sm" variant="primary" busy={busy} className="mt-2" onClick={() => void act(dest)}>
                {dest.kind === "url" ? t("reportAbuse.open") : t("reportAbuse.copy")}
              </Button>
            </div>
          ))}
        </div>
        <div className="rounded-2xl bg-canvas px-4 py-1">
          <Toggle checked={markSpam} onChange={setMarkSpam} label={t("reportAbuse.markSpam")} />
        </div>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
