import { describe, expect, it } from "vitest";
import type { ContactInput } from "./types";
import { cardFromInput, patchFromInput, toContactRecord, type JmapCard } from "./contacts";

const card = (patch: Partial<JmapCard> = {}): JmapCard => ({
  id: "k1",
  addressBookIds: { b1: true },
  kind: "individual",
  name: {
    components: [
      { kind: "given", value: "Mina" },
      { kind: "surname", value: "Sommer" },
    ],
    full: "Mina Sommer",
  },
  emails: {
    e1: { address: "mina@example.org", contexts: { private: true }, pref: 1, label: "kept" },
  },
  phones: {
    p1: { number: "+49 30 5550123", features: { mobile: true, voice: true } },
  },
  organizations: { o1: { name: "Nyu & Co" } },
  ...patch,
});

const input = (patch: Partial<ContactInput> = {}): ContactInput => ({
  ...inputOf(card()),
  ...patch,
});

function inputOf(from: JmapCard): ContactInput {
  const record = toContactRecord(from, "a");
  return {
    addressBookId: record.addressBookId,
    given: record.given,
    surname: record.surname,
    organization: record.organization,
    title: record.title,
    emails: record.emails,
    phones: record.phones,
    addresses: record.addresses,
    birthday: record.birthday,
    birthdayChanged: false,
    note: record.note,
  };
}

describe("reading cards", () => {
  it("reads the parts the view shows", () => {
    const record = toContactRecord(
      card({
        titles: { t1: { name: "Baker" } },
        notes: { n1: { note: "Likes rye" } },
        addresses: {
          a1: {
            contexts: { work: true },
            components: [
              { kind: "name", value: "Musterweg" },
              { kind: "separator", value: " " },
              { kind: "number", value: "5" },
              { kind: "postcode", value: "12345" },
              { kind: "locality", value: "Musterstadt" },
              { kind: "country", value: "Germany" },
            ],
          },
        },
        anniversaries: { b1: { kind: "birth", date: { "@type": "PartialDate", year: 1996, month: 4, day: 12 } } },
      }),
      "a",
    );
    expect(record).toMatchObject({
      id: "k1",
      accountId: "a",
      addressBookId: "b1",
      displayName: "Mina Sommer",
      given: "Mina",
      surname: "Sommer",
      organization: "Nyu & Co",
      title: "Baker",
      note: "Likes rye",
      birthday: "1996-04-12",
      emails: [{ id: "e1", address: "mina@example.org", kind: "home" }],
      phones: [{ id: "p1", number: "+49 30 5550123", kind: "mobile" }],
      addresses: [
        {
          id: "a1",
          street: "Musterweg 5",
          postcode: "12345",
          locality: "Musterstadt",
          country: "Germany",
          kind: "work",
        },
      ],
      isGroup: false,
    });
  });

  it("splits a full name without parts at its last space", () => {
    const record = toContactRecord(card({ name: { full: "Anna Lena Beispiel" } }), "a");
    expect([record.given, record.surname]).toEqual(["Anna Lena", "Beispiel"]);
  });

  it("names a contact without a name by its company, then its address", () => {
    expect(toContactRecord(card({ name: undefined }), "a").displayName).toBe("Nyu & Co");
    expect(toContactRecord(card({ name: undefined, organizations: undefined }), "a").displayName).toBe(
      "mina@example.org",
    );
  });

  it("reads a birthday without a year", () => {
    const record = toContactRecord(
      card({ anniversaries: { x: { kind: "birth", date: { "@type": "PartialDate", month: 9, day: 30 } } } }),
      "a",
    );
    expect(record.birthday).toBe("--09-30");
  });

  it("shows only photos inside the card, never links to other sites", () => {
    const inside = "data:image/png;base64,iVBORw0KGgo=";
    expect(toContactRecord(card({ media: { m1: { kind: "photo", uri: inside } } }), "a").photo).toBe(inside);
    expect(
      toContactRecord(card({ media: { m1: { kind: "photo", uri: "https://tracker.example/me.png" } } }), "a").photo,
    ).toBeNull();
  });
});

describe("writing cards", () => {
  it("makes a new card with a full name vCard can use", () => {
    const created = cardFromInput({
      ...input(),
      emails: [
        { id: "", address: " neu@example.org ", kind: "work" },
        { id: "", address: "", kind: "other" },
      ],
      phones: [],
      birthday: "--09-30",
    });
    expect(created).toMatchObject({
      "@type": "Card",
      addressBookIds: { b1: true },
      name: { full: "Mina Sommer" },
      organizations: { o1: { name: "Nyu & Co" } },
      emails: { e1: { address: "neu@example.org", contexts: { work: true } } },
      anniversaries: { b1: { kind: "birth", date: { "@type": "PartialDate", month: 9, day: 30 } } },
    });
    expect(created.phones).toBeUndefined();
  });

  it("names a card without a name by its company", () => {
    const created = cardFromInput(input({ given: "", surname: "" }));
    expect(created.name).toEqual({ full: "Nyu & Co" });
  });

  it("sends nothing when nothing changed", () => {
    expect(patchFromInput(card(), input())).toEqual({});
  });

  it("keeps what the editor doesn't show when an entry changes", () => {
    const patch = patchFromInput(card(), input({ emails: [{ id: "e1", address: "mina@example.net", kind: "home" }] }));
    expect(patch).toEqual({
      emails: { e1: { address: "mina@example.net", contexts: { private: true }, pref: 1, label: "kept" } },
    });
  });

  it("keeps other phone features when the kind changes", () => {
    const patch = patchFromInput(card(), input({ phones: [{ id: "p1", number: "+49 30 5550123", kind: "work" }] }));
    expect(patch).toEqual({
      phones: { p1: { number: "+49 30 5550123", features: { voice: true }, contexts: { work: true } } },
    });
  });

  it("changes, removes and adds single entries with patches", () => {
    expect(patchFromInput(card(), input({ organization: "Nyu GmbH" }))).toEqual({
      "organizations/o1/name": "Nyu GmbH",
    });
    expect(patchFromInput(card(), input({ organization: "" }))).toEqual({ "organizations/o1": null });
    expect(patchFromInput(card(), input({ note: "New" }))).toEqual({ notes: { n1: { note: "New" } } });
  });

  it("rebuilds the name and keeps its other parts", () => {
    const withTitle = card({
      name: {
        components: [
          { kind: "title", value: "Dr." },
          { kind: "given", value: "Mina" },
          { kind: "surname", value: "Sommer" },
        ],
        full: "Dr. Mina Sommer",
      },
    });
    expect(patchFromInput(withTitle, input({ surname: "Winter" }))).toEqual({
      name: {
        components: [
          { kind: "title", value: "Dr." },
          { kind: "given", value: "Mina" },
          { kind: "surname", value: "Winter" },
        ],
        full: "Dr. Mina Winter",
      },
    });
  });

  it("changes the birthday only when the editor touched it", () => {
    const born = card({ anniversaries: { x: { kind: "birth", date: { "@type": "PartialDate", month: 1, day: 2 } } } });
    const from = inputOf(born);
    expect(patchFromInput(born, { ...from, birthday: "2000-01-02" })).toEqual({});
    expect(patchFromInput(born, { ...from, birthday: "2000-01-02", birthdayChanged: true })).toEqual({
      "anniversaries/x/date": { "@type": "PartialDate", year: 2000, month: 1, day: 2 },
    });
    expect(patchFromInput(born, { ...from, birthday: null, birthdayChanged: true })).toEqual({
      "anniversaries/x": null,
    });
  });

  it("moves a card to another address book", () => {
    expect(patchFromInput(card(), input({ addressBookId: "b2" }))).toEqual({ addressBookIds: { b2: true } });
  });
});
