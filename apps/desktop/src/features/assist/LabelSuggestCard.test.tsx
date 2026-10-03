import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistLabel, AssistLabelSuggestion, AssistOptions, Message } from "@/backend/types";
import { i18n } from "@/i18n";
import type { LabelEntry } from "@/lib/labelFilter";
import { LABEL_DEFAULTS } from "./labels";
import { LabelSuggestCard, initialChoice, labelChanges } from "./LabelSuggestCard";
import { useAssistReader } from "./readerState";

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

const label = (id: string, name: string): AssistLabel => ({
  id,
  name,
  description: "",
  ...LABEL_DEFAULTS,
  keyword: name.toLowerCase(),
  color: null,
});
const LABELS = [label("l1", "Rechnungen"), label("l2", "Reisen")];

const SUGGESTION: AssistLabelSuggestion = {
  emailId: "m1",
  providerId: "p1",
  providerName: "Mistral (Server)",
  model: null,
  usage: null,
  verdicts: [
    { labelId: "l1", name: "Rechnungen", reason: "It is an invoice.", fits: true, isSet: false },
    { labelId: "l2", name: "Reisen", reason: "Nothing about travel.", fits: false, isSet: true },
  ],
  newLabels: [{ name: "Strom", description: "Power bills", color: "#f59e0b", reason: "A power company." }],
};

const fake = {
  listAccounts: vi.fn(async () => [{ id: "acc", email: "mini@example.org" }]),
  assistScopes: vi.fn(async () => [
    { id: "acc", kind: "server", accountId: "acc", accountIds: ["acc"], options: OPTIONS },
  ]),
  assistLabels: vi.fn(async () => LABELS),
  suggestLabels: vi.fn(async () => SUGGESTION),
  setKeywords: vi.fn(async () => {}),
  createAssistLabel: vi.fn(async (_scope: string, input: { name: string }) => ({
    ...label("l3", input.name),
    keyword: "strom",
  })),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

const mail = { id: "m1", threadId: "t1", accountId: "acc", keywords: ["reisen"] } as unknown as Message;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  vi.clearAllMocks();
  useAssistReader.setState({ labelChecks: { m1: true }, labelResults: {} });
});
afterEach(cleanup);

describe("label changes", () => {
  const entries: LabelEntry[] = LABELS.map((each) => ({ scope: "acc", accountIds: ["acc"], label: each }));

  it("starts with what fits and changes only what differs from the mail", () => {
    const choice = initialChoice(SUGGESTION);
    expect(choice).toEqual({ l1: true, l2: false });
    expect(labelChanges(mail, entries, choice)).toEqual({ rechnungen: true, reisen: false });
    expect(labelChanges(mail, entries, { l1: false, l2: true })).toEqual({});
  });
});

describe("Label again", () => {
  it("shows each label with its reason and applies the ticks", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <LabelSuggestCard message={mail} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("It is an invoice.")).toBeTruthy();
    expect(fake.suggestLabels).toHaveBeenCalledWith("m1", "en", true);
    expect(screen.getByText("Nothing about travel.")).toBeTruthy();
    expect(screen.getByText("set now")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() => expect(fake.setKeywords).toHaveBeenCalledWith(["m1"], { rechnungen: true, reisen: false }));
    await waitFor(() => expect(useAssistReader.getState().labelChecks).toEqual({}));
  });

  it("makes a proposed label and puts it on with one click", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <LabelSuggestCard message={mail} />
      </QueryClientProvider>,
    );
    const create = await screen.findByRole("button", { name: "Create and apply" });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(create);
    await waitFor(() =>
      expect(fake.createAssistLabel).toHaveBeenCalledWith("acc", {
        name: "Strom",
        description: "Power bills",
        color: "#f59e0b",
      }),
    );
    await waitFor(() => expect(fake.setKeywords).toHaveBeenCalledWith(["m1"], { strom: true }));
    expect(await screen.findByRole("button", { name: "Created and applied" })).toBeTruthy();
  });
});
