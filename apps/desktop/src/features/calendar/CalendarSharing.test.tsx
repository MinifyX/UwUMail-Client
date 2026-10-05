import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarAccount, CalendarInfo, ShareLevel } from "@/backend/types";
import { ARMING_MS } from "@/components/ui/armed";
import { i18n } from "@/i18n";
import { useSettings } from "@/state/settings";
import { CalendarList } from "./CalendarList";

function calendar(id: string, name: string, extra: Partial<CalendarInfo> = {}): CalendarInfo {
  return {
    id,
    accountId: "a",
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

let calendars: CalendarInfo[] = [];
const SOURCES: CalendarAccount[] = [{ accountId: "a", source: "jmap", caldavUrl: null, problem: null, checked: true }];

const fake = {
  listAccounts: vi.fn(async () => [{ id: "a", name: "Private", email: "mini@uwumail.example" }]),
  calendars: vi.fn(async () => calendars.map((c) => ({ ...c }))),
  calendarAccounts: vi.fn(async () => SOURCES),
  calendarEvents: vi.fn(async () => []),
  calendarPeople: vi.fn(async (_accountId: string) => [
    { id: "p-kai", name: "Kai Kralle", email: "kai@uwumail.example" },
    { id: "p-leni", name: "Leni", email: "leni@uwumail.example" },
  ]),
  shareCalendar: vi.fn(async (id: string, personId: string, level: ShareLevel | null) => {
    calendars = calendars.map((c) => {
      if (c.id !== id) return c;
      const sharedWith = { ...c.sharedWith };
      if (level) sharedWith[personId] = level;
      else delete sharedWith[personId];
      return { ...c, sharedWith };
    });
  }),
  deleteCalendar: vi.fn(async (id: string) => {
    calendars = calendars.filter((c) => c.id !== id);
  }),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CalendarList />
    </QueryClientProvider>,
  );
}

async function openMenu(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Actions for ${name}` }));
}

describe("sharing calendars on a UwUMail server", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    calendars = [
      calendar("a:home", "Home", { isDefault: true, mayShare: true, sharedWith: { "p-kai": "read" } }),
      calendar("a:band", "Band", { sharedBy: { email: "leni@uwumail.example", name: "Leni" } }),
    ];
  });
  afterEach(cleanup);

  it("shows who shared a calendar and with how many the own one is shared", async () => {
    renderList();
    expect(await screen.findByText("Shared by Leni")).toBeTruthy();
    expect(screen.getByLabelText("Shared with 1 person")).toBeTruthy();
  });

  it("shares with somebody of the server and stops again", async () => {
    renderList();
    await openMenu("Home");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Share …" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Kai Kralle")).toBeTruthy();
    fireEvent.click(await within(dialog).findByRole("button", { name: /Leni/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Share" }));
    await waitFor(() => expect(fake.shareCalendar).toHaveBeenCalledWith("a:home", "p-leni", "read"));
    expect(fake.calendarPeople).toHaveBeenCalledWith("a");

    fireEvent.click(within(dialog).getByRole("button", { name: "Stop sharing with Kai Kralle" }));
    await waitFor(() => expect(fake.shareCalendar).toHaveBeenLastCalledWith("a:home", "p-kai", null));
  });

  it("offers no sharing for a calendar shared with this mailbox, only leaving it", async () => {
    renderList();
    await openMenu("Band");
    expect(screen.queryByRole("menuitem", { name: "Share …" })).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from my calendars" }));
    expect(await screen.findByText("Remove “Band” from your calendars?")).toBeTruthy();
    const leave = screen.getAllByRole("button", { name: "Remove from my calendars" }).at(-1)!;
    // An armed button: it waits a moment before a click counts.
    const now = vi.spyOn(performance, "now").mockReturnValue(performance.now() + ARMING_MS + 10);
    fireEvent.click(leave);
    now.mockRestore();
    await waitFor(() => expect(fake.deleteCalendar).toHaveBeenCalledWith("a:band"));
  });
});
