import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistEventsResult, CalendarInfo, ImageTextResult, Message } from "@/backend/types";
import { i18n } from "@/i18n";
import { deviceTimeZone } from "@/lib/calendarDates";
import { detectEvents, type DetectedEvent } from "@/lib/dates";
import { useSettings } from "@/state/settings";
import { EventEditor } from "../calendar/EventEditor";
import { useCalendarUi } from "../calendar/state";
import { eventDraft, openInCalendar } from "./addToCalendar";
import { useDismissedDates } from "./dismissed";
import { EventsBar } from "./EventsBar";
import { swappedDay, whenLabel } from "./format";
import { useMailEvents, type MailEvents } from "./useMailEvents";

const CALENDARS: CalendarInfo[] = [
  {
    id: "home",
    accountId: "acc",
    name: "Home",
    color: "#ff4d8d",
    isDefault: true,
    isVisible: true,
    sortOrder: 0,
    mayWrite: true,
    mayDelete: true,
  },
];

const fake = {
  listAccounts: vi.fn(async () => [{ id: "acc", name: "Private", email: "mini@example.org" }]),
  calendarsAvailable: vi.fn(async () => true),
  calendars: vi.fn(async () => CALENDARS),
  createEvent: vi.fn(async () => "new"),
  imageText: vi.fn(async (): Promise<ImageTextResult> => ({
    emailId: "m1",
    unavailable: false,
    images: [{ source: "cid:poster@shop.example", text: "HERBSTFEST\nSa 17.10. · 14–18 Uhr", width: 1, height: 1 }],
    skipped: 0,
  })),
  assistFeatures: vi.fn(async () => ({
    compose: false,
    summarize: false,
    spamCheck: false,
    extractEvents: true,
    autoLabels: false,
  })),
  extractEvents: vi.fn(async (): Promise<AssistEventsResult> => ({
    events: [
      {
        title: "Lesung mit Leni",
        start: "2026-10-16T19:30:00",
        end: "2026-10-16T21:30:00",
        allDay: false,
        timeZone: null,
        location: "Café Lindenblüte",
        description: null,
        url: null,
        participants: [],
        confidence: 0.9,
        quote: "Lesung am Freitag",
      },
    ],
  })),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

const REFERENCE = "2026-09-29T10:00:00";
const NOW = new Date(2026, 8, 29, 10);

function event(text: string): DetectedEvent {
  const [found] = detectEvents(text, { reference: REFERENCE, subject: "Hallo", locale: "de-DE" });
  return found!;
}

function message(patch: Partial<Message> = {}): Message {
  return {
    id: "m1",
    threadId: "t1",
    accountId: "a1",
    folderId: "inbox",
    from: { name: "Mia Mood", email: "mia@mood.example" },
    to: [],
    cc: [],
    replyTo: [],
    subject: "Lesung",
    date: new Date(2026, 8, 29, 10).toISOString(),
    flags: { seen: true, flagged: false, answered: false, draft: false },
    snippet: "",
    bodyHtml: null,
    bodyText: "Lesung am Freitag, 16.10. um 19:30 Uhr im Café Lindenblüte.",
    hasRemoteContent: false,
    attachments: [],
    ...patch,
  };
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
  useSettings.getState().update({ tone: "neutral" });
});
beforeEach(() => {
  vi.clearAllMocks();
  useSettings.getState().update({ detectEvents: true, assistRefineEvents: false });
  useDismissedDates.getState().clear();
});
afterEach(() => {
  cleanup();
  act(() => useCalendarUi.setState({ editor: null }));
});

describe("whenLabel", () => {
  it("writes ranges and times short, the year only when it isn't this one", () => {
    expect(whenLabel(event("Deals vom 6. – 9. Okt"), "de-DE", NOW)).toBe("6.–9. Okt.");
    expect(whenLabel(event("Deals Oct 6–9"), "en-US", NOW)).toMatch(/^Oct 6\s–\s9$/u);
    expect(whenLabel(event("Party am Freitag, 16.10. um 19:30 Uhr"), "de-DE", NOW)).toBe("Fr., 16. Okt., 19:30");
    expect(whenLabel(event("Party am 16.10. von 19 bis 22 Uhr"), "de-DE", NOW)).toMatch(
      /^Fr\., 16\. Okt\., 19:00\s?–\s?22:00/,
    );
    expect(whenLabel(event("Messe am 3.2.2027"), "de-DE", NOW)).toBe("Mi., 3. Feb. 2027");
  });

  it("names the other reading of a day that could be the month", () => {
    expect(swappedDay({ start: "2026-12-10T15:00:00" }, "en-US")).toBe("October 12, 2026");
    expect(swappedDay({ start: "2026-12-20T15:00:00" }, "en-US")).toBeNull();
    expect(swappedDay({ start: "2026-05-05T15:00:00" }, "en-US")).toBeNull();
  });
});

describe("eventDraft", () => {
  const origin = { subject: "Lesung 📚", from: { name: "Mia", email: "mia@mood.example" }, accountId: "a1" };
  const t = (key: string, options?: Record<string, unknown>) => `${key}${options ? JSON.stringify(options) : ""}`;

  it("fills title, times, place, the mail's account and notes with the quote, subject and sender", () => {
    const draft = eventDraft(event("Lesung am Freitag, 16.10. um 19:30 Uhr im Café Lindenblüte."), origin, t);
    expect(draft).toMatchObject({
      title: "Lesung",
      start: "2026-10-16T19:30:00",
      end: "2026-10-16T20:30:00",
      allDay: false,
      location: "Café Lindenblüte",
      accountId: "a1",
    });
    expect(draft.description).toContain("dates.notesQuote");
    expect(draft.description).toContain('"subject":"Lesung 📚"');
    expect(draft.description).toContain('"sender":"Mia <mia@mood.example>"');
  });

  it("adds the appointment's own link", () => {
    const found = event("Party am 16.10. um 19 Uhr");
    expect(eventDraft({ ...found, url: "https://shop.example/tickets" }, origin, t).description).toContain(
      "https://shop.example/tickets",
    );
  });

  it("moves a time in another zone onto this device's clock", () => {
    const found = event("Webinar on Oct 6 at 3pm UTC");
    const draft = eventDraft(found, origin, t);
    const offset = -new Date("2026-10-06T15:00:00Z").getTimezoneOffset();
    const expected = new Date(Date.UTC(2026, 9, 6, 15) + offset * 60_000).toISOString().slice(0, 19);
    expect(found.timeZone).toBe("Etc/UTC");
    expect(draft.start).toBe(deviceTimeZone() === "Etc/UTC" ? "2026-10-06T15:00:00" : expected);
  });

  it("cuts a long quote without splitting an emoji", () => {
    const long = { ...event("Party am 16.10. um 19 Uhr"), quote: "🎉".repeat(500) };
    const quote = /notesQuote\{"quote":"([^"]*)"\}/u.exec(eventDraft(long, origin, t).description!)![1]!;
    expect(Array.from(quote)).toHaveLength(400);
    expect(quote.endsWith("🎉…")).toBe(true);
  });
});

function found(events: DetectedEvent[], patch: Partial<MailEvents> = {}): MailEvents {
  return {
    events,
    marks: [],
    textEvents: events,
    canRefine: false,
    refining: false,
    refined: false,
    refineFailed: false,
    refine: vi.fn(),
    ...patch,
  };
}

describe("EventsBar", () => {
  const future = (text: string) => ({ ...event(text), past: false, end: "2099-01-01T00:00:00" });

  it("offers a single appointment right away", () => {
    const onAdd = vi.fn();
    render(<EventsBar messageId="m1" found={found([future("Pixel Days vom 6. – 9. Okt")])} onAdd={onAdd} />);
    const bar = screen.getByRole("region", { name: "Appointments in this mail" });
    expect(within(bar).getByText("Pixel Days")).toBeTruthy();
    fireEvent.click(within(bar).getByRole("button", { name: "Add to calendar" }));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Pixel Days" }));
  });

  it("folds several and lists them on request", () => {
    const events = [future("Lesung am 16.10. um 19 Uhr"), future("Kino am 20.10. um 20 Uhr")];
    render(<EventsBar messageId="m1" found={found(events)} onAdd={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: /2 appointments found/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(screen.getByRole("list")).getAllByRole("button", { name: /^Add .* to the calendar$/ })).toHaveLength(
      2,
    );
  });

  it("shows nothing for what's over, and stays away once put away for the mail", () => {
    const { rerender } = render(
      <EventsBar
        messageId="m1"
        found={found([{ ...future("Party am 16.10."), end: "2000-01-01T00:00:00" }])}
        onAdd={vi.fn()}
      />,
    );
    expect(screen.queryByRole("region")).toBeNull();
    rerender(<EventsBar messageId="m1" found={found([future("Party am 16.10.")])} onAdd={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide for this mail" }));
    expect(screen.queryByRole("region")).toBeNull();
    rerender(<EventsBar messageId="m2" found={found([future("Party am 16.10.")])} onAdd={vi.fn()} />);
    expect(screen.getByRole("region")).toBeTruthy();
  });

  it("asks the assistant only on a click, and only where it can", () => {
    const refine = vi.fn();
    const { rerender } = render(
      <EventsBar messageId="m1" found={found([future("Party am 16.10.")])} onAdd={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Check with AI" })).toBeNull();
    rerender(
      <EventsBar
        messageId="m1"
        found={found([future("Party am 16.10.")], { canRefine: true, refine })}
        onAdd={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Check with AI" }));
    expect(refine).toHaveBeenCalledOnce();
  });
});

describe("useMailEvents", () => {
  const options = { open: true, allowRemote: false, inJunk: false };

  it("finds the text's dates, reads the pictures, and never asks the assistant by itself", async () => {
    const mail = message({ bodyHtml: '<p>Lesung am 16.10. um 19:30 Uhr</p><img src="cid:poster@shop.example">' });
    const { result } = renderHook(() => useMailEvents(mail, options), { wrapper: wrapper() });
    // Once it's known there is a calendar to offer them for.
    await waitFor(() => expect(result.current.textEvents).toHaveLength(1));
    expect(result.current.marks).toHaveLength(1);
    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(fake.imageText).toHaveBeenCalledWith("m1", false);
    // The assistant is asked about the mail's own account.
    await waitFor(() => expect(fake.assistFeatures).toHaveBeenCalledWith("a1"));
    expect(result.current.events.map((found) => found.source)).toEqual(["text", "image"]);
    await waitFor(() => expect(result.current.canRefine).toBe(true));
    expect(fake.extractEvents).not.toHaveBeenCalled();

    act(() => result.current.refine());
    await waitFor(() => expect(result.current.refined).toBe(true));
    expect(fake.extractEvents).toHaveBeenCalledWith("m1", true);
    expect(result.current.events[0]).toMatchObject({ refined: true, end: "2026-10-16T21:30:00" });
  });

  it("reads remote pictures only once they may load", async () => {
    const mail = message({
      bodyHtml: '<p>Party am 16.10.</p><img src="https://shop.example/poster.png">',
      hasRemoteContent: true,
    });
    const blocked = renderHook(() => useMailEvents(mail, options), { wrapper: wrapper() });
    await waitFor(() => expect(blocked.result.current.textEvents).toHaveLength(1));
    expect(fake.imageText).not.toHaveBeenCalled();
    blocked.unmount();
    const allowed = renderHook(() => useMailEvents(mail, { ...options, allowRemote: true }), { wrapper: wrapper() });
    await waitFor(() => expect(fake.imageText).toHaveBeenCalledWith("m1", true));
    allowed.unmount();
  });

  it("asks the assistant on its own only with assist.refineEvents", async () => {
    useSettings.getState().update({ assistRefineEvents: true });
    const { result } = renderHook(() => useMailEvents(message(), options), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.refined).toBe(true));
    expect(fake.extractEvents).toHaveBeenCalledWith("m1", false);
    // Plain text has no pictures to read.
    expect(fake.imageText).not.toHaveBeenCalled();
  });

  it("finds nothing in a picture where nothing can read it", async () => {
    fake.imageText.mockResolvedValueOnce({ emailId: "m1", unavailable: true, images: [], skipped: 0 });
    const mail = message({ bodyHtml: '<p>Hallo</p><img src="cid:poster@shop.example">' });
    const { result } = renderHook(() => useMailEvents(mail, options), { wrapper: wrapper() });
    await waitFor(() => expect(fake.imageText).toHaveBeenCalled());
    await waitFor(() => expect(result.current.canRefine).toBe(true));
    expect(result.current.events).toEqual([]);
  });

  it("offers the dates of a mail with an invitation, since the app has no invitation card", async () => {
    const mail = message({
      attachments: [{ id: "a", filename: "invite.ics", mimeType: "text/calendar", size: 1, inline: false }],
    } as Partial<Message>);
    const { result } = renderHook(() => useMailEvents(mail, options), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.events).toHaveLength(1));
  });

  it("stays quiet when switched off, in junk and for drafts", async () => {
    const quiet = [
      { mail: message(), options, before: () => useSettings.getState().update({ detectEvents: false }) },
      { mail: message(), options: { ...options, inJunk: true } },
      { mail: message({ flags: { seen: true, flagged: false, answered: false, draft: true } }), options },
    ];
    for (const { mail, options: given, before } of quiet) {
      before?.();
      const { result, unmount } = renderHook(() => useMailEvents(mail, given), { wrapper: wrapper() });
      await waitFor(() => expect(fake.calendarsAvailable).toHaveBeenCalled());
      expect(result.current.events).toEqual([]);
      unmount();
      useSettings.getState().update({ detectEvents: true });
    }
    expect(fake.assistFeatures).not.toHaveBeenCalled();
    expect(fake.extractEvents).not.toHaveBeenCalled();
  });
});

describe("into the calendar", () => {
  it("opens the editor filled in, and saves what the person confirms", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <EventEditor />
      </QueryClientProvider>,
    );
    const t = i18n.getFixedT("en", "neutral");
    act(() =>
      openInCalendar(
        event("Lesung am Freitag, 16.10. um 19:30 Uhr im Café Lindenblüte."),
        { subject: "Lesung", from: { email: "mia@mood.example" }, accountId: "acc" },
        t,
      ),
    );
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByLabelText<HTMLSelectElement>("Calendar").value).toBe("home"));
    expect(within(dialog).getByLabelText<HTMLInputElement>("Title").value).toBe("Lesung");
    expect(within(dialog).getByLabelText<HTMLInputElement>("Location").value).toBe("Café Lindenblüte");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fake.createEvent).toHaveBeenCalledOnce());
    expect(fake.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "home",
        title: "Lesung",
        location: "Café Lindenblüte",
        start: "2026-10-16T19:30:00",
        end: "2026-10-16T20:30:00",
        allDay: false,
        description: expect.stringContaining("From the mail “Lesung” by mia@mood.example"),
      }),
    );
  });
});
