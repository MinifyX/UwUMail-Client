import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, AddressBookInfo, ContactRecord } from "@/backend/types";
import { i18n } from "@/i18n";
import { useSettings } from "@/state/settings";
import { useUi } from "@/state/ui";
import { ContactEditor } from "./ContactEditor";
import { ContactsShell } from "./ContactsShell";
import { ContactsSidebar } from "./ContactsSidebar";
import { DeleteContactQuestion } from "./DeleteContactQuestion";
import { draftFromSender } from "./format";
import { startNewContact, useContactsUi } from "./state";

const BOOKS: AddressBookInfo[] = [
  { id: "b1", accountId: "acc", name: "Friends", isDefault: true, sortOrder: 0, mayWrite: true, mayDelete: true },
  { id: "b2", accountId: "acc", name: "Work", isDefault: false, sortOrder: 1, mayWrite: true, mayDelete: true },
];

const contact = (patch: Partial<ContactRecord>): ContactRecord => ({
  id: "k1",
  accountId: "acc",
  addressBookId: "b1",
  displayName: "Mina Sommer",
  given: "Mina",
  surname: "Sommer",
  organization: "",
  title: "",
  emails: [{ id: "e1", address: "mina@example.org", kind: "home" }],
  phones: [],
  addresses: [],
  birthday: null,
  note: "",
  photo: null,
  isGroup: false,
  ...patch,
});

const CONTACTS = [
  contact({}),
  contact({
    id: "k2",
    addressBookId: "b2",
    displayName: "Otto Beispiel",
    given: "Otto",
    surname: "Beispiel",
    organization: "Nyu & Co",
    emails: [{ id: "e1", address: "otto@example.com", kind: "work" }],
    phones: [{ id: "p1", number: "+49 30 5550199", kind: "work" }],
  }),
];

const ACCOUNTS: Account[] = ["acc", "club"].map((id) => ({
  id,
  name: id === "acc" ? "Private" : "Club",
  email: `${id}@example.org`,
  displayName: "Mini",
  color: "pink",
  auth: "password",
  status: { state: "idle" },
  protocol: "imap",
  protocols: ["imap"],
}));

let books = BOOKS;
const fake = {
  listAccounts: vi.fn(async () => ACCOUNTS),
  contactsAccounts: vi.fn(async () =>
    ACCOUNTS.map((account) => ({
      accountId: account.id,
      source: "carddav",
      carddavUrl: null,
      problem: null,
      checked: true,
    })),
  ),
  createAddressBook: vi.fn(async () => BOOKS[0]!),
  contactsAvailable: vi.fn(async () => true),
  calendarsAvailable: vi.fn(async () => false),
  addressBooks: vi.fn(async () => books),
  contacts: vi.fn(async () => CONTACTS),
  createContact: vi.fn(async () => "k3"),
  updateContact: vi.fn(async () => {}),
  deleteContact: vi.fn(async () => {}),
  // Only the UwUMail account ("acc") sends birthday reminders.
  birthdayFeatures: vi.fn(async () => [
    { accountId: "acc", server: true, import: true },
    { accountId: "club", server: false, import: false },
  ]),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

/** The open dialog with this heading; the app's dialogs show their title as a heading. */
async function findDialog(title: string | RegExp) {
  const heading = await screen.findByRole("heading", { name: title });
  return heading.closest("dialog")!;
}

function renderContacts({ shell = true } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      {shell && <ContactsShell />}
      <ContactEditor />
      <DeleteContactQuestion />
    </QueryClientProvider>,
  );
}

describe("contacts flows", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    books = BOOKS;
    act(() => useUi.getState().setSection("contacts"));
  });
  afterEach(() => {
    cleanup();
    act(() => useContactsUi.setState({ bookId: null, search: "", selectedId: null, editor: null, deleting: null }));
  });

  it("lists the contacts by name and finds them by company or number", async () => {
    renderContacts();
    const list = await screen.findByRole("list", { name: "Contacts" });
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole("button")
          .map((row) => row.textContent),
      ).toHaveLength(2),
    );
    expect(within(list).getByText("Mina Sommer")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search contacts" }), { target: { value: "nyu" } });
    await waitFor(() => expect(within(list).queryByText("Mina Sommer")).toBeNull());
    expect(within(list).getByText("Otto Beispiel")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search contacts" }), { target: { value: "5550199" } });
    await waitFor(() => expect(within(list).getByText("Otto Beispiel")).toBeTruthy());
  });

  it("shows a contact and asks before deleting it", async () => {
    renderContacts();
    fireEvent.click(await screen.findByText("Otto Beispiel"));
    const detail = await screen.findByRole("region", { name: "Otto Beispiel" });
    expect(within(detail).getByText("otto@example.com")).toBeTruthy();

    fireEvent.click(within(detail).getByRole("button", { name: "Delete" }));
    const question = await findDialog(/Delete “Otto Beispiel”/);
    fireEvent.click(within(question).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(fake.deleteContact).toHaveBeenCalledWith("k2"));
  });

  it("saves the sender of a mail as a new contact in the default address book", async () => {
    renderContacts({ shell: false });
    act(() => startNewContact(draftFromSender("Lea Muster", "lea@example.net")));
    const dialog = await findDialog("New contact");
    await waitFor(() => expect(within(dialog).getByLabelText<HTMLSelectElement>("Address book").value).toBe("b1"));
    expect(within(dialog).getByLabelText<HTMLInputElement>("First name").value).toBe("Lea");
    expect(within(dialog).getByLabelText<HTMLInputElement>("Last name").value).toBe("Muster");

    fireEvent.click(within(dialog).getByRole("button", { name: "Add phone number" }));
    fireEvent.change(within(dialog).getByLabelText("Phone"), { target: { value: "+49 30 5550100" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fake.createContact).toHaveBeenCalledTimes(1));
    expect(fake.createContact).toHaveBeenCalledWith(
      expect.objectContaining({
        addressBookId: "b1",
        given: "Lea",
        surname: "Muster",
        emails: [{ id: "", address: "lea@example.net", kind: "other" }],
        phones: [{ id: "", number: "+49 30 5550100", kind: "mobile" }],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("heading", { name: "New contact" })).toBeNull());
  });

  it("needs something that names the contact", async () => {
    renderContacts({ shell: false });
    act(() => startNewContact());
    const dialog = await findDialog("New contact");
    await waitFor(() => expect(within(dialog).getByLabelText<HTMLSelectElement>("Address book").value).toBe("b1"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(fake.createContact).not.toHaveBeenCalled();
  });

  it("moves a contact to another address book while editing it", async () => {
    renderContacts({ shell: false });
    act(() => useContactsUi.getState().openEditor({ contact: CONTACTS[0]! }));
    const dialog = await findDialog("Edit contact");
    await waitFor(() => expect(within(dialog).getByLabelText<HTMLSelectElement>("Address book").value).toBe("b1"));
    fireEvent.change(within(dialog).getByLabelText("Address book"), { target: { value: "b2" } });
    fireEvent.change(within(dialog).getByLabelText("Company"), { target: { value: "Nyu & Co" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fake.updateContact).toHaveBeenCalledTimes(1));
    expect(fake.updateContact).toHaveBeenCalledWith(
      "k1",
      expect.objectContaining({ addressBookId: "b2", organization: "Nyu & Co", given: "Mina", birthdayChanged: false }),
    );
  });

  it("keeps a birthday without a year and adds an anniversary and reminders", async () => {
    renderContacts({ shell: false });
    act(() =>
      useContactsUi.getState().openEditor({ contact: { ...CONTACTS[0]!, birthday: "--02-29", reminders: [] } }),
    );
    const dialog = await findDialog("Edit contact");
    const birthday = within(dialog).getByRole("group", { name: "Birthday" });
    expect(within(birthday).getByLabelText<HTMLInputElement>("Day").value).toBe("29");
    expect(within(birthday).getByLabelText<HTMLSelectElement>("Month").value).toBe("2");
    expect(within(birthday).getByLabelText<HTMLInputElement>("Year (optional)").value).toBe("");

    const anniversary = within(dialog).getByRole("group", { name: "Wedding anniversary" });
    fireEvent.change(within(anniversary).getByLabelText("Day"), { target: { value: "12" } });
    fireEvent.change(within(anniversary).getByLabelText("Month"), { target: { value: "6" } });
    fireEvent.change(within(anniversary).getByLabelText("Year (optional)"), { target: { value: "2021" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "1 week before" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "On the day at 9:00" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fake.updateContact).toHaveBeenCalledTimes(1));
    expect(fake.updateContact).toHaveBeenCalledWith(
      "k1",
      expect.objectContaining({
        birthday: "--02-29",
        birthdayChanged: false,
        anniversary: "2021-06-12",
        anniversaryChanged: true,
        reminders: [
          { daysBefore: 0, time: "09:00" },
          { daysBefore: 7, time: "09:00" },
        ],
      }),
    );
  });

  it("refuses a day that doesn't exist, like 29 February 2023", async () => {
    renderContacts({ shell: false });
    act(() => startNewContact({ given: "Lea" }));
    const dialog = await findDialog("New contact");
    await waitFor(() => expect(within(dialog).getByLabelText<HTMLSelectElement>("Address book").value).toBe("b1"));
    const birthday = within(dialog).getByRole("group", { name: "Birthday" });
    fireEvent.change(within(birthday).getByLabelText("Day"), { target: { value: "29" } });
    fireEvent.change(within(birthday).getByLabelText("Month"), { target: { value: "2" } });
    fireEvent.change(within(birthday).getByLabelText("Year (optional)"), { target: { value: "2023" } });
    expect(within(birthday).getByRole("alert").textContent).toBe("This day doesn't exist.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(fake.createContact).not.toHaveBeenCalled();

    fireEvent.change(within(birthday).getByLabelText("Year (optional)"), { target: { value: "2024" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fake.createContact).toHaveBeenCalledTimes(1));
    expect(fake.createContact).toHaveBeenCalledWith(
      expect.objectContaining({ given: "Lea", birthday: "2024-02-29", birthdayChanged: true }),
    );
  });

  it("shows the age in the list and when the birthday comes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 3, 12, 10, 0));
    try {
      fake.contacts.mockResolvedValueOnce([
        { ...CONTACTS[0]!, birthday: "1996-04-12", reminders: [{ daysBefore: 1, time: "09:00" }] },
        { ...CONTACTS[1]!, birthday: "1970-12-24", anniversary: "--06-12" },
      ]);
      renderContacts();
      const list = await screen.findByRole("list", { name: "Contacts" });
      expect((await within(list).findByLabelText("30 years old")).textContent).toBe("30");
      expect(within(list).getByLabelText("55 years old")).toBeTruthy();

      fireEvent.click(within(list).getByText("Mina Sommer"));
      const mina = await screen.findByRole("region", { name: "Mina Sommer" });
      expect(within(mina).getByText("turns 30 · today!")).toBeTruthy();
      expect(within(mina).getByText("1 day before")).toBeTruthy();

      fireEvent.click(within(list).getByText("Otto Beispiel"));
      const otto = await screen.findByRole("region", { name: "Otto Beispiel" });
      expect(within(otto).getByText("55 years old · turns 56 on December 24, 2026")).toBeTruthy();
      expect(within(otto).getByText("next on June 12, 2026")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers reminders only where the UwUMail server sends them", async () => {
    renderContacts({ shell: false });
    act(() => useContactsUi.getState().openEditor({ contact: { ...CONTACTS[0]!, accountId: "club" } }));
    const dialog = await findDialog("Edit contact");
    expect(within(dialog).getByRole("group", { name: "Birthday" })).toBeTruthy();
    await waitFor(() => expect(fake.birthdayFeatures).toHaveBeenCalled());
    expect(within(dialog).queryByRole("checkbox", { name: "1 week before" })).toBeNull();
  });

  it("groups the address books of several mailboxes and asks where a new one goes", async () => {
    books = [
      ...BOOKS,
      {
        id: "c1",
        accountId: "club",
        name: "Members",
        isDefault: true,
        sortOrder: 0,
        mayWrite: false,
        mayDelete: false,
      },
    ];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ContactsSidebar />
      </QueryClientProvider>,
    );
    const club = await screen.findByRole("list", { name: "Club" });
    expect(within(club).getByText("Members")).toBeTruthy();
    // Read-only address books have nothing to change.
    expect(within(club).queryByRole("button", { name: /Actions for Members/ })).toBeNull();
    expect(within(screen.getByRole("list", { name: "Private" })).getByText("Work")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New address book" }));
    const dialog = await findDialog("New address book");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Band" } });
    fireEvent.change(within(dialog).getByLabelText("Mailbox"), { target: { value: "club" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(fake.createAddressBook).toHaveBeenCalledWith("Band", "club"));
  });

  it("offers only writable address books of the contact's own mailbox when editing", async () => {
    books = [
      ...BOOKS,
      { id: "c1", accountId: "club", name: "Members", isDefault: true, sortOrder: 0, mayWrite: true, mayDelete: true },
    ];
    renderContacts({ shell: false });
    act(() => useContactsUi.getState().openEditor({ contact: CONTACTS[0]! }));
    const dialog = await findDialog("Edit contact");
    const select = await waitFor(() => within(dialog).getByLabelText<HTMLSelectElement>("Address book"));
    expect([...select.options].map((option) => option.value)).toEqual(["b1", "b2"]);
  });
});

describe("drafts", () => {
  it("leaves out a sender name that is only the address again", () => {
    expect(draftFromSender("lea@example.net", "lea@example.net")).toEqual({ emails: ["lea@example.net"] });
    expect(draftFromSender('"Lea Muster"', "lea@example.net")).toEqual({
      given: "Lea",
      surname: "Muster",
      emails: ["lea@example.net"],
    });
  });
});
