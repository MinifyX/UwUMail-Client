import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, ShipmentAccount } from "@/backend/types";
import { i18n } from "@/i18n";
import { useSettings } from "@/state/settings";
import { AccountShipments } from "./AccountShipments";

const account = (id: string): Account => ({
  id,
  name: id,
  email: `${id}@example.org`,
  displayName: "Mini",
  color: "pink",
  auth: "password",
  status: { state: "idle" },
  protocol: "jmap",
  protocols: ["jmap"],
});

let entries: ShipmentAccount[] = [];
const fake = {
  shipmentAccounts: vi.fn(async () => entries),
  saveUserSettings: vi.fn(async (accountId: string, patch: Record<string, unknown>) => {
    entries = entries.map((e) => (e.accountId === accountId ? { ...e, on: patch.shipments === "on" } : e));
    return { ok: true as const };
  }),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

const renderBlock = (id: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AccountShipments account={account(id)} />
    </QueryClientProvider>,
  );

describe("a mailbox's parcel detection", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    entries = [
      { accountId: "uwu", on: true, switchable: true },
      { accountId: "imap", on: true, switchable: false },
    ];
  });
  afterEach(cleanup);

  it("is left out where the server can't switch parcels", async () => {
    renderBlock("imap");
    await waitFor(() => expect(fake.shipmentAccounts).toHaveBeenCalled());
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("asks before switching off, starts on Cancel and keeps them on when cancelled", async () => {
    renderBlock("uwu");
    fireEvent.click(await screen.findByRole("switch", { name: /Parcel detection/ }));
    expect(await screen.findByText(/uwu@example\.org/)).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.click(cancel);
    expect(fake.saveUserSettings).not.toHaveBeenCalled();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("switches off on the server after the confirmation", async () => {
    renderBlock("uwu");
    fireEvent.click(await screen.findByRole("switch", { name: /Parcel detection/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn off and delete" }));
    await waitFor(() => expect(fake.saveUserSettings).toHaveBeenCalledWith("uwu", { shipments: "off" }));
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"));
  });
});
