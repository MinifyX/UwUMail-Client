// Fictional address books and contacts for the demo, the same made-up people who write the demo
// mail. No real people, addresses or numbers.

import { BackendError } from "./backend";
import type { AddressBookInfo, Contact, ContactInput, ContactRecord } from "./types";

type Lang = "de" | "en";

function sampleBooks(lang: Lang, accountId: string): AddressBookInfo[] {
  return [
    {
      id: "book-personal",
      accountId,
      name: lang === "de" ? "Kontakte" : "Contacts",
      isDefault: true,
      sortOrder: 0,
      mayWrite: true,
      mayDelete: true,
    },
    { id: "book-studio", accountId, name: "Studio", isDefault: false, sortOrder: 1, mayWrite: true, mayDelete: true },
  ];
}

function sampleContacts(lang: Lang, accountId: string): ContactRecord[] {
  const de = lang === "de";
  const person = (patch: Partial<ContactRecord> & Pick<ContactRecord, "id" | "given" | "surname">): ContactRecord => ({
    accountId,
    addressBookId: "book-personal",
    displayName: [patch.given, patch.surname].filter(Boolean).join(" "),
    organization: "",
    title: "",
    emails: [],
    phones: [],
    addresses: [],
    birthday: null,
    note: "",
    photo: null,
    isGroup: false,
    ...patch,
  });
  return [
    person({
      id: "contact-leni",
      given: "Leni",
      surname: "Wanders",
      emails: [{ id: "e1", address: "leni@wanders.example", kind: "home" }],
      phones: [{ id: "p1", number: "+49 170 5550101", kind: "mobile" }],
      addresses: [
        {
          id: "a1",
          street: de ? "Sonnenweg 7" : "7 Sunny Lane",
          postcode: "12345",
          locality: de ? "Musterstadt" : "Exampletown",
          region: "",
          country: de ? "Deutschland" : "Germany",
          kind: "home",
        },
      ],
      birthday: "1996-04-12",
      note: de ? "Mag Hafermilch und lange Spaziergänge." : "Likes oat milk and long walks.",
    }),
    person({
      id: "contact-noah",
      given: "Noah",
      surname: "Zockt",
      emails: [{ id: "e1", address: "noah@zockt.example", kind: "other" }],
      phones: [{ id: "p1", number: "+49 171 5550102", kind: "mobile" }],
      birthday: "--09-30",
    }),
    person({
      id: "contact-mia",
      given: "Mia",
      surname: "Mood",
      emails: [{ id: "e1", address: "mia@mood.example", kind: "home" }],
    }),
    person({
      id: "contact-finn",
      given: "Finn",
      surname: "Creates",
      emails: [{ id: "e1", address: "finn@creates.example", kind: "work" }],
      phones: [{ id: "p1", number: "+49 30 5550103", kind: "work" }],
    }),
    person({
      id: "contact-emma",
      addressBookId: "book-studio",
      given: "Emma",
      surname: "Vogt",
      organization: "Bright Labs",
      title: de ? "Produktleitung" : "Head of Product",
      emails: [{ id: "e1", address: "emma.vogt@brightlabs.example", kind: "work" }],
      phones: [{ id: "p1", number: "+49 40 5550104", kind: "work" }],
    }),
    person({
      id: "contact-lukas",
      addressBookId: "book-studio",
      given: "Lukas",
      surname: "Editz",
      organization: "Pixel Studio",
      title: de ? "Schnitt" : "Editing",
      emails: [{ id: "e1", address: "lukas@pixelstudio.example", kind: "work" }],
    }),
    person({
      id: "contact-bakery",
      given: "",
      surname: "",
      displayName: "Kaffee & Kuchen",
      organization: "Kaffee & Kuchen",
      emails: [{ id: "e1", address: "hallo@kaffeekuchen.example", kind: "work" }],
      phones: [{ id: "p1", number: "+49 89 5550105", kind: "work" }],
      note: de ? "Bester Käsekuchen der Stadt." : "Best cheesecake in town.",
    }),
  ];
}

let nextId = 1;

/** Address books and contacts the demo keeps in memory; they start over with every reload. */
export class DemoContacts {
  private books: AddressBookInfo[];
  private list: ContactRecord[];

  constructor(
    lang: Lang,
    private readonly accountId: string,
    private readonly changed: () => void,
  ) {
    this.books = sampleBooks(lang, accountId);
    this.list = sampleContacts(lang, accountId);
  }

  addressBooks(): AddressBookInfo[] {
    const onlyOne = this.books.length <= 1;
    return this.books.map((book) => ({ ...book, mayDelete: !onlyOne }));
  }

  createAddressBook(name: string): AddressBookInfo {
    const book: AddressBookInfo = {
      id: `book-${nextId++}`,
      accountId: this.accountId,
      name,
      isDefault: false,
      sortOrder: this.books.length,
      mayWrite: true,
      mayDelete: true,
    };
    this.books.push(book);
    this.changed();
    return book;
  }

  renameAddressBook(id: string, name: string) {
    this.books = this.books.map((book) => (book.id === id ? { ...book, name } : book));
    this.changed();
  }

  deleteAddressBook(id: string) {
    if (this.books.length <= 1) throw new BackendError("invalid_input", "The only address book stays.");
    const gone = this.books.find((book) => book.id === id);
    this.books = this.books.filter((book) => book.id !== id);
    this.list = this.list.filter((contact) => contact.addressBookId !== id);
    if (gone?.isDefault) this.books[0] = { ...this.books[0]!, isDefault: true };
    this.changed();
  }

  setDefaultAddressBook(id: string) {
    this.books = this.books.map((book) => ({ ...book, isDefault: book.id === id }));
    this.changed();
  }

  contacts(): ContactRecord[] {
    return this.list.map((contact) => ({ ...contact }));
  }

  private record(id: string, input: ContactInput, before?: ContactRecord): ContactRecord {
    const given = input.given.trim();
    const surname = input.surname.trim();
    const emails = input.emails
      .filter((email) => email.address.trim())
      .map((email, index) => ({ ...email, id: email.id || `e${index + 1}`, address: email.address.trim() }));
    return {
      id,
      accountId: this.accountId,
      addressBookId: input.addressBookId,
      displayName: [given, surname].filter(Boolean).join(" ") || input.organization.trim() || emails[0]?.address || "",
      given,
      surname,
      organization: input.organization.trim(),
      title: input.title.trim(),
      emails,
      phones: input.phones
        .filter((phone) => phone.number.trim())
        .map((phone, index) => ({ ...phone, id: phone.id || `p${index + 1}`, number: phone.number.trim() })),
      addresses: input.addresses
        .filter((postal) => [postal.street, postal.postcode, postal.locality, postal.country].some((v) => v.trim()))
        .map((postal, index) => ({ ...postal, id: postal.id || `a${index + 1}` })),
      birthday: input.birthdayChanged ? input.birthday : (before?.birthday ?? null),
      note: input.note.trim(),
      photo: before?.photo ?? null,
      isGroup: false,
    };
  }

  createContact(input: ContactInput): string {
    const id = `contact-${nextId++}`;
    this.list.push(this.record(id, input));
    this.changed();
    return id;
  }

  updateContact(id: string, input: ContactInput) {
    const before = this.list.find((contact) => contact.id === id);
    if (!before) throw new BackendError("not_found", "This contact is gone.");
    this.list = this.list.map((contact) => (contact.id === id ? this.record(id, input, before) : contact));
    this.changed();
  }

  deleteContact(id: string) {
    this.list = this.list.filter((contact) => contact.id !== id);
    this.changed();
  }

  /** Suggestions from the address books, one per address. */
  search(query: string): Contact[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.list.flatMap((contact) =>
      [contact.displayName, contact.organization, ...contact.emails.map((e) => e.address)].some((text) =>
        text.toLowerCase().includes(q),
      )
        ? contact.emails.map((email) => ({ name: contact.displayName, email: email.address, timesContacted: 0 }))
        : [],
    );
  }
}
