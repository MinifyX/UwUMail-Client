import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailScheduling, Message } from "@/backend/types";
import { i18n } from "@/i18n";
import { useSettings } from "@/state/settings";
import { formatInvitationTime, MailInvitationCard } from "./Invitation";

let found: MailScheduling | null = null;

const fake = {
  mailInvitation: vi.fn(async () => found),
  respondToInvitation: vi.fn(async () => {}),
  removeCancelledEvent: vi.fn(async () => {}),
  getSenderPicture: vi.fn(async () => null),
  senderPicture: vi.fn(async () => null),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

const invitation = (patch: Partial<MailScheduling> = {}): MailScheduling => ({
  kind: "invitation",
  method: "request",
  title: "Logo review",
  start: "2026-10-01T08:00:00Z",
  end: "2026-10-01T09:00:00Z",
  allDay: false,
  location: "Bright Labs, room 4",
  organizer: "Emma Vogt",
  organizerEmail: "emma@brightlabs.example",
  attendees: [
    { email: "emma@brightlabs.example", name: "Emma Vogt", status: "accepted" },
    { email: "mini@uwumail.example", name: "Mini", status: "needs-action" },
  ],
  moreAttendees: 0,
  repeats: false,
  occurrence: null,
  verified: true,
  sender: "emma@brightlabs.example",
  senderConfirmed: true,
  status: "needs-action",
  attendee: null,
  attendeeEmail: null,
  cancelled: false,
  revision: "new",
  inCalendar: false,
  place: "device",
  canAnswer: true,
  canComment: true,
  canRemove: false,
  ...patch,
});

const mail = (from: string): Message =>
  ({
    id: "m1",
    threadId: "t1",
    accountId: "acc",
    folderId: "inbox",
    from: { email: from },
    to: [{ email: "mini@uwumail.example" }],
    cc: [],
    replyTo: [],
    subject: "Logo review",
    date: "2026-09-21T10:00:00Z",
    flags: { seen: true, flagged: false, answered: false, draft: false },
    snippet: "",
    bodyHtml: null,
    bodyText: "",
    hasRemoteContent: false,
    attachments: [{ id: "a1", filename: "invite.ics", mimeType: "text/calendar", size: 400, inline: false }],
  }) as unknown as Message;

function renderCard(from: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MailInvitationCard message={mail(from)} />
    </QueryClientProvider>,
  );
}

describe("an invitation in a mail (WEBMAIL-2)", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("shows the event and sends the answer only on a click", async () => {
    found = invitation();
    renderCard("emma@brightlabs.example");
    expect(await screen.findByText("Invitation from Emma Vogt")).toBeTruthy();
    expect(screen.getByText("Bright Labs, room 4")).toBeTruthy();
    expect(
      screen.getByText(
        "You haven't answered yet. UwUMail keeps the event in the calendar “Invitations” on this device and tells the organizer by mail.",
      ),
    ).toBeTruthy();
    expect(fake.respondToInvitation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(fake.respondToInvitation).toHaveBeenCalledWith("m1", "accepted", undefined, "en"));
  });

  it("sends a comment along where the answer can carry one", async () => {
    found = invitation({ place: "microsoft" });
    renderCard("emma@brightlabs.example");
    fireEvent.click(await screen.findByRole("button", { name: "Add a comment" }));
    fireEvent.change(screen.getByLabelText("Comment for the organizer"), { target: { value: "  Running late  " } });
    fireEvent.click(screen.getByRole("button", { name: "Maybe" }));
    await waitFor(() => expect(fake.respondToInvitation).toHaveBeenCalledWith("m1", "tentative", "Running late", "en"));
  });

  it("offers no comment where the server answers without one", async () => {
    found = invitation({ place: "server", canComment: false });
    renderCard("emma@brightlabs.example");
    expect(await screen.findByRole("button", { name: "Decline" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a comment" })).toBeNull();
    expect(screen.getByText(/Your UwUMail server tells the organizer\./)).toBeTruthy();
  });

  it("lists who is invited, the organizer marked", async () => {
    found = invitation({ moreAttendees: 3 });
    renderCard("emma@brightlabs.example");
    fireEvent.click(await screen.findByText("Invited · 5"));
    expect(screen.getByText("· Organizer")).toBeTruthy();
    expect(screen.getByText("· no answer yet")).toBeTruthy();
    expect(screen.getByText("and 3 more")).toBeTruthy();
  });

  it("warns when the receiving server didn't vouch for the organizer's address", async () => {
    found = invitation({ senderConfirmed: false });
    renderCard("emma@brightlabs.example");
    expect(
      await screen.findByText(
        "The receiving mail server didn't confirm the sender's address. Only answer if you expected this invitation.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
  });

  it("doesn't believe a cancellation from someone else, and offers nothing", async () => {
    found = invitation({ method: "cancel", verified: false, sender: "emma@brightlabs-events.example" });
    renderCard("emma@brightlabs-events.example");
    expect(
      await screen.findByText(
        "This mail says the event is cancelled, but nothing confirms it comes from the event's organizer. Your calendar keeps the event as it is.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Sent by emma@brightlabs-events.example; the organizer is emma@brightlabs.example."),
    ).toBeTruthy();
    expect(screen.queryByText("The organizer cancelled this event.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove from calendar" })).toBeNull();
  });

  it("shows who sent an unverified mail as it is written, invisible characters too (W-34)", async () => {
    found = invitation({ verified: false, sender: "mallory‮@example.net" });
    renderCard("mallory‮@example.net");
    expect(
      await screen.findByText("Sent by mallory<U+202E>@example.net; the organizer is emma@brightlabs.example."),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Your answer" })).toBeNull();
  });

  it("offers to remove the organizer's cancellation from the calendar, on a click", async () => {
    found = invitation({ method: "cancel", cancelled: true, canAnswer: false, canRemove: true, inCalendar: true });
    renderCard("emma@brightlabs.example");
    expect(await screen.findByText("The organizer cancelled this event.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(fake.removeCancelledEvent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove from calendar" }));
    await waitFor(() => expect(fake.removeCancelledEvent).toHaveBeenCalledWith("m1"));
  });

  it("names single cancelled dates as such", async () => {
    found = invitation({
      method: "cancel",
      cancelled: true,
      canAnswer: false,
      canRemove: true,
      occurrence: "2026-10-08T08:00:00Z",
    });
    renderCard("emma@brightlabs.example");
    expect(await screen.findByText("The organizer cancelled this date.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove the date from calendar" })).toBeTruthy();
  });

  it("can't answer a mail the calendar already has a newer version of", async () => {
    found = invitation({ revision: "outdated", canAnswer: false, status: "accepted" });
    renderCard("emma@brightlabs.example");
    expect(
      await screen.findByText(
        "Your calendar already has a newer version of this event, so this mail can't be answered any more.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("says an update is one, and shows the answer so far", async () => {
    found = invitation({ revision: "update", status: "tentative", inCalendar: true });
    renderCard("emma@brightlabs.example");
    expect(
      await screen.findByText("The organizer changed this event. Your answer goes with the new version."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Maybe" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows an attendee's answer, and a stranger's as not counting", async () => {
    const reply = invitation({
      kind: "reply",
      method: "reply",
      title: "Game night",
      attendee: "Noah Zockt",
      attendeeEmail: "noah@zockt.example",
      status: "accepted",
      canAnswer: false,
    });
    found = reply;
    const first = renderCard("noah@zockt.example");
    expect(await screen.findByText("Noah Zockt accepted.")).toBeTruthy();
    first.unmount();

    found = { ...reply, verified: false, sender: "mallory@example.net" };
    renderCard("mallory@example.net");
    expect(
      await screen.findByText("This answer doesn't come from anyone invited to the event, so it doesn't count."),
    ).toBeTruthy();
    expect(screen.queryByText(/accepted\./)).toBeNull();
  });

  it("shows nothing for mail without an iCalendar part", async () => {
    found = invitation();
    const client = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={client}>
        <MailInvitationCard message={{ ...mail("emma@brightlabs.example"), attachments: [] }} />
      </QueryClientProvider>,
    );
    expect(container.textContent).toBe("");
    expect(fake.mailInvitation).not.toHaveBeenCalled();
  });
});

describe("invitation times", () => {
  it("writes days, spans and times", () => {
    expect(formatInvitationTime({ start: "2026-10-03", end: "2026-10-04", allDay: true }, "en")).toBe(
      "Saturday, October 3, 2026",
    );
    expect(formatInvitationTime({ start: "2026-10-03", end: "2026-10-06", allDay: true }, "en")).toBe(
      "Saturday, October 3, 2026 – Monday, October 5, 2026",
    );
    expect(
      formatInvitationTime({ start: "2026-10-03T09:00:00", end: "2026-10-03T10:30:00", allDay: false }, "en"),
    ).toBe("Saturday, October 3, 2026 at 9:00 AM – 10:30 AM");
    expect(formatInvitationTime({ start: "not a date", end: null, allDay: false }, "en")).toBeNull();
    expect(formatInvitationTime({ start: null, end: null, allDay: false }, "en")).toBeNull();
  });
});
