import { useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { backend, BackendError } from "@/backend/backend";
import type { Shipment, ShipmentInput, ShipmentPatch, ShipmentStatus } from "@/backend/types";
import { translate } from "@/i18n";
import { queryKeys } from "@/lib/queries";
import { markNow, shipmentKey, shipmentsAvailable } from "@/lib/shipments";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";

export function useShipments() {
  return useQuery({ queryKey: queryKeys.shipments, queryFn: () => backend().shipments() });
}

export function useShipmentAccounts() {
  return useQuery({ queryKey: queryKeys.shipmentAccounts, queryFn: () => backend().shipmentAccounts() });
}

/** Whether any mailbox has parcels; undefined until known. */
export function useShipmentsAvailable(): boolean | undefined {
  const { data } = useShipmentAccounts();
  return data && shipmentsAvailable(data);
}

export function useHiddenShipments() {
  return useQuery({ queryKey: queryKeys.hiddenShipments, queryFn: () => backend().shipments(true) });
}

/** The card (by shipmentKey) the mail's parcel chip leads to; the view scrolls to it and focuses it once. */
export const useShipmentFocus = create<{ key: string | null; set: (key: string | null) => void }>()((set) => ({
  key: null,
  set: (key) => set({ key }),
}));

export function showShipment(shipment: Shipment) {
  useShipmentFocus.getState().set(shipmentKey(shipment));
  useUi.getState().setSection("shipments");
}

/** What went wrong, in the reader's language. */
export function shipmentErrorText(error: unknown): string {
  const code = error instanceof BackendError ? error.code : "internal";
  if (code === "invalid_input") return translate("shipments.error.invalid");
  if (code === "not_found") return translate("shipments.error.notFound");
  if (code === "connection_failed") return translate("shipments.error.connection");
  return translate("shipments.error.generic");
}

/** Adding, renaming, hiding and deleting, with the toasts and the refresh after each. */
export function useShipmentActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.shipments });
  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    try {
      await work();
      await refresh();
      return true;
    } catch (error) {
      toast(shipmentErrorText(error), "error");
      return false;
    }
  };
  const update = (shipment: Shipment, patch: ShipmentPatch) =>
    run(() => backend().updateShipment(shipment.accountId, shipment.id, patch));
  return {
    add: (input: ShipmentInput) => run(() => backend().createShipment(input)),
    rename: (shipment: Shipment, title: string | null) => update(shipment, { title }),
    hide: async (shipment: Shipment) => {
      if (!(await update(shipment, { hidden: true }))) return;
      toast(translate("shipments.toast.hidden"), "success", undefined, {
        action: { label: translate("shipments.undo"), run: () => void update(shipment, { hidden: false }) },
      });
    },
    unhide: (shipment: Shipment) => update(shipment, { hidden: false }),
    mark: async (shipment: Shipment, status: ShipmentStatus) => {
      const at = markNow();
      const set = (undo: boolean) =>
        run(() => backend().markShipment(shipment.accountId, shipment.id, at, status, undo));
      if (!(await set(false))) return;
      const name = translate(`shipments.status.${status}`);
      toast(translate("shipments.toast.marked", { status: name }), "success", undefined, {
        action: { label: translate("shipments.undo"), run: () => void set(true) },
      });
    },
    /** Asks the carrier now; says briefly why not when the server didn't. */
    lookUp: async (shipment: Shipment) => {
      try {
        const refused = await backend().refreshShipment(shipment.accountId, shipment.id);
        await refresh();
        if (refused) toast(translate(`shipments.refused.${refused}`), "info");
        else toast(translate("shipments.toast.lookedUp"), "success");
      } catch (error) {
        toast(shipmentErrorText(error), "error");
      }
    },
    remove: async (shipment: Shipment) => {
      if (await run(() => backend().deleteShipment(shipment.accountId, shipment.id))) {
        toast(translate("shipments.toast.deleted"), "success");
      }
    },
  };
}
