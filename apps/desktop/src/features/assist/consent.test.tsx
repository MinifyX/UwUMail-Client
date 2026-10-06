import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistError } from "@/backend/backend";
import type { AiConsent, AiDestination } from "@/backend/types";
import { i18n } from "@/i18n";
import { useAiConsent } from "@/state/aiConsent";
import { AiConsentQuestion, sentItems } from "./AiConsentQuestion";
import { forgetDeclinedConsents, withAiConsent } from "./consent";
import { ConsentSettings } from "./settings/AssistantSettings";

const OPENAI: AiDestination = { destination: "provider:d1", kind: "openai", name: "OpenAI", host: "api.openai.com" };

let consents: AiConsent[] = [];

const fake = {
  grantAssistConsent: vi.fn(async (destination: string, host: string) => {
    consents = [{ ...OPENAI, destination, host, grantedAt: 1_790_000_000 }];
  }),
  assistConsents: vi.fn(async () => consents),
  revokeAssistConsent: vi.fn(async (destination: string) => {
    consents = consents.filter((consent) => consent.destination !== destination);
  }),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

/** A call of the assistant the way the engine answers it: refused until the consent is there. */
function summarizeCall() {
  return vi.fn(async () => {
    if (!consents.some((consent) => consent.destination === OPENAI.destination)) {
      throw new AssistError("consentRequired", "Allow it first.", { consent: OPENAI });
    }
    return { summary: "Ein Fest im Park." };
  });
}

function renderQuestion() {
  return render(<AiConsentQuestion />);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  vi.clearAllMocks();
  consents = [];
  forgetDeclinedConsents();
  useAiConsent.setState({ pending: null });
});
afterEach(cleanup);

describe("asking before mail goes to an AI provider", () => {
  it("names the provider and what is sent, and retries once allowed", async () => {
    renderQuestion();
    const call = summarizeCall();
    const result = withAiConsent(["summarize"], call);
    expect(await screen.findByText(/sends personal data from your mail to OpenAI \(api\.openai\.com\)/)).toBeTruthy();
    expect(screen.getByText("Names and addresses of the sender and recipients")).toBeTruthy();
    expect(screen.getByText("The text of the mail")).toBeTruthy();
    expect(screen.getByText(/Settings → AI assistant/)).toBeTruthy();
    expect(screen.getByText(/privacy policy and terms of OpenAI/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await expect(result).resolves.toEqual({ summary: "Ein Fest im Park." });
    expect(fake.grantAssistConsent).toHaveBeenCalledWith("provider:d1", "api.openai.com");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("sends nothing on “Not now”, and an automatic call doesn't ask again", async () => {
    renderQuestion();
    const call = summarizeCall();
    const result = withAiConsent(["extractEvents"], call, { automatic: true });
    expect(await screen.findByText("Text read from the mail's pictures")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await expect(result).rejects.toMatchObject({ type: "consentRequired" });
    expect(fake.grantAssistConsent).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);

    await expect(withAiConsent(["extractEvents"], call, { automatic: true })).rejects.toMatchObject({
      code: "consent_required",
    });
    expect(useAiConsent.getState().pending).toBeNull();
    // A click asks again.
    const clicked = withAiConsent(["extractEvents"], call);
    await waitFor(() => expect(useAiConsent.getState().pending).not.toBeNull());
    act(() => useAiConsent.getState().pending!.answer(false));
    await expect(clicked).rejects.toMatchObject({ type: "consentRequired" });
  });

  it("passes other errors on without asking", async () => {
    const failing = vi.fn(async () => {
      throw new AssistError("providerFailed", "busy");
    });
    await expect(withAiConsent(["summarize"], failing)).rejects.toMatchObject({ type: "providerFailed" });
    expect(useAiConsent.getState().pending).toBeNull();
  });

  it("lists what each feature sends", () => {
    expect(sentItems(["summarize"])).toEqual(["people", "subject", "text"]);
    expect(sentItems(["spamCheck", "autoLabels"])).toEqual(["people", "subject", "text", "headers", "labels"]);
    expect(sentItems(["compose"])).toContain("draft");
  });
});

describe("the consents in the settings", () => {
  it("lists each one and takes it back", async () => {
    consents = [{ ...OPENAI, grantedAt: 1_790_000_000 }];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ConsentSettings />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("OpenAI")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke for OpenAI" }));
    await waitFor(() => expect(fake.revokeAssistConsent).toHaveBeenCalledWith("provider:d1"));
    // The engine says "assist:changed"; here the list is read again by hand.
    await act(() => client.invalidateQueries());
    expect(await screen.findByText("You haven't allowed sending mail anywhere yet.")).toBeTruthy();
  });
});
