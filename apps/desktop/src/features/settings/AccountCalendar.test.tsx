import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, CalendarAccount } from "@/backend/types";
import { i18n } from "@/i18n";
import { useSettings } from "@/state/settings";
import { AccountCalendar, caldavUrlProblem } from "./AccountCalendar";

function account(id: string, auth: Account["auth"], protocol: Account["protocol"]): Account {
  return {
    id,
    name: id,
    email: `${id}@example.org`,
    displayName: "Mini",
    color: "pink",
    auth,
    status: { state: "idle" },
    protocol,
    protocols: [protocol],
  };
}

let sources: CalendarAccount[] = [];
const fake = {
  calendarAccounts: vi.fn(async () => sources),
  setCalDavUrl: vi.fn(async (accountId: string, url: string | null) => {
    sources = sources.map((entry) =>
      entry.accountId === accountId
        ? { ...entry, caldavUrl: url, source: url ? "caldav" : null, problem: url ? null : entry.problem }
        : entry,
    );
  }),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function renderBlock(of: Account) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AccountCalendar account={of} />
    </QueryClientProvider>,
  );
}

describe("a mailbox's calendar settings", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    sources = [
      { accountId: "club", source: null, caldavUrl: null, problem: "No calendar server found." },
      { accountId: "uwu", source: "jmap", caldavUrl: null, problem: null },
      { accountId: "work", source: null, caldavUrl: null, problem: "No calendars for Microsoft sign-ins." },
      { accountId: "dav", source: "caldav", caldavUrl: "https://dav.example.net/cal/", problem: null },
    ];
  });
  afterEach(cleanup);

  it("takes only https addresses", () => {
    expect(caldavUrlProblem("https://dav.example.com/")).toBeNull();
    expect(caldavUrlProblem("  https://dav.example.com/remote.php/dav  ")).toBeNull();
    expect(caldavUrlProblem("http://dav.example.com/")).toBe("https");
    expect(caldavUrlProblem("javascript:alert(1)")).toBe("https");
    expect(caldavUrlProblem("dav.example.com")).toBe("invalid");
  });

  it("says why there is no calendar and stores a typed address after checking it", async () => {
    renderBlock(account("club", "password", "imap"));
    expect(await screen.findByText("Not available")).toBeTruthy();
    expect(screen.getByText("No calendar server found.")).toBeTruthy();

    const field = screen.getByLabelText("CalDAV address");
    fireEvent.change(field, { target: { value: "http://dav.example.com/" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("The address has to start with https://.")).toBeTruthy();
    expect(fake.setCalDavUrl).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: " https://dav.example.com/ " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fake.setCalDavUrl).toHaveBeenCalledWith("club", "https://dav.example.com/"));
    expect(await screen.findByText("CalDAV")).toBeTruthy();
    expect(fake.calendarAccounts.mock.calls.length).toBeGreaterThan(1);
  });

  it("removes a typed address and checks again", async () => {
    renderBlock(account("dav", "password", "imap"));
    expect(await screen.findByText("CalDAV")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("CalDAV address").value).toBe("https://dav.example.net/cal/");

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(fake.setCalDavUrl).toHaveBeenCalledWith("dav", "https://dav.example.net/cal/"));

    fireEvent.click(await screen.findByRole("button", { name: "Remove address" }));
    await waitFor(() => expect(fake.setCalDavUrl).toHaveBeenLastCalledWith("dav", null));
  });

  it("offers no address where CalDAV can't help", async () => {
    const { unmount } = renderBlock(account("uwu", "password", "jmap"));
    expect(await screen.findByText("UwUMail server")).toBeTruthy();
    expect(screen.queryByLabelText("CalDAV address")).toBeNull();
    unmount();

    renderBlock(account("work", "microsoft", "imap"));
    expect(await screen.findByText("No calendars for Microsoft sign-ins.")).toBeTruthy();
    expect(screen.queryByLabelText("CalDAV address")).toBeNull();
  });
});
