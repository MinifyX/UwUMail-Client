import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BackupEmail } from "@/backend/types";
import { i18n } from "@/i18n";
import { BackupSearchDialog, useBackupSearch } from "./BackupSearch";

const mail = (id: string, subject: string, inMailbox: boolean): BackupEmail => ({
  id,
  subject,
  from: [{ name: "Shop", email: "shop@example.com" }],
  to: [{ email: "mini@example.org" }],
  receivedAt: "2026-10-02T08:00:00Z",
  size: 1200,
  folder: "Inbox",
  snapshots: ["2026-10-03T02:00:00Z"],
  inMailbox,
});

const searchBackups = vi.fn(async () => ({
  list: [mail("k1", "Order shipped", false), mail("k2", "Invoice", true)],
  indexing: { done: 1, total: 2 },
}));
const restoreBackupMail = vi.fn(async () => ({
  restored: ["k1"],
  alreadyThere: [] as string[],
  notRestored: [{ id: "k2", reason: "overQuota" }],
}));

vi.mock("@/backend/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/backend/backend")>()),
  backend: () => ({ searchBackups, restoreBackupMail, subscribe: () => () => {} }),
}));

describe("backup search", () => {
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

  afterEach(() => {
    cleanup();
    useBackupSearch.getState().close();
  });

  it("finds mail, restores the chosen ones and tells what happened", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BackupSearchDialog />
      </QueryClientProvider>,
    );
    useBackupSearch.getState().open("a1");

    fireEvent.change(await screen.findByLabelText("Search for"), { target: { value: "order" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    const status = screen.getByRole("status");
    expect(await within(status).findByText("2 messages found")).toBeTruthy();
    expect(within(status).getByText(/still being searched \(1 of 2\)/)).toBeTruthy();
    expect(searchBackups).toHaveBeenCalledWith("a1", { text: "order", after: undefined, before: undefined });
    expect(screen.getByText("Already in your mailbox")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /Order shipped/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Invoice/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restore (2)" }));

    expect(await within(status).findByText(/1 message restored/)).toBeTruthy();
    expect(within(status).getByText("1 message not restored: mailbox is full")).toBeTruthy();
    expect(restoreBackupMail).toHaveBeenCalledWith("a1", ["k1", "k2"]);
  });
});
