import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistError } from "@/backend/backend";
import type {
  AssistComposeRequest,
  AssistLabel,
  AssistLabelInput,
  AssistLabelLogEntry,
  AssistOptions,
  AssistProviderInput,
  AssistSpamCheck,
  AssistStreamHandlers,
  LabelBase,
  LabelOverlap,
  Message,
} from "@/backend/types";
import { i18n } from "@/i18n";
import { useSettings } from "@/state/settings";
import { useToasts } from "@/state/toasts";
import { ComposeAssistPanel, type ComposeAssistContext, type ComposeAssistStart } from "./ComposeAssist";
import { MessageLabels } from "./LabelChips";
import { LABEL_DEFAULTS } from "./labels";
import { useAssistReader } from "./readerState";
import { AssistForAccount, AssistScopeProvider } from "./useAssist";
import { LabelSettings } from "./settings/LabelSettings";
import { ProviderSettings } from "./settings/ProviderSettings";
import { SpamCheckCard } from "./SpamCheckCard";

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

const ANSWER = { providerId: "q1", providerName: "Mistral (Server)", model: "mistral-small-latest", usage: null };

let labels: AssistLabel[] = [];
let log: AssistLabelLogEntry[] = [];
let overlaps: LabelOverlap[] = [];
/** How the next compose answer comes: streamed pieces, then the result, or a failure. */
let compose: (request: AssistComposeRequest, handlers: AssistStreamHandlers) => Promise<unknown>;

const fake = {
  kind: "jmap",
  assistScopes: vi.fn(async () => [
    { id: "acc", kind: "server", accountId: "acc", accountIds: ["acc"], options: OPTIONS },
    { id: "device", kind: "device", accountId: null, accountIds: ["other"], options: OPTIONS },
  ]),
  assistFeatures: vi.fn(async () => OPTIONS.features),
  assistSettings: vi.fn(async () => ({
    default: null,
    features: { compose: null, summarize: null, spamCheck: null, extractEvents: null, autoLabels: null },
    autoLabels: false,
    effective: { compose: ANSWER, summarize: ANSWER, spamCheck: ANSWER, extractEvents: ANSWER, autoLabels: ANSWER },
  })),
  assistProviders: vi.fn(async () => [
    {
      id: "q1",
      name: "Mistral (Server)",
      kind: "mistral",
      scope: "server",
      baseUrl: null,
      hasKey: true,
      keyHint: null,
      model: "mistral-medium-latest",
      fastModel: "mistral-small-latest",
      features: ["compose"],
      quota: { requestsPerDay: 200, tokensPerDay: null },
      experimental: false,
      connected: true,
    },
  ]),
  createAssistProvider: vi.fn(async (_scope: string, input: AssistProviderInput) => ({ id: "q9", ...input })),
  assistCompose: vi.fn((_accountId: string, request: AssistComposeRequest, handlers: AssistStreamHandlers) =>
    compose(request, handlers),
  ),
  assistLabels: vi.fn(async () => labels.map((label) => ({ ...label }))),
  createAssistLabel: vi.fn(async (_scope: string, input: AssistLabelInput) => {
    const made = { ...LABEL_DEFAULTS, id: `g${labels.length + 1}`, keyword: input.name.toLowerCase(), ...input };
    labels = [...labels, made];
    return made;
  }),
  updateAssistLabel: vi.fn(async (_scope: string, id: string, patch: Partial<AssistLabelInput>) => {
    labels = labels.map((label) => (label.id === id ? { ...label, ...patch } : label));
  }),
  restoreBaseLabel: vi.fn(async (_scope: string, base: LabelBase) => {
    const made = { ...LABEL_DEFAULTS, id: `g${labels.length + 1}`, name: base, keyword: base, description: "", base };
    labels = [...labels, { ...made, color: null }];
    return { ...made, color: null };
  }),
  checkLabelOverlap: vi.fn(async () => overlaps),
  assistLabelLog: vi.fn(async () => log),
  undoAssistLabels: vi.fn(async () => {}),
  setKeywords: vi.fn(async () => {}),
  assistSpamCheck: vi.fn(async (emailId: string): Promise<AssistSpamCheck> => ({
    ...ANSWER,
    emailId,
    verdict: "phishing",
    confidence: 0.9,
    reasons: ["Asks to confirm a password through a link"],
    reasonDetails: [{ text: "Asks to confirm a password through a link", quote: "confirm your password", fact: null }],
    droppedReasons: 1,
    facts: {
      score: 6.5,
      band: "leaningSpam",
      evidence: [
        { code: "DMARC_FAIL", tone: "bad", weight: 2, detail: "bank.example", phishing: false },
        {
          code: "LOOKALIKE_BRAND_LINK",
          tone: "bad",
          weight: 3,
          detail: "paypa1.example looks like PayPal",
          phishing: true,
        },
        { code: "SOMETHING_NEW", tone: "good", weight: -0.5, detail: null, phishing: false },
      ],
      allowed: ["suspicious", "spam", "phishing"],
      defaultVerdict: "suspicious",
    },
    signals: {
      authentication: { spf: "fail", dkim: null, dmarc: "fail", fromDomain: "bank.example" },
      spamScore: 4.2,
      spamThreshold: 5,
      tests: ["DMARC_FAIL"],
      inJunk: false,
      sender: {
        address: "service@bank.example",
        earlierMessages: 0,
        earlierInJunk: 0,
        writtenTo: 0,
        inContacts: false,
        firstSeen: null,
      },
    },
  })),
  markSpam: vi.fn(async () => []),
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

/** Settings talk to one scope, as the settings page sets it. */
function inScope(scope: string, node: ReactNode) {
  return renderWith(<AssistScopeProvider scope={scope}>{node}</AssistScopeProvider>);
}

const CONTEXT: ComposeAssistContext = {
  source: { scope: "own", text: "hey leni, friday works" },
  subject: "Lunch",
  replyToEmailId: "e1",
  language: "en",
};

function panel(start: ComposeAssistStart, extra: Partial<Parameters<typeof ComposeAssistPanel>[0]> = {}) {
  const props = {
    start,
    context: CONTEXT,
    subjectEmpty: false,
    onInsert: vi.fn(),
    onReplace: vi.fn(),
    onSubject: vi.fn(),
    onClose: vi.fn(),
    ...extra,
  };
  renderWith(<ComposeAssistPanel {...props} />);
  return props;
}

const message = (patch: Partial<Message> = {}): Message => ({
  id: "e1",
  threadId: "t1",
  accountId: "acc",
  folderId: "acc:inbox",
  from: { name: "Bank", email: "service@bank.example" },
  to: [{ name: "Mini", email: "mini@uwumail.example" }],
  cc: [],
  replyTo: [],
  subject: "Confirm your account",
  date: "2026-09-28T10:00:00Z",
  flags: { seen: true, flagged: false, answered: false, draft: false },
  snippet: "",
  bodyHtml: null,
  bodyText: "",
  hasRemoteContent: false,
  attachments: [],
  ...patch,
});

describe("the assistant's UI", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    labels = [];
    log = [];
    overlaps = [];
    compose = async (_request, handlers) => {
      handlers.onDelta?.("Hi Leni, ");
      handlers.onDelta?.("Friday works for me.");
      return { ...ANSWER, text: "Hi Leni, Friday works for me.", subject: null };
    };
  });
  afterEach(() => {
    cleanup();
    act(() => {
      useToasts.setState({ toasts: [] });
      useAssistReader.setState({ summaries: {}, spamChecks: {}, done: {}, spamResults: {} });
    });
  });

  it("rewrites the own text with a preset at once, and changes the draft only on a click", async () => {
    const props = panel({ kind: "rewrite", preset: "formal" });
    expect(await screen.findByText("Hi Leni, Friday works for me.")).toBeTruthy();
    expect(fake.assistCompose.mock.calls[0]![1]).toEqual({
      mode: "rewrite",
      instruction: null,
      preset: "formal",
      targetLanguage: null,
      text: "hey leni, friday works",
      subject: "Lunch",
      replyToEmailId: "e1",
      wantSubject: false,
      language: "en",
    });
    expect(screen.getByText("Mistral (Server) · mistral-small-latest")).toBeTruthy();
    expect(props.onReplace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Replace my text" }));
    expect(props.onReplace).toHaveBeenCalledWith("Hi Leni, Friday works for me.");
  });

  it("writes from an instruction with a subject proposal", async () => {
    compose = async (_request, handlers) => {
      handlers.onSubject?.("Friday lunch");
      handlers.onDelta?.("Yes!");
      return { ...ANSWER, text: "Yes!", subject: "Friday lunch" };
    };
    const props = panel({ kind: "write" }, { subjectEmpty: true });
    expect(fake.assistCompose).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Instruction"), { target: { value: "Say yes" } });
    fireEvent.click(screen.getByRole("button", { name: "Write" }));
    await screen.findByText("Yes!");
    expect(fake.assistCompose.mock.calls[0]![1]).toMatchObject({
      mode: "write",
      instruction: "Say yes",
      wantSubject: true,
      text: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Use as subject" }));
    expect(props.onSubject).toHaveBeenCalledWith("Friday lunch");
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    expect(props.onInsert).toHaveBeenCalledWith("Yes!");
  });

  it("stops a streaming answer and keeps what came", async () => {
    let signal: AbortSignal | undefined;
    compose = (_request, handlers) => {
      signal = handlers.signal;
      handlers.onDelta?.("Half a sen");
      return new Promise((_resolve, reject) =>
        handlers.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
      );
    };
    panel({ kind: "rewrite", preset: "shorter" });
    await screen.findByText("Half a sen");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(signal?.aborted).toBe(true);
    expect(await screen.findByRole("button", { name: "Insert" })).toBeTruthy();
    expect(screen.getByText("Half a sen")).toBeTruthy();
  });

  it("says kindly when the day's limit is used up, and tries again", async () => {
    compose = async () => {
      throw new AssistError("overQuota", "requests: 200 of 200");
    };
    panel({ kind: "rewrite", preset: "clearer" });
    expect(
      await screen.findByText("Today's limit for the assistant is used up. It resets at midnight (UTC)."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fake.assistCompose).toHaveBeenCalledTimes(2));
  });

  it("tells when the model is busy and for how long", async () => {
    compose = async () => {
      throw new AssistError("providerFailed", "429", { retryAfter: 12.2 });
    };
    panel({ kind: "rewrite", preset: "proofread" });
    expect(await screen.findByText("The model is busy right now. Try again in 13 seconds.")).toBeTruthy();
  });

  it("shows why the assistant set a label and undoes it", async () => {
    labels = [
      { ...LABEL_DEFAULTS, id: "g1", name: "Invoices", keyword: "invoices", description: "Bills", color: "#f59e0b" },
    ];
    log = [
      {
        id: "l1",
        emailId: "e1",
        labelId: "g1",
        name: "Invoices",
        keyword: "invoices",
        source: "ai",
        code: "ai",
        params: {},
        reason: "It is an invoice for September.",
        createdAt: "2026-09-28T10:02:00Z",
        undone: false,
        providerName: "Mistral (Server)",
        model: "mistral-small-latest",
      },
    ];
    renderWith(<MessageLabels message={message({ keywords: ["invoices"] })} canEdit />);
    fireEvent.click(await screen.findByRole("button", { name: /Invoices/ }));
    await waitFor(() => expect(fake.assistLabelLog).toHaveBeenCalledWith("acc", ["e1"], 50));
    const card = await screen.findByRole("dialog", { name: "Invoices" });
    expect(await within(card).findByText("It is an invoice for September.")).toBeTruthy();
    expect(within(card).getByText(/Mistral \(Server\) · mistral-small-latest/)).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(fake.undoAssistLabels).toHaveBeenCalledWith("acc", ["l1"]));
  });

  it("puts a label on by hand as a keyword", async () => {
    labels = [{ ...LABEL_DEFAULTS, id: "g1", name: "Travel", keyword: "travel", description: "", color: null }];
    renderWith(<MessageLabels message={message()} canEdit />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a label" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Travel" }));
    await waitFor(() => expect(fake.setKeywords).toHaveBeenCalledWith(["e1"], { travel: true }));
  });

  it("lists the base labels apart, switched one by one, with their fixed definition", async () => {
    const base = (id: string, name: string, which: LabelBase, auto = true): AssistLabel => ({
      ...LABEL_DEFAULTS,
      id,
      name,
      keyword: name.toLowerCase(),
      description: `${name} definition`,
      color: null,
      base: which,
      auto,
    });
    labels = [
      base("g1", "Invoice", "invoice"),
      base("g2", "Personal", "personal", false),
      { ...LABEL_DEFAULTS, id: "g3", name: "Travel", keyword: "travel", description: "Trips", color: null },
    ];
    inScope("acc", <LabelSettings options={OPTIONS} />);
    expect(await screen.findByText("Base labels")).toBeTruthy();
    expect(screen.getByText("Your own labels")).toBeTruthy();
    // The definition is folded away until asked for.
    expect(screen.queryByText("Invoice definition")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Show definition" })[0]!);
    expect(screen.getByText("Invoice definition")).toBeTruthy();
    const personal = screen.getByRole("switch", { name: "Put “Personal” on by itself" });
    expect(personal.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("switch", { name: "Put “Invoice” on by itself" }));
    await waitFor(() => expect(fake.updateAssistLabel).toHaveBeenCalledWith("acc", "g1", { auto: false }));
    // Six were deleted: each can come back.
    fireEvent.click(screen.getByRole("button", { name: "Restore Shipping" }));
    await waitFor(() => expect(fake.restoreBaseLabel).toHaveBeenCalledWith("acc", "shipping"));
    expect(screen.getByRole("button", { name: "Restore Promotions" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore Invoice" })).toBeNull();
  });

  it("offers every base label again when the scope announces them and all were deleted", async () => {
    inScope("device", <LabelSettings options={{ ...OPTIONS, baseLabels: ["invoice", "work"] }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Restore Work & business" }));
    await waitFor(() => expect(fake.restoreBaseLabel).toHaveBeenCalledWith("device", "work"));
    expect(screen.getByRole("button", { name: "Restore Invoice" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore Shipping" })).toBeNull();
  });

  it("edits a base label's name but never its definition", async () => {
    labels = [
      {
        ...LABEL_DEFAULTS,
        id: "g1",
        name: "Invoice",
        keyword: "invoice",
        description: "Fixed definition",
        color: null,
        base: "invoice",
      },
    ];
    inScope("acc", <LabelSettings options={OPTIONS} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Invoice" }));
    expect(screen.queryByLabelText("What belongs here")).toBeNull();
    expect(screen.getByText("Fixed definition")).toBeTruthy();
    expect(screen.queryByLabelText("Detector")).toBeNull();
    expect(screen.getByText("Has its own detector built in.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bills" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fake.updateAssistLabel).toHaveBeenCalledWith("acc", "g1", { name: "Bills" }));
    expect(fake.checkLabelOverlap).not.toHaveBeenCalled();
  });

  it("warns of overlapping labels while typing, but still saves", async () => {
    overlaps = [
      { id: "g1", name: "Invoice", base: "invoice", kind: "meaning", words: [] },
      { id: "g2", name: "Phone", base: null, kind: "words", words: ["mobile", "contract"] },
    ];
    inScope("acc", <LabelSettings options={OPTIONS} />);
    fireEvent.click(await screen.findByRole("button", { name: "New label" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Phone bills" } });
    fireEvent.change(screen.getByLabelText("What belongs here"), { target: { value: "mobile contract" } });
    expect(await screen.findByText("Means the same as the base label “Invoice”.")).toBeTruthy();
    expect(screen.getByText("Very similar words to “Phone”: mobile, contract")).toBeTruthy();
    // Asked once, after typing rested.
    expect(fake.checkLabelOverlap).toHaveBeenCalledTimes(1);
    expect(fake.checkLabelOverlap).toHaveBeenCalledWith("acc", "Phone bills", "mobile contract", undefined);
    fireEvent.click(screen.getByRole("button", { name: "Create label" }));
    await waitFor(() => expect(fake.createAssistLabel).toHaveBeenCalled());
  });

  it("checks a new label before saving it", async () => {
    labels = [{ ...LABEL_DEFAULTS, id: "g1", name: "Travel", keyword: "travel", description: "", color: null }];
    inScope("acc", <LabelSettings options={OPTIONS} />);
    // The list is there (its keyword shows).
    await screen.findByText("travel");
    fireEvent.click(screen.getByRole("button", { name: "New label" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "travel" } });
    fireEvent.click(screen.getByRole("button", { name: "Create label" }));
    expect(await screen.findByText("You already have a label with that name.")).toBeTruthy();
    expect(fake.createAssistLabel).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Kids" } });
    fireEvent.change(screen.getByLabelText("What belongs here"), { target: { value: "School and daycare" } });
    fireEvent.click(screen.getByRole("button", { name: "Create label" }));
    await waitFor(() =>
      expect(fake.createAssistLabel).toHaveBeenCalledWith(
        "acc",
        expect.objectContaining({ name: "Kids", description: "School and daycare" }),
      ),
    );
  });

  it("adds an own provider only with a key, which it never shows again", async () => {
    inScope("acc", <ProviderSettings options={OPTIONS} />);
    expect(await screen.findByText("Mistral (Server)")).toBeTruthy();
    expect(screen.getByText("200 requests per day")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("This provider needs an API key.")).toBeTruthy();
    const key = screen.getByLabelText("API key");
    expect(key.getAttribute("type")).toBe("password");
    fireEvent.change(key, { target: { value: "sk-test-1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(fake.createAssistProvider).toHaveBeenCalledWith("acc", {
        name: "OpenAI",
        kind: "openai",
        apiKey: "sk-test-1234",
      }),
    );
  });

  it("warns that a Claude subscription can't be used", async () => {
    inScope("acc", <ProviderSettings options={OPTIONS} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "anthropic" } });
    expect(screen.getByText(/A Claude subscription \(Pro or Max\) can't be used here/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "chatgpt" } });
    expect(screen.getByText("Experimental and unofficial")).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  it("offers no ChatGPT sign-in for the providers on this device", async () => {
    inScope("device", <ProviderSettings options={OPTIONS} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
    const kinds = within(screen.getByLabelText("Provider")).getAllByRole("option") as HTMLOptionElement[];
    expect(kinds.map((option) => option.value)).toContain("ollama");
    expect(kinds.map((option) => option.value)).not.toContain("chatgpt");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-device-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(fake.createAssistProvider).toHaveBeenCalledWith("device", expect.objectContaining({ kind: "openai" })),
    );
  });

  it("shows the model's verdict next to the server's findings and reports spam", async () => {
    act(() => useAssistReader.getState().showSpamCheck("e1"));
    renderWith(<SpamCheckCard message={message()} inJunk={false} />);
    expect(await screen.findByText("Phishing")).toBeTruthy();
    expect(fake.assistSpamCheck).toHaveBeenCalledWith("e1", "en");
    expect(screen.getByText("sure")).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByText(/The model said/)).toBeNull();
    expect(screen.getByText("Asks to confirm a password through a link")).toBeTruthy();
    expect(screen.getByText("In the mail: “confirm your password”")).toBeTruthy();
    expect(screen.getByText(/1 reason of the model was left out/)).toBeTruthy();
    // The facts, strongest first, with codes the app does not know yet shown as they are.
    expect(screen.getByText(/rather spam/)).toBeTruthy();
    const facts = within(screen.getByRole("list", { name: "What the facts say" })).getAllByRole("listitem");
    expect(facts.map((item) => item.textContent)).toEqual([
      "Link imitates a known brandpaypa1.example looks like PayPal+3.0",
      "DMARC failed: the sender may be forged" + "bank.example" + "+2.0",
      "SOMETHING_NEW-0.5",
    ]);
    expect(screen.getByText("4.2 of 5.0 points")).toBeTruthy();
    expect(screen.getByText("First mail from this address")).toBeTruthy();
    expect(screen.getByText("Not in your address book")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Spam" }));
    await waitFor(() => expect(fake.markSpam).toHaveBeenCalledWith(["e1"], true));
    expect(useAssistReader.getState().spamChecks.e1).toBeUndefined();
  });

  it("says how sure the model is in words and when the facts moved its verdict", async () => {
    const result = await fake.assistSpamCheck("e1");
    fake.assistSpamCheck.mockResolvedValueOnce({
      ...result,
      verdict: "suspicious",
      modelVerdict: "spam",
      confidence: 0.7,
    });
    act(() => useAssistReader.getState().showSpamCheck("e1"));
    renderWith(<SpamCheckCard message={message()} inJunk={false} />);
    expect(await screen.findByText("Suspicious")).toBeTruthy();
    expect(screen.getByText("fairly sure")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "How sure the model is" }).getAttribute("aria-valuetext")).toBe(
      "fairly sure",
    );
    expect(screen.getByText(/The model said “Spam”, but the facts don’t allow that/)).toBeTruthy();
  });
});
