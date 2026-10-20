import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Folder, Message, SnoozedMessage, UnsnoozeOutcome } from "@/backend/types";
import { useAccounts, useFolders } from "@/lib/queries";
import { useSettings } from "@/state/settings";
import { snoozable, useSnooze, useSnoozeRunner } from "./snooze";

const account = (id: string, email: string, protocol: Account["protocol"], readOnly = false) =>
  ({ id, email, name: email, protocol, readOnly }) as Account;
const folder = (
  id: string,
  accountId: string,
  name: string,
  role: Folder["role"] = null,
  parentId: string | null = null,
): Folder => ({
  id,
  accountId,
  name,
  path: id,
  role,
  parentId,
  selectable: true,
  unread: 0,
  total: 0,
});

const accounts = [account("a", "Me@Example.com", "imap"), account("j", "jay@example.org", "jmap")];
const folders = [
  { ...folder("a:inbox", "a", "INBOX", "inbox"), path: "INBOX" },
  { ...folder("a:work", "a", "Work"), path: "INBOX.Work" },
  { ...folder("a:sent", "a", "Sent", "sent"), path: "Sent" },
  folder("j:inbox", "j", "Inbox", "inbox"),
  folder("j:p", "j", "Projects"),
  folder("j:p2", "j", "Done", null, "j:p"),
];

const fake = {
  listAccounts: vi.fn(async () => accounts),
  listFolders: vi.fn(async () => folders),
  unsnooze: vi.fn(
    async (_account: string, _header: string, _folder: string | null): Promise<UnsnoozeOutcome> => "moved",
  ),
  snoozeMessages: vi.fn(async (): Promise<SnoozedMessage[]> => []),
  moveMessages: vi.fn(async () => []),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const message = (id: string, folderId: string, draft = false) =>
  ({ id, folderId, accountId: folderId.split(":")[0], flags: { draft } }) as Message;

beforeEach(() => {
  vi.clearAllMocks();
  useSettings.setState({ snoozes: {} });
});

describe("snoozing", () => {
  it("moves what was received, or the sent mail when that's all", () => {
    const thread = [message("1", "a:inbox"), message("2", "a:sent"), message("3", "a:inbox", true)];
    expect(snoozable(thread, folders).map((m) => m.id)).toEqual(["1"]);
    expect(snoozable([message("2", "a:sent")], folders).map((m) => m.id)).toEqual(["2"]);
  });

  it("writes one key per mail, naming the folder it came from as the settings do", async () => {
    fake.snoozeMessages.mockResolvedValueOnce([
      { id: "1", accountId: "a", headerId: "one@example.com", folderId: "a:work" },
      { id: "2", accountId: "j", headerId: "two@example.org", folderId: "j:p2" },
      { id: "3", accountId: "j", headerId: "three@example.org", folderId: null },
    ]);
    const { result } = renderHook(
      () => {
        const { snooze } = useSnooze();
        const accountsLoaded = !!useAccounts().data;
        const foldersLoaded = !!useFolders().data;
        return { snooze, ready: accountsLoaded && foldersLoaded };
      },
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    const until = new Date("2026-10-21T07:00:00.250Z");
    await act(() => result.current.snooze([message("1", "a:work"), message("2", "j:p2")], until));
    const entries = Object.entries(useSettings.getState().snoozes);
    expect(entries.map(([, entry]) => entry)).toEqual([
      { account: "me@example.com", messageId: "one@example.com", folder: "INBOX.Work", until: "2026-10-21T07:00:00Z" },
      {
        account: "jay@example.org",
        messageId: "two@example.org",
        folder: "Projects/Done",
        until: "2026-10-21T07:00:00Z",
      },
      // Already snoozed without a key: back to the inbox.
      { account: "jay@example.org", messageId: "three@example.org", folder: "Inbox", until: "2026-10-21T07:00:00Z" },
    ]);
    for (const [id] of entries) expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
});

describe("the snooze runner", () => {
  it("brings back what's due and drops its key, and leaves the rest", async () => {
    useSettings.setState({
      snoozes: {
        due: {
          account: "me@example.com",
          messageId: "one@example.com",
          folder: "INBOX.Work",
          until: "2026-01-01T00:00:00Z",
        },
        gone: {
          account: "jay@example.org",
          messageId: "two@example.org",
          folder: "Gone",
          until: "2026-01-01T00:00:00Z",
        },
        later: {
          account: "me@example.com",
          messageId: "x@example.com",
          folder: "INBOX",
          until: "2999-01-01T00:00:00Z",
        },
        elsewhere: {
          account: "else@example.net",
          messageId: "y@example.net",
          folder: "INBOX",
          until: "2026-01-01T00:00:00Z",
        },
        waiting: {
          account: "me@example.com",
          messageId: "w@example.com",
          folder: "INBOX",
          until: "2026-01-02T00:00:00Z",
        },
      },
    });
    fake.unsnooze.mockImplementation(async (_account: string, header: string) =>
      header === "w@example.com" ? "waiting" : header === "two@example.org" ? "gone" : "moved",
    );
    renderHook(() => useSnoozeRunner(), { wrapper: wrapper() });
    await waitFor(() =>
      expect(Object.keys(useSettings.getState().snoozes).sort()).toEqual(["elsewhere", "later", "waiting"]),
    );
    expect(fake.unsnooze).toHaveBeenCalledWith("a", "one@example.com", "a:work");
    // A folder this device doesn't know: the engine picks the inbox.
    expect(fake.unsnooze).toHaveBeenCalledWith("j", "two@example.org", null);
    expect(fake.unsnooze).toHaveBeenCalledTimes(3);
  });
});
