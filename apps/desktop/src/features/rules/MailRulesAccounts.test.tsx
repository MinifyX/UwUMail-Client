import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { rulesToSieve } from "@/lib/sieveRules";
import { useSettings } from "@/state/settings";
import { useUi } from "@/state/ui";
import { SettingsDialog } from "../settings/SettingsDialog";
import { MailRules } from "./MailRules";

const ACCOUNTS = [
  { id: "a", name: "Private", email: "mini@example.org", protocols: ["jmap"], protocol: "jmap", auth: "password" },
  { id: "m", name: "Work", email: "mini@example.com", protocols: ["imap"], protocol: "imap", auth: "microsoft" },
  { id: "b", name: "Club", email: "board@example.net", protocols: ["jmap"], protocol: "jmap", auth: "password" },
];

function script(name: string) {
  return rulesToSieve({
    v: 1,
    rules: [
      {
        id: name,
        name,
        enabled: true,
        match: "all",
        conditions: [{ field: "subject", op: "contains", value: name }],
        actions: [{ type: "flag" }],
        stop: false,
      },
    ],
  });
}

let ruleAccounts = ["a", "b"];
const fake = {
  listAccounts: vi.fn(async () => ACCOUNTS),
  listFolders: vi.fn(async () => []),
  mailRulesAvailable: vi.fn(async (accountId?: string) =>
    accountId ? ruleAccounts.includes(accountId) : ruleAccounts.length > 0,
  ),
  mailRules: vi.fn(async (accountId?: string) => ({ script: script(`Rule of ${accountId}`), active: true })),
  validateMailRules: vi.fn(async (): Promise<string | null> => null),
  saveMailRules: vi.fn(async () => {}),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function renderWithClient(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

describe("mail rules of several mailboxes", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    ruleAccounts = ["a", "b"];
  });
  afterEach(() => {
    cleanup();
    act(() => useUi.getState().closeSettings());
  });

  it("offers only the mailboxes whose server runs rules and shows the chosen one's", async () => {
    renderWithClient(<MailRules />);
    const picker = await screen.findByLabelText<HTMLSelectElement>("Mailbox");
    expect([...picker.options].map((option) => option.value)).toEqual(["a", "b"]);
    expect(await screen.findByText("Rule of a")).toBeTruthy();

    fireEvent.change(picker, { target: { value: "b" } });
    expect(await screen.findByText("Rule of b")).toBeTruthy();
    expect(fake.mailRules).toHaveBeenCalledWith("b");
    expect(fake.mailRules).not.toHaveBeenCalledWith("m");
  });

  it("asks for no mailbox when only one runs rules", async () => {
    ruleAccounts = ["b"];
    renderWithClient(<MailRules />);
    expect(await screen.findByText("Rule of b")).toBeTruthy();
    expect(screen.queryByLabelText("Mailbox")).toBeNull();
  });

  it("leaves the rules out of the settings when no server runs them", async () => {
    act(() => useUi.getState().openSettings("appearance"));
    const { unmount } = renderWithClient(<SettingsDialog />);
    // The settings ask a lot on their first render; give them time on a busy test run.
    expect(await screen.findByRole("button", { name: "Rules" }, { timeout: 5000 })).toBeTruthy();
    unmount();

    ruleAccounts = [];
    fake.mailRulesAvailable.mockClear();
    renderWithClient(<SettingsDialog />);
    // Every mailbox was asked and the answers are in.
    await waitFor(() => expect(fake.mailRulesAvailable).toHaveBeenCalledTimes(ACCOUNTS.length), { timeout: 5000 });
    await act(async () => {});
    await screen.findByRole("button", { name: "Appearance" });
    expect(screen.queryByRole("button", { name: "Rules" })).toBeNull();
  });
});
