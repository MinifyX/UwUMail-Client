import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistOptions } from "@/backend/types";
import { i18n } from "@/i18n";
import { AiConsentQuestion } from "../AiConsentQuestion";
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
let granted = false;
const SERVER = { destination: "server:uwu", kind: "uwumailServer", name: "mini@uwu.example", host: "mail.uwu.example" };

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
  assistDestination: vi.fn(async () => ({ ...SERVER, granted })),
  grantAssistConsent: vi.fn(async () => {
    granted = true;
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
      <AiConsentQuestion />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  vi.clearAllMocks();
  serverAssist = null;
  granted = false;
});
afterEach(cleanup);

describe("the server's AI for other mailboxes", () => {
  it("is off until chosen and says that mail goes to the server", async () => {
    renderSetting();
    const toggle = await screen.findByRole("switch", { name: /Use the AI of mini@uwu\.example/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/The mail's content \(sender, subject and text\) is sent to that server/)).toBeTruthy();
    expect(screen.queryByText(/goes to mini@uwu\.example/)).toBeNull();

    // Switching it on asks first; "Not now" leaves it off and sends nothing.
    fireEvent.click(toggle);
    expect(await screen.findByText(/UwUMail server of mini@uwu\.example \(mail\.uwu\.example\)/)).toBeTruthy();
    expect(fake.assistDestination).toHaveBeenCalledWith("uwu", "compose");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Allow" })).toBeNull());
    expect(fake.grantAssistConsent).not.toHaveBeenCalled();
    expect(fake.updateAssistSettings).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(fake.updateAssistSettings).toHaveBeenCalledWith("device", { serverAssist: "uwu" }));
    expect(fake.grantAssistConsent).toHaveBeenCalledWith("server:uwu", "mail.uwu.example");
  });

  it("warns while it is on and turns off again", async () => {
    serverAssist = "uwu";
    renderSetting();
    expect(await screen.findByText("Mail of your other mailboxes goes to mini@uwu.example for the AI")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(fake.updateAssistSettings).toHaveBeenCalledWith("device", { serverAssist: null }));
  });
});
