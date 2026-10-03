import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistOptions } from "@/backend/types";
import { i18n } from "@/i18n";
import { AssistScopeProvider } from "../useAssist";
import { ServerAssistSetting } from "./AssistantSettings";

const OPTIONS: AssistOptions = {
  features: { compose: true, summarize: true, spamCheck: true, extractEvents: true, autoLabels: true },
  mayAddProviders: true,
  mayUsePrivateAddresses: true,
  maxProviders: 5,
  maxLabels: 30,
  maxInstructionChars: 2000,
  maxTextChars: 20000,
  maxLabelConditions: 10,
  baseLabels: [],
  foreignMail: false,
  foreignServers: ["uwu"],
};

let serverAssist: string | null = null;

const fake = {
  listAccounts: vi.fn(async () => [{ id: "uwu", email: "mini@uwu.example" }]),
  assistScopes: vi.fn(async () => [
    { id: "device", kind: "device", accountId: null, accountIds: ["other"], options: OPTIONS },
  ]),
  assistSettings: vi.fn(async () => ({
    default: null,
    features: {},
    autoLabels: false,
    nonAiLabels: true,
    serverAssist,
    effective: {},
  })),
  updateAssistSettings: vi.fn(async (_scope: string, patch: { serverAssist?: string | null }) => {
    serverAssist = patch.serverAssist ?? null;
  }),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function renderSetting() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AssistScopeProvider scope="device">
        <ServerAssistSetting servers={["uwu"]} />
      </AssistScopeProvider>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  vi.clearAllMocks();
  serverAssist = null;
});
afterEach(cleanup);

describe("the server's AI for other mailboxes", () => {
  it("is off until chosen and says that mail goes to the server", async () => {
    renderSetting();
    const toggle = await screen.findByRole("switch", { name: /Use the AI of mini@uwu\.example/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/The mail's content \(sender, subject and text\) is sent to that server/)).toBeTruthy();
    expect(screen.queryByText(/goes to mini@uwu\.example/)).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(fake.updateAssistSettings).toHaveBeenCalledWith("device", { serverAssist: "uwu" }));
  });

  it("warns while it is on and turns off again", async () => {
    serverAssist = "uwu";
    renderSetting();
    expect(await screen.findByText("Mail of your other mailboxes goes to mini@uwu.example for the AI")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(fake.updateAssistSettings).toHaveBeenCalledWith("device", { serverAssist: null }));
  });
});
