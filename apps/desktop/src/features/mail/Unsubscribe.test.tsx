import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, UnsubscribeOutcome } from "@/backend/types";
import { i18n } from "@/i18n";
import { useSettings } from "@/state/settings";
import { useToasts } from "@/state/toasts";
import { ARMING_MS } from "./LinkWarning";
import { UnsubscribeButton } from "./Unsubscribe";

const fake = {
  unsubscribe: vi.fn(async (_id: string): Promise<UnsubscribeOutcome> => ({ kind: "done" })),
  inboxMessagesFrom: vi.fn(async () => []),
  archive: vi.fn(async () => []),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

const newsletter = (unsubscribe: Message["unsubscribe"]): Message => ({
  id: "m1",
  threadId: "t1",
  accountId: "acc",
  folderId: "inbox",
  from: { name: "Pixel Parts", email: "news@pixelparts.example" },
  to: [{ email: "mini@uwumail.example" }],
  cc: [],
  replyTo: [],
  subject: "Autumn newsletter",
  date: "2026-09-21T10:00:00Z",
  flags: { seen: true, flagged: false, answered: false, draft: false },
  snippet: "",
  bodyHtml: null,
  bodyText: "",
  hasRemoteContent: false,
  attachments: [],
  unsubscribe,
});

function renderButton(message: Message) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UnsubscribeButton message={message} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Unsubscribe" }));
}

const toasts = () => useToasts.getState().toasts.map((toast) => toast.message);

/** The page's clock, which the answer buttons read; it only moves when a test moves it. */
let clock = 0;
/** Time passes, as it does between reading a question and answering it. */
const later = () => {
  clock += ARMING_MS;
};

describe("unsubscribing", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    act(() => useToasts.setState({ toasts: [] }));
  });

  it("does it in one click, and names the mail that would go otherwise", async () => {
    renderButton(
      newsletter({ oneClick: true, url: "https://pixelparts.example/u", mailto: "mailto:leave@pixelparts.example" }),
    );
    expect(await screen.findByText(/asks the sender's server to take you off the list/)).toBeTruthy();
    expect(
      screen.getByText("If that doesn't work directly, a mail goes from you to leave@pixelparts.example."),
    ).toBeTruthy();
    expect(screen.queryByText("If it can't be done that way, the sender's own page opens.")).toBeNull();
    later();
    fireEvent.click(screen.getAllByRole("button", { name: "Unsubscribe" }).at(-1)!);
    await waitFor(() => expect(fake.unsubscribe).toHaveBeenCalledWith("m1"));
    await waitFor(() => expect(toasts()).toContain("Unsubscribed from Pixel Parts"));
  });

  it("says the page opens when one click is all the mail offers besides it", async () => {
    renderButton(newsletter({ oneClick: true, url: "https://pixelparts.example/u" }));
    expect(await screen.findByText("If it can't be done that way, the sender's own page opens.")).toBeTruthy();
  });

  it("doesn't take an answer from the gesture that asked (W-29)", async () => {
    renderButton(
      newsletter({ oneClick: true, url: "https://pixelparts.example/u", mailto: "mailto:leave@pixelparts.example" }),
    );
    const ask = (await screen.findAllByRole("button", { name: "Unsubscribe" })).at(-1)!;
    // The second click of a double click, and Enter held down on the button that opened the question.
    fireEvent.click(ask);
    const held = fireEvent.keyDown(ask, { key: "Enter", repeat: true });
    expect(held).toBe(false);
    expect(fake.unsubscribe).not.toHaveBeenCalled();

    later();
    fireEvent.click(ask);
    await waitFor(() => expect(fake.unsubscribe).toHaveBeenCalledTimes(1));
  });
});
