import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Folder } from "@/backend/types";
import { ARMING_MS } from "@/components/ui/armed";
import { i18n } from "@/i18n";
import { useFolderEdit } from "@/state/folderEdit";
import { useToasts } from "@/state/toasts";
import { FolderDialogs } from "./FolderDialogs";
import { MailboxNav } from "./MailboxNav";

const account: Account = {
  id: "a1",
  name: "Test",
  email: "mini@uwumail.test",
  displayName: "Mini",
  color: "pink",
  auth: "password",
  status: { state: "idle" },
  protocol: "jmap",
  protocols: ["jmap"],
};

const folder = (id: string, name: string, extra: Partial<Folder> = {}): Folder => ({
  id,
  accountId: "a1",
  name,
  path: name,
  role: null,
  parentId: null,
  selectable: true,
  unread: 0,
  total: 0,
  ...extra,
});

const folders = [
  folder("inbox", "Inbox", { role: "inbox" }),
  folder("trash", "Trash", { role: "trash", total: 3 }),
  folder("receipts", "Receipts", { total: 2 }),
  folder("projects", "Projects"),
  folder("alpha", "Alpha", { parentId: "projects", path: "Projects/Alpha" }),
];

const createFolder = vi.fn(async () => "new");
const renameFolder = vi.fn(async () => {});
const deleteFolder = vi.fn(async () => {});
const emptyFolder = vi.fn(async () => 3);

/**
 * Answers a destructive question: a click right away is part of the gesture that asked and does
 * nothing (security-audit C-10); one after the arming time answers.
 */
function answer(button: HTMLElement, action: ReturnType<typeof vi.fn>) {
  const asked = performance.now();
  const now = vi.spyOn(performance, "now").mockReturnValue(asked + 10);
  fireEvent.click(button);
  expect(action).not.toHaveBeenCalled();
  now.mockReturnValue(asked + ARMING_MS + 10);
  fireEvent.click(button);
  now.mockRestore();
}

vi.mock("@/backend/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/backend/backend")>()),
  backend: () => ({
    listAccounts: () => Promise.resolve([account]),
    listFolders: () => Promise.resolve(folders),
    subscribe: () => () => {},
    createFolder,
    renameFolder,
    deleteFolder,
    emptyFolder,
  }),
}));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MailboxNav />
      <FolderDialogs />
    </QueryClientProvider>,
  );
}

describe("folder management", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    // jsdom has no modal dialogs.
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
    // The first render of the navigation pays for everything that loads once (modules, the query
    // client, the translations). Done here, it no longer eats into the first test's one second for
    // finding the folder menu, which on a busy machine it sometimes didn't fit into.
    setup();
    await screen.findByRole("button", { name: "More for Receipts" }, { timeout: 20_000 });
    cleanup();
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    useFolderEdit.getState().close();
    useToasts.setState({ toasts: [] });
  });

  afterEach(cleanup);

  it("creates a folder inside another one from its menu", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "More for Receipts" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New folder inside" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "  2026 " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(createFolder).toHaveBeenCalledWith({ accountId: "a1", name: "2026", parentId: "receipts" }),
    );
    await waitFor(() => expect(useFolderEdit.getState().request).toBeNull());
    expect(useToasts.getState().toasts.at(-1)?.message).toContain("2026");
  });

  it("opens the menu with a right-click and renames, keeping the dialog open on errors", async () => {
    renameFolder.mockRejectedValueOnce(new Error('There\'s already a folder called "Bills" here.'));
    setup();
    fireEvent.contextMenu(await screen.findByText("Receipts"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByLabelText("Name");
    expect((input as HTMLInputElement).value).toBe("Receipts");
    fireEvent.change(input, { target: { value: "Bills" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      'There\'s already a folder called "Bills" here.',
    );
    expect(useFolderEdit.getState().request?.kind).toBe("rename");
  });

  it("says what's wrong with a name before asking the mailbox", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "More for Receipts" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByLabelText("Name");
    // A JMAP (UwUMail) mailbox separates folder levels with "/".
    fireEvent.change(input, { target: { value: "Bills/2026" } });
    expect((await screen.findByRole("alert")).textContent).toBe("A folder name can't contain “/”.");
    fireEvent.change(input, { target: { value: "trash" } });
    expect(screen.getByRole("alert").textContent).toBe("There's already a folder with that name here.");
    expect(screen.getByRole("button", { name: "Rename" })).toHaveProperty("disabled", true);
    // "Empty" waits for the submit.
    fireEvent.change(input, { target: { value: "  " } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.submit(input.closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a name.");
    expect(renameFolder).not.toHaveBeenCalled();
  });

  it("system folders offer no rename or delete, the trash offers emptying with its count", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "More for Trash" }));
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete folder" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Empty trash" }));
    expect(await screen.findByText(/3 messages will be (deleted|gone) for good/)).toBeTruthy();
    answer(screen.getByRole("button", { name: "Delete for good" }), emptyFolder);
    await waitFor(() => expect(emptyFolder).toHaveBeenCalledWith("trash"));
    await waitFor(() => expect(useToasts.getState().toasts.at(-1)?.message).toMatch(/3 (messages|mails)/));
  });

  it("asks before deleting a folder and says its mail goes to the trash", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "More for Receipts" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete folder" }));
    expect(await screen.findByText(/2 messages (go |move )?to the trash/)).toBeTruthy();
    answer(screen.getByRole("button", { name: "Delete folder" }), deleteFolder);
    await waitFor(() => expect(deleteFolder).toHaveBeenCalledWith("receipts"));
  });

  it("says a folder with folders inside can't go yet, without asking the mailbox", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "More for Projects" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete folder" }));
    expect(await screen.findByText("“Projects” still holds folders")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete folder" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useFolderEdit.getState().request).toBeNull();
    expect(deleteFolder).not.toHaveBeenCalled();
  });
});
