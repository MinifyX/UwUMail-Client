import { describe, expect, it } from "vitest";
import type { AssistLabel, AssistLabelLogEntry, AssistProvider, AssistUsage } from "@/backend/types";
import {
  labelPatch,
  labelProblems,
  labelsOff,
  labelsOn,
  missingStarters,
  setByAssistant,
  STARTER_LABELS,
  threadKeywords,
} from "./labels";
import {
  emptyProviderForm,
  insecureUrl,
  isPrivateHost,
  nextChoice,
  providerCreateInput,
  providerFormFrom,
  providerProblems,
  providersFor,
  providerUpdateInput,
} from "./providerForm";
import { authTone, percent, scoreShare, summaryParts } from "./readerState";
import { dailyTotals, featureTotals, todayShare } from "./usage";

const label = (id: string, name: string, keyword: string, color: string | null = null): AssistLabel => ({
  id,
  name,
  keyword,
  description: "",
  color,
});

const LABELS = [
  label("g1", "Rechnungen", "rechnungen", "#f59e0b"),
  label("g2", "Newsletter", "newsletter"),
  label("g3", "Reisen", "reisen"),
];

const entry = (patch: Partial<AssistLabelLogEntry>): AssistLabelLogEntry => ({
  id: "l1",
  emailId: "e1",
  labelId: "g1",
  name: "Rechnungen",
  keyword: "rechnungen",
  reason: "An invoice.",
  createdAt: "2026-09-28T10:00:00Z",
  undone: false,
  providerName: null,
  model: null,
  ...patch,
});

describe("labels on mail", () => {
  it("are the keywords that are labels, in the person's order", () => {
    expect(labelsOn(["reisen", "$seen", "other", "Rechnungen"], LABELS).map((l) => l.id)).toEqual(["g1", "g3"]);
    expect(labelsOn(undefined, LABELS)).toEqual([]);
    expect(labelsOff(["reisen"], LABELS).map((l) => l.id)).toEqual(["g1", "g2"]);
  });

  it("of a conversation are those of all its mails", () => {
    expect(threadKeywords([{ keywords: ["b", "a"] }, {}, { keywords: ["a", "c"] }])).toEqual(["a", "b", "c"]);
  });

  it("say why the assistant set them: the newest entry that isn't undone", () => {
    const log = [
      entry({ id: "l1", createdAt: "2026-09-27T10:00:00Z", reason: "old" }),
      entry({ id: "l2", createdAt: "2026-09-28T10:00:00Z", reason: "new" }),
      entry({ id: "l3", createdAt: "2026-09-29T10:00:00Z", undone: true }),
      entry({ id: "l4", emailId: "e2" }),
    ];
    expect(setByAssistant(log, "e1", "rechnungen")?.id).toBe("l2");
    expect(setByAssistant(log, "e1", "reisen")).toBeNull();
    expect(setByAssistant([entry({ undone: true })], "e1", "rechnungen")).toBeNull();
  });
});

describe("the starter labels", () => {
  const text = (id: string) => ({ name: `${id[0]!.toUpperCase()}${id.slice(1)}`, description: `About ${id}` });

  it("are six, each with a colour", () => {
    expect(STARTER_LABELS.map((starter) => starter.id)).toEqual([
      "invoices",
      "newsletters",
      "orders",
      "travel",
      "appointments",
      "personal",
    ]);
    expect(missingStarters([], text).every((input) => /^#[0-9a-f]{6}$/.test(input.color ?? ""))).toBe(true);
  });

  it("leave out what is there already, ignoring case", () => {
    const names = missingStarters([label("g9", " TRAVEL ", "travel"), label("g8", "invoices", "invoices")], text).map(
      (input) => input.name,
    );
    expect(names).toEqual(["Newsletters", "Orders", "Appointments", "Personal"]);
  });
});

describe("the label form", () => {
  it("needs a name that is short enough and not taken", () => {
    expect(labelProblems({ name: " ", description: "", color: null }, LABELS)).toEqual({ name: "nameMissing" });
    expect(labelProblems({ name: "x".repeat(41), description: "", color: null }, LABELS)).toEqual({
      name: "nameTooLong",
    });
    // Counted in characters, not bytes: 40 umlauts fit.
    expect(labelProblems({ name: "ä".repeat(40), description: "", color: null }, LABELS)).toEqual({});
    expect(labelProblems({ name: "newsletter", description: "", color: null }, LABELS)).toEqual({
      name: "nameTaken",
    });
    // Its own name is no clash.
    expect(labelProblems({ name: "Newsletter", description: "", color: null }, LABELS, "g2")).toEqual({});
    expect(labelProblems({ name: "a\nb", description: "", color: null }, LABELS)).toEqual({ name: "control" });
    expect(labelProblems({ name: "Ok", description: "y".repeat(301), color: null }, LABELS)).toEqual({
      description: "descriptionTooLong",
    });
  });

  it("sends only what changed", () => {
    expect(labelPatch(LABELS[0]!, { name: "Rechnungen", description: " Bills ", color: "#f59e0b" })).toEqual({
      description: "Bills",
    });
    expect(labelPatch(LABELS[0]!, { name: "Bills", description: "", color: null })).toEqual({
      name: "Bills",
      color: null,
    });
  });
});

const provider = (patch: Partial<AssistProvider>): AssistProvider => ({
  id: "q7",
  name: "Mine",
  kind: "openai",
  scope: "personal",
  baseUrl: null,
  hasKey: true,
  keyHint: "…a1b2",
  model: "gpt-5-mini",
  fastModel: null,
  features: ["compose", "summarize"],
  quota: null,
  experimental: false,
  connected: true,
  ...patch,
});

describe("the provider form", () => {
  it("needs a key for kinds that need one, but keeps a stored one", () => {
    const form = { ...emptyProviderForm("openai") };
    expect(form.name).toBe("OpenAI");
    expect(providerProblems(form, null)).toEqual({ apiKey: "keyMissing" });
    expect(providerProblems({ ...form, apiKey: "sk-1" }, null)).toEqual({});
    expect(providerProblems(form, { hasKey: true })).toEqual({});
    expect(providerProblems({ ...form, removeKey: true }, { hasKey: true })).toEqual({ apiKey: "keyMissing" });
    expect(providerProblems(emptyProviderForm("chatgpt"), null)).toEqual({});
  });

  it("checks the address of Ollama and OpenAI-compatible servers", () => {
    const form = emptyProviderForm("ollama");
    expect(providerProblems(form, null)).toEqual({ baseUrl: "urlMissing" });
    expect(providerProblems({ ...form, baseUrl: "ftp://192.0.2.10" }, null)).toEqual({ baseUrl: "urlScheme" });
    expect(providerProblems({ ...form, baseUrl: "not a url" }, null)).toEqual({ baseUrl: "urlScheme" });
    expect(providerProblems({ ...form, baseUrl: "https://me:pw@llm.example.com" }, null)).toEqual({
      baseUrl: "urlLogin",
    });
    expect(providerProblems({ ...form, baseUrl: "http://192.168.1.5:11434" }, null)).toEqual({});
    expect(providerProblems({ ...form, name: "" }, null).name).toBe("nameMissing");
    expect(providerProblems({ ...form, name: "n".repeat(61) }, null).name).toBe("nameTooLong");
  });

  it("warns about keys over plain http outside the local network", () => {
    const form = emptyProviderForm("openaiCompatible");
    expect(insecureUrl({ ...form, baseUrl: "http://llm.example.com/v1" })).toBe(true);
    expect(insecureUrl({ ...form, baseUrl: "https://llm.example.com/v1" })).toBe(false);
    expect(insecureUrl({ ...form, baseUrl: "http://10.0.0.2:8080" })).toBe(false);
    expect(insecureUrl({ ...emptyProviderForm("openai"), baseUrl: "http://llm.example.com" })).toBe(false);
    expect(["localhost", "ollama.local", "172.20.1.1", "[::1]", "fd00:1::2"].every(isPrivateHost)).toBe(true);
    expect(["192.0.2.10", "172.32.0.1", "llm.example.com", "2001:db8::1"].some(isPrivateHost)).toBe(false);
  });

  it("creates with only what applies to the kind", () => {
    expect(
      providerCreateInput({
        ...emptyProviderForm("openai"),
        apiKey: " sk-1 ",
        baseUrl: "https://x.example",
        model: " ",
      }),
    ).toEqual({ name: "OpenAI", kind: "openai", apiKey: "sk-1" });
    expect(
      providerCreateInput({ ...emptyProviderForm("ollama"), baseUrl: "http://192.168.1.5:11434", apiKey: "nope" }),
    ).toEqual({ name: "Ollama", kind: "ollama", baseUrl: "http://192.168.1.5:11434" });
  });

  it("updates only what changed; the key only when typed or removed", () => {
    const stored = provider({});
    const form = providerFormFrom(stored);
    expect(form.apiKey).toBe("");
    expect(providerUpdateInput(stored, form)).toEqual({});
    expect(providerUpdateInput(stored, { ...form, apiKey: "sk-new", model: "", fastModel: "gpt-5-nano" })).toEqual({
      apiKey: "sk-new",
      model: null,
      fastModel: "gpt-5-nano",
    });
    const compatible = provider({ kind: "openaiCompatible", baseUrl: "https://llm.example.com/v1" });
    expect(providerUpdateInput(compatible, { ...providerFormFrom(compatible), removeKey: true })).toEqual({
      apiKey: "",
    });
  });

  it("offers only ready providers allowed for a feature", () => {
    const list = [
      provider({ id: "a" }),
      provider({ id: "b", connected: false }),
      provider({ id: "c", features: ["autoLabels"] }),
    ];
    expect(providersFor(list, "compose").map((p) => p.id)).toEqual(["a"]);
    expect(providersFor(list, null).map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("keeps a model only with its provider", () => {
    expect(nextChoice(null, { providerId: "" })).toBeNull();
    expect(nextChoice(null, { providerId: "q1" })).toEqual({ providerId: "q1", model: null });
    expect(nextChoice({ providerId: "q1", model: "big" }, { providerId: "q2" })).toEqual({
      providerId: "q2",
      model: null,
    });
    expect(nextChoice({ providerId: "q1", model: "big" }, { providerId: "q1" })).toEqual({
      providerId: "q1",
      model: "big",
    });
    expect(nextChoice({ providerId: "q1", model: "big" }, { model: " " })).toEqual({ providerId: "q1", model: null });
  });
});

describe("the reader's cards", () => {
  it("split a summary into sentences and points", () => {
    expect(
      summaryParts("Leni asks about lunch.\nShe proposes Friday.\n\n- Friday 12:00\n* Café\n  more on that\n"),
    ).toEqual({
      lead: ["Leni asks about lunch.", "She proposes Friday."],
      points: ["Friday 12:00", "Café", "more on that"],
    });
  });

  it("read the server's signals", () => {
    expect([authTone("pass"), authTone("FAIL"), authTone("softfail"), authTone("none"), authTone(null)]).toEqual([
      "good",
      "bad",
      "bad",
      "neutral",
      "neutral",
    ]);
    expect(scoreShare(4.2, 5)).toBeCloseTo(0.84);
    expect(scoreShare(9, 5)).toBe(1);
    expect(scoreShare(null, 5)).toBeNull();
    expect(scoreShare(1, 0)).toBeNull();
    expect([percent(0.856), percent(2), percent(-1)]).toEqual([86, 100, 0]);
  });
});

describe("the usage", () => {
  const usage: AssistUsage = {
    days: [
      {
        day: "2026-09-29",
        providerId: "q1",
        providerName: "M",
        feature: "summarize",
        requests: 3,
        inputTokens: 100,
        outputTokens: 20,
      },
      {
        day: "2026-09-29",
        providerId: "q2",
        providerName: "N",
        feature: "compose",
        requests: 1,
        inputTokens: 50,
        outputTokens: 50,
      },
      {
        day: "2026-09-27",
        providerId: "q1",
        providerName: "M",
        feature: "summarize",
        requests: 2,
        inputTokens: 10,
        outputTokens: 10,
      },
      {
        day: "2026-08-01",
        providerId: "q1",
        providerName: "M",
        feature: "spamCheck",
        requests: 9,
        inputTokens: 1,
        outputTokens: 1,
      },
    ],
    today: [],
  };

  it("fills every day of the window, oldest first", () => {
    const days = dailyTotals(usage, 3, new Date("2026-09-29T22:00:00Z"));
    expect(days).toEqual([
      { day: "2026-09-27", requests: 2, tokens: 20 },
      { day: "2026-09-28", requests: 0, tokens: 0 },
      { day: "2026-09-29", requests: 4, tokens: 220 },
    ]);
  });

  it("sums per feature, most used first", () => {
    expect(featureTotals(usage).map((total) => [total.feature, total.requests])).toEqual([
      ["spamCheck", 9],
      ["summarize", 5],
      ["compose", 1],
    ]);
  });

  it("measures today against the limit that runs out first", () => {
    const base = { providerId: "q1", providerName: "M", requests: 50, tokens: 90_000 };
    expect(todayShare({ ...base, requestsPerDay: 200, tokensPerDay: 100_000 })).toEqual({
      requests: 0.25,
      tokens: 0.9,
      max: 0.9,
    });
    expect(todayShare({ ...base, requestsPerDay: null, tokensPerDay: null }).max).toBeNull();
    expect(todayShare({ ...base, requestsPerDay: 10, tokensPerDay: null }).max).toBe(1);
  });
});
