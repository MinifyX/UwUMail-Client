import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarAccount, CalendarInfo, CalendarOccurrence } from "@/backend/types";
import { i18n } from "@/i18n";
import { useSettings } from "@/state/settings";
import { CalendarList } from "./CalendarList";
import { EventEditor } from "./EventEditor";
import { useCalendarUi } from "./state";

function calendar(id: string, accountId: string, name: string, extra: Partial<CalendarInfo> = {}): CalendarInfo {
  return {
    id,
    accountId,
    name,
    color: "#ff4d8d",
    isDefault: false,
    isVisible: true,
    sortOrder: 0,
    mayWrite: true,
    mayDelete: true,
    ...extra,
  };
}

// Two mailboxes with calendars and one (a Microsoft sign-in) without.
const CALENDARS: CalendarInfo[] = [
  calendar("a:home", "a", "Home"),
  calendar("a:sport", "a", "Sport", { sortOrder: 1 }),
  calendar("b:club", "b", "Club", { isDefault: true }),
];
const ACCOUNTS = [
  { id: "a", name: "Private", email: "mini@example.org" },
  { id: "b", name: "Club", email: "board@example.net" },
  { id: "m", name: "Work", email: "mini@example.com" },
];
const SOURCES: CalendarAccount[] = [
  { accountId: "a", source: "jmap", caldavUrl: null, problem: null },
  { accountId: "b", source: "caldav", caldavUrl: null, problem: null },
  { accountId: "m", source: null, caldavUrl: null, problem: "No calendars for Microsoft sign-ins." },
];

const fake = {
  listAccounts: vi.fn(async () => ACCOUNTS),
  calendars: vi.fn(async () => CALENDARS),
  calendarAccounts: vi.fn(async () => SOURCES),
  calendarEvents: vi.fn(async () => []),
  createCalendar: vi.fn(async (input: { accountId?: string; name: string; color: string | null }) =>
    calendar("new", input.accountId ?? "a", input.name),
  ),
  updateCalendar: vi.fn(async () => {}),
  createEvent: vi.fn(async () => "new"),
  updateEvent: vi.fn(async () => {}),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function renderWithClient(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

describe("calendars of several mailboxes", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    cleanup();
    act(() => useCalendarUi.setState({ popover: null, quick: null, editor: null, deleteScope: null }));
  });

  it("lists the calendars under the name of their mailbox", async () => {
    renderWithClient(<CalendarList />);
    const privateList = await screen.findByRole("list", { name: "Private" });
    const clubList = screen.getByRole("list", { name: "Club" });
    expect(
      within(privateList)
        .getAllByRole("checkbox")
        .map((box) => box.textContent),
    ).toEqual(["Home", "Sport"]);
    expect(
      within(clubList)
        .getAllByRole("checkbox")
        .map((box) => box.textContent),
    ).toEqual(["ClubDefault"]);
    // No heading for the mailbox without calendars.
    expect(screen.queryByText("Work")).toBeNull();
  });

  it("asks which mailbox a new calendar goes to, starting with the default calendar's", async () => {
    renderWithClient(<CalendarList />);
    await screen.findByRole("list", { name: "Private" });
    fireEvent.click(screen.getByRole("button", { name: "New calendar" }));
    const dialog = await screen.findByRole("dialog");
    const mailbox = await within(dialog).findByLabelText<HTMLSelectElement>("Mailbox");
    expect(mailbox.value).toBe("b");
    // Only mailboxes that have calendars can take one.
    expect([...mailbox.options].map((option) => option.value)).toEqual(["a", "b"]);

    fireEvent.change(mailbox, { target: { value: "a" } });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Uni" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(fake.createCalendar).toHaveBeenCalledTimes(1));
    expect(fake.createCalendar.mock.calls[0]![0]).toMatchObject({ accountId: "a", name: "Uni" });
  });

  it("groups the editor's calendars by mailbox for a new event", async () => {
    renderWithClient(<EventEditor />);
    act(() =>
      useCalendarUi.getState().openEditor({
        occurrence: null,
        draft: { start: "2026-09-23T10:00:00", end: "2026-09-23T11:00:00", allDay: false },
      }),
    );
    const dialog = await screen.findByRole("dialog");
    const picker = await within(dialog).findByLabelText<HTMLSelectElement>("Calendar");
    await waitFor(() => expect(picker.querySelectorAll("optgroup")).toHaveLength(2));
    const groups = [...picker.querySelectorAll("optgroup")].map((group) => [
      group.label,
      [...group.querySelectorAll("option")].map((option) => option.textContent),
    ]);
    expect(groups).toEqual([
      ["Private", ["Home", "Sport"]],
      ["Club", ["Club"]],
    ]);
    expect(picker.value).toBe("b:club");
  });

  it("keeps an event in its own mailbox", async () => {
    const occurrence: CalendarOccurrence = {
      id: "a:e1",
      eventId: "a:e1",
      accountId: "a",
      calendarId: "a:home",
      title: "Dentist",
      description: "",
      location: "",
      allDay: false,
      start: "2026-09-23T10:00:00",
      end: "2026-09-23T11:00:00",
      timeZone: null,
      recurrence: null,
      recurrenceEditable: true,
      recurrenceId: null,
      readOnly: false,
      color: null,
    };
    renderWithClient(<EventEditor />);
    act(() => useCalendarUi.getState().openEditor({ occurrence }));
    const dialog = await screen.findByRole("dialog");
    const picker = await within(dialog).findByLabelText<HTMLSelectElement>("Calendar");
    await waitFor(() => expect(picker.options).toHaveLength(2));
    expect([...picker.options].map((option) => option.value)).toEqual(["a:home", "a:sport"]);
    expect(picker.querySelector("optgroup")).toBeNull();
  });
});
