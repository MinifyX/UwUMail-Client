import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, ContactRecord, Message, ThreadDetail } from "@/backend/types";
import { useNyuCameo } from "@/components/nyu/cameo";
import { DEFAULT_SETTINGS, useSettings } from "@/state/settings";
import { useNyuOnOpen } from "./nyuOnOpen";

const ACCOUNTS = [
  { id: "own", email: "me@example.com" },
  // A foreign IMAP mailbox is just as much the person's own.
  { id: "imap", email: "me@mail.example.net" },
] as Account[];

const LENA: ContactRecord = {
  id: "c1",
  accountId: "own",
  addressBookId: "b1",
  displayName: "Lena Berg",
  given: "Lena",
  surname: "Berg",
  organization: "",
  title: "",
  emails: [{ id: "e1", address: "lena@example.org", kind: "home" }],
  phones: [],
  addresses: [],
  birthday: "--09-30",
  note: "",
  photo: null,
  isGroup: false,
};

const fake = {
  listAccounts: vi.fn(async () => ACCOUNTS),
  contactsAvailable: vi.fn(async () => true),
  contacts: vi.fn(async () => [LENA]),
  knownContacts: vi.fn(async () => [LENA]),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

const message = (from: string, seen: boolean): Message =>
  ({ id: `m-${from}`, from: { name: "", email: from }, flags: { seen }, attachments: [] }) as unknown as Message;

const thread = (id: string, messages: Message[]): ThreadDetail =>
  ({ thread: { id }, messages }) as unknown as ThreadDetail;

function Reader({ detail }: { detail: ThreadDetail }) {
  useNyuOnOpen(detail);
  return null;
}

function open(detail: ThreadDetail, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <Reader detail={detail} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 30 September, in the afternoon: Lena's birthday, not late at night.
  vi.setSystemTime(new Date(2026, 8, 30, 15, 0));
  useNyuCameo.setState({ current: null, played: {} });
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useSettings.setState({ nyuAnimations: DEFAULT_SETTINGS.nyuAnimations });
});

describe("Nyu when a mail opens", () => {
  it("waits for the contacts and wears a party hat for a birthday, without searching for address books", async () => {
    // The reply of one of the own mailboxes (a foreign IMAP one) is newer: the sender is still Lena.
    open(thread("t1", [message("lena@example.org", false), message("me@mail.example.net", true)]));
    await waitFor(() => expect(useNyuCameo.getState().current?.name).toBe("birthday"));
    expect(fake.knownContacts).toHaveBeenCalledTimes(1);
    expect(fake.contacts).not.toHaveBeenCalled();
  });

  it("brings hearts for new mail from a contact, also once it was marked read", async () => {
    useNyuCameo.setState({ current: null, played: { [`birthday:lena@example.org:2026-09-30`]: Date.now() } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = open(thread("t2", [message("lena@example.org", false)]), client);
    view.rerender(
      <QueryClientProvider client={client}>
        <Reader detail={thread("t2", [message("lena@example.org", true)])} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(useNyuCameo.getState().current?.name).toBe("friend"));
  });

  it("greets without the contacts when they take too long", async () => {
    fake.knownContacts.mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(2026, 8, 30, 15, 0));
    open(thread("t5", [message("lena@example.org", false)]));
    await vi.waitFor(() => expect(fake.knownContacts).toHaveBeenCalled());
    expect(useNyuCameo.getState().current).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(useNyuCameo.getState().current?.name).toBe("peek");
  });

  it("takes the contacts already loaded, and peeks at mail from strangers", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["contacts"], [LENA]);
    open(thread("t3", [message("stranger@example.com", false)]), client);
    await waitFor(() => expect(useNyuCameo.getState().current?.name).toBe("peek"));
    expect(fake.knownContacts).not.toHaveBeenCalled();
  });

  it("stays away and reads no contacts while Nyu is off", async () => {
    useSettings.setState({ nyuAnimations: "off" });
    open(thread("t4", [message("lena@example.org", false)]));
    await waitFor(() => expect(fake.listAccounts).toHaveBeenCalled());
    expect(useNyuCameo.getState().current).toBeNull();
    expect(fake.knownContacts).not.toHaveBeenCalled();
  });
});
