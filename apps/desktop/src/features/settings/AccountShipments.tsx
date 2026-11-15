import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Toggle } from "@uwusuite/design";
import { backend } from "@/backend/backend";
import type { Account } from "@/backend/types";
import { useT } from "@/i18n";
import { queryKeys } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { useShipmentAccounts } from "../shipments/useShipments";

/** Settings → Mailboxes, per mailbox whose UwUMail server offers parcels: switching them on or off. */
export function AccountShipments({ account }: { account: Account }) {
  const { t } = useT();
  const client = useQueryClient();
  const { data } = useShipmentAccounts();
  const [busy, setBusy] = useState(false);
  const entry = data?.find((each) => each.accountId === account.id);
  if (!entry?.switchable) return null;

  const change = async (on: boolean) => {
    // The server deletes the parcels it found when they go off.
    if (!on && !window.confirm(t("accountShipments.offConfirm", { email: account.email }))) return;
    setBusy(true);
    try {
      const saved = await backend().saveUserSettings(account.id, { shipments: on ? "on" : "off" });
      if (!saved.ok) throw new Error(saved.type);
    } catch (error) {
      toast(t("accountShipments.failed", { reason: error instanceof Error ? error.message : String(error) }), "error");
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: queryKeys.shipments });
    }
  };

  return (
    <div className="basis-full border-t border-hairline pt-2.5">
      <Toggle
        checked={entry.on}
        disabled={busy}
        onChange={(on) => void change(on)}
        label={t("accountShipments.title")}
        description={t("accountShipments.description")}
      />
    </div>
  );
}
