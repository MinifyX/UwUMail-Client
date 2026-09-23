import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarInfo, CalendarOccurrence } from "@/backend/types";
import { i18n } from "@/i18n";
import { deviceTimeZone } from "@/lib/calendarDates";
import { useSettings } from "@/state/settings";
import { DeleteScopeQuestion } from "./DeleteScopeQuestion";
import { EventEditor } from "./EventEditor";
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
    id: "work",
    accountId: "acc",
    name: "Work",
    color: "#8b5cf6",
    isDefault: false,
    isVisible: true,
    sortOrder: 1,
    mayWrite: true,
    mayDelete: true,
  },
];

const YOGA: CalendarOccurrence = {
  id: "yoga~2026-09-22T18:30:00",
  eventId: "yoga",
  accountId: "acc",
  calendarId: "home",
  title: "Yoga",
  description: "",
  location: "",
  allDay: false,
  start: "2026-09-22T18:30:00",
  end: "2026-09-22T19:30:00",
  timeZone: null,
  recurrence: { frequency: "weekly", interval: 1, byDay: ["tu"], until: null, count: null },
  recurrenceEditable: true,
  recurrenceId: "2026-09-22T18:30:00",
  readOnly: false,
  color: null,
};

const fake = {
  listAccounts: vi.fn(async () => []),
  calendars: vi.fn(async () => CALENDARS),
  calendarEvents: vi.fn(async () => []),
  createEvent: vi.fn(async () => "new"),
  updateEvent: vi.fn(async () => {}),
  deleteEvent: vi.fn(async () => {}),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function renderCalendarParts() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EventPopover />
      <EventEditor />
      <DeleteScopeQuestion />
    </QueryClientProvider>,
  );
}

describe("calendar flows", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    cleanup();
    act(() => useCalendarUi.setState({ popover: null, quick: null, editor: null, deleteScope: null }));
  });

  it("creates a weekly event through the editor", async () => {
    renderCalendarParts();
    act(() =>
      useCalendarUi.getState().openEditor({
        occurrence: null,
        draft: { start: "2026-09-23T10:00:00", end: "2026-09-23T11:00:00", allDay: false },
      }),
    );
    const dialog = await screen.findByRole("dialog");
    // The calendars arrive after the editor opened; the default one is chosen.
    await waitFor(() => expect(within(dialog).getByLabelText<HTMLSelectElement>("Calendar").value).toBe("home"));

    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Team lunch" } });
    fireEvent.change(within(dialog).getByLabelText("Location"), { target: { value: "Canteen" } });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Repeat" }), { target: { value: "weekly" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Fri" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fake.createEvent).toHaveBeenCalledTimes(1));
    expect(fake.createEvent).toHaveBeenCalledWith({
      calendarId: "home",
      title: "Team lunch",
      description: "",
      location: "Canteen",
      allDay: false,
      start: "2026-09-23T10:00:00",
      end: "2026-09-23T11:00:00",
      timeZone: deviceTimeZone(),
      recurrence: { frequency: "weekly", interval: 1, byDay: ["we", "fr"], until: null, count: null },
    });
    await waitFor(() => expect(useCalendarUi.getState().editor).toBeNull());
  });

  it("doesn't save an event that ends before it starts", async () => {
    renderCalendarParts();
    act(() =>
      useCalendarUi.getState().openEditor({
        occurrence: null,
        draft: { start: "2026-09-23T10:00:00", end: "2026-09-23T11:00:00", allDay: false },
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("End time"), { target: { value: "09:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("The end has to come after the start.")).toBeTruthy();
    expect(fake.createEvent).not.toHaveBeenCalled();
  });

  it("asks whether only this occurrence or the whole series goes", async () => {
    renderCalendarParts();
    act(() => useCalendarUi.getState().showPopover(YOGA, { left: 100, top: 100, width: 80, height: 40 }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    const question = await screen.findByRole("heading", { name: "Delete repeating event" });
    const dialog = question.closest("dialog")!;
    expect(within(dialog).getByLabelText<HTMLInputElement>("Only this event").checked).toBe(true);
    fireEvent.click(within(dialog).getByLabelText("All events of the series"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(fake.deleteEvent).toHaveBeenCalledWith(YOGA.id, "series"));
  });

  it("deletes nothing when the question is cancelled", async () => {
    renderCalendarParts();
    act(() => useCalendarUi.getState().showPopover(YOGA, { left: 100, top: 100, width: 80, height: 40 }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = (await screen.findByRole("heading", { name: "Delete repeating event" })).closest("dialog")!;
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(useCalendarUi.getState().deleteScope).toBeNull());
    expect(fake.deleteEvent).not.toHaveBeenCalled();
  });

  it("deletes a single event without asking", async () => {
    renderCalendarParts();
    const single = { ...YOGA, id: "dentist", eventId: "dentist", recurrence: null, recurrenceId: null };
    act(() => useCalendarUi.getState().showPopover(single, { left: 100, top: 100, width: 80, height: 40 }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(fake.deleteEvent).toHaveBeenCalledWith("dentist", "series"));
    expect(screen.queryByRole("heading", { name: "Delete repeating event" })).toBeNull();
  });
});
