// A made-up AI assistant for the demo: no model anywhere, only answers that look like one wrote
// them, streamed in small pieces like the server does. Everything starts over with every reload.

import { assistKind } from "@/lib/assistKinds";
import { AssistError } from "./backend";
import {
  ASSIST_FEATURES,
  type AssistAnswer,
  type AssistComposeRequest,
  type AssistComposeResult,
  type AssistEffective,
  type AssistEstimate,
  type AssistEstimateMethod,
  type AssistEvent,
  type AssistEventsResult,
  type AssistFeature,
  type AssistLabel,
  type AssistLabelInput,
  type AssistLabelLogEntry,
  type AssistModels,
  type AssistOptions,
  type AssistProvider,
  type AssistProviderInput,
  type AssistSettings,
  type AssistSettingsPatch,
  type AssistSpamCheck,
  type AssistStreamHandlers,
  type AssistSummarizeRequest,
  type AssistSummary,
  type AssistUsage,
  type AssistVerdict,
  type ChatgptLogin,
  type ChatgptPoll,
  type Message,
} from "./types";

type Lang = "de" | "en";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Milliseconds between two pieces of a streamed answer. */
export const DEMO_STREAM_STEP = 35;

const OPTIONS: AssistOptions = {
  features: { compose: true, summarize: true, spamCheck: true, extractEvents: true, autoLabels: true },
  mayAddProviders: true,
  mayUsePrivateAddresses: true,
  maxProviders: 5,
  maxLabels: 30,
  maxInstructionChars: 2000,
  maxTextChars: 20000,
};

const SERVER_PROVIDER: AssistProvider = {
  id: "q1",
  name: "Mistral (Server)",
  kind: "mistral",
  scope: "server",
  baseUrl: null,
  hasKey: true,
  keyHint: null,
  model: "mistral-medium-latest",
  fastModel: "mistral-small-latest",
  features: [...ASSIST_FEATURES],
  quota: { requestsPerDay: 200, tokensPerDay: 400_000 },
  experimental: false,
  connected: true,
};

/** The made-up local model "this device" starts with in the demo. */
const DEVICE_PROVIDER: AssistProvider = {
  id: "d1",
  name: "Ollama",
  kind: "ollama",
  scope: "personal",
  baseUrl: "http://localhost:11434",
  hasKey: false,
  keyHint: null,
  model: "llama3.1:8b",
  fastModel: "llama3.2:3b",
  features: [...ASSIST_FEATURES],
  quota: null,
  experimental: false,
  connected: true,
};

const DEMO_MODELS: Record<string, string[]> = {
  openai: ["gpt-5", "gpt-5-mini", "gpt-5-nano"],
  anthropic: ["claude-haiku-4-5", "claude-opus-5", "claude-sonnet-4-5"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"],
  mistral: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"],
  openrouter: ["google/gemini-2.5-flash-lite", "mistralai/mistral-small-3.2-24b-instruct", "openai/gpt-5-mini"],
  ollama: ["gemma3:4b", "llama3.1:8b", "llama3.2:3b", "qwen3:8b"],
  openaiCompatible: ["local-model"],
  chatgpt: ["gpt-5", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini"],
};

/** A lower-case ASCII keyword from a label's name, the way the server makes one. */
export function demoKeyword(name: string, taken: string[]): string {
  const base = name
    .toLowerCase()
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replaceAll("ß", "ss")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/-und-|-and-/g, "-");
  const wanted = base || `label-${taken.length + 1}`;
  let keyword = wanted;
  for (let n = 2; taken.includes(keyword); n += 1) keyword = `${wanted}-${n}`;
  return keyword;
}

function aborted(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/** Hands `text` to `onDelta` a few words at a time, like a model writing. */
async function streamText(text: string, handlers: AssistStreamHandlers | undefined): Promise<void> {
  const pieces = text.match(/\S+\s*|\s+/g) ?? [];
  for (let index = 0; index < pieces.length; index += 2) {
    if (handlers?.signal?.aborted) throw aborted();
    await new Promise((resolve) => setTimeout(resolve, DEMO_STREAM_STEP));
    if (handlers?.signal?.aborted) throw aborted();
    handlers?.onDelta?.(pieces.slice(index, index + 2).join(""));
  }
}

async function thinking(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  if (signal?.aborted) throw aborted();
}

const tokens = (text: string) => Math.max(1, Math.round(text.length / 4));

const WEEKDAYS: Record<string, number> = {
  sonntag: 0,
  montag: 1,
  dienstag: 2,
  mittwoch: 3,
  donnerstag: 4,
  freitag: 5,
  samstag: 6,
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const pad = (value: number) => String(value).padStart(2, "0");

function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function plainSubject(subject: string): string {
  return subject.replace(/^((re|aw|fwd|wg):\s*)+/i, "").trim();
}

export class DemoAssist {
  private providers: AssistProvider[];
  private settings: Omit<AssistSettings, "effective"> = {
    default: null,
    features: Object.fromEntries(ASSIST_FEATURES.map((feature) => [feature, null])) as AssistSettings["features"],
    autoLabels: true,
  };
  private labels: AssistLabel[];
  private log: AssistLabelLogEntry[] = [];
  private usage: AssistUsage["days"] = [];
  private nextId = 1;
  private polls = new Map<string, number>();

  constructor(
    private readonly lang: Lang,
    /** The demo's mail, as it is now. */
    private readonly messages: () => Message[],
    private readonly changed: (mail: boolean) => void,
    /** The providers set up on this device, not a UwUMail server's assistant. */
    private readonly device = false,
  ) {
    this.providers = [structuredClone(device ? DEVICE_PROVIDER : SERVER_PROVIDER)];
    const de = lang === "de";
    const names = de
      ? [
          ["Rechnungen", "Rechnungen, Quittungen und Zahlungsbestätigungen", "#f59e0b"],
          ["Newsletter", "Newsletter, Angebote und Werbung von Läden und Diensten", "#8b5cf6"],
          ["Bestellungen & Versand", "Bestellbestätigungen, Versand- und Lieferinfos", "#0ea5e9"],
        ]
      : [
          ["Invoices", "Invoices, receipts and payment confirmations", "#f59e0b"],
          ["Newsletters", "Newsletters, offers and ads from shops and services", "#8b5cf6"],
          ["Orders & shipping", "Order confirmations, shipping and delivery updates", "#0ea5e9"],
        ];
    this.labels = [];
    for (const [name, description, color] of names) {
      this.labels.push({
        id: `g${this.nextId++}`,
        name: name!,
        description: description!,
        color: color!,
        keyword: demoKeyword(
          name!,
          this.labels.map((label) => label.keyword),
        ),
      });
    }
    this.seedLabels();
    this.seedUsage();
  }

  /** A few weeks of made-up use, so the settings have something to show. */
  private seedUsage() {
    const features: AssistFeature[] = ["summarize", "autoLabels", "compose", "spamCheck"];
    for (let back = 1; back < 30; back += 1) {
      // Quiet on some days, busier on others; always the same.
      const requests = (back * 7) % 11;
      if (requests === 0) continue;
      const feature = features[back % features.length]!;
      this.usage.push({
        day: new Date(Date.now() - back * DAY).toISOString().slice(0, 10),
        providerId: this.providers[0]!.id,
        providerName: this.providers[0]!.name,
        feature,
        requests,
        inputTokens: requests * 1450,
        outputTokens: requests * (feature === "compose" ? 260 : 90),
      });
    }
  }

  /** The labels "the model" put on the sample mail before the demo started. */
  private seedLabels() {
    const de = this.lang === "de";
    const [, newsletter, orders] = this.labels;
    for (const message of this.messages()) {
      const subject = message.subject.toLowerCase();
      if (/newsletter|aktion|deal|herbstkarte|autumn menu/.test(subject)) {
        this.label(
          message,
          newsletter!,
          de
            ? "Ein Rundschreiben eines Ladens mit Angeboten, kein persönliches Anschreiben."
            : "A shop's mailing with offers, not a personal message.",
        );
      } else if (/bestellung|your order/.test(subject)) {
        this.label(
          message,
          orders!,
          de
            ? "Die Mail meldet den Versand einer Bestellung mit Sendungsverfolgung."
            : "The mail says an order has shipped and links to its tracking.",
        );
      }
    }
  }

  private label(message: Message, label: AssistLabel, reason: string) {
    const who = this.effective("autoLabels");
    message.keywords = [...new Set([...(message.keywords ?? []), label.keyword])].sort();
    this.log.unshift({
      id: `l${this.nextId++}`,
      emailId: message.id,
      labelId: label.id,
      name: label.name,
      keyword: label.keyword,
      reason,
      createdAt: new Date(new Date(message.date).getTime() + 2 * MINUTE).toISOString(),
      undone: false,
      providerName: who?.providerName ?? this.providers[0]!.name,
      model: who?.model ?? this.providers[0]!.fastModel,
    });
  }

  options(): AssistOptions {
    return this.device ? { ...structuredClone(OPTIONS), maxProviders: 10 } : structuredClone(OPTIONS);
  }

  /** Per feature whether some provider may do it now; null when none can. */
  features(): AssistOptions["features"] | null {
    const features = Object.fromEntries(
      ASSIST_FEATURES.map((feature) => [feature, OPTIONS.features[feature] && this.effective(feature) !== null]),
    ) as AssistOptions["features"];
    return Object.values(features).some(Boolean) ? features : null;
  }

  listProviders(): AssistProvider[] {
    return structuredClone(this.providers);
  }

  private provider(id: string): AssistProvider {
    const found = this.providers.find((provider) => provider.id === id);
    if (!found) throw new AssistError("notFound", "No such provider.");
    return found;
  }

  private own(id: string): AssistProvider {
    const found = this.provider(id);
    if (found.scope !== "personal") throw new AssistError("forbidden", "Server providers are the admin's.");
    return found;
  }

  private checkBaseUrl(kind: AssistProvider["kind"], baseUrl: string | null | undefined) {
    if (!assistKind(kind).baseUrl) return;
    if (!baseUrl || !/^https?:\/\/[^\s/@]+/i.test(baseUrl)) {
      throw new AssistError("invalidProperties", "The address must start with http:// or https://.", {
        properties: ["baseUrl"],
      });
    }
  }

  createProvider(input: AssistProviderInput): AssistProvider {
    const name = input.name?.trim() ?? "";
    if (!name || name.length > 60) {
      throw new AssistError("invalidProperties", "A name of 1 to 60 characters.", { properties: ["name"] });
    }
    const kind = input.kind ?? "openaiCompatible";
    this.checkBaseUrl(kind, input.baseUrl);
    if (this.providers.filter((provider) => provider.scope === "personal").length >= OPTIONS.maxProviders) {
      throw new AssistError("overQuota", "No more providers of your own.");
    }
    const key = input.apiKey?.trim() ?? "";
    const provider: AssistProvider = {
      id: `q${100 + this.nextId++}`,
      name,
      kind,
      scope: "personal",
      baseUrl: assistKind(kind).baseUrl ? (input.baseUrl?.trim() ?? null) : null,
      hasKey: key !== "",
      keyHint: key ? `…${key.slice(-4)}` : null,
      model: input.model?.trim() || null,
      fastModel: input.fastModel?.trim() || null,
      features: [...ASSIST_FEATURES],
      quota: null,
      experimental: kind === "chatgpt",
      connected: kind === "chatgpt" ? false : key !== "" || assistKind(kind).key !== "required",
    };
    this.providers.push(provider);
    this.changed(false);
    return structuredClone(provider);
  }

  updateProvider(id: string, patch: AssistProviderInput) {
    const provider = this.own(id);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name || name.length > 60) {
        throw new AssistError("invalidProperties", "A name of 1 to 60 characters.", { properties: ["name"] });
      }
      provider.name = name;
    }
    if (patch.baseUrl !== undefined) {
      this.checkBaseUrl(provider.kind, patch.baseUrl);
      provider.baseUrl = patch.baseUrl?.trim() || null;
    }
    if (patch.apiKey !== undefined) {
      const key = patch.apiKey.trim();
      provider.hasKey = key !== "";
      provider.keyHint = key ? `…${key.slice(-4)}` : null;
      if (provider.kind !== "chatgpt") provider.connected = key !== "" || assistKind(provider.kind).key !== "required";
    }
    if (patch.model !== undefined) provider.model = patch.model?.trim() || null;
    if (patch.fastModel !== undefined) provider.fastModel = patch.fastModel?.trim() || null;
    this.changed(false);
  }

  deleteProvider(id: string) {
    this.own(id);
    this.providers = this.providers.filter((provider) => provider.id !== id);
    if (this.settings.default?.providerId === id) this.settings.default = null;
    for (const feature of ASSIST_FEATURES) {
      if (this.settings.features[feature]?.providerId === id) this.settings.features[feature] = null;
    }
    this.changed(false);
  }

  models(providerId: string): AssistModels {
    const provider = this.provider(providerId);
    if (provider.scope === "personal" && !provider.connected) {
      throw new AssistError("providerFailed", "The provider refused the key (401).");
    }
    const kind = assistKind(provider.kind);
    return {
      models: (DEMO_MODELS[provider.kind] ?? []).map((id) => ({ id, name: id })),
      model: provider.model ?? (kind.model || null),
      fastModel: provider.fastModel ?? (kind.fastModel || null),
    };
  }

  chatgptLogin(providerId: string): ChatgptLogin {
    const provider = this.own(providerId);
    if (provider.kind !== "chatgpt") throw new AssistError("invalidArguments", "Not a ChatGPT provider.");
    this.polls.set(providerId, 0);
    return {
      userCode: "UWU4-DEMO",
      verificationUri: "https://auth.example.com/device",
      interval: 2,
      expiresAt: new Date(Date.now() + 15 * MINUTE).toISOString(),
    };
  }

  chatgptPoll(providerId: string): ChatgptPoll {
    const provider = this.own(providerId);
    const count = (this.polls.get(providerId) ?? 0) + 1;
    this.polls.set(providerId, count);
    // The demo "signs in" on the third look.
    if (count < 3) return { status: "pending", description: null };
    provider.connected = true;
    this.polls.delete(providerId);
    this.changed(false);
    return { status: "connected", description: null };
  }

  private allowed(feature: AssistFeature): AssistProvider[] {
    return this.providers.filter((provider) => provider.features.includes(feature) && provider.connected);
  }

  private effective(feature: AssistFeature): AssistEffective | null {
    const allowed = this.allowed(feature);
    const pick = [this.settings.features[feature], this.settings.default]
      .filter((choice) => choice !== null)
      .map((choice) => ({ choice, provider: allowed.find((provider) => provider.id === choice.providerId) }))
      .find((entry) => entry.provider);
    const provider =
      pick?.provider ??
      allowed.find((entry) => entry.scope === "server") ??
      allowed.find((entry) => entry.scope === "personal");
    if (!provider) return null;
    const model =
      pick?.choice.model ?? (feature === "compose" ? provider.model : (provider.fastModel ?? provider.model));
    return { providerId: provider.id, providerName: provider.name, model, scope: provider.scope };
  }

  getSettings(): AssistSettings {
    return {
      ...structuredClone(this.settings),
      effective: Object.fromEntries(
        ASSIST_FEATURES.map((feature) => [feature, this.effective(feature)]),
      ) as AssistSettings["effective"],
    };
  }

  updateSettings(patch: AssistSettingsPatch) {
    const check = (choice: { providerId: string } | null | undefined, feature?: AssistFeature) => {
      if (!choice) return;
      const provider = this.providers.find((entry) => entry.id === choice.providerId);
      if (!provider || (feature && !provider.features.includes(feature))) {
        throw new AssistError("invalidProperties", "That provider can't be used for it.", {
          properties: [feature ? `features/${feature}` : "default"],
        });
      }
    };
    check(patch.default);
    for (const [feature, choice] of Object.entries(patch.features ?? {})) check(choice, feature as AssistFeature);
    if (patch.default !== undefined) this.settings.default = patch.default;
    for (const [feature, choice] of Object.entries(patch.features ?? {})) {
      if (choice !== undefined) this.settings.features[feature as AssistFeature] = choice;
    }
    if (patch.autoLabels !== undefined) this.settings.autoLabels = patch.autoLabels;
    this.changed(false);
  }

  /** Who "answers" a feature, and the note of what it used. */
  private answer(feature: AssistFeature, input: string, output: string): AssistAnswer {
    const effective = this.effective(feature);
    if (!effective) throw new AssistError("assistUnavailable", "No provider may do that.");
    const usage = { inputTokens: tokens(input) + 350, outputTokens: tokens(output) };
    this.usage.push({
      day: new Date().toISOString().slice(0, 10),
      providerId: effective.providerId,
      providerName: effective.providerName,
      feature,
      requests: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    return {
      providerId: effective.providerId,
      providerName: effective.providerName,
      model: effective.model,
      usage,
    };
  }

  private message(emailId: string): Message {
    const found = this.messages().find((message) => message.id === emailId);
    if (!found) throw new AssistError("notFound", "That mail is gone.");
    return found;
  }

  private text(message: Message): string {
    return (message.bodyText ?? message.snippet).trim();
  }

  async compose(request: AssistComposeRequest, handlers?: AssistStreamHandlers): Promise<AssistComposeResult> {
    if (!this.effective("compose")) throw new AssistError("assistUnavailable", "No provider may write.");
    if ((request.mode === "write" || request.mode === "adjust") && !request.instruction?.trim()) {
      throw new AssistError("invalidArguments", "An instruction is needed.");
    }
    if (request.mode !== "write" && !request.text?.trim()) {
      throw new AssistError("invalidArguments", "There is no text to rewrite.");
    }
    await thinking(450, handlers?.signal);
    const subject = request.mode === "write" && request.wantSubject ? this.proposedSubject(request) : null;
    if (subject) handlers?.onSubject?.(subject);
    const text = this.composed(request);
    await streamText(text, handlers);
    return {
      ...this.answer("compose", `${request.instruction ?? ""}${request.text ?? ""}`, text),
      text,
      subject,
    };
  }

  private proposedSubject(request: AssistComposeRequest): string {
    const instruction = (request.instruction ?? "").trim().replace(/[.!?]+$/, "");
    const short = instruction.length > 48 ? `${instruction.slice(0, 45).trimEnd()}…` : instruction;
    return short.charAt(0).toUpperCase() + short.slice(1);
  }

  private composed(request: AssistComposeRequest): string {
    const de = this.lang === "de" || request.language === "de";
    const text = (request.text ?? "").trim();
    const replyTo = request.replyToEmailId
      ? this.messages().find((message) => message.id === request.replyToEmailId)
      : undefined;
    const name = replyTo?.from.name?.split(/\s+/)[0];
    const hello = name ? (de ? `Hallo ${name},` : `Hi ${name},`) : de ? "Hallo," : "Hi,";
    switch (request.mode) {
      case "write": {
        const wish = (request.instruction ?? "").trim().replace(/[.!]+$/, "");
        return de
          ? `${hello}\n\n${replyTo ? "danke für deine Nachricht! " : ""}Kurz zu deinem Anliegen: ${wish}.\n\nSag gern Bescheid, wenn noch etwas offen ist.\n\nLiebe Grüße`
          : `${hello}\n\n${replyTo ? "thanks for your message! " : ""}A quick note on this: ${wish}.\n\nJust let me know if anything is still open.\n\nBest`;
      }
      case "adjust":
        return de
          ? `${text}\n\n(Angepasst: ${request.instruction?.trim()})`
          : `${text}\n\n(Adjusted: ${request.instruction?.trim()})`;
      case "rewrite":
        return this.rewritten(text, request, de);
    }
  }

  private rewritten(text: string, request: AssistComposeRequest, de: boolean): string {
    const body = text.replace(/^(hallo|hi|hey|liebe[rs]?|dear)\b[^\n]*\n+/i, "").trim();
    switch (request.preset) {
      case "formal":
        return de
          ? `Sehr geehrte Damen und Herren,\n\n${body}\n\nMit freundlichen Grüßen`
          : `Dear Sir or Madam,\n\n${body}\n\nKind regards`;
      case "casual":
        return de ? `Hey,\n\n${body}\n\nLG` : `Hey,\n\n${body}\n\nCheers`;
      case "shorter": {
        const kept = sentences(body);
        return kept.slice(0, Math.max(1, Math.ceil(kept.length / 2))).join(" ");
      }
      case "friendlier":
        return de
          ? `Hallo,\n\n${body}\n\nVielen Dank dir schon mal – ich freu mich auf deine Antwort! 😊`
          : `Hi,\n\n${body}\n\nThanks so much in advance – looking forward to hearing from you! 😊`;
      case "clearer":
        return sentences(body)
          .map((sentence) => `- ${sentence}`)
          .join("\n");
      case "proofread":
        return text
          .replace(/[ \t]{2,}/g, " ")
          .replace(/\s+([,.!?])/g, "$1")
          .replace(/(^|[.!?]\s+)([a-zäöü])/g, (_, before: string, letter: string) => before + letter.toUpperCase())
          .replace(/\bi\b/g, "I");
      case "translate":
        return de
          ? `[Demo-Übersetzung ins ${request.targetLanguage ?? "Englische"}]\n\n${text}`
          : `[Demo translation into ${request.targetLanguage ?? "German"}]\n\n${text}`;
      default:
        return text;
    }
  }

  async summarize(request: AssistSummarizeRequest, handlers?: AssistStreamHandlers): Promise<AssistSummary> {
    if (!this.effective("summarize")) throw new AssistError("assistUnavailable", "No provider may summarize.");
    const de = this.lang === "de";
    let summary: string;
    if (request.threadId) {
      const thread = this.messages()
        .filter((message) => message.threadId === request.threadId)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-20);
      if (thread.length === 0) throw new AssistError("notFound", "That conversation is gone.");
      const people = [...new Set(thread.map((message) => message.from.name ?? message.from.email))];
      const lead = de
        ? `${thread.length} Nachrichten zwischen ${people.join(" und ")} zu „${plainSubject(thread[0]!.subject)}“.`
        : `${thread.length} messages between ${people.join(" and ")} about "${plainSubject(thread[0]!.subject)}".`;
      const points = thread
        .slice(-5)
        .map((message) => `- ${message.from.name ?? message.from.email}: ${sentences(this.text(message))[0] ?? ""}`);
      summary = [lead, ...points].join("\n");
    } else {
      const message = this.message(request.emailId ?? "");
      const all = sentences(this.text(message));
      const lead = de
        ? `${message.from.name ?? message.from.email} schreibt zu „${plainSubject(message.subject)}“.`
        : `${message.from.name ?? message.from.email} writes about "${plainSubject(message.subject)}".`;
      const points = all
        .filter((sentence) => /\d|\?|bitte|please|bis |by /i.test(sentence))
        .concat(all)
        .filter((sentence, index, list) => list.indexOf(sentence) === index)
        .slice(0, 3)
        .map((sentence) => `- ${sentence}`);
      summary = [lead, ...points].join("\n");
    }
    await thinking(500, handlers?.signal);
    await streamText(summary, handlers);
    return {
      ...this.answer("summarize", summary.repeat(3), summary),
      emailId: request.emailId ?? null,
      threadId: request.threadId ?? null,
      summary,
    };
  }

  async spamCheck(emailId: string): Promise<AssistSpamCheck> {
    if (!this.effective("spamCheck")) throw new AssistError("assistUnavailable", "No provider may check mail.");
    const message = this.message(emailId);
    const de = this.lang === "de";
    const address = message.from.email.toLowerCase();
    const domain = address.split("@")[1] ?? "";
    const earlier = this.messages().filter(
      (other) => other.id !== message.id && other.from.email.toLowerCase() === address && other.date < message.date,
    );
    const writtenTo = this.messages().filter(
      (other) => other.folderId.endsWith(":sent") && other.to.some((person) => person.email.toLowerCase() === address),
    ).length;
    const risky = message.attachments.some((attachment) => /\.(exe|scr|js|bat|cmd)$/i.test(attachment.filename));
    const pushy = /24 (stunden|hours)|sofort|immediately|konto gesperrt|verify/i.test(this.text(message));
    const newsletter = (message.keywords ?? []).some((keyword) => keyword.startsWith("newsletter"));
    const verdict: AssistVerdict = risky ? "phishing" : pushy ? "suspicious" : "legitimate";
    const reasons = risky
      ? de
        ? [
            "Der Anhang heißt wie eine PDF, ist aber ein ausführbares Programm (.exe).",
            "Die Mail setzt mit einer Frist von 24 Stunden unter Druck.",
            "Der Absender hat noch nie zuvor geschrieben und nennt keinen Namen.",
          ]
        : [
            "The attachment is named like a PDF but is an executable program (.exe).",
            "The mail pressures you with a 24-hour deadline.",
            "The sender never wrote before and gives no name.",
          ]
      : pushy
        ? de
          ? ["Die Mail drängt zu schnellem Handeln.", "Der Absender ist unbekannt."]
          : ["The mail pushes for quick action.", "The sender is unknown."]
        : de
          ? [
              earlier.length > 0 ? "Der Absender hat schon öfter geschrieben." : "Der Inhalt passt zum Absender.",
              newsletter ? "Ein üblicher Newsletter mit Abmeldelink." : "Keine Aufforderung zu Zahlungen oder Logins.",
            ]
          : [
              earlier.length > 0 ? "The sender has written before." : "The content fits the sender.",
              newsletter ? "An ordinary newsletter with an unsubscribe link." : "No request for payments or logins.",
            ];
    await thinking(900);
    const answer = this.answer("spamCheck", this.text(message), reasons.join(" "));
    return {
      ...answer,
      emailId,
      verdict,
      confidence: risky ? 0.93 : pushy ? 0.64 : 0.86,
      reasons,
      signals: {
        authentication: risky
          ? { spf: "softfail", dkim: "none", dmarc: "fail", fromDomain: domain }
          : { spf: "pass", dkim: "pass", dmarc: "pass", fromDomain: domain },
        spamScore: risky ? 4.6 : newsletter ? 1.2 : 0.3,
        spamThreshold: 5,
        tests: risky
          ? ["DMARC_FAIL", "MIME_EXE_ATTACHMENT", "URGENT_PAYMENT"]
          : newsletter
            ? ["HAS_LIST_UNSUB", "HTML_IMAGE_RATIO"]
            : [],
        inJunk: message.folderId.endsWith(":junk"),
        sender: {
          address,
          earlierMessages: earlier.length,
          earlierInJunk: earlier.filter((other) => other.folderId.endsWith(":junk")).length,
          writtenTo,
          inContacts: !risky && (writtenTo > 0 || earlier.length > 0),
          firstSeen: earlier[0]?.date ?? null,
        },
      },
    };
  }

  async extractEvents(emailId: string): Promise<AssistEventsResult> {
    if (!this.effective("extractEvents")) throw new AssistError("assistUnavailable", "No provider may do that.");
    const message = this.message(emailId);
    const text = this.text(message);
    const sent = new Date(message.date);
    const events: AssistEvent[] = [];
    for (const sentence of sentences(text)) {
      const day =
        /\b(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(
          sentence,
        );
      if (!day || events.length >= 10) continue;
      const date = new Date(sent);
      const wanted = WEEKDAYS[day[1]!.toLowerCase()]!;
      date.setDate(date.getDate() + ((wanted - date.getDay() + 7) % 7 || 7));
      const time = /\b(\d{1,2})(?::(\d{2}))?\s*(uhr|am|pm)\b/i.exec(sentence);
      const deadline = /\bbis\b|\bby\b/i.test(sentence);
      let hour = time ? Number(time[1]) : null;
      if (hour !== null && time?.[3]?.toLowerCase() === "pm" && hour < 12) hour += 12;
      const start =
        hour === null ? `${localDate(date)}T00:00:00` : `${localDate(date)}T${pad(hour)}:${time?.[2] ?? "00"}:00`;
      const end = new Date(date);
      if (hour === null) end.setDate(end.getDate() + 1);
      const endText =
        hour === null
          ? `${localDate(end)}T00:00:00`
          : `${localDate(date)}T${pad(Math.min(23, hour + (deadline ? 1 : 3)))}:${time?.[2] ?? "00"}:00`;
      const title = plainSubject(message.subject).replace(/\?$/, "");
      events.push({
        title: deadline ? (this.lang === "de" ? `Frist: ${title}` : `Due: ${title}`) : title,
        start,
        end: endText,
        allDay: hour === null,
        timeZone: null,
        location: null,
        description: null,
        url: null,
        participants: message.from.name ? [{ name: message.from.name, email: message.from.email }] : [],
        confidence: hour === null ? 0.62 : 0.84,
        quote: sentence.slice(0, 300),
      });
    }
    await thinking(700);
    return { events, answer: this.answer("extractEvents", text, JSON.stringify(events)) };
  }

  /**
   * What a call would take, like the server's `Assist/estimate`: the text it would read, the fixed
   * instructions and a typical answer; nothing is counted. The server's provider has daily limits.
   */
  estimate(method: AssistEstimateMethod, args: Record<string, unknown>): AssistEstimate {
    const feature: AssistFeature =
      method === "Assist/compose"
        ? "compose"
        : method === "Assist/summarize"
          ? "summarize"
          : method === "Assist/spamCheck"
            ? "spamCheck"
            : "extractEvents";
    const effective = this.effective(feature);
    if (!effective) throw new AssistError("assistUnavailable", "No provider may do that.");
    const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
    let input = 350;
    let output: number;
    if (method === "Assist/compose") {
      if ((text("mode") === "write" || text("mode") === "adjust") && !text("instruction").trim()) {
        throw new AssistError("invalidArguments", "An instruction is needed.");
      }
      input += tokens(text("instruction")) + tokens(text("text"));
      output = text("mode") === "write" ? 400 : Math.max(100, tokens(text("text")));
    } else if (method === "Assist/summarize" && text("threadId")) {
      const thread = this.messages()
        .filter((message) => message.threadId === text("threadId"))
        .slice(-20);
      input += thread.reduce((sum, message) => sum + tokens(this.text(message)), 0);
      output = Math.min(600, 150 + 50 * Math.max(0, thread.length - 1));
    } else {
      input += tokens(this.text(this.message(text("emailId"))));
      output = method === "Assist/summarize" ? 150 : method === "Assist/spamCheck" ? 150 : 250;
    }
    const provider = this.providers.find((entry) => entry.id === effective.providerId);
    const today = new Date().toISOString().slice(0, 10);
    const used = this.usage.filter((entry) => entry.day === today && entry.providerId === effective.providerId);
    const quota = provider?.scope === "server" ? provider.quota : null;
    const left = (limit: number | null | undefined, spent: number) =>
      limit === null || limit === undefined ? null : Math.max(0, limit - spent);
    return {
      method,
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
      providerId: effective.providerId,
      providerName: effective.providerName,
      model: effective.model,
      tokensLeftToday: left(
        quota?.tokensPerDay,
        used.reduce((sum, entry) => sum + entry.inputTokens + entry.outputTokens, 0),
      ),
      requestsLeftToday: left(
        quota?.requestsPerDay,
        used.reduce((sum, entry) => sum + entry.requests, 0),
      ),
    };
  }

  /** The models at an address not saved yet: the demo's made-up local ones. */
  probeModels(kind: AssistProvider["kind"], baseUrl: string): AssistModels {
    this.checkBaseUrl(kind, baseUrl);
    return { models: (DEMO_MODELS[kind] ?? []).map((id) => ({ id, name: id })), model: null, fastModel: null };
  }

  /** Whether a provider at this address exists already. */
  hasAddress(baseUrl: string): boolean {
    const plain = (url: string | null) => (url ?? "").replace(/\/v1\/?$/, "").replace(/\/$/, "");
    return this.providers.some((provider) => plain(provider.baseUrl) === plain(baseUrl));
  }

  usageReport(days: number): AssistUsage {
    const since = new Date(Date.now() - (days - 1) * DAY).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const grouped = new Map<string, AssistUsage["days"][number]>();
    for (const entry of this.usage.filter((item) => item.day >= since)) {
      const key = `${entry.day}|${entry.providerId}|${entry.feature}`;
      const sum = grouped.get(key) ?? { ...entry, requests: 0, inputTokens: 0, outputTokens: 0 };
      sum.requests += entry.requests;
      sum.inputTokens += entry.inputTokens;
      sum.outputTokens += entry.outputTokens;
      grouped.set(key, sum);
    }
    const perProvider = new Map<string, AssistUsage["today"][number]>();
    for (const entry of this.usage.filter((item) => item.day === today)) {
      const provider = this.providers.find((item) => item.id === entry.providerId);
      const sum = perProvider.get(entry.providerId) ?? {
        providerId: entry.providerId,
        providerName: entry.providerName,
        requests: 0,
        tokens: 0,
        requestsPerDay: provider?.quota?.requestsPerDay ?? null,
        tokensPerDay: provider?.quota?.tokensPerDay ?? null,
      };
      sum.requests += entry.requests;
      sum.tokens += entry.inputTokens + entry.outputTokens;
      perProvider.set(entry.providerId, sum);
    }
    return { days: [...grouped.values()].sort((a, b) => b.day.localeCompare(a.day)), today: [...perProvider.values()] };
  }

  listLabels(): AssistLabel[] {
    return structuredClone(this.labels);
  }

  private checkLabel(input: Partial<AssistLabelInput>, except?: string) {
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name || name.length > 40) {
        throw new AssistError("invalidProperties", "A name of 1 to 40 characters.", { properties: ["name"] });
      }
      if (this.labels.some((label) => label.id !== except && label.name.toLowerCase() === name.toLowerCase())) {
        throw new AssistError("invalidProperties", "There is a label of that name.", { properties: ["name"] });
      }
    }
    if (input.description !== undefined && input.description.length > 300) {
      throw new AssistError("invalidProperties", "At most 300 characters.", { properties: ["description"] });
    }
  }

  createLabel(input: AssistLabelInput): AssistLabel {
    this.checkLabel(input);
    if (this.labels.length >= OPTIONS.maxLabels) throw new AssistError("overQuota", "No more labels.");
    const label: AssistLabel = {
      id: `g${this.nextId++}`,
      name: input.name.trim(),
      description: input.description.trim(),
      color: input.color,
      keyword: demoKeyword(
        input.name.trim(),
        this.labels.map((entry) => entry.keyword),
      ),
    };
    this.labels.push(label);
    this.changed(false);
    return structuredClone(label);
  }

  updateLabel(id: string, patch: Partial<AssistLabelInput>) {
    const label = this.labels.find((entry) => entry.id === id);
    if (!label) throw new AssistError("notFound", "No such label.");
    this.checkLabel(patch, id);
    if (patch.name !== undefined) label.name = patch.name.trim();
    if (patch.description !== undefined) label.description = patch.description.trim();
    if (patch.color !== undefined) label.color = patch.color;
    for (const entry of this.log) if (entry.labelId === id) entry.name = label.name;
    this.changed(false);
  }

  deleteLabel(id: string) {
    const label = this.labels.find((entry) => entry.id === id);
    if (!label) throw new AssistError("notFound", "No such label.");
    this.labels = this.labels.filter((entry) => entry.id !== id);
    this.log = this.log.filter((entry) => entry.labelId !== id);
    for (const message of this.messages()) {
      if (message.keywords?.includes(label.keyword)) {
        message.keywords = message.keywords.filter((keyword) => keyword !== label.keyword);
      }
    }
    this.changed(true);
  }

  labelLog(emailIds: string[] | null, limit: number): AssistLabelLogEntry[] {
    const wanted = emailIds ? new Set(emailIds) : null;
    return structuredClone(
      this.log.filter((entry) => !wanted || wanted.has(entry.emailId)).slice(0, Math.min(500, limit)),
    );
  }

  undo(logIds: string[]) {
    for (const entry of this.log) {
      if (!logIds.includes(entry.id) || entry.undone) continue;
      entry.undone = true;
      const message = this.messages().find((item) => item.id === entry.emailId);
      if (message?.keywords) message.keywords = message.keywords.filter((keyword) => keyword !== entry.keyword);
    }
    this.changed(true);
  }

  /** Keywords set or taken off by hand: a label the model set and the person took off counts as undone. */
  keywordsChanged(emailIds: string[], keywords: Record<string, boolean>) {
    const removed = new Set(Object.keys(keywords).filter((keyword) => !keywords[keyword]));
    if (removed.size === 0) return;
    for (const entry of this.log) {
      if (emailIds.includes(entry.emailId) && removed.has(entry.keyword)) entry.undone = true;
    }
    this.changed(false);
  }

  async apply(emailIds: string[]): Promise<Record<string, string[]>> {
    if (!this.effective("autoLabels")) throw new AssistError("assistUnavailable", "No provider may label mail.");
    await thinking(600);
    const labeled: Record<string, string[]> = {};
    for (const id of emailIds.slice(0, 20)) {
      const message = this.messages().find((item) => item.id === id);
      if (!message) continue;
      const text = `${message.subject} ${this.text(message)}`.toLowerCase();
      const words = (label: AssistLabel) =>
        `${label.name} ${label.description}`
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter((word) => word.length > 4);
      const fits = this.labels.filter((label) => words(label).some((word) => text.includes(word)));
      for (const label of fits) {
        if (message.keywords?.includes(label.keyword)) continue;
        this.label(
          message,
          label,
          this.lang === "de"
            ? `Die Mail passt zur Beschreibung „${label.description}“.`
            : `The mail fits the description "${label.description}".`,
        );
      }
      labeled[id] = fits.map((label) => label.id);
      this.answer("autoLabels", text, "{}");
    }
    this.changed(true);
    return labeled;
  }
}
