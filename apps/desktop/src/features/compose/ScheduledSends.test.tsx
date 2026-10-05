import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, OutgoingMessage, ScheduledSend, SendLaterInfo } from "@/backend/types";
import { i18n } from "@/i18n";
import { useToasts } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { SendLaterDialog } from "./SendLater";
import { ScheduledNavItem } from "./ScheduledSends";

const account = (id: string, email: string): Account => ({
  id,
  name: "Test",
  email,
  displayName: "Mini",
  color: "pink",
  auth: "password",
  status: { state: "idle" },
  protocol: "imap",
  protocols: ["imap"],
});

const inTwoHours = new Date(Date.now() + 2 * 3_600_000).toISOString();

let sends: ScheduledSend[] = [];
const stopScheduled = vi.fn(async () => {});
const sendScheduledNow = vi.fn(async () => {});
const rescheduleSend = vi.fn(async () => {});
const editScheduled = vi.fn(async (): Promise<OutgoingMessage> => ({
  accountId: "a1",
  to: [{ email: "kim@uwumail.example" }],
  cc: [],
  bcc: [],
  subject: "Angebot",
  html: "<p>Hi</p>",
  text: "Hi",
  attachments: [],
}));
const sendLaterInfo = vi.fn(async (): Promise<SendLaterInfo> => ({ kind: "local", maxDelaySeconds: 365 * 86_400 }));

vi.mock("@/backend/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/backend/backend")>()),
  backend: () => ({
    listAccounts: () =>
      Promise.resolve([account("a1", "mini@uwumail.example"), account("a2", "studio@uwumail.example")]),
    scheduledSends: () => Promise.resolve(sends),
    subscribe: () => () => {},
    stopScheduled,
    sendScheduledNow,
    rescheduleSend,
    editScheduled,
    sendLaterInfo,
  }),
}));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ScheduledNavItem />
    </QueryClientProvider>,
  );
}

async function openList() {
  fireEvent.click(await screen.findByRole("button", { name: /Scheduled/ }));
  return dialogTitled("Scheduled mail");
}

async function dialogTitled(name: string) {
  return (await screen.findByRole("heading", { name })).closest("dialog")!;
}

describe("scheduled mail", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    useToasts.setState({ toasts: [] });
    useUi.setState({ compose: null });
    sends = [
      {
        id: "s-local",
        accountId: "a1",
        kind: "local",
        sendAt: inTwoHours,
        subject: "Angebot",
        to: [{ name: "Kim", email: "kim@uwumail.example" }],
      },
      {
        id: "s-server",
        accountId: "a2",
        kind: "server",
        sendAt: inTwoHours,
        subject: "",
        to: [{ email: "lu@uwumail.example" }],
        retrying: true,
      },
    ];
  });

  afterEach(cleanup);

  it("isn't in the folder list while nothing waits", async () => {
    sends = [];
    setup();
    await waitFor(() => expect(screen.queryByRole("button", { name: /Scheduled/ })).toBeNull());
  });

  it("lists what waits, where it waits and who it goes to", async () => {
    setup();
    expect(await screen.findByText("2")).toBeTruthy();
    const dialog = await openList();
    expect(within(dialog).getByText("Angebot")).toBeTruthy();
    expect(within(dialog).getByText("To Kim")).toBeTruthy();
    expect(within(dialog).getByText("On this device")).toBeTruthy();
    expect(within(dialog).getByText("On the server")).toBeTruthy();
    expect(within(dialog).getByText(/Server not reachable/)).toBeTruthy();
    expect(await within(dialog).findByText(/studio@uwumail\.example/)).toBeTruthy();
  });

  it("shows a mail that couldn't go or may have gone out as waiting for you (SL-3/SL-4)", async () => {
    sends = [
      { ...sends[0]!, held: "failed", heldReason: "Sending failed: offline" },
      { ...sends[0]!, id: "s-unsure", subject: "Rechnung", held: "unsure", heldReason: "The connection broke off." },
    ];
    setup();
    const dialog = await openList();
    expect(within(dialog).getByText(/Not sent: Sending failed: offline It waits here/)).toBeTruthy();
    expect(within(dialog).getByText(/May have gone out: The connection broke off\./)).toBeTruthy();
  });

  it("sends one now and stops another into Drafts", async () => {
    setup();
    const dialog = await openList();
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Send now" })[0]!);
    await waitFor(() =>
      expect(sendScheduledNow).toHaveBeenCalledWith(expect.objectContaining({ id: "s-local", kind: "local" })),
    );
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Don't send" })[1]!);
    await waitFor(() =>
      expect(stopScheduled).toHaveBeenCalledWith(expect.objectContaining({ id: "s-server", accountId: "a2" })),
    );
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.message)).toContain("Not sent. The mail is back in Drafts."),
    );
  });

  it("gives one a new time", async () => {
    setup();
    const dialog = await openList();
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Change time" })[0]!);
    const picker = await dialogTitled("Send later");
    fireEvent.click(within(picker).getByRole("button", { name: /Tomorrow morning/ }));
    await waitFor(() =>
      expect(rescheduleSend).toHaveBeenCalledWith(expect.objectContaining({ id: "s-local" }), expect.any(String)),
    );
    const [, sendAt] = rescheduleSend.mock.calls[0] as unknown as [unknown, string];
    expect(new Date(sendAt).getHours()).toBe(8);
  });

  it("opens one in the composer to edit it", async () => {
    setup();
    const dialog = await openList();
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Edit" })[0]!);
    await waitFor(() => expect(useUi.getState().compose?.restore?.subject).toBe("Angebot"));
    expect(editScheduled).toHaveBeenCalledWith(expect.objectContaining({ id: "s-local" }));
  });

  it("reports what went wrong", async () => {
    sendScheduledNow.mockRejectedValueOnce(new Error("This mail is already on its way."));
    setup();
    const dialog = await openList();
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Send now" })[0]!);
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.message)).toContain(
        "That didn't work: This mail is already on its way.",
      ),
    );
  });
});

describe("the send later dialog", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(cleanup);

  const show = (info: SendLaterInfo, onPick = vi.fn()) => {
    render(<SendLaterDialog open info={info} onClose={() => {}} onPick={onPick} />);
    return onPick;
  };

  it("says that this device has to be running for mailboxes without a UwUMail server", () => {
    show({ kind: "local", maxDelaySeconds: 365 * 86_400 });
    expect(screen.getByTestId("later-where").textContent).toMatch(/waits on this device/);
  });

  it("says the server sends it for UwUMail mailboxes", () => {
    show({ kind: "server", maxDelaySeconds: 30 * 86_400 });
    expect(screen.getByTestId("later-where").textContent).toMatch(/UwUMail server sends it/);
  });

  it("refuses a time beyond what the mailbox holds, naming who holds it", () => {
    const onPick = show({ kind: "local", maxDelaySeconds: 86_400 });
    const far = new Date(Date.now() + 3 * 86_400_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const value = `${far.getFullYear()}-${pad(far.getMonth() + 1)}-${pad(far.getDate())}T08:00`;
    fireEvent.change(screen.getByLabelText("Pick a date and time"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(screen.getByRole("alert").textContent).toBe("UwUMail holds mail for at most 1 days.");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("takes a quick choice at once", () => {
    const onPick = show({ kind: "server", maxDelaySeconds: 30 * 86_400 });
    fireEvent.click(screen.getByRole("button", { name: /Tomorrow afternoon/ }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(new Date(onPick.mock.calls[0]![0] as string).getHours()).toBe(13);
  });
});
