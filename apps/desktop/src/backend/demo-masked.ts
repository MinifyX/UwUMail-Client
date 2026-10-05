// Made-up masked addresses for the demo, on reserved domains only. They start over with every
// reload.

import { BackendError } from "./backend";
import type { MaskedAddress, MaskedAddressInput, MaskedAddressPatch, MaskedOptions } from "./types";

type Lang = "de" | "en";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The demo mailbox's own domain, and one only for masked addresses. */
const OPTIONS: MaskedOptions = { domains: ["mask.example", "uwumail.example"], defaultDomain: "mask.example" };

const WORDS = ["maple", "otter", "cloud", "pebble", "mochi", "fern", "comet", "tulip", "badger", "lantern"];

function sampleAddresses(lang: Lang, now: number): MaskedAddress[] {
  const de = lang === "de";
  const at = (ago: number) => new Date(now - ago).toISOString();
  const item = (patch: Partial<MaskedAddress> & Pick<MaskedAddress, "id" | "email">): MaskedAddress => ({
    state: "enabled",
    forDomain: "",
    description: "",
    url: null,
    createdAt: at(30 * DAY),
    lastMessageAt: null,
    createdBy: "Portal",
    ...patch,
  });
  return [
    item({
      id: "x6",
      email: "comet.fern217@mask.example",
      state: "pending",
      forDomain: "https://tickets.example.org",
      description: de ? "Konzertkarten" : "Concert tickets",
      url: "https://tickets.example.org/account",
      createdAt: at(2 * HOUR),
      createdBy: "JMAP",
    }),
    item({
      id: "x5",
      email: "shop.maple.otter482@mask.example",
      forDomain: "https://pixelparts.example",
      description: de ? "Pixelparts-Kundenkonto" : "Pixelparts customer account",
      createdAt: at(6 * DAY),
      lastMessageAt: at(5 * HOUR),
    }),
    item({
      id: "x4",
      email: "mochi.tulip90@uwumail.example",
      forDomain: "https://forum.example.net",
      description: de ? "Katzenforum" : "Cat forum",
      createdAt: at(21 * DAY),
      lastMessageAt: at(3 * DAY),
      createdBy: "JMAP",
    }),
    item({
      id: "x3",
      email: "pebble.badger731@mask.example",
      state: "disabled",
      forDomain: "https://deals.example.com",
      description: de ? "Gewinnspiel – schickt nur noch Werbung" : "Giveaway – only sends ads now",
      createdAt: at(64 * DAY),
      lastMessageAt: at(DAY),
    }),
    item({
      id: "x2",
      email: "cloud.lantern55@mask.example",
      state: "deleted",
      forDomain: "https://oldnews.example",
      description: de ? "Alter Newsletter" : "Old newsletter",
      createdAt: at(180 * DAY),
      lastMessageAt: at(90 * DAY),
    }),
    item({
      id: "x1",
      email: "fern.otter804@uwumail.example",
      forDomain: "https://library.example.org",
      description: de ? "Stadtbücherei" : "City library",
      createdAt: at(240 * DAY),
      lastMessageAt: at(12 * DAY),
    }),
  ];
}

/** The demo's masked addresses: made, switched and restored like on the server, in memory. */
export class DemoMasked {
  private list: MaskedAddress[];
  private nextId = 7;

  constructor(
    lang: Lang,
    private readonly changed: () => void,
  ) {
    this.list = sampleAddresses(lang, Date.now());
  }

  options(): MaskedOptions {
    return structuredClone(OPTIONS);
  }

  addresses(): MaskedAddress[] {
    return this.list.map((item) => ({ ...item }));
  }

  create(input: MaskedAddressInput): MaskedAddress {
    const domain = input.domain ?? OPTIONS.defaultDomain ?? OPTIONS.domains![0]!;
    if (!OPTIONS.domains!.includes(domain)) {
      throw new BackendError("forbidden", `Masked addresses can't be made on ${domain}.`);
    }
    const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)]!;
    let email: string;
    do {
      const local = `${pick()}.${pick()}${Math.floor(Math.random() * 1000)}`;
      email = `${input.emailPrefix ? `${input.emailPrefix}.` : ""}${local}@${domain}`;
    } while (this.list.some((item) => item.email === email));
    const item: MaskedAddress = {
      id: `x${this.nextId++}`,
      email,
      state: "enabled",
      forDomain: input.forDomain,
      description: input.description,
      url: input.url,
      createdAt: new Date().toISOString(),
      lastMessageAt: null,
      createdBy: "JMAP",
    };
    this.list = [item, ...this.list];
    this.changed();
    return { ...item };
  }

  update(id: string, patch: MaskedAddressPatch) {
    if (!this.list.some((item) => item.id === id)) throw new BackendError("not_found", "This masked address is gone.");
    const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    this.list = this.list.map((item) => (item.id === id ? { ...item, ...changes } : item));
    this.changed();
  }
}
