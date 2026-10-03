import { describe, expect, it } from "vitest";
import {
  LABEL_BASES,
  type AssistLabel,
  type AssistLabelLogEntry,
  type AssistProvider,
  type AssistUsage,
} from "@/backend/types";
import {
  labelPatch,
  labelProblems,
  labelsOff,
  labelsOn,
  missingBases,
  overlapLines,
  setByAssistant,
  threadKeywords,
  usableProposals,
  LABEL_DEFAULTS,
  labelReason,
} from "./labels";
import { translate } from "@/i18n";
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
  ...LABEL_DEFAULTS,
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
  source: "ai",
  reason: "An invoice.",
  code: "ai",
  params: {},
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

  it("refuses names that turn the text around them", () => {
    expect(labelProblems({ name: "abc\u202Efdp.exe", description: "", color: null }, LABELS)).toEqual({
      name: "control",
    });
    expect(labelProblems({ name: "a\u0085b", description: "", color: null }, LABELS)).toEqual({ name: "control" });
    // Emoji sequences stay fine.
    expect(labelProblems({ name: "Familie 👨\u200D👩\u200D👧", description: "", color: null }, LABELS)).toEqual({});
  });

  it("offers only new labels a model proposed that could be saved as they are", () => {
    const proposal = (name: string, description = "") => ({ name, description, color: null, reason: "" });
    const offered = usableProposals([
      proposal("Strom"),
      proposal("x".repeat(41)),
      proposal("Bank\nKonto"),
      proposal("\u202Etxt"),
      proposal("Ok", "y".repeat(301)),
    ]);
    expect(offered.map((each) => each.name)).toEqual(["Strom"]);
  });

  it("sends only what changed", () => {
    expect(labelPatch(LABELS[0]!, { name: "Rechnungen", description: " Bills ", color: "#f59e0b" })).toEqual({
      description: "Bills",
    });
    expect(labelPatch(LABELS[0]!, { name: "Bills", description: "", color: null })).toEqual({
      name: "Bills",
      color: null,
    });
    expect(labelPatch(LABELS[0]!, { name: "Rechnungen", description: "", color: "#f59e0b", auto: false })).toEqual({
      auto: false,
    });
  });

  it("never sends or checks a base label's fixed definition", () => {
    const base = { ...label("g7", "Rechnung", "rechnung"), base: "invoice" as const, description: "d".repeat(400) };
    expect(labelProblems({ name: "Rechnung", description: base.description, color: null }, [base], "g7")).toEqual({});
    expect(labelPatch(base, { name: "Belege", description: "changed", color: null })).toEqual({ name: "Belege" });
  });
});

describe("base labels and overlaps", () => {
  const t = (key: string, options?: Record<string, unknown>) => `${key}${options ? JSON.stringify(options) : ""}`;

  it("knows which base labels were deleted, and none on an older server", () => {
    const base = (which: AssistLabel["base"]) => ({ base: which });
    expect(missingBases([base("invoice"), base(null), base("work")], LABEL_BASES)).toEqual([
      "shipping",
      "appointment",
      "newsletter",
      "account",
      "personal",
      "advertising",
    ]);
    expect(missingBases(LABEL_BASES.map(base), LABEL_BASES)).toEqual([]);
    expect(missingBases([base(null)], LABEL_BASES)).toEqual([]);
    expect(missingBases([], LABEL_BASES)).toEqual([]);
  });

  it("offers every base label again when all were deleted in a scope that announces them", () => {
    expect(missingBases([], LABEL_BASES, LABEL_BASES)).toEqual([...LABEL_BASES]);
    expect(missingBases([{ base: null }], LABEL_BASES, ["invoice", "work"])).toEqual(["invoice", "work"]);
  });

  it("explains each overlap once, by its kind", () => {
    expect(
      overlapLines(
        [
          { id: "g1", name: "Rechnung", base: "invoice", kind: "name", words: [] },
          { id: "g1", name: "Rechnung", base: "invoice", kind: "meaning", words: [] },
          { id: "g2", name: "Werbung", base: "advertising", kind: "meaning", words: [] },
          { id: "g3", name: "Handy", base: null, kind: "words", words: ["mobilfunk", "vertrag"] },
          { id: "g4", name: "Leer", base: null, kind: "words", words: [] },
        ],
        t,
      ),
    ).toEqual([
      'labels.overlap.name{"name":"Rechnung"}',
      'labels.overlap.meaning{"name":"Werbung"}',
      'labels.overlap.words{"name":"Handy","words":"mobilfunk, vertrag"}',
      'labels.overlap.words{"name":"Leer","words":"…"}',
    ]);
    expect(overlapLines([], t)).toEqual([]);
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
  inputPricePerMillion: null,
  outputPricePerMillion: null,
  price: null,
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
        reasoningTokens: 0,
        cost: null,
      },
      {
        day: "2026-09-29",
        providerId: "q2",
        providerName: "N",
        feature: "compose",
        requests: 1,
        inputTokens: 50,
        outputTokens: 50,
        reasoningTokens: 0,
        cost: null,
      },
      {
        day: "2026-09-27",
        providerId: "q1",
        providerName: "M",
        feature: "summarize",
        requests: 2,
        inputTokens: 10,
        outputTokens: 10,
        reasoningTokens: 0,
        cost: null,
      },
      {
        day: "2026-08-01",
        providerId: "q1",
        providerName: "M",
        feature: "spamCheck",
        requests: 9,
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        cost: null,
      },
    ],
    today: [],
  };

  it("fills every day of the window, oldest first", () => {
    const days = dailyTotals(usage, 3, new Date("2026-09-29T22:00:00Z"));
    expect(days).toEqual([
      { day: "2026-09-27", requests: 2, tokens: 20, cost: null },
      { day: "2026-09-28", requests: 0, tokens: 0, cost: null },
      { day: "2026-09-29", requests: 4, tokens: 220, cost: null },
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
    const base = { providerId: "q1", providerName: "M", requests: 50, tokens: 90_000, cost: null };
    expect(todayShare({ ...base, requestsPerDay: 200, tokensPerDay: 100_000 })).toEqual({
      requests: 0.25,
      tokens: 0.9,
      max: 0.9,
    });
    expect(todayShare({ ...base, requestsPerDay: null, tokensPerDay: null }).max).toBeNull();
    expect(todayShare({ ...base, requestsPerDay: 10, tokensPerDay: null }).max).toBe(1);
  });
});

describe("labelReason", () => {
  const t = (key: string, options?: Record<string, unknown>) => translate(key, { ...options, lng: "en" });
  const reason = (code: string, params: Record<string, unknown>) =>
    labelReason({ code, params, reason: "Fallback." }, t);

  it("says why in the person's words", () => {
    expect(
      reason("rule", {
        match: "any",
        conditions: [
          { field: "subject", value: "Rechnung" },
          { field: "hasAttachment", value: "true" },
        ],
      }),
    ).toBe("Matches the label's conditions: subject contains “Rechnung” or has an attachment");
    expect(reason("sender", { address: "leni@example.org", count: 3 })).toBe(
      "leni@example.org got this label by hand 3 times",
    );
    expect(reason("invoice", { word: "Rechnung", amount: "49,90 €" })).toBe(
      "Looks like an invoice: “Rechnung” in the subject, 49,90 €",
    );
    expect(reason("shipping", { carrier: "DHL", tracking: null })).toBe("Looks like a shipment: DHL");
    expect(reason("classifier", { probability: 0.9946, examples: 23 })).toBe(
      "Similar to the 23 mails with this label (99.4 % sure)",
    );
  });

  it("puts the new detectors and similar mails in the person's words", () => {
    expect(reason("invoice", { number: "RE-4711", amount: "39,99 €" })).toBe(
      "Looks like an invoice: invoice number RE-4711, 39,99 €",
    );
    expect(reason("account", { word: "Passwort", code: false })).toBe("About your account: “Passwort”");
    expect(reason("account", { word: null, code: true })).toBe("About your account: a one-time code");
    expect(reason("account", { word: null, code: false })).toBe("Fallback.");
    expect(reason("personal", { known: true, freemail: false })).toBe("Looks personal: written by a person you know");
    expect(reason("personal", { known: false, freemail: true })).toBe(
      "Looks personal: written by a person from a private address",
    );
    expect(reason("personal", {})).toBe("Fallback.");
    expect(reason("work", { colleague: true, known: false })).toBe(
      "Looks like work: written by a colleague from your own domain",
    );
    expect(reason("work", { colleague: false, known: true })).toBe(
      "Looks like work: written by a business contact you know",
    );
    expect(reason("work", { colleague: false, known: false })).toBe("Fallback.");
    expect(reason("advertising", { words: ["sale", "-20 %", 3] })).toBe("Looks like advertising: sale, -20 %");
    expect(reason("advertising", { words: [] })).toBe("Fallback.");
    expect(reason("similar", { neighbours: 4, similarity: 0.874 })).toBe(
      "Like 4 of your mails with this label (87 % alike)",
    );
    expect(reason("similar", { neighbours: 4 })).toBe("Fallback.");
  });

  it("falls back to the entry's own sentence", () => {
    expect(reason("ai", {})).toBe("Fallback.");
    expect(reason("somethingNew", { x: 1 })).toBe("Fallback.");
    expect(reason("invoice", {})).toBe("Fallback.");
  });
});
