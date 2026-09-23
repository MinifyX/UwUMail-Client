import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Folder } from "@/backend/types";
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
];

const createFolder = vi.fn(async () => "new");
const renameFolder = vi.fn(async () => {});
const deleteFolder = vi.fn(async () => {});
const emptyFolder = vi.fn(async () => 3);

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
  });

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

  it("system folders offer no rename or delete, the trash offers emptying with its count", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "More for Trash" }));
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete folder" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Empty trash" }));
    expect(await screen.findByText(/3 messages will be (deleted|gone) for good/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete for good" }));
    await waitFor(() => expect(emptyFolder).toHaveBeenCalledWith("trash"));
    await waitFor(() => expect(useToasts.getState().toasts.at(-1)?.message).toMatch(/3 messages/));
  });

  it("asks before deleting a folder and says its mail goes to the trash", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "More for Receipts" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete folder" }));
    expect(await screen.findByText(/2 messages (go )?to the trash/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));
    await waitFor(() => expect(deleteFolder).toHaveBeenCalledWith("receipts"));
  });
});
