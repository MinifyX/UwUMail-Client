import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushStatus } from "@/backend/mobile";
import { i18n } from "@/i18n";
import { useSettings } from "@/state/settings";
import { UnifiedPush } from "./UnifiedPush";

let status: PushStatus;
const fake = vi.hoisted(() => ({
  pushStatus: vi.fn(),
  setUnifiedPush: vi.fn(),
}));

vi.mock("@/backend/mobile", () => ({ mobile: fake }));

function base(): PushStatus {
  return {
    distributors: [{ id: "io.heckel.ntfy", name: "ntfy" }],
    distributor: "io.heckel.ntfy",
    enabled: false,
    active: false,
    accounts: { active: 0, waiting: 0, other: 2 },
    failed: 0,
    working: false,
    watchNeeded: true,
  };
}

function renderSetting() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UnifiedPush />
    </QueryClientProvider>,
  );
}

describe("the UnifiedPush setting", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    status = base();
    fake.pushStatus.mockImplementation(async () => status);
    fake.setUnifiedPush.mockImplementation(async (enabled: boolean, distributor: string | null) => {
      status = { ...status, enabled, distributor, active: enabled, working: enabled };
      return status;
    });
  });
  afterEach(cleanup);

  it("stays hidden without a push app", async () => {
    status = { ...base(), distributors: [], distributor: null };
    const { container } = renderSetting();
    await waitFor(() => expect(fake.pushStatus).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("switches on with the only push app and says it's setting up", async () => {
    renderSetting();
    fireEvent.click(await screen.findByRole("switch", { name: /Instant mail through UnifiedPush/ }));
    await waitFor(() => expect(fake.setUnifiedPush).toHaveBeenCalledWith(true, "io.heckel.ntfy"));
    expect(await screen.findByText("Setting up your mailboxes with ntfy…")).toBeTruthy();
  });

  it("lets people pick among several push apps", async () => {
    status = {
      ...base(),
      enabled: true,
      active: false,
      distributor: null,
      distributors: [
        { id: "io.heckel.ntfy", name: "ntfy" },
        { id: "org.unifiedpush.distributor.nextpush", name: "NextPush" },
      ],
    };
    renderSetting();
    const picker = await screen.findByRole("combobox", { name: "Push app" });
    fireEvent.change(picker, { target: { value: "org.unifiedpush.distributor.nextpush" } });
    await waitFor(() => expect(fake.setUnifiedPush).toHaveBeenCalledWith(true, "org.unifiedpush.distributor.nextpush"));
  });

  it("says which mailboxes still need the lasting notification", async () => {
    status = { ...base(), enabled: true, active: true, accounts: { active: 1, waiting: 0, other: 1 } };
    renderSetting();
    expect(
      await screen.findByText(
        "1 mailbox gets new mail through ntfy. The others stay connected with the lasting notification.",
      ),
    ).toBeTruthy();
  });

  it("says when no mailbox's server can push over Web Push", async () => {
    status = { ...base(), enabled: true, active: true, accounts: { active: 0, waiting: 0, other: 2 } };
    renderSetting();
    expect(await screen.findByText(/That needs a JMAP server with Web Push/)).toBeTruthy();
  });

  it("says when the push app is gone", async () => {
    status = { ...base(), enabled: true, active: false, distributors: [], distributor: null };
    renderSetting();
    expect(await screen.findByText(/Your push app is gone/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: /Instant mail through UnifiedPush/ }));
    await waitFor(() => expect(fake.setUnifiedPush).toHaveBeenCalledWith(false, null));
  });

  it("says when every mailbox gets its mail through the push app", async () => {
    status = {
      ...base(),
      enabled: true,
      active: true,
      watchNeeded: false,
      accounts: { active: 2, waiting: 0, other: 0 },
    };
    renderSetting();
    expect(await screen.findByText(/All mailboxes get new mail through ntfy/)).toBeTruthy();
  });
});
