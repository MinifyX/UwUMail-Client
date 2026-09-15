import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, X } from "lucide-react";
import { backend } from "@/backend/backend";
import { IconButton } from "@/components/ui/Button";
import { useT } from "@/i18n";
import { toast } from "@/state/toasts";
import { Row } from "./Row";

export const BLOCKED_SENDERS_KEY = ["blockedSenders"] as const;

export function BlockedSenders() {
  const { t } = useT();
  const client = useQueryClient();
  const { data: blocked = [] } = useQuery({ queryKey: BLOCKED_SENDERS_KEY, queryFn: () => backend().blockedSenders() });

  return (
    <Row label={t("settings.blockedSenders")} description={t("settings.blockedSendersDesc")}>
      {blocked.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-3 text-[13px] text-muted">
          {t("settings.blockedSendersEmpty")}
        </p>
      ) : (
        <ul className="flex max-h-56 flex-col overflow-y-auto rounded-2xl border border-hairline p-1">
          {blocked.map((entry) => (
            <li key={entry} className="flex items-center gap-3 rounded-xl py-1 pr-1 pl-3 hover:bg-elevated">
              <Ban className="size-4 shrink-0 text-faint" aria-hidden />
              <span className="selectable min-w-0 flex-1 truncate text-[13.5px]">{entry}</span>
              <IconButton
                icon={X}
                size="sm"
                label={t("settings.unblockSender", { entry })}
                onClick={() =>
                  void backend()
                    .unblockSender(entry)
                    .then(() => client.invalidateQueries({ queryKey: BLOCKED_SENDERS_KEY }))
                    .then(() => toast(t("toast.unblocked", { entry })))
                }
              />
            </li>
          ))}
        </ul>
      )}
    </Row>
  );
}
