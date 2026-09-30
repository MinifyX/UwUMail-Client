/**
 * The AI assistant's answers from the engine, as the page uses them. The Rust side answers in the
 * shapes of UwUMail Server's `urn:uwumail:jmap:assist` (see the server's docs/jmap-assist.md) for
 * both kinds of scope, a UwUMail account's server and this device, so the same converters as the
 * webmail's normalize them: nothing that comes back is trusted to have the right shape.
 */

import { BackendError } from "./backend";
import {
  ASSIST_FEATURES,
  DEVICE_ASSIST_SCOPE,
  type AssistAnswer,
  type AssistChoice,
  type AssistEffective,
  type AssistEstimate,
  type AssistEstimateMethod,
  type AssistEvent,
  type AssistFeature,
  type AssistFeatures,
  type AssistLabel,
  type AssistLabelInput,
  type AssistLabelLogEntry,
  type AssistModels,
  type AssistOptions,
  type AssistProvider,
  type AssistProviderInput,
  type AssistProviderKind,
  type AssistScope,
  type AssistSettings,
  type AssistSettingsPatch,
  type AssistSpamCheck,
  type AssistCost,
  type AssistPrice,
  type AssistUsage,
  type AssistVerdict,
  type ChatgptLogin,
  type ChatgptPoll,
  type LocalModelServer,
} from "./types";

export type Raw = Record<string, unknown>;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const asCount = (value: unknown): number => Math.max(0, Math.round(asNumber(value) ?? 0));
export const asObject = (value: unknown): Raw | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null;
const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const asObjects = (value: unknown): Raw[] =>
  Array.isArray(value) ? value.map((entry) => asObject(entry)).filter((entry): entry is Raw => entry !== null) : [];

const KINDS: readonly AssistProviderKind[] = [
  "openai",
  "anthropic",
  "gemini",
  "mistral",
  "openrouter",
  "ollama",
  "openaiCompatible",
  "chatgpt",
];

/** Per feature whether it is there; anything but `true` is off. */
export function toAssistFeatures(value: unknown): AssistFeatures {
  const raw = asObject(value) ?? {};
  return Object.fromEntries(ASSIST_FEATURES.map((feature) => [feature, raw[feature] === true])) as AssistFeatures;
}

/** `assist_features`: null (no assistant for this mailbox) stays null. */
export function toAssistFeaturesOrNull(value: unknown): AssistFeatures | null {
  return asObject(value) ? toAssistFeatures(value) : null;
}

/**
 * What a scope allows, from the capability object (the server's, or the one the engine makes for
 * this device). The limits fall back to the server's own defaults where one is left out.
 */
export function toAssistOptions(value: unknown): AssistOptions {
  const raw = asObject(value) ?? {};
  return {
    features: toAssistFeatures(raw.features),
    mayAddProviders: raw.mayAddProviders === true,
    mayUsePrivateAddresses: raw.mayUsePrivateAddresses === true,
    maxProviders: asNumber(raw.maxProviders) ?? 10,
    maxLabels: asNumber(raw.maxLabels) ?? 30,
    maxInstructionChars: asNumber(raw.maxInstructionChars) ?? 2000,
    maxTextChars: asNumber(raw.maxTextChars) ?? 20000,
  };
}

/** `assist_scopes`: the scopes with an id, the device's always as `DEVICE_ASSIST_SCOPE`. */
export function toAssistScopes(value: unknown): AssistScope[] {
  return asObjects(value).flatMap((raw) => {
    const device = raw.kind === "device" || raw.id === DEVICE_ASSIST_SCOPE;
    const id = device ? DEVICE_ASSIST_SCOPE : asString(raw.id);
    if (!id) return [];
    return [
      {
        id,
        kind: device ? "device" : "server",
        accountId: device ? null : (asString(raw.accountId) ?? id),
        accountIds: asStrings(raw.accountIds),
        options: toAssistOptions(raw.options),
      } satisfies AssistScope,
    ];
  });
}

export function toAssistProvider(raw: Raw): AssistProvider {
  const kind = KINDS.includes(raw.kind as AssistProviderKind) ? (raw.kind as AssistProviderKind) : "openaiCompatible";
  const quota = asObject(raw.quota);
  return {
    id: String(raw.id),
    name: asString(raw.name) ?? String(raw.id),
    kind,
    scope: raw.scope === "personal" ? "personal" : "server",
    baseUrl: asString(raw.baseUrl),
    hasKey: raw.hasKey === true,
    keyHint: asString(raw.keyHint),
    model: asString(raw.model),
    fastModel: asString(raw.fastModel),
    features: asStrings(raw.features).filter((feature): feature is AssistFeature =>
      ASSIST_FEATURES.includes(feature as AssistFeature),
    ),
    quota: quota
      ? { requestsPerDay: asNumber(quota.requestsPerDay), tokensPerDay: asNumber(quota.tokensPerDay) }
      : null,
    experimental: raw.experimental === true || kind === "chatgpt",
    connected: raw.connected === true,
    inputPricePerMillion: asPrice(raw.inputPricePerMillion),
    outputPricePerMillion: asPrice(raw.outputPricePerMillion),
    price: toAssistPrice(raw.price),
  };
}

/** A price per million tokens: a finite number of at least 0, else null. */
const asPrice = (value: unknown): number | null => {
  const number = asNumber(value);
  return number !== null && number >= 0 ? number : null;
};

const PRICE_SOURCES: readonly AssistPrice["source"][] = ["auto", "manual", "free"];

export function toAssistPrice(value: unknown): AssistPrice | null {
  const raw = asObject(value);
  if (!raw) return null;
  const input = asPrice(raw.inputPerMillion);
  const output = asPrice(raw.outputPerMillion);
  const source = PRICE_SOURCES.find((known) => known === raw.source);
  return input === null || output === null || !source
    ? null
    : { inputPerMillion: input, outputPerMillion: output, source };
}

/** A cost as the server (or this device) answers it; null when missing or odd. */
export function toAssistCost(value: unknown): AssistCost | null {
  const raw = asObject(value);
  if (!raw) return null;
  const amount = asNumber(raw.amount);
  const currency = asString(raw.currency);
  if (amount === null || amount < 0 || !currency || !/^[A-Z]{3}$/.test(currency)) return null;
  return { amount, currency, usd: asPrice(raw.usd) };
}

export function toAssistProviders(value: unknown): AssistProvider[] {
  return asObjects(value)
    .filter((raw) => raw.id !== undefined && raw.id !== null)
    .map(toAssistProvider);
}

/** The create object: only what may be set, `apiKey` only when typed. */
export function providerCreate(input: AssistProviderInput): Raw {
  return providerPatch(input, true);
}

/** The update: only what the patch names. `kind` never changes. */
export function providerUpdate(patch: AssistProviderInput): Raw {
  return providerPatch(patch, false);
}

function providerPatch(input: AssistProviderInput, creating: boolean): Raw {
  const out: Raw = {};
  if (input.name !== undefined) out.name = input.name.trim();
  if (creating && input.kind !== undefined) out.kind = input.kind;
  if (input.baseUrl !== undefined) out.baseUrl = input.baseUrl?.trim() || null;
  if (input.apiKey !== undefined && (input.apiKey !== "" || !creating)) out.apiKey = input.apiKey.trim();
  if (input.model !== undefined) out.model = input.model?.trim() || null;
  if (input.fastModel !== undefined) out.fastModel = input.fastModel?.trim() || null;
  if (input.inputPricePerMillion !== undefined) out.inputPricePerMillion = input.inputPricePerMillion;
  if (input.outputPricePerMillion !== undefined) out.outputPricePerMillion = input.outputPricePerMillion;
  return out;
}

export function toAssistModels(value: unknown): AssistModels {
  const raw = asObject(value) ?? {};
  return {
    models: asObjects(raw.models)
      .filter((entry) => typeof entry.id === "string")
      .map((entry) => ({ id: entry.id as string, name: asString(entry.name) ?? (entry.id as string) })),
    model: asString(raw.model),
    fastModel: asString(raw.fastModel),
  };
}

const ESTIMATE_METHODS: readonly AssistEstimateMethod[] = [
  "Assist/compose",
  "Assist/summarize",
  "Assist/spamCheck",
  "Assist/extractEvents",
];

/** A count of tokens or requests: a whole number, never below zero; null when missing. */
const asAmount = (value: unknown): number | null => {
  const number = asNumber(value);
  return number === null ? null : Math.max(0, Math.round(number));
};

/**
 * `Assist/estimate`'s answer; null when it isn't one (an older server's, or nothing), so the
 * button just goes without its tooltip.
 */
export function toAssistEstimate(value: unknown, method: AssistEstimateMethod): AssistEstimate | null {
  const raw = asObject(value);
  if (!raw) return null;
  const input = asAmount(raw.inputTokens);
  const output = asAmount(raw.outputTokens);
  if (input === null || output === null) return null;
  const named = asString(raw.method);
  return {
    method: named && (ESTIMATE_METHODS as readonly string[]).includes(named) ? (named as AssistEstimateMethod) : method,
    inputTokens: input,
    outputTokens: output,
    totalTokens: asAmount(raw.totalTokens) ?? input + output,
    providerId: asString(raw.providerId),
    providerName: asString(raw.providerName),
    model: asString(raw.model),
    tokensLeftToday: asAmount(raw.tokensLeftToday),
    requestsLeftToday: asAmount(raw.requestsLeftToday),
    cost: toAssistCost(raw.cost),
  };
}

/** Ollama and LM Studio found on this computer; anything of another shape is left out. */
export function toLocalModelServers(value: unknown): LocalModelServer[] {
  return asObjects(value).flatMap((raw) => {
    const kind = raw.kind === "ollama" || raw.kind === "openaiCompatible" ? raw.kind : null;
    const name = asString(raw.name);
    const baseUrl = asString(raw.baseUrl);
    if (!kind || !name || !baseUrl || !/^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(baseUrl)) return [];
    return [{ kind, name, baseUrl, models: toAssistModels({ models: raw.models }).models, added: raw.added === true }];
  });
}

export function toChatgptLogin(value: unknown): ChatgptLogin {
  const raw = asObject(value) ?? {};
  const userCode = asString(raw.userCode);
  const verificationUri = asString(raw.verificationUri);
  // Opened in the browser: a web page, never a script or a local address (webmail security audit W-44).
  if (!userCode || !verificationUri || !/^https:\/\/[^/\\]/i.test(verificationUri)) {
    throw new BackendError("internal", "The server started no sign-in.");
  }
  return {
    userCode,
    verificationUri,
    interval: Math.max(1, asNumber(raw.interval) ?? 5),
    expiresAt: asString(raw.expiresAt),
  };
}

export function toChatgptPoll(value: unknown): ChatgptPoll {
  const status = asObject(value)?.status;
  return {
    status: status === "connected" || status === "expired" || status === "failed" ? status : "pending",
    description: asString(asObject(value)?.description),
  };
}

function toChoice(value: unknown): AssistChoice | null {
  const raw = asObject(value);
  const providerId = asString(raw?.providerId);
  return providerId ? { providerId, model: asString(raw?.model) } : null;
}

function toEffective(value: unknown): AssistEffective | null {
  const raw = asObject(value);
  const providerId = asString(raw?.providerId);
  if (!raw || !providerId) return null;
  return {
    providerId,
    providerName: asString(raw.providerName) ?? providerId,
    model: asString(raw.model),
    scope: raw.scope === "personal" ? "personal" : "server",
  };
}

export function toAssistSettings(value: unknown): AssistSettings {
  const raw = asObject(value);
  const features = asObject(raw?.features) ?? {};
  const effective = asObject(raw?.effective) ?? {};
  return {
    default: toChoice(raw?.default),
    features: Object.fromEntries(ASSIST_FEATURES.map((feature) => [feature, toChoice(features[feature])])) as Record<
      AssistFeature,
      AssistChoice | null
    >,
    autoLabels: raw?.autoLabels === true,
    effective: Object.fromEntries(
      ASSIST_FEATURES.map((feature) => [feature, toEffective(effective[feature])]),
    ) as Record<AssistFeature, AssistEffective | null>,
  };
}

/** The settings update: one path per feature, so other features' choices stay. */
export function assistSettingsUpdate(patch: AssistSettingsPatch): Raw {
  const update: Raw = {};
  if (patch.default !== undefined) update.default = patch.default;
  for (const [feature, choice] of Object.entries(patch.features ?? {})) {
    if (choice !== undefined) update[`features/${feature}`] = choice;
  }
  if (patch.autoLabels !== undefined) update.autoLabels = patch.autoLabels;
  return update;
}

export function toAssistLabel(raw: Raw): AssistLabel {
  const color = asString(raw.color);
  return {
    id: String(raw.id),
    name: asString(raw.name) ?? "",
    description: asString(raw.description) ?? "",
    keyword: (asString(raw.keyword) ?? "").toLowerCase(),
    color: color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : null,
  };
}

export function toAssistLabels(value: unknown): AssistLabel[] {
  return asObjects(value)
    .filter((raw) => raw.id !== undefined && raw.id !== null)
    .map(toAssistLabel);
}

export function labelCreate(input: AssistLabelInput): Raw {
  return { name: input.name.trim(), description: input.description.trim(), color: input.color };
}

export function labelUpdate(patch: Partial<AssistLabelInput>): Raw {
  const out: Raw = {};
  if (patch.name !== undefined) out.name = patch.name.trim();
  if (patch.description !== undefined) out.description = patch.description.trim();
  if (patch.color !== undefined) out.color = patch.color;
  return out;
}

export function toLabelLogEntry(raw: Raw): AssistLabelLogEntry {
  return {
    id: String(raw.id),
    emailId: String(raw.emailId),
    labelId: String(raw.labelId),
    name: asString(raw.name) ?? "",
    keyword: (asString(raw.keyword) ?? "").toLowerCase(),
    reason: asString(raw.reason) ?? "",
    createdAt: asString(raw.createdAt) ?? new Date(0).toISOString(),
    undone: raw.undone === true,
    providerName: asString(raw.providerName),
    model: asString(raw.model),
  };
}

export function toLabelLog(value: unknown): AssistLabelLogEntry[] {
  return asObjects(value)
    .filter((raw) => raw.id !== undefined && raw.emailId !== undefined)
    .map(toLabelLogEntry);
}

/** `assist_apply_labels`: label ids per message id; anything else is left out. */
export function toAppliedLabels(value: unknown): Record<string, string[]> {
  const raw = asObject(value) ?? {};
  return Object.fromEntries(Object.entries(raw).map(([id, labels]) => [id, asStrings(labels)]));
}

/** Who answered, as every answer of a model says. */
export function answerOf(value: unknown): AssistAnswer {
  const raw = asObject(value) ?? {};
  const usage = asObject(raw.usage);
  return {
    providerId: asString(raw.providerId) ?? "",
    providerName: asString(raw.providerName) ?? "",
    model: asString(raw.model),
    usage: usage ? { inputTokens: asCount(usage.inputTokens), outputTokens: asCount(usage.outputTokens) } : null,
  };
}

const VERDICTS: readonly AssistVerdict[] = ["legitimate", "suspicious", "spam", "phishing"];

export function toSpamCheck(value: unknown, emailId: string): AssistSpamCheck {
  const raw = asObject(value) ?? {};
  const signals = asObject(raw.signals) ?? {};
  const auth = asObject(signals.authentication) ?? {};
  const sender = asObject(signals.sender) ?? {};
  const confidence = asNumber(raw.confidence) ?? 0;
  return {
    ...answerOf(raw),
    emailId: asString(raw.emailId) ?? emailId,
    verdict: VERDICTS.includes(raw.verdict as AssistVerdict) ? (raw.verdict as AssistVerdict) : "suspicious",
    confidence: Math.min(1, Math.max(0, confidence)),
    reasons: asStrings(raw.reasons).slice(0, 6),
    signals: {
      authentication: {
        spf: asString(auth.spf),
        dkim: asString(auth.dkim),
        dmarc: asString(auth.dmarc),
        fromDomain: asString(auth.fromDomain),
      },
      spamScore: asNumber(signals.spamScore),
      spamThreshold: asNumber(signals.spamThreshold),
      tests: asStrings(signals.tests),
      inJunk: signals.inJunk === true,
      sender: {
        address: asString(sender.address) ?? "",
        earlierMessages: asCount(sender.earlierMessages),
        earlierInJunk: asCount(sender.earlierInJunk),
        writtenTo: asCount(sender.writtenTo),
        inContacts: sender.inContacts === true,
        firstSeen: asString(sender.firstSeen),
      },
    },
  };
}

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** The most events of one mail taken from the assistant, and how long their texts may be. */
export const MAX_ASSIST_EVENTS = 20;
const MAX_EVENT_TEXT = { title: 200, location: 300, description: 2000, quote: 1000 } as const;

/** At most `max` characters (never half an emoji); what the model wrote comes from the mail. */
function clip(value: string | null, max: number): string | null {
  if (value === null || value.length <= max) return value;
  return Array.from(value).slice(0, max).join("");
}

/** The events of `assist_extract_events`; one without a readable start is left out. */
export function toEvents(value: unknown): AssistEvent[] {
  const raw = asObject(value) ?? {};
  const list = Array.isArray(raw.events) ? raw.events.slice(0, MAX_ASSIST_EVENTS * 2) : [];
  return asObjects(list)
    .flatMap((entry) => {
      const start = asString(entry.start);
      if (!start || !LOCAL_DATE_TIME.test(start)) return [];
      const allDay = entry.allDay === true;
      const given = asString(entry.end);
      const end = given && LOCAL_DATE_TIME.test(given) && given > start ? given : defaultEnd(start, allDay);
      const url = asString(entry.url);
      return [
        {
          title: clip(asString(entry.title), MAX_EVENT_TEXT.title) ?? "",
          start,
          end,
          allDay,
          timeZone: asString(entry.timeZone),
          location: clip(asString(entry.location), MAX_EVENT_TEXT.location),
          description: clip(asString(entry.description), MAX_EVENT_TEXT.description),
          url: url && url.startsWith("https://") ? url : null,
          participants: asObjects(entry.participants)
            .filter((person) => typeof person.email === "string")
            .map((person) => ({ name: asString(person.name) ?? "", email: person.email as string })),
          confidence: Math.min(1, Math.max(0, asNumber(entry.confidence) ?? 0)),
          quote: clip(asString(entry.quote), MAX_EVENT_TEXT.quote) ?? "",
        },
      ];
    })
    .slice(0, MAX_ASSIST_EVENTS);
}

/** An hour after `start`, or the next day for an all-day event, as the server does. */
function defaultEnd(start: string, allDay: boolean): string {
  const [date, time] = start.split("T") as [string, string];
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute, second] = time.split(":").map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(year, month - 1, day + (allDay ? 1 : 0), hour + (allDay ? 0 : 1), minute, second));
  return moved.toISOString().slice(0, 19);
}

export function toUsage(value: unknown): AssistUsage {
  const raw = asObject(value) ?? {};
  return {
    days: asObjects(raw.days).map((entry) => ({
      day: asString(entry.day) ?? "",
      providerId: asString(entry.providerId) ?? "",
      providerName: asString(entry.providerName) ?? "",
      feature: asString(entry.feature) ?? "",
      requests: asCount(entry.requests),
      inputTokens: asCount(entry.inputTokens),
      outputTokens: asCount(entry.outputTokens),
      cost: toAssistCost(entry.cost),
    })),
    today: asObjects(raw.today).map((entry) => ({
      providerId: asString(entry.providerId) ?? "",
      providerName: asString(entry.providerName) ?? "",
      requests: asCount(entry.requests),
      tokens: asCount(entry.tokens),
      requestsPerDay: asNumber(entry.requestsPerDay),
      tokensPerDay: asNumber(entry.tokensPerDay),
      cost: toAssistCost(entry.cost),
    })),
  };
}

/** A written text: what `assist_compose` answers. */
export function toComposeText(value: unknown): { text: string; subject: string | null } {
  const raw = asObject(value) ?? {};
  const subject = asString(raw.subject);
  return { text: asString(raw.text) ?? "", subject: subject?.trim() ? subject : null };
}

/** A summary: what `assist_summarize` answers. */
export function toSummaryText(value: unknown): { emailId: string | null; threadId: string | null; summary: string } {
  const raw = asObject(value) ?? {};
  return {
    emailId: asString(raw.emailId),
    threadId: asString(raw.threadId),
    summary: asString(raw.summary) ?? "",
  };
}
