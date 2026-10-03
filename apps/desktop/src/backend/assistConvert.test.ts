import { describe, expect, it } from "vitest";
import { AssistError } from "./backend";
import {
  labelUpdate,
  toLabelSuggestion,
  assistSettingsUpdate,
  MAX_ASSIST_EVENTS,
  toAssistFeaturesOrNull,
  toAssistLabels,
  toAssistScopes,
  toEvents,
  toSpamCheck,
} from "./assistConvert";
import { engineError } from "./tauri";
import { LABEL_DEFAULTS } from "@/features/assist/labels";

describe("the assistant's answers from the engine", () => {
  it("reads the scopes, a server's and this device's", () => {
    const scopes = toAssistScopes([
      { id: "acc-1", kind: "server", accountId: "acc-1", accountIds: ["acc-1"], options: { maxLabels: 30 } },
      { id: "device", kind: "device", accountIds: ["acc-2", 7], options: {} },
      { kind: "server" },
    ]);
    expect(scopes.map((scope) => [scope.id, scope.kind, scope.accountId, scope.accountIds])).toEqual([
      ["acc-1", "server", "acc-1", ["acc-1"]],
      ["device", "device", null, ["acc-2"]],
    ]);
    expect(scopes[0]!.options.maxLabels).toBe(30);
  });

  it("keeps null features as null, so everything stays hidden", () => {
    expect(toAssistFeaturesOrNull(null)).toBeNull();
    expect(toAssistFeaturesOrNull({ compose: true, summarize: "yes" })).toMatchObject({
      compose: true,
      summarize: false,
    });
  });

  it("sends settings as a patch per feature", () => {
    expect(
      assistSettingsUpdate({
        default: { providerId: "p1", model: null },
        features: { spamCheck: null, compose: undefined },
        autoLabels: true,
      }),
    ).toEqual({ default: { providerId: "p1", model: null }, "features/spamCheck": null, autoLabels: true });
  });

  it("keeps labels' colours only as hex and their keywords in lower case", () => {
    expect(
      toAssistLabels([
        { id: "l1", name: "Travel", keyword: "Travel", color: "#AABBCC" },
        { id: "l2", name: "Bad", keyword: "bad", color: "red;background:url(x)" },
        { name: "No id" },
      ]),
    ).toEqual([
      { ...LABEL_DEFAULTS, id: "l1", name: "Travel", description: "", keyword: "travel", color: "#aabbcc" },
      { ...LABEL_DEFAULTS, id: "l2", name: "Bad", description: "", keyword: "bad", color: null },
    ]);
  });

  it("reads a label's rules and detector, and leaves out what it doesn't know", () => {
    const [label] = toAssistLabels([
      {
        id: "g1",
        name: "Rechnungen",
        keyword: "rechnungen",
        rules: {
          match: "any",
          conditions: [
            { field: "from", value: "@stadtwerke.example" },
            { field: "hasAttachment", value: true },
            { field: "size", value: "10" },
          ],
        },
        detector: "invoice",
        learnSenders: false,
        totalEmails: 12,
        unreadEmails: 3,
        examples: 17,
      },
    ]);
    expect(label).toMatchObject({
      rules: {
        match: "any",
        conditions: [
          { field: "from", value: "@stadtwerke.example" },
          { field: "hasAttachment", value: "true" },
        ],
      },
      detector: "invoice",
      learnSenders: false,
      classifier: true,
      totalEmails: 12,
      unreadEmails: 3,
      examples: 17,
    });
    expect(toAssistLabels([{ id: "g2", rules: { conditions: [] }, detector: "spam" }])[0]).toMatchObject({
      rules: null,
      detector: null,
    });
  });

  it("sends rules trimmed, and none without conditions", () => {
    expect(
      labelUpdate({
        rules: {
          match: "all",
          conditions: [
            { field: "subject", value: "  Rechnung " },
            { field: "text", value: " " },
          ],
        },
      }),
    ).toEqual({ rules: { match: "all", conditions: [{ field: "subject", value: "Rechnung" }] } });
    expect(labelUpdate({ rules: { match: "any", conditions: [] }, detector: null })).toEqual({
      rules: null,
      detector: null,
    });
  });

  it("keeps only well-formed verdicts and at most two new labels", () => {
    const suggestion = toLabelSuggestion(
      {
        verdicts: [
          { labelId: "g1", name: "Rechnungen", reason: "Eine Rechnung.", fits: true, isSet: false },
          { labelId: "g2", reason: "?", fits: "yes" },
        ],
        newLabels: [
          { name: "Strom", description: "Stromanbieter", color: "#AABBCC", reason: "Neu." },
          { name: "", description: "leer" },
          { name: "Zwei", color: "red" },
          { name: "Drei" },
        ],
        providerId: "q1",
        providerName: "Mistral",
        model: "m",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      "e1",
    );
    expect(suggestion.verdicts).toEqual([
      { labelId: "g1", name: "Rechnungen", reason: "Eine Rechnung.", fits: true, isSet: false },
    ]);
    expect(suggestion.newLabels.map((label) => [label.name, label.color])).toEqual([
      ["Strom", "#aabbcc"],
      ["Zwei", null],
    ]);
    expect(suggestion).toMatchObject({ emailId: "e1", providerName: "Mistral" });
  });

  it("keeps the model's own spam verdict only when it was lowered", () => {
    expect(toSpamCheck({ verdict: "suspicious", modelVerdict: "spam" }, "e1")).toMatchObject({
      verdict: "suspicious",
      modelVerdict: "spam",
    });
    expect(toSpamCheck({ verdict: "suspicious", modelVerdict: "phishing" }, "e1").modelVerdict).toBe("phishing");
    for (const modelVerdict of [null, undefined, "scam"]) {
      expect(toSpamCheck({ verdict: "suspicious", modelVerdict }, "e1")).not.toHaveProperty("modelVerdict");
    }
    // An older server sends neither facts nor details.
    expect(toSpamCheck({ verdict: "spam" }, "e1")).toMatchObject({ facts: null, reasonDetails: [], droppedReasons: 0 });
  });

  it("reads the facts and the evidence of the reasons, and drops what is malformed", () => {
    const check = toSpamCheck(
      {
        verdict: "phishing",
        reasons: ["Die Adresse ahmt PayPal nach."],
        reasonDetails: [
          { text: "Die Adresse ahmt PayPal nach.", quote: null, fact: "F2" },
          { text: "Droht mit Sperrung.", quote: "wird gesperrt", fact: "<script>" },
          { quote: "ohne Text" },
          "kaputt",
        ],
        droppedReasons: 2,
        facts: {
          score: 7.5,
          band: "spam",
          evidence: [
            {
              code: "LOOKALIKE_BRAND_FROM",
              tone: "bad",
              weight: 4,
              detail: "paypa1.example looks like PayPal",
              phishing: true,
            },
            { code: "lower case", tone: "bad", weight: 1 },
            { code: "DMARC_PASS", tone: "good" },
            { code: "FIRST_MAIL", tone: "weird", weight: 0.5 },
          ],
          allowed: ["spam", "phishing", "scam"],
          defaultVerdict: "nonsense",
        },
      },
      "e1",
    );
    expect(check.reasonDetails).toEqual([
      { text: "Die Adresse ahmt PayPal nach.", quote: null, fact: "F2" },
      { text: "Droht mit Sperrung.", quote: "wird gesperrt", fact: null },
    ]);
    expect(check.droppedReasons).toBe(2);
    expect(check.facts).toEqual({
      score: 7.5,
      band: "spam",
      evidence: [
        {
          code: "LOOKALIKE_BRAND_FROM",
          tone: "bad",
          weight: 4,
          detail: "paypa1.example looks like PayPal",
          phishing: true,
        },
        { code: "FIRST_MAIL", tone: "bad", weight: 0.5, detail: null, phishing: false },
      ],
      allowed: ["spam", "phishing"],
      defaultVerdict: "suspicious",
    });
    expect(toSpamCheck({ facts: { score: 1, band: "maybe" } }, "e1").facts).toBeNull();
  });

  it("drops events without a start, links that aren't https and more than the limit", () => {
    const many = Array.from({ length: MAX_ASSIST_EVENTS + 5 }, (_, n) => ({
      title: `E${n}`,
      start: "2026-10-17T19:30:00",
    }));
    expect(toEvents({ events: many })).toHaveLength(MAX_ASSIST_EVENTS);
    const [event] = toEvents({
      events: [
        { title: "Dinner", start: "2026-10-17T19:30:00", url: "javascript:alert(1)", confidence: 3 },
        { title: "Never", start: "Friday" },
      ],
    });
    expect(event).toMatchObject({ title: "Dinner", end: "2026-10-17T20:30:00", url: null, confidence: 1 });
  });

  it("turns the engine's refusals into an AssistError with its type", () => {
    const error = engineError({
      code: "invalid_input",
      message: "Too many requests",
      assist: { type: "providerFailed", retryAfter: 13, properties: ["baseUrl", 4] },
    });
    expect(error).toBeInstanceOf(AssistError);
    expect(error).toMatchObject({ type: "providerFailed", retryAfter: 13, properties: ["baseUrl"] });
    expect(engineError({ code: "auth_failed", message: "no" })).not.toBeInstanceOf(AssistError);
  });
});
