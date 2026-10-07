import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Folder } from "@/backend/types";
import { ARMING_MS } from "@/components/ui/armed";
import { i18n } from "@/i18n";
import { isReadOnly, nestAccounts, takesSharedMailboxes, useSharedMailboxes } from "@/state/sharedMailboxes";
import { MailboxNav } from "../mail/MailboxNav";
import { SharedMailboxDialogs } from "./SharedMailboxDialogs";
import { useSettings } from "@/state/settings";

const work: Account = {
  id: "work",
  name: "contoso.example",
  email: "alex@contoso.example",
  displayName: "Alex",
  color: "violet",
  auth: "microsoft",
  status: { state: "idle" },
  protocol: "imap",
  protocols: ["imap"],
  sharedSearch: "done",
};
const team: Account = { ...work, id: "team", email: "team@contoso.example", displayName: "Team", parentId: "work" };
delete team.sharedSearch;
const home: Account = { ...work, id: "home", email: "mini@home.test", auth: "password", sharedSearch: undefined };

const inbox = (accountId: string, unread: number): Folder => ({
  id: `${accountId}:inbox`,
  accountId,
  name: "Inbox",
  path: "INBOX",
  role: "inbox",
  parentId: null,
  selectable: true,
  unread,
  total: unread,
});

const addSharedMailbox = vi.fn(async () => team);
const removeAccount = vi.fn(async () => {});

vi.mock("@/backend/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/backend/backend")>()),
  backend: () => ({
    listAccounts: () => Promise.resolve([work, team, home]),
    listFolders: () => Promise.resolve([inbox("work", 1), inbox("team", 4), inbox("home", 0)]),
    subscribe: () => () => {},
    addSharedMailbox,
    removeAccount,
  }),
}));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MailboxNav />
      <SharedMailboxDialogs />
    </QueryClientProvider>,
  );
}

/** Answers a destructive question after the arming time (security-audit C-10). */
function answer(button: HTMLElement) {
  const asked = performance.now();
  const now = vi.spyOn(performance, "now").mockReturnValue(asked + ARMING_MS + 10);
  fireEvent.click(button);
  now.mockRestore();
}

describe("shared mailboxes", () => {
  beforeAll(async () => {
    useSettings.setState({ expandedAccounts: ["work", "team", "home", "support"] });
    await i18n.changeLanguage("en");
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
    setup();
    await screen.findByRole("tree", { name: "team@contoso.example" }, { timeout: 20_000 });
    cleanup();
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    useSharedMailboxes.getState().close();
    // Mailboxes start folded; these tests work inside them.
    useSettings.setState({ expandedAccounts: ["work", "team", "home", "support"] });
  });

  afterEach(cleanup);

  it("groups shared mailboxes under their account", () => {
    expect(
      nestAccounts([work, team, home]).map(({ account, shared }) => [account.id, shared.map((s) => s.id)]),
    ).toEqual([
      ["work", ["team"]],
      ["home", []],
    ]);
    // Without its account (another workspace), it stands on its own.
    expect(nestAccounts([team, home]).map(({ account }) => account.id)).toEqual(["team", "home"]);
    expect(takesSharedMailboxes(work)).toBe(true);
    expect(takesSharedMailboxes(team)).toBe(false);
    expect(takesSharedMailboxes(home)).toBe(false);
    // A JMAP login whose server shares mailboxes takes back one removed before, by address.
    const login: Account = { ...home, protocol: "jmap", protocols: ["imap", "jmap"], sharedSearch: "done" };
    expect(takesSharedMailboxes(login)).toBe(true);
    expect(takesSharedMailboxes({ ...login, sharedSearch: undefined })).toBe(false);
    const support: Account = { ...login, id: "support", parentId: "home", serverShared: true, readOnly: true };
    expect(takesSharedMailboxes(support)).toBe(false);
    expect(isReadOnly([login, support], "support")).toBe(true);
    expect(isReadOnly([login, support], "home")).toBe(false);
    expect(isReadOnly([login, support], undefined)).toBe(false);
  });

  it("shows a shared mailbox with its own folders inside its account, and folds with it", async () => {
    setup();
    const tree = await screen.findByRole("tree", { name: "team@contoso.example" });
    const accountTree = screen.getByRole("tree", { name: "alex@contoso.example" });
    // Inside the account's section, right after the account's own folders.
    const section = accountTree.closest("section")!;
    expect(section.contains(tree)).toBe(true);
    expect(within(tree).getByText("4")).toBeTruthy();

    const header = within(section).getAllByRole("button", { expanded: true })[0]!;
    fireEvent.click(header);
    expect(screen.queryByRole("tree", { name: "team@contoso.example" })).toBeNull();
    // Folded, the account still tells what's unread in its own and its shared inboxes.
    expect(within(header).getByText("5")).toBeTruthy();
  });

  it("adds a shared mailbox by address from the account's menu", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "More for alex@contoso.example" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add shared mailbox" }));
    fireEvent.change(screen.getByLabelText("Address of the shared mailbox"), {
      target: { value: "team@contoso.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(addSharedMailbox).toHaveBeenCalledWith("work", "team@contoso.example", undefined));
    // The password mailbox has no such entry.
    fireEvent.click(screen.getByRole("button", { name: "More for mini@home.test" }));
    expect(screen.queryByRole("menuitem", { name: "Add shared mailbox" })).toBeNull();
  });

  it("removes an account with its shared mailboxes unless they're kept", async () => {
    setup();
    await screen.findByRole("tree", { name: "team@contoso.example" });
    useSharedMailboxes.getState().open({ kind: "remove", account: work });
    const keep = await screen.findByRole("checkbox", { name: "Also remove its shared mailbox" });
    expect((keep as HTMLInputElement).checked).toBe(true);
    fireEvent.click(keep);
    answer(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removeAccount).toHaveBeenCalledWith("work", { keepShared: true }));
  });

  it("removes one shared mailbox from its menu", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "More for team@contoso.example" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove shared mailbox" }));
    expect(await screen.findByText(/It isn't added again automatically/)).toBeTruthy();
    answer(screen.getByRole("button", { name: "Remove shared mailbox" }));
    await waitFor(() => expect(removeAccount).toHaveBeenCalledWith("team", { keepShared: false }));
  });
});
