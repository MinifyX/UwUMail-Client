import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistError } from "@/backend/backend";
import { toAssistEstimate, toLocalModelServers } from "@/backend/assistConvert";
import { DemoAssist } from "@/backend/demo-assist";
import type {
  AssistEstimate,
  AssistOptions,
  AssistProbeInput,
  AssistProviderInput,
  LocalModelServer,
  Message,
} from "@/backend/types";
import { Menu } from "@/components/ui/Menu";
import { i18n } from "@/i18n";
import { useSettings } from "@/state/settings";
import { composeEstimate } from "./ComposeAssist";
import { EstimateLabel, EstimateTip, estimateDetails, estimateKey, estimateText, LONG_PRESS_MS } from "./estimate";
import { useEventSearch } from "../dates/search";
import { ThreadAssistButton } from "./ReaderAssist";
import { ProviderSettings } from "./settings/ProviderSettings";
import { AssistForAccount, AssistScopeProvider } from "./useAssist";

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
  foreignServers: [],
};

const ESTIMATE: AssistEstimate = {
  method: "Assist/summarize",
  inputTokens: 1100,
  outputTokens: 150,
  totalTokens: 1250,
  providerId: "q1",
  providerName: "Mistral (Server)",
  model: "mistral-small-latest",
  tokensLeftToday: 48000,
  requestsLeftToday: 190,
  cost: null,
  reasoningTokens: 0,
  imageCount: 0,
  calls: [],
  calibrated: false,
};

let local: LocalModelServer[] = [];

const fake = {
  assistEstimate: vi.fn(async (): Promise<AssistEstimate | null> => ESTIMATE),
  assistScopes: vi.fn(async () => [
    { id: "device", kind: "device", accountId: null, accountIds: ["other"], options: OPTIONS },
  ]),
  assistFeatures: vi.fn(async () => OPTIONS.features),
  calendarsAvailable: vi.fn(async () => true),
  assistProviders: vi.fn(async () => []),
  assistLocalModels: vi.fn(async () => local),
  assistProbeModels: vi.fn(async (input: AssistProbeInput) => ({
    models: input.baseUrl.includes("11434") ? [{ id: "qwen3:8b", name: "qwen3:8b" }] : [],
    model: null,
    fastModel: null,
  })),
  createAssistProvider: vi.fn(async (_scope: string, input: AssistProviderInput) => ({ id: "d9", ...input })),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function renderWith(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AssistForAccount accountId="acc">{node}</AssistForAccount>
    </QueryClientProvider>,
  );
}

const REQUEST = { accountId: "acc", method: "Assist/summarize" as const, args: { emailId: "e1", language: "en" } };

beforeAll(async () => {
  await i18n.changeLanguage("en");
  useSettings.getState().update({ tone: "neutral" });
});
beforeEach(() => {
  vi.clearAllMocks();
  local = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the estimate's words", () => {
  const t = i18n.getFixedT("en", "neutral");

  it("says the tokens and what is left today in the reader's number format", () => {
    expect(estimateText(ESTIMATE, t, "en")).toBe("≈ 1,300 tokens · 48,000 left today");
    expect(estimateText(ESTIMATE, i18n.getFixedT("de", "neutral"), "de")).toBe(
      "≈ 1.300 Tokens · heute noch 48.000 übrig",
    );
    expect(estimateText({ ...ESTIMATE, tokensLeftToday: null, requestsLeftToday: 1 }, t, "en")).toBe(
      "≈ 1,300 tokens · 1 request left today",
    );
    expect(estimateText({ ...ESTIMATE, tokensLeftToday: null, requestsLeftToday: null }, t, "en")).toBe(
      "≈ 1,300 tokens",
    );
    // Rough like the estimate: tens below 1,000, hundreds above.
    expect(estimateText({ ...ESTIMATE, totalTokens: 347, tokensLeftToday: null }, t, "en")).toBe(
      "≈ 350 tokens · 190 requests left today",
    );
    const cost = { amount: 0.0214, currency: "EUR", usd: 0.025, max: null, parts: null };
    expect(estimateText({ ...ESTIMATE, cost, totalTokens: 1200 }, t, "en")).toBe(
      "≈ 1,200 tokens · ≈ €0.021 · 48,000 left today",
    );
    const german = estimateText({ ...ESTIMATE, cost, totalTokens: 1200 }, i18n.getFixedT("de", "neutral"), "de");
    // Intl puts a non-breaking space before the euro sign.
    expect(german.replace(/\u00a0/g, " ")).toBe("≈ 1.200 Tokens · ≈ 0,021 € · heute noch 48.000 übrig");
  });

  it("adds the worst case and a small breakdown when the server says them", () => {
    const rich = toAssistEstimate(
      {
        method: "Assist/extractEvents",
        inputTokens: 900,
        outputTokens: 150,
        reasoningTokens: 200,
        totalTokens: 1250,
        imageCount: 2,
        calibrated: true,
        calls: [
          { purpose: "main", inputTokens: 700, outputTokens: 150, reasoningTokens: 200, images: 2, weight: 1 },
          { purpose: "retry", inputTokens: 400, outputTokens: 0, reasoningTokens: 0, images: 0, weight: 0.5 },
        ],
        tokensLeftToday: 48000,
        requestsLeftToday: null,
        cost: {
          amount: 0.02,
          currency: "EUR",
          usd: 0.023,
          max: { amount: 0.05, usd: 0.058 },
          parts: { input: 0.004, output: 0.006, reasoning: 0.008, images: 0.002, requests: 0, other: 0 },
        },
      },
      "Assist/extractEvents",
    )!;
    expect(estimateText(rich, t, "en")).toBe("≈ 1,300 tokens · ≈ €0.02 (max €0.05) · 48,000 left today");
    expect(estimateDetails(rich, t, "en")).toEqual([
      "Input: ≈ 900 tokens · ≈ €0.004",
      "Pictures: 2 pictures · ≈ €0.002",
      "Answer: ≈ 150 tokens · ≈ €0.006",
      "Thinking: ≈ 200 tokens · ≈ €0.008",
      "Extra calls: 1 call · ≈ 200 tokens",
      "Calibrated from your last calls",
    ]);
    const german = estimateText(rich, i18n.getFixedT("de", "neutral"), "de").replace(/\u00a0/g, " ");
    expect(german).toBe("≈ 1.300 Tokens · ≈ 0,02 € (max. 0,05 €) · heute noch 48.000 übrig");
    // Only lines that aren't zero; fees where there are some.
    const plain = {
      ...rich,
      imageCount: 0,
      reasoningTokens: 0,
      calibrated: false,
      calls: rich.calls.slice(0, 1),
      cost: { ...rich.cost!, parts: { ...rich.cost!.parts!, images: 0, reasoning: 0, requests: 0.001 } },
    };
    expect(estimateDetails(plain, t, "en")).toEqual([
      "Input: ≈ 900 tokens · ≈ €0.004",
      "Answer: ≈ 150 tokens · ≈ €0.006",
      "Fees: ≈ €0.001",
    ]);
    // No worst case above the cost: no "max".
    const flat = { ...rich, cost: { ...rich.cost!, max: { amount: 0.02, usd: 0.023 } } };
    expect(estimateText(flat, t, "en")).toBe("≈ 1,300 tokens · ≈ €0.02 · 48,000 left today");
  });

  it("says today's words for an older server", () => {
    const old = toAssistEstimate(
      { inputTokens: 1100, outputTokens: 150, tokensLeftToday: 48000, cost: { amount: 0.02, currency: "EUR" } },
      "Assist/summarize",
    )!;
    expect(old).toMatchObject({ reasoningTokens: 0, imageCount: 0, calls: [], calibrated: false });
    expect(old.cost).toMatchObject({ max: null, parts: null });
    expect(estimateText(old, t, "en")).toBe("≈ 1,300 tokens · ≈ €0.02 · 48,000 left today");
    expect(estimateDetails(old, t, "en")).toEqual([]);
  });

  it("keeps one cache entry per call, whatever the order of its arguments", () => {
    const one = estimateKey({ ...REQUEST, args: { emailId: "e1", language: "en" } });
    const two = estimateKey({ ...REQUEST, args: { language: "en", emailId: "e1" } });
    expect(one).toEqual(two);
    expect(estimateKey({ ...REQUEST, args: { emailId: "e2", language: "en" } })).not.toEqual(one);
  });

  it("reads only well-formed answers and local servers", () => {
    expect(toAssistEstimate(null, "Assist/compose")).toBeNull();
    expect(toAssistEstimate({ inputTokens: "many" }, "Assist/compose")).toBeNull();
    expect(
      toAssistEstimate({ inputTokens: 10.4, outputTokens: 5, tokensLeftToday: -3 }, "Assist/spamCheck"),
    ).toMatchObject({
      method: "Assist/spamCheck",
      inputTokens: 10,
      totalTokens: 15,
      tokensLeftToday: 0,
      requestsLeftToday: null,
    });
    expect(
      toLocalModelServers([
        { kind: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434", models: [{ id: "qwen3:8b" }] },
        { kind: "ollama", name: "Elsewhere", baseUrl: "http://192.0.2.10:11434", models: [] },
        { kind: "openai", name: "Nope", baseUrl: "http://127.0.0.1:1234/v1" },
      ]),
    ).toEqual([
      {
        kind: "ollama",
        name: "Ollama",
        baseUrl: "http://127.0.0.1:11434",
        models: [{ id: "qwen3:8b", name: "qwen3:8b" }],
        added: false,
      },
    ]);
  });

  it("estimates a composer item with the draft as it is", () => {
    const context = {
      source: { scope: "own" as const, text: "hey leni" },
      subject: "",
      replyToEmailId: null,
      language: "en",
    };
    expect(composeEstimate("acc", { kind: "rewrite", preset: "translate" }, context).args).toMatchObject({
      mode: "rewrite",
      preset: "translate",
      targetLanguage: "de",
      text: "hey leni",
      instruction: null,
    });
    // Nothing typed yet: a placeholder instruction, so the server takes it.
    expect(composeEstimate("acc", { kind: "write" }, context).args).toMatchObject({
      mode: "write",
      instruction: "…",
      text: null,
      wantSubject: true,
    });
  });
});

describe("the tooltip", () => {
  it("asks on the first hover only and shows the estimate", async () => {
    const click = vi.fn();
    renderWith(
      <EstimateTip request={REQUEST} hint="Reads the mail">
        <button type="button" onClick={click}>
          Summarize
        </button>
      </EstimateTip>,
    );
    expect(fake.assistEstimate).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "Summarize" });
    fireEvent.pointerEnter(button.parentElement!, { pointerType: "mouse" });
    const tip = await screen.findByRole("tooltip");
    await waitFor(() => expect(tip.textContent).toContain("≈ 1,300 tokens · 48,000 left today"));
    expect(tip.textContent).toContain("Reads the mail");
    expect(fake.assistEstimate).toHaveBeenCalledWith(
      "acc",
      "Assist/summarize",
      { emailId: "e1", language: "en" },
      "EUR",
    );
    expect(button.parentElement!.getAttribute("aria-describedby")).toBe(tip.id);
    fireEvent.pointerLeave(button.parentElement!, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerEnter(button.parentElement!, { pointerType: "mouse" });
    await screen.findByRole("tooltip");
    expect(fake.assistEstimate).toHaveBeenCalledOnce();
    fireEvent.click(button);
    expect(click).toHaveBeenCalledOnce();
  });

  it("shows nothing for an older server or a refusal", async () => {
    fake.assistEstimate.mockResolvedValueOnce(null);
    const { unmount } = renderWith(
      <EstimateTip request={REQUEST}>
        <button type="button">Summarize</button>
      </EstimateTip>,
    );
    fireEvent.pointerEnter(screen.getByRole("button").parentElement!, { pointerType: "mouse" });
    await waitFor(() => expect(fake.assistEstimate).toHaveBeenCalled());
    expect(screen.queryByRole("tooltip")).toBeNull();
    unmount();
    fake.assistEstimate.mockRejectedValueOnce(new AssistError("assistUnavailable", "No provider"));
    renderWith(
      <EstimateTip request={REQUEST}>
        <button type="button">Summarize</button>
      </EstimateTip>,
    );
    fireEvent.pointerEnter(screen.getByRole("button").parentElement!, { pointerType: "mouse" });
    await waitFor(() => expect(fake.assistEstimate).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows on a long press on touch screens, which then doesn't tap the button", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const click = vi.fn();
    renderWith(
      <EstimateTip request={REQUEST}>
        <button type="button" onClick={click}>
          Summarize
        </button>
      </EstimateTip>,
    );
    const button = screen.getByRole("button", { name: "Summarize" });
    // A tap is a tap.
    fireEvent.pointerDown(button, { pointerType: "touch" });
    fireEvent.pointerUp(button, { pointerType: "touch" });
    fireEvent.click(button);
    expect(click).toHaveBeenCalledOnce();
    expect(fake.assistEstimate).not.toHaveBeenCalled();
    // A long press shows the estimate and swallows the click that follows.
    fireEvent.pointerDown(button, { pointerType: "touch" });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 10));
    fireEvent.pointerUp(button, { pointerType: "touch" });
    fireEvent.click(button);
    expect(click).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toContain("≈ 1,300 tokens"));
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("works on a menu's items, asking for the draft only when wanted", async () => {
    const source = vi.fn(() => REQUEST);
    const pick = vi.fn();
    renderWith(
      <Menu
        items={[{ label: <EstimateLabel request={source}>Shorter</EstimateLabel>, onSelect: pick }]}
        trigger={(menu) => (
          <button type="button" onClick={menu.toggle}>
            Assistant
          </button>
        )}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Assistant" }));
    const item = screen.getByRole("menuitem", { name: "Shorter" });
    expect(source).not.toHaveBeenCalled();
    fireEvent.pointerEnter(item, { pointerType: "mouse" });
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toContain("≈ 1,300 tokens"));
    expect(source).toHaveBeenCalledOnce();
    expect(item.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
    fireEvent.click(item);
    expect(pick).toHaveBeenCalledOnce();
  });
});

describe("local models", () => {
  const ollama: LocalModelServer = {
    kind: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434",
    models: [
      { id: "llama3.2:3b", name: "llama3.2:3b" },
      { id: "qwen3:8b", name: "qwen3:8b" },
    ],
    added: false,
  };

  function settings() {
    return renderWith(
      <AssistScopeProvider scope="device">
        <ProviderSettings options={OPTIONS} />
      </AssistScopeProvider>,
    );
  }

  it("offers a running Ollama with one click and the picked model", async () => {
    local = [
      ollama,
      { ...ollama, name: "LM Studio", kind: "openaiCompatible", baseUrl: "http://127.0.0.1:1234/v1", added: true },
    ];
    settings();
    const offers = await screen.findByText("Found on this computer");
    const box = offers.closest("div")!;
    expect(within(box).queryByText("LM Studio")).toBeNull();
    fireEvent.change(within(box).getByLabelText("Model for Ollama"), { target: { value: "qwen3:8b" } });
    fireEvent.click(within(box).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(fake.createAssistProvider).toHaveBeenCalledWith("device", {
        name: "Ollama",
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3:8b",
        fastModel: "qwen3:8b",
      }),
    );
  });

  it("offers nothing when nothing runs here, and never for a server's scope", async () => {
    settings();
    await waitFor(() => expect(fake.assistLocalModels).toHaveBeenCalled());
    expect(screen.queryByText("Found on this computer")).toBeNull();
    cleanup();
    local = [ollama];
    renderWith(
      <AssistScopeProvider scope="acc">
        <ProviderSettings options={OPTIONS} />
      </AssistScopeProvider>,
    );
    await screen.findByRole("button", { name: "Add provider" });
    expect(fake.assistLocalModels).toHaveBeenCalledOnce();
  });

  it("lists the models of an address before it is saved", async () => {
    settings();
    fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "ollama" } });
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "http://127.0.0.1:11434" } });
    const pick = await screen.findAllByRole("button", { name: /Pick from the list: Model for writing/ });
    fireEvent.click(pick[0]!);
    const option = await screen.findByRole("option", { name: "qwen3:8b" });
    expect(fake.assistProbeModels).toHaveBeenCalledWith({
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: null,
    });
    fireEvent.click(option);
    expect(screen.getByLabelText<HTMLInputElement>("Model for writing").value).toBe("qwen3:8b");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(fake.createAssistProvider).toHaveBeenCalledWith(
        "device",
        expect.objectContaining({ kind: "ollama", model: "qwen3:8b" }),
      ),
    );
  });
});

const mail: Message = {
  id: "m1",
  threadId: "t1",
  accountId: "acc",
  folderId: "acc:inbox",
  from: { name: "Mia", email: "mia@example.com" },
  to: [],
  cc: [],
  replyTo: [],
  subject: "Sommerfest",
  date: new Date().toISOString(),
  flags: { seen: true, flagged: false, answered: false, draft: false },
  snippet: "",
  bodyHtml: null,
  bodyText: "Wir feiern am Freitag um 18 Uhr im Park.",
  hasRemoteContent: false,
  attachments: [],
};

describe("Find appointment", () => {
  it("is in the reader's assistant menu with its estimate, and asks for the newest mail", async () => {
    useEventSearch.setState({ asked: {} });
    renderWith(<ThreadAssistButton threadId="t1" messages={[mail]} own mine={new Set(["mini@example.org"])} />);
    fireEvent.click(await screen.findByRole("button", { name: "AI assistant" }));
    const item = await screen.findByRole("menuitem", { name: "Find appointment" });
    fireEvent.pointerEnter(item, { pointerType: "mouse" });
    await waitFor(() =>
      expect(fake.assistEstimate).toHaveBeenCalledWith(
        "acc",
        "Assist/extractEvents",
        {
          emailId: "m1",
          includeImages: false,
        },
        "EUR",
      ),
    );
    fireEvent.click(item);
    expect(useEventSearch.getState().asked).toEqual({ m1: true });
  });
});

describe("the demo's estimates", () => {
  it("counts like the server and never uses the quota", () => {
    const server = new DemoAssist(
      "en",
      () => [mail],
      () => {},
    );
    const before = server.usageReport(1).today;
    const estimate = server.estimate("Assist/extractEvents", { emailId: "m1", includeImages: false });
    expect(estimate.outputTokens).toBe(250);
    expect(estimate.totalTokens).toBe(estimate.inputTokens + 250);
    expect(estimate.tokensLeftToday).not.toBeNull();
    expect(server.usageReport(1).today).toEqual(before);
    const device = new DemoAssist(
      "en",
      () => [mail],
      () => {},
      true,
    );
    expect(device.estimate("Assist/summarize", { emailId: "m1" }).tokensLeftToday).toBeNull();
    expect(() => device.estimate("Assist/compose", { mode: "write" })).toThrow(AssistError);
  });
});
