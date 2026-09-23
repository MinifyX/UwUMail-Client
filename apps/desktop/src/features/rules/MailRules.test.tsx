import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { parseRulesScript, rulesToSieve, type RuleSet } from "@/lib/sieveRules";
import { useSettings } from "@/state/settings";
import { MailRules } from "./MailRules";

const RULES: RuleSet = {
  v: 1,
  rules: [
    {
      id: "r1",
      name: "Invoices",
      enabled: true,
      match: "all",
      conditions: [{ field: "subject", op: "contains", value: "Invoice" }],
      actions: [{ type: "flag" }],
      stop: false,
    },
  ],
};

let stored: string | null = null;
const fake = {
  listAccounts: vi.fn(async () => [{ id: "acc", email: "me@example.org" }]),
  listFolders: vi.fn(async () => []),
  mailRulesAvailable: vi.fn(async () => true),
  mailRules: vi.fn(async () => ({ script: stored, active: true })),
  validateMailRules: vi.fn(async (): Promise<string | null> => null),
  saveMailRules: vi.fn(async (script: string) => {
    stored = script;
  }),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function renderRules() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MailRules />
    </QueryClientProvider>,
  );
}

describe("mail rules settings", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("switches a rule off by checking and storing the regenerated script", async () => {
    stored = rulesToSieve(RULES);
    renderRules();
    fireEvent.click(await screen.findByRole("switch", { name: "Invoices on or off" }));
    await waitFor(() => expect(fake.saveMailRules).toHaveBeenCalledTimes(1));
    expect(fake.validateMailRules).toHaveBeenCalledBefore(fake.saveMailRules);
    const saved = parseRulesScript(fake.saveMailRules.mock.calls[0]![0]);
    expect(saved.kind === "rules" && saved.set.rules[0]!.enabled).toBe(false);
  });

  it("saves nothing the server refuses", async () => {
    stored = rulesToSieve(RULES);
    fake.validateMailRules.mockResolvedValueOnce("line 3: syntax error");
    renderRules();
    fireEvent.click(await screen.findByRole("switch", { name: "Invoices on or off" }));
    await waitFor(() => expect(fake.validateMailRules).toHaveBeenCalled());
    expect(fake.saveMailRules).not.toHaveBeenCalled();
  });

  it("shows a script edited elsewhere as text instead of guessing", async () => {
    stored = 'require ["fileinto"];\nif header :contains "subject" "x" { fileinto "X"; }\n';
    renderRules();
    const text = await screen.findByLabelText<HTMLTextAreaElement>("Sieve script");
    expect(text.value).toBe(stored);
    expect(screen.getByText("These rules were edited elsewhere")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New rule" })).toBeNull();
  });
});
