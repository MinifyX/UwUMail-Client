import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistError } from "@/backend/backend";
import { toAssistCost, toAssistEstimate, toAssistProvider, toUsage } from "@/backend/assistConvert";
import { DemoAssist } from "@/backend/demo-assist";
import type { AssistEstimate, AssistOptions, AssistProvider, AssistUsage } from "@/backend/types";
import { i18n } from "@/i18n";
import { useSettings } from "@/state/settings";
import { assistCurrency, formatCost, mayChooseCurrency, sumCosts } from "./cost";
import { EstimateTip } from "./estimate";
import {
  emptyProviderForm,
  parsePrice,
  providerCreateInput,
  providerFormFrom,
  providerProblems,
  providerUpdateInput,
} from "./providerForm";
import { CurrencySetting } from "./settings/AssistantSettings";
import { UsageSettings } from "./settings/UsageSettings";
import { AssistScopeProvider } from "./useAssist";
import { dailyTotals, featureTotals } from "./usage";

const OPTIONS: AssistOptions = {
  features: { compose: true, summarize: true, spamCheck: true, extractEvents: true, autoLabels: true },
  mayAddProviders: true,
  mayUsePrivateAddresses: true,
  maxProviders: 5,
  maxLabels: 30,
  maxInstructionChars: 2000,
  maxTextChars: 20000,
  maxLabelConditions: 10,
  foreignMail: false,
  foreignServers: [],
};

const ESTIMATE: AssistEstimate = {
  method: "Assist/spamCheck",
  inputTokens: 1100,
  outputTokens: 134,
  totalTokens: 1234,
  providerId: "q1",
  providerName: "Mistral (Server)",
  model: "mistral-small-latest",
  tokensLeftToday: 48000,
  requestsLeftToday: null,
  cost: { amount: 0.0213, currency: "EUR", usd: 0.0248, max: null, parts: null },
  reasoningTokens: 0,
  imageCount: 0,
  calls: [],
  calibrated: false,
};

const today = new Date().toISOString().slice(0, 10);
const USAGE: AssistUsage = {
  days: [
    {
      day: today,
      providerId: "q1",
      providerName: "Mistral (Server)",
      feature: "summarize",
      requests: 3,
      inputTokens: 3000,
      outputTokens: 300,
      reasoningTokens: 0,
      cost: { amount: 1.5, currency: "EUR", usd: 1.74 },
    },
    {
      day: today,
      providerId: "q2",
      providerName: "Own",
      feature: "compose",
      requests: 1,
      inputTokens: 100,
      outputTokens: 100,
      reasoningTokens: 0,
      // An older row, from before prices.
      cost: null,
    },
  ],
  today: [
    {
      providerId: "q1",
      providerName: "Mistral (Server)",
      requests: 3,
      tokens: 3300,
      requestsPerDay: null,
      tokensPerDay: null,
      cost: { amount: 1.5, currency: "EUR", usd: 1.74 },
    },
  ],
};

const fake = {
  assistScopes: vi.fn(async () => [
    { id: "device", kind: "device", accountId: null, accountIds: ["acc"], options: OPTIONS },
  ]),
  assistEstimate: vi.fn(async (): Promise<AssistEstimate | null> => ESTIMATE),
  assistUsage: vi.fn(async () => USAGE),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function renderWith(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AssistScopeProvider scope="device">{node}</AssistScopeProvider>
    </QueryClientProvider>,
  );
}

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, { ...options, ns: "neutral" });
/** Intl's non-breaking spaces as plain ones. */
const plain = (text: string | null) => (text ?? "").replace(/[\u00a0\u202f]/g, " ");

beforeAll(() => useSettings.getState().update({ tone: "neutral" }));
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  useSettings.getState().update({ assistCurrency: "EUR" });
});
afterEach(() => cleanup());

describe("the currency", () => {
  it("follows the language: yen, yuan, and in English euros or dollars as chosen", () => {
    expect(assistCurrency("ja", "USD")).toBe("JPY");
    expect(assistCurrency("zh-CN", "EUR")).toBe("CNY");
    expect(assistCurrency("de", "USD")).toBe("EUR");
    expect(assistCurrency("en-GB", "USD")).toBe("USD");
    expect(assistCurrency("en", "EUR")).toBe("EUR");
    expect(assistCurrency("en", "GBP" as never)).toBe("EUR");
    expect(assistCurrency("en", undefined)).toBe("EUR");
    expect(mayChooseCurrency("en-US")).toBe(true);
    expect(mayChooseCurrency("de")).toBe(false);
  });
});

describe("formatCost", () => {
  it("writes small amounts with enough digits and tiny ones as below a floor", () => {
    expect(formatCost({ amount: 0.0213, currency: "EUR" }, "en", t, true)).toBe("≈ €0.021");
    expect(plain(formatCost({ amount: 0.0023, currency: "EUR" }, "de", t))).toBe("0,0023 €");
    expect(formatCost({ amount: 0.00001, currency: "USD" }, "en", t)).toBe("< $0.0001");
    expect(formatCost({ amount: 12.345, currency: "USD" }, "en", t)).toBe("$12.35");
    expect(formatCost({ amount: 3.4, currency: "JPY" }, "ja", t)).toBe("￥3");
    expect(formatCost({ amount: 0, currency: "EUR" }, "en", t)).toBe("free");
  });

  it("adds up what has a cost; null when nothing had one", () => {
    expect(sumCosts([null, undefined])).toBeNull();
    expect(
      sumCosts([{ amount: 1, currency: "EUR", usd: 1.2 }, null, { amount: 0.5, currency: "EUR", usd: null }]),
    ).toEqual({ amount: 1.5, currency: "EUR", usd: null });
    const days = dailyTotals(USAGE, 1);
    expect(days[0]!.cost?.amount).toBe(1.5);
    expect(featureTotals(USAGE).find((total) => total.feature === "compose")!.cost).toBeNull();
  });
});

describe("costs from the backend", () => {
  it("takes what is well-formed and tolerates servers without costs", () => {
    expect(toAssistCost({ amount: 0.02, currency: "EUR", usd: 0.023 })).toEqual({
      amount: 0.02,
      currency: "EUR",
      usd: 0.023,
    });
    expect(toAssistCost({ amount: -1, currency: "EUR" })).toBeNull();
    expect(toAssistCost({ amount: 1, currency: "euro" })).toBeNull();
    expect(toAssistCost(undefined)).toBeNull();
    const estimate = toAssistEstimate({ inputTokens: 10, outputTokens: 5 }, "Assist/spamCheck");
    expect(estimate?.cost).toBeNull();
    const usage = toUsage({
      days: [{ day: today, feature: "compose", cost: { amount: 1, currency: "USD", usd: 1 } }],
      today: [{ providerId: "q1" }],
    });
    expect(usage.days[0]!.cost).toEqual({ amount: 1, currency: "USD", usd: 1 });
    expect(usage.today[0]!.cost).toBeNull();
    const provider = toAssistProvider({
      id: "d1",
      kind: "openai",
      inputPricePerMillion: 1.5,
      outputPricePerMillion: "much",
      price: { inputPerMillion: 1.5, outputPerMillion: 2, source: "manual" },
    });
    expect([provider.inputPricePerMillion, provider.outputPricePerMillion]).toEqual([1.5, null]);
    expect(provider.price?.source).toBe("manual");
    expect(toAssistProvider({ id: "d2", price: { inputPerMillion: 1, source: "auto" } }).price).toBeNull();
  });
});

describe("costs in the UI", () => {
  it("puts the cost into the tooltip, asked in the person's currency", async () => {
    useSettings.getState().update({ assistCurrency: "USD" });
    renderWith(
      <EstimateTip request={{ accountId: "acc", method: "Assist/spamCheck", args: { emailId: "e1" } }}>
        <button type="button">Check</button>
      </EstimateTip>,
    );
    fireEvent.pointerEnter(screen.getByRole("button").parentElement!, { pointerType: "mouse" });
    expect((await screen.findByRole("tooltip")).textContent).toBe("≈ 1,200 tokens · ≈ €0.021 · 48,000 left today");
    expect(fake.assistEstimate).toHaveBeenCalledWith("acc", "Assist/spamCheck", { emailId: "e1" }, "USD");
  });

  it("leaves the cost out where the server gives none", async () => {
    fake.assistEstimate.mockResolvedValueOnce({ ...ESTIMATE, cost: null });
    renderWith(
      <EstimateTip request={{ accountId: "acc", method: "Assist/spamCheck", args: { emailId: "e2" } }}>
        <button type="button">Check</button>
      </EstimateTip>,
    );
    fireEvent.pointerEnter(screen.getByRole("button").parentElement!, { pointerType: "mouse" });
    expect((await screen.findByRole("tooltip")).textContent).toBe("≈ 1,200 tokens · 48,000 left today");
  });

  it("shows what was spent today, per feature and over the month", async () => {
    renderWith(<UsageSettings />);
    expect(await screen.findByText(/1 request · 200 tokens$/)).toBeTruthy();
    // Today's provider and the summaries' feature row.
    expect(screen.getAllByText(/3 requests · 3.3K tokens · €1.50$/)).toHaveLength(2);
    // The month: what had no price adds nothing.
    expect(screen.getByText(/4 requests · 3.5K tokens · €1.50$/)).toBeTruthy();
    expect(fake.assistUsage).toHaveBeenCalledWith("device", 30, "EUR");
  });

  it("offers the currency only in English", async () => {
    const { unmount } = renderWith(<CurrencySetting />);
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    expect(useSettings.getState().assistCurrency).toBe("USD");
    unmount();
    await i18n.changeLanguage("de");
    renderWith(<CurrencySetting />);
    expect(screen.queryByLabelText("Währung")).toBeNull();
  });
});

describe("prices in the provider form", () => {
  const provider: AssistProvider = {
    id: "q9",
    name: "Mine",
    kind: "openai",
    scope: "personal",
    baseUrl: null,
    hasKey: true,
    keyHint: "…1234",
    model: null,
    fastModel: null,
    features: [],
    quota: null,
    experimental: false,
    connected: true,
    inputPricePerMillion: 0.4,
    outputPricePerMillion: null,
    price: { inputPerMillion: 0.4, outputPerMillion: 1.6, source: "manual" },
  };

  it("reads either decimal mark and sends only a changed price", () => {
    expect(parsePrice("0,40")).toBe(0.4);
    expect(parsePrice(" ")).toBeNull();
    expect(parsePrice("1e3")).toBeNaN();
    const form = providerFormFrom(provider);
    expect(form.inputPrice).toBe("0.4");
    expect(providerUpdateInput(provider, form)).toEqual({});
    expect(providerUpdateInput(provider, { ...form, inputPrice: "", outputPrice: "3" })).toEqual({
      inputPricePerMillion: null,
      outputPricePerMillion: 3,
    });
  });

  it("checks prices, and free kinds have none", () => {
    const form = { ...emptyProviderForm("openai"), apiKey: "sk-x", inputPrice: "-1", outputPrice: "20000" };
    expect(providerProblems(form, null)).toEqual({ inputPrice: "priceInvalid", outputPrice: "priceInvalid" });
    expect(providerCreateInput({ ...form, inputPrice: "0,5", outputPrice: "" })).toMatchObject({
      inputPricePerMillion: 0.5,
    });
    const ollama = { ...emptyProviderForm("ollama"), baseUrl: "http://127.0.0.1:11434", inputPrice: "x" };
    expect(providerProblems(ollama, null)).toEqual({});
    expect(providerCreateInput(ollama)).not.toHaveProperty("inputPricePerMillion");
  });
});

describe("the demo's prices", () => {
  it("prices own providers, keeps local ones free and costs in the currency asked", () => {
    const device = new DemoAssist(
      "en",
      () => [],
      () => {},
      true,
    );
    expect(device.listProviders()[0]!.price?.source).toBe("free");
    const openai = device.createProvider({ name: "OpenAI", kind: "openai", apiKey: "sk-demo", model: "gpt-5-mini" });
    expect(openai.price).toEqual({ inputPerMillion: 0.25, outputPerMillion: 2, source: "auto" });
    expect(() => device.updateProvider(openai.id, { inputPricePerMillion: -1 })).toThrow(AssistError);
    device.updateProvider(openai.id, { inputPricePerMillion: 1 });
    expect(device.listProviders().find((entry) => entry.id === openai.id)!.price?.source).toBe("manual");
    const free = device.estimate("Assist/compose", { mode: "write", instruction: "Say yes" }, "JPY");
    expect(free.cost).toMatchObject({ amount: 0, currency: "JPY", usd: 0, max: { amount: 0 } });
    const report = device.usageReport(30, "USD");
    expect(report.days.every((day) => day.cost === null || day.cost.currency === "USD")).toBe(true);
  });
});
