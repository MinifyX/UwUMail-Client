import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, ContactsAccount } from "@/backend/types";
import { i18n } from "@/i18n";
import { useSettings } from "@/state/settings";
import { AccountContacts } from "./AccountContacts";

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

let sources: ContactsAccount[] = [];
const fake = {
  contactsAccounts: vi.fn(async () => sources),
  setCardDavUrl: vi.fn(async (accountId: string, url: string | null) => {
    sources = sources.map((entry) =>
      entry.accountId === accountId
        ? { ...entry, carddavUrl: url, source: url ? "carddav" : null, problem: url ? null : entry.problem }
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
      <AccountContacts account={of} />
    </QueryClientProvider>,
  );
}

describe("a mailbox's contacts settings", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    sources = [
      { accountId: "club", source: null, carddavUrl: null, problem: "No address book server found." },
      { accountId: "uwu", source: "jmap", carddavUrl: null, problem: null },
      { accountId: "work", source: null, carddavUrl: null, problem: "None for Microsoft sign-ins." },
    ];
  });
  afterEach(cleanup);

  it("says why there are no address books and stores a typed address after checking it", async () => {
    renderBlock(account("club", "password", "imap"));
    expect(await screen.findByText("Not available")).toBeTruthy();
    expect(screen.getByText("No address book server found.")).toBeTruthy();

    const field = screen.getByLabelText("CardDAV address");
    fireEvent.change(field, { target: { value: "http://dav.example.com/" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("The address has to start with https://.")).toBeTruthy();
    expect(fake.setCardDavUrl).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: " https://dav.example.com/ " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fake.setCardDavUrl).toHaveBeenCalledWith("club", "https://dav.example.com/"));
    expect(await screen.findByText("CardDAV")).toBeTruthy();
  });

  it("offers no address where CardDAV can't help", async () => {
    const { unmount } = renderBlock(account("uwu", "password", "jmap"));
    expect(await screen.findByText("UwUMail server")).toBeTruthy();
    expect(screen.queryByLabelText("CardDAV address")).toBeNull();
    unmount();

    renderBlock(account("work", "microsoft", "imap"));
    expect(
      await screen.findByText("Address books of mailboxes signed in with Microsoft or Google aren't supported yet."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("CardDAV address")).toBeNull();
  });
});
