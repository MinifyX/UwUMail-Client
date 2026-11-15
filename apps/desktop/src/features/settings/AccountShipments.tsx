import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Toggle } from "@uwusuite/design";
import { backend } from "@/backend/backend";
import type { Account } from "@/backend/types";
import { Dialog } from "@/components/ui/Dialog";
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
  const [asking, setAsking] = useState(false);
  const entry = data?.find((each) => each.accountId === account.id);
  if (!entry?.switchable) return null;

  const change = async (on: boolean) => {
    setAsking(false);
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
        // The server deletes the parcels it found when they go off, so that asks first.
        onChange={(on) => (on ? void change(true) : setAsking(true))}
        label={t("accountShipments.title")}
        description={t("accountShipments.description")}
      />
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title={t("accountShipments.offTitle")}
        tone="warning"
        width="sm"
        footer={
          <>
            <Button variant="ghost" autoFocus onClick={() => setAsking(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={() => void change(false)}>
              {t("accountShipments.offAction")}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-muted">{t("accountShipments.offConfirm", { email: account.email })}</p>
      </Dialog>
    </div>
  );
}
