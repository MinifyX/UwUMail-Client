import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, X } from "lucide-react";
import { backend } from "@/backend/backend";
import type { BlockedSender } from "@/backend/types";
import { IconButton } from "@/components/ui/Button";
import { useT } from "@/i18n";
import { useAccounts } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { Row } from "./Row";

export const BLOCKED_SENDERS_KEY = ["blockedSenders"] as const;

const keyOf = (sender: BlockedSender) => `${sender.accountId ?? "app"}:${sender.serverId ?? sender.entry}`;

export function BlockedSenders() {
  const { t } = useT();
  const client = useQueryClient();
  const { data: accounts = [] } = useAccounts();
  const { data: blocked = [] } = useQuery({ queryKey: BLOCKED_SENDERS_KEY, queryFn: () => backend().blockedSenders() });
  const where = (sender: BlockedSender) => {
    if (!sender.accountId) return t("settings.blockedInApp");
    const email = accounts.find((account) => account.id === sender.accountId)?.email ?? "";
    return t("settings.blockedOnServer", { email });
  };
  const unblock = (sender: BlockedSender) =>
    void backend()
      .unblockSender(sender)
      .then(() => toast(t("toast.unblocked", { entry: sender.entry })))
      .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), "error"))
      .finally(() => void client.invalidateQueries({ queryKey: BLOCKED_SENDERS_KEY }));

  return (
    <Row label={t("settings.blockedSenders")} description={t("settings.blockedSendersDesc")}>
      {blocked.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-3 text-[13px] text-muted">
          {t("settings.blockedSendersEmpty")}
        </p>
      ) : (
        <ul className="flex max-h-56 flex-col overflow-y-auto rounded-2xl border border-hairline p-1">
          {blocked.map((sender) => (
            <li key={keyOf(sender)} className="flex items-center gap-3 rounded-xl py-1 pr-1 pl-3 hover:bg-elevated">
              <Ban className="size-4 shrink-0 text-faint" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="selectable block truncate text-[13.5px]">{sender.entry}</span>
                <span className="block truncate text-[12px] text-muted">{where(sender)}</span>
              </span>
              <IconButton
                icon={X}
                size="sm"
                label={t("settings.unblockSender", { entry: sender.entry })}
                onClick={() => unblock(sender)}
              />
            </li>
          ))}
        </ul>
      )}
    </Row>
  );
}
