import type { Shipment, ShipmentAccount, ShipmentStatus } from "@/backend/types";
import { todayKey } from "./calendarDates";

const DAY = 24 * 60 * 60 * 1000;

/** The steps the progress line shows, in order. */
export const STEPS: readonly ShipmentStatus[] = ["ordered", "shipped", "inTransit", "outForDelivery", "delivered"];

const DONE: ReadonlySet<ShipmentStatus> = new Set(["delivered", "returned", "cancelled"]);

/** Whether the parcel is still coming (or waiting to be picked up). */
export const isActive = (shipment: Shipment) => !DONE.has(shipment.status);

/** The step of the progress line the parcel is at; a pickup or a failed try sits at the last mile. */
export function stepOf(status: ShipmentStatus): number {
  if (status === "readyForPickup" || status === "deliveryFailed") return 3;
  const index = STEPS.indexOf(status);
  return index < 0 ? 2 : index;
}

/** The local day of a date or a time; a bare date stays the day it names. */
export function dayOf(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : todayKey(new Date(value));
}

/** When the parcel was finished: delivered, sent back or cancelled. */
export const finishedAt = (shipment: Shipment) => shipment.deliveredAt || shipment.statusAt || shipment.updated;

/** The day it is expected, if known. */
const expectedDay = (shipment: Shipment) => (shipment.expected?.from ? dayOf(shipment.expected.from) : null);

/** Unique across mailboxes: ids are unique within their mailbox only. */
export const shipmentKey = (shipment: Pick<Shipment, "accountId" | "id">) => `${shipment.accountId}:${shipment.id}`;

export interface ShipmentGroups {
  today: Shipment[];
  onTheWay: Shipment[];
  delivered: Shipment[];
}

/** Today's parcels, the others still coming (soonest first), and the ones finished in the last 7 days. */
export function groupShipments(shipments: Shipment[], now: Date = new Date()): ShipmentGroups {
  const today = todayKey(now);
  const groups: ShipmentGroups = { today: [], onTheWay: [], delivered: [] };
  for (const shipment of shipments) {
    if (shipment.hidden) continue;
    if (!isActive(shipment)) {
      if (now.getTime() - Date.parse(finishedAt(shipment)) <= 7 * DAY) groups.delivered.push(shipment);
    } else if (shipment.status === "outForDelivery" || expectedDay(shipment) === today) {
      groups.today.push(shipment);
    } else {
      groups.onTheWay.push(shipment);
    }
  }
  const expected = (s: Shipment) => expectedDay(s) ?? "9999";
  groups.onTheWay.sort(
    (a, b) => expected(a).localeCompare(expected(b)) || Date.parse(b.updated) - Date.parse(a.updated),
  );
  groups.delivered.sort((a, b) => Date.parse(finishedAt(b)) - Date.parse(finishedAt(a)));
  return groups;
}

/** The parcel a mail belongs to, newest first, if any. */
export function shipmentOfMail(shipments: Shipment[], emailId: string): Shipment | null {
  return shipments.find((s) => !s.hidden && s.emailIds.includes(emailId)) ?? null;
}

/** Parcels are there when at least one mailbox has them on. */
export const shipmentsAvailable = (accounts: ShipmentAccount[]) => accounts.some((account) => account.on);
