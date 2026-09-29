import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BirthdayCandidate, CalendarInfo, CalendarOccurrence, ContactRecord } from "@/backend/types";
import { i18n } from "@/i18n";
import { useSettings } from "@/state/settings";
import { useUi } from "@/state/ui";
import { useContactsUi } from "../contacts/state";
import { BirthdayImportDialog } from "./BirthdayImport";
import { CalendarList } from "./CalendarList";
import { EventPopover } from "./EventPopover";
import { useCalendarUi } from "./state";

const CALENDARS: CalendarInfo[] = [
  {
    id: "home",
    accountId: "acc",
    name: "Home",
    color: "#ff4d8d",
    isDefault: true,
    isVisible: true,
    sortOrder: 0,
    mayWrite: true,
    mayDelete: true,
  },
  {
    id: "bdays",
    accountId: "acc",
    name: "Birthdays",
    color: "#f5a623",
    isDefault: false,
    isVisible: true,
    sortOrder: 1,
    mayWrite: false,
    mayDelete: false,
    isBirthdays: true,
  },
  {
    id: "dav:uwu-birthdays",
    accountId: "dav",
    name: "uwu-birthdays",
    color: "#f5a623",
    isDefault: false,
    isVisible: true,
    sortOrder: 1_000_000,
    mayWrite: false,
    mayDelete: false,
    isBirthdays: true,
    isLocal: true,
  },
];

const person = (id: string, name: string, birthday: string | null = null): ContactRecord => ({
  id,
  accountId: "acc",
  addressBookId: "b1",
  displayName: name,
  given: name.split(" ")[0]!,
  surname: name.split(" ")[1] ?? "",
  organization: "",
  title: "",
  emails: [],
  phones: [],
  addresses: [],
  birthday,
  note: "",
  photo: null,
  isGroup: false,
});

const CONTACTS = [
  person("k1", "Mia Mood"),
  person("k2", "Jürgen Müller", "1970-05-01"),
  person("k3", "Max Muster"),
  person("k4", "Max Mustermann"),
];

const candidate = (patch: Partial<BirthdayCandidate>): BirthdayCandidate => ({
  eventId: "e1",
  calendarId: "home",
  title: "Mia's birthday",
  name: "Mia",
  birthday: "1999-10-19",
  mayDeleteEvent: true,
  match: "matched",
  contacts: [{ contactId: "k1", name: "Mia Mood", birthday: null }],
  ...patch,
});

const CANDIDATES = [
  candidate({}),
  candidate({
    eventId: "e2",
    title: "🎂 Oma Hilde",
    name: "Oma Hilde",
    birthday: "--11-08",
    match: "unmatched",
    contacts: [],
  }),
  candidate({
    eventId: "e3",
    title: "Geburtstag Max",
    name: "Max",
    birthday: "--02-29",
    match: "ambiguous",
    mayDeleteEvent: false,
    contacts: [
      { contactId: "k3", name: "Max Muster", birthday: null },
      { contactId: "k4", name: "Max Mustermann", birthday: null },
    ],
  }),
  candidate({
    eventId: "e4",
    title: "Geb. Juergen",
    name: "Juergen",
    birthday: "1971-05-01",
    match: "conflict",
    contacts: [{ contactId: "k2", name: "Jürgen Müller", birthday: "1970-05-01" }],
  }),
];

const fake = {
  listAccounts: vi.fn(async () => [
    { id: "acc", name: "UwUMail", email: "me@example.com" },
    { id: "dav", name: "Elsewhere", email: "me@example.org" },
  ]),
  calendarAccounts: vi.fn(async () => []),
  calendars: vi.fn(async () => CALENDARS),
  calendarEvents: vi.fn(async () => []),
  contactsAvailable: vi.fn(async () => true),
  contacts: vi.fn(async () => CONTACTS),
  sharingAvailable: vi.fn(async () => false),
  birthdayFeatures: vi.fn(async () => [
    { accountId: "acc", server: true, import: true },
    { accountId: "dav", server: false, import: false },
  ]),
  scanBirthdays: vi.fn(async (_accountId: string) => ({ candidates: CANDIDATES, truncated: false })),
  importBirthdays: vi.fn(async (_accountId: string, entries: { eventId: string }[]) => ({
    imported: entries.map((entry) => ({ eventId: entry.eventId, contactId: "k1", created: false, eventDeleted: true })),
    failed: [],
  })),
  updateCalendar: vi.fn(async () => {}),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function renderWith(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const BIRTHDAY: CalendarOccurrence = {
  id: "bday-k1-b~2026-10-19T00:00:00",
  eventId: "bday-k1-b",
  accountId: "acc",
  calendarId: "bdays",
  title: "Mia Mood (27)",
  description: "",
  location: "",
  allDay: true,
  start: "2026-10-19T00:00:00",
  end: "2026-10-20T00:00:00",
  timeZone: null,
  recurrence: { frequency: "yearly", interval: 1, byDay: null, until: null, count: null },
  recurrenceEditable: false,
  recurrenceId: "2026-10-19T00:00:00",
  readOnly: true,
  color: null,
  birthday: { contactId: "k1", kind: "birth", label: null, name: "Mia Mood", year: 1999, age: 27 },
};

describe("birthdays", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    try {
      localStorage.clear();
    } catch {
      // Tests without storage still run.
    }
  });
  afterEach(() => {
    cleanup();
    act(() => useCalendarUi.setState({ popover: null }));
  });

  it("shows the age of a birthday and opens the contact", async () => {
    renderWith(<EventPopover />);
    act(() => useCalendarUi.getState().showPopover(BIRTHDAY, { left: 10, top: 10, width: 10, height: 10 }));
    expect(await screen.findByText("Mia Mood · turns 27")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    await waitFor(() => expect(screen.getByText(/From your contacts/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Open contact" }));
    expect(useUi.getState().section).toBe("contacts");
    expect(useContactsUi.getState().selectedId).toBe("k1");
    expect(useCalendarUi.getState().popover).toBeNull();
  });

  it("keeps the birthdays calendar out of default and delete, and hints at birthdays elsewhere", async () => {
    renderWith(<CalendarList />);
    const hint = await screen.findByRole("complementary", { name: "4 birthdays found in your calendars" });
    // The UwUMail account's birthdays calendar comes first, the local one of the other account second.
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Actions for Birthdays" })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: "Actions for Birthdays" })[0]!);
    const menu = await screen.findByRole("menu");
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(items).toEqual(["Edit calendar", "Take over birthdays from calendars…"]);

    fireEvent.click(within(hint).getByRole("button", { name: "Don't show again" }));
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(localStorage.getItem("uwu.birthdayHint.dismissed.acc")).toBe("1");
    expect(fake.scanBirthdays).toHaveBeenCalledWith("acc");
    expect(fake.scanBirthdays).not.toHaveBeenCalledWith("dav");
  });

  it("names the local birthdays calendar and changes only its colour", async () => {
    renderWith(<CalendarList />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Actions for Birthdays" })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: "Actions for Birthdays" })[1]!);
    const items = within(await screen.findByRole("menu"))
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(items).toEqual(["Edit calendar"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit calendar" }));
    const dialog = (await screen.findByRole("heading", { name: "Edit calendar" })).closest("form")!;
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Colour 1" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fake.updateCalendar).toHaveBeenCalledTimes(1));
    expect(fake.updateCalendar).toHaveBeenCalledWith("dav:uwu-birthdays", { color: expect.any(String) });
  });

  it("takes birthdays over only as chosen and says which events go", async () => {
    renderWith(<BirthdayImportDialog accountId="acc" onClose={() => {}} />);
    const dialog = (await screen.findByRole("heading", { name: "Take over birthdays" })).closest("dialog")!;
    await within(dialog).findByText("Clear matches");

    // Mia goes on her own, Oma Hilde becomes a new contact, Max and Jürgen wait for a choice.
    expect(within(dialog).getByRole("checkbox", { name: "Take over: Mia's birthday" })).toHaveProperty("checked", true);
    expect(within(dialog).getByText(/Afterwards the 2 original events are deleted/)).toBeTruthy();

    const max = within(dialog).getByRole("radiogroup", { name: "Geburtstag Max" }).closest("li")!;
    fireEvent.click(within(max).getByRole("radio", { name: "Assign to existing contact" }));
    fireEvent.click(within(max).getByRole("radio", { name: "Max Mustermann" }));
    expect(within(max).getByText("The event stays (its calendar is read-only)")).toBeTruthy();

    const juergen = within(dialog).getByRole("radiogroup", { name: "Geb. Juergen" }).closest("li")!;
    expect(within(juergen).getByText(/Jürgen Müller already has another birthday/)).toBeTruthy();
    fireEvent.click(within(juergen).getByRole("radio", { name: "Assign to existing contact" }));
    // Searched by characters: "mueller" finds Müller.
    fireEvent.change(within(juergen).getByRole("searchbox", { name: "Search contacts" }), {
      target: { value: "mueller" },
    });
    fireEvent.click(within(juergen).getByRole("radio", { name: "Jürgen Müller" }));
    expect(within(juergen).getByText(/Replaces the birthday it has/)).toBeTruthy();

    const oma = within(dialog).getByRole("radiogroup", { name: "🎂 Oma Hilde" }).closest("li")!;
    fireEvent.change(within(oma).getByRole("textbox", { name: "Name of the new contact" }), {
      target: { value: "Hilde Muster" },
    });

    expect(within(dialog).getByText(/Afterwards the 3 original events are deleted/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Take over 4 and delete events" }));
    await waitFor(() => expect(fake.importBirthdays).toHaveBeenCalledTimes(1));
    expect(fake.importBirthdays).toHaveBeenCalledWith("acc", [
      { eventId: "e1", contactId: "k1", overwrite: false },
      { eventId: "e2", newContactName: "Hilde Muster" },
      { eventId: "e3", contactId: "k4", overwrite: false },
      { eventId: "e4", contactId: "k2", overwrite: true },
    ]);
  });

  it("deletes nothing that is skipped or unticked", async () => {
    renderWith(<BirthdayImportDialog accountId="acc" onClose={() => {}} />);
    const dialog = (await screen.findByRole("heading", { name: "Take over birthdays" })).closest("dialog")!;
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: "Take over: Mia's birthday" }));
    const oma = within(dialog).getByRole("radiogroup", { name: "🎂 Oma Hilde" }).closest("li")!;
    fireEvent.click(within(oma).getByRole("radio", { name: "Skip" }));
    expect(within(dialog).queryByText(/original event/)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Nothing selected" })).toHaveProperty("disabled", true);
  });
});
