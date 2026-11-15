import { Icon, ICONS } from "@uwusuite/design";
import { useT } from "@/i18n";
import { shipmentOfMail } from "@/lib/shipments";
import { showShipment, useShipments } from "./useShipments";

/** "Parcel: out for delivery" above a shipping mail; leads to the parcel's card. */
export function ShipmentChip({ emailId }: { emailId: string }) {
  const { t } = useT();
  const { data: shipments = [] } = useShipments();
  const shipment = shipmentOfMail(shipments, emailId);
  if (!shipment) return null;
  return (
    <button
      type="button"
      onClick={() => showShipment(shipment)}
      className="inline-flex items-center gap-1.5 self-start rounded-full border border-hairline bg-canvas px-3 py-1 text-[12.5px] font-semibold text-ink hover:bg-pink-tint/50 focus-visible:shadow-focus focus-visible:outline-hidden"
    >
      <Icon icon={ICONS.parcel} size="sm" className="text-muted" />
      {t("shipments.chip", { status: t(`shipments.status.${shipment.status}`) })}
    </button>
  );
}
