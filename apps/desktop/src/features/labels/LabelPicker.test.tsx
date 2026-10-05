import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistLabel, AssistLabelInput, AssistOptions, Message } from "@/backend/types";
import { i18n } from "@/i18n";
import type { LabelEntry } from "@/lib/labelFilter";
import { useToasts } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { LABEL_DEFAULTS } from "../assist/labels";
import { filterLabelEntries } from "./labelActions";
import { LabelPicker } from "./LabelPicker";

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

const label = (id: string, name: string, base: AssistLabel["base"] = null): AssistLabel => ({
  id,
  name,
  description: "",
  ...LABEL_DEFAULTS,
  keyword: name.toLowerCase(),
  color: null,
  base,
});

/** The UwUMail account's labels on its server, and this device's for the other mailbox. */
let server: AssistLabel[] = [];
let device: AssistLabel[] = [];
let maxLabels = 30;
/** The mail of each conversation. */
let threads: Record<string, Message[]> = {};

const mail = (id: string, accountId: string, keywords: string[]) =>
  ({ id, threadId: `t-${id}`, accountId, keywords }) as unknown as Message;

const fake = {
  listAccounts: vi.fn(async () => [
    { id: "acc", email: "mini@example.org" },
    { id: "other", email: "mini@example.net" },
  ]),
  assistScopes: vi.fn(async () => [
    { id: "acc", kind: "server", accountId: "acc", accountIds: ["acc"], options: { ...OPTIONS, maxLabels } },
    { id: "device", kind: "device", accountId: null, accountIds: ["other"], options: { ...OPTIONS, maxLabels } },
  ]),
  assistLabels: vi.fn(async (scope: string) => (scope === "acc" ? server : device)),
  getThread: vi.fn(async (id: string) => ({ thread: { id }, messages: threads[id] ?? [] })),
  setKeywords: vi.fn(async (ids: string[], change: Record<string, boolean>) => {
    for (const messages of Object.values(threads)) {
      for (const message of messages) {
        if (!ids.includes(message.id)) continue;
        for (const [keyword, on] of Object.entries(change)) {
          const others = (message.keywords ?? []).filter((each) => each !== keyword);
          message.keywords = on ? [...others, keyword] : others;
        }
      }
    }
  }),
  createAssistLabel: vi.fn(async (scope: string, input: AssistLabelInput) => {
    const made = { ...label(`n${server.length + device.length}`, input.name), color: input.color };
    if (scope === "acc") server = [...server, made];
    else device = [...device, made];
    return made;
  }),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function open(threadIds: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LabelPicker />
    </QueryClientProvider>,
  );
  act(() => useUi.getState().openLabeling({ threadIds }));
  return screen.getByRole("combobox", { name: "Find or create a label" });
}

const options = () => within(screen.getByRole("listbox", { name: "Labels" })).queryAllByRole("option");

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  vi.clearAllMocks();
  maxLabels = 30;
  server = [label("g1", "Invoice", "invoice"), label("g2", "Travel"), label("g3", "Trains")];
  device = [label("d1", "Hobby")];
  threads = {
    t1: [mail("m1", "acc", ["travel"]), mail("m2", "acc", [])],
    t2: [mail("m3", "acc", ["travel", "trains"])],
    t3: [mail("m4", "other", [])],
  };
});
afterEach(() => {
  act(() => useUi.getState().closeLabeling());
  cleanup();
});

describe("the quick label picker", () => {
  it("says for how many conversations, marks what is on and toggles by keyboard", async () => {
    const input = open(["t1", "t2"]);
    expect(screen.getByText(/For 2 conversations\. Enter or a click/)).toBeTruthy();
    // Only the labels the mail can carry: the server's, not this device's.
    await waitFor(() => expect(options().map((option) => option.textContent)).toEqual(["Invoice", "Travel", "Trains"]));
    const checked = options().map((option) => option.getAttribute("aria-checked"));
    expect(checked).toEqual(["false", "mixed", "mixed"]);
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(input));

    // Down to "Travel", Enter: it goes on where it is missing.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fake.setKeywords).toHaveBeenCalledWith(["m2"], { travel: true }));
    await waitFor(() => expect(options()[1]!.getAttribute("aria-checked")).toBe("true"));
    expect(useToasts.getState().toasts.map((each) => each.message)).toContain(
      "Label “Travel” added to 2 conversations",
    );

    // Enter again takes it off everywhere; Up wraps around to the last one.
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fake.setKeywords).toHaveBeenLastCalledWith(["m1", "m2", "m3"], { travel: false }));
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[2]!.id);
  });

  it("finds labels as typed, those starting with it first, and makes a new one in place", async () => {
    const input = open(["t1"]);
    expect(screen.getByText(/For 1 conversation\./)).toBeTruthy();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.change(input, { target: { value: "ai" } });
    // "Trains" holds it, "Invoice" doesn't; a name that is no label yet can be made.
    expect(options().map((option) => option.textContent)).toEqual(["Trains", "Create “ai”"]);
    fireEvent.change(input, { target: { value: "tr" } });
    expect(options().map((option) => option.textContent)).toEqual(["Travel", "Trains", "Create “tr”"]);
    // The same name in other letters is no new label.
    fireEvent.change(input, { target: { value: "TRAVEL " } });
    expect(options().map((option) => option.textContent)).toEqual(["Travel"]);

    fireEvent.change(input, { target: { value: "Clubs" } });
    fireEvent.click(screen.getByRole("option", { name: "Create “Clubs”" }));
    await waitFor(() =>
      expect(fake.createAssistLabel).toHaveBeenCalledWith("acc", expect.objectContaining({ name: "Clubs" })),
    );
    await waitFor(() => expect(fake.setKeywords).toHaveBeenCalledWith(["m1", "m2"], { clubs: true }));
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("makes no label for mail of two places, nor beyond the limit", async () => {
    let input = open(["t1", "t3"]);
    await waitFor(() => expect(options()).toHaveLength(4));
    fireEvent.change(input, { target: { value: "Clubs" } });
    expect(options()).toHaveLength(0);
    expect(screen.getByText("No label with this name.")).toBeTruthy();
    act(() => useUi.getState().closeLabeling());
    cleanup();

    // Base labels don't count toward the limit; own ones do.
    maxLabels = 2;
    input = open(["t1"]);
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.change(input, { target: { value: "Clubs" } });
    expect(options()).toHaveLength(0);
  });

  it("invites to type a name when there are no labels yet", async () => {
    server = [];
    const input = open(["t1"]);
    expect(await screen.findByText("No labels yet. Type a name to create one.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "Clubs" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fake.createAssistLabel).toHaveBeenCalledOnce());
  });
});

describe("filterLabelEntries", () => {
  it("puts names that start with the text first, then those holding it, ignoring case", () => {
    const entries: LabelEntry[] = ["Kabel", "Abo", "ab und zu", "Xylo"].map((name, index) => ({
      scope: "acc",
      accountIds: ["acc"],
      label: label(`l${index}`, name),
    }));
    expect(filterLabelEntries(entries, " AB ").map((entry) => entry.label.name)).toEqual(["Abo", "ab und zu", "Kabel"]);
    expect(filterLabelEntries(entries, "")).toHaveLength(4);
  });
});
