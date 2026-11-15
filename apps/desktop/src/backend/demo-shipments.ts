import type { Shipment } from "./types";

const HOUR = 60 * 60 * 1000;

/** A few parcels for the demo: one today, one on its way, one to pick up, one delivered. */
export function demoShipments(accountId: string, now: Date = new Date()): Shipment[] {
  const at = (hours: number) => new Date(now.getTime() + hours * HOUR).toISOString();
  const base = {
    accountId,
    trackingUrl: null,
    title: null,
    orderRef: null,
    deliveredAt: null,
    pickup: null,
    hidden: false,
    emailIds: [],
    expected: null,
  };
  return [
    {
      ...base,
      id: "demo-today",
      carrier: "dhl",
      number: "00340434161094042557",
      trackingUrl: "https://tracking.example/00340434161094042557",
      merchant: "Bücherwurm",
      orderRef: "BW-20419",
      status: "outForDelivery",
      statusAt: at(-2),
      expected: { from: at(1), to: at(3), allDay: false },
      events: [
        { at: at(-30), status: "shipped", text: null, location: null, source: "mail" },
        { at: at(-2), status: "outForDelivery", text: null, location: null, source: "mail" },
      ],
      created: at(-30),
      updated: at(-2),
    },
    {
      ...base,
      id: "demo-way",
      carrier: "hermes",
      number: "H1002345678901",
      merchant: "Teeladen",
      status: "inTransit",
      statusAt: at(-20),
      expected: { from: at(48), to: null, allDay: true },
      events: [{ at: at(-20), status: "inTransit", text: null, location: null, source: "mail" }],
      created: at(-20),
      updated: at(-20),
    },
    {
      ...base,
      id: "demo-pickup",
      carrier: "dpd",
      number: "01505012345678",
      merchant: "Kabelkiste",
      status: "readyForPickup",
      statusAt: at(-5),
      pickup: { kind: "parcelShop", name: "Kiosk am Markt", address: "Marktplatz 1", until: at(24 * 6).slice(0, 10) },
      events: [{ at: at(-5), status: "readyForPickup", text: null, location: null, source: "mail" }],
      created: at(-50),
      updated: at(-5),
    },
    {
      ...base,
      id: "demo-done",
      carrier: "ups",
      number: "1Z999AA10123456784",
      merchant: "Gartenglück",
      status: "delivered",
      statusAt: at(-26),
      deliveredAt: at(-26),
      events: [{ at: at(-26), status: "delivered", text: null, location: null, source: "mail" }],
      created: at(-80),
      updated: at(-26),
    },
  ];
}
