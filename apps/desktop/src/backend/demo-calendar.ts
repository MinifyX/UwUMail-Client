// The demo's calendars: the JMAP mailbox plays a UwUMail server with JMAP calendars, the
// Microsoft one has none (like the real engine). Everything is relative to today and kept in
// memory. Demo events are floating: their wall times are the same in every zone.

import { BackendError } from "./backend";
import type {
  CalendarAccount,
  CalendarInfo,
  CalendarOccurrence,
  EventDeleteScope,
  EventInput,
  Recurrence,
  Weekday,
} from "./types";

type Lang = "de" | "en";

interface StoredEvent {
  id: string;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  /** Wall times, `YYYY-MM-DDTHH:mm:ss`; all-day events at midnight, the end exclusive. */
  start: string;
  end: string;
  timeZone: string | null;
  recurrence: Recurrence | null;
  /** Recurrence ids of occurrences taken out of the series. */
  excluded: string[];
}

const WEEKDAYS: Weekday[] = ["su", "mo", "tu", "we", "th", "fr", "sa"];
/** Occurrences a series produces at most, like the engine's bounded expansion. */
const MAX_INSTANCES = 5000;
const DAY = 86_400_000;

/** Wall times as UTC-based milliseconds, so arithmetic never trips over daylight saving. */
function parse(text: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text.trim());
  if (!match) throw new BackendError("invalid_input", `"${text}" isn't a date and time.`);
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

function format(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

function today(): number {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

function addMonths(ms: number, months: number): number {
  const date = new Date(ms);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  // Like RFC 5545: the 31st of a month without one doesn't happen.
  const length = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  if (day > length) return Number.NaN;
  date.setUTCDate(day);
  return date.getTime();
}

/** The starts of a series from its first one on, bounded, as wall-time milliseconds. */
function* starts(first: number, rule: Recurrence): Generator<number> {
  const until = rule.until ? parse(rule.until) + DAY - 1 : Number.POSITIVE_INFINITY;
  const interval = Math.max(1, rule.interval);
  let produced = 0;
  const emit = (ms: number) => ms >= first && ms <= until && (rule.count === null || produced < rule.count);
  for (let step = 0; step < MAX_INSTANCES && produced < MAX_INSTANCES; step++) {
    let candidates: number[];
    switch (rule.frequency) {
      case "daily":
        candidates = [first + step * interval * DAY];
        break;
      case "weekly": {
        const weekStart = first - ((new Date(first).getUTCDay() + 6) % 7) * DAY + step * interval * 7 * DAY;
        const days = rule.byDay?.length ? rule.byDay : [WEEKDAYS[new Date(first).getUTCDay()]!];
        candidates = days.map((day) => weekStart + ((WEEKDAYS.indexOf(day) + 6) % 7) * DAY).sort((a, b) => a - b);
        break;
      }
      case "monthly":
        candidates = [addMonths(first, step * interval)];
        break;
      case "yearly":
        candidates = [addMonths(first, step * interval * 12)];
        break;
    }
    for (const candidate of candidates) {
      if (Number.isNaN(candidate)) continue;
      if (candidate > until || (rule.count !== null && produced >= rule.count)) return;
      if (emit(candidate)) {
        produced += 1;
        yield candidate;
      }
    }
  }
}

function check(input: EventInput) {
  if (input.title.length > 1024 || input.location.length > 1024) {
    throw new BackendError("invalid_input", "The title or place is too long.");
  }
  const start = parse(input.start);
  const end = parse(input.end);
  if (end < start) throw new BackendError("invalid_input", "The event ends before it starts.");
  if (input.recurrence && (input.recurrence.interval < 1 || input.recurrence.count === 0)) {
    throw new BackendError("invalid_input", "That repeat rule makes no sense.");
  }
  if (input.allDay) {
    const first = parse(input.start.slice(0, 10));
    const last = Math.max(parse(input.end.slice(0, 10)), first + DAY);
    return { start: format(first), end: format(last), timeZone: null };
  }
  return { start: format(start), end: format(end), timeZone: input.timeZone };
}

export class DemoCalendar {
  private calendarList: CalendarInfo[];
  private events: StoredEvent[];
  private nextId = 1;

  constructor(
    lang: Lang,
    private readonly changed: () => void,
  ) {
    const de = lang === "de";
    const calendar = (id: string, name: string, color: string, extra: Partial<CalendarInfo> = {}): CalendarInfo => ({
      id: `acc-private:${id}`,
      accountId: "acc-private",
      name,
      color,
      isDefault: false,
      isVisible: true,
      sortOrder: 0,
      mayWrite: true,
      mayDelete: true,
      ...extra,
    });
    this.calendarList = [
      calendar("personal", de ? "Privat" : "Personal", "#ec4899", { isDefault: true }),
      calendar("sport", "Sport", "#10b981", { sortOrder: 1 }),
      calendar("holidays", de ? "Feiertage" : "Holidays", "#f59e0b", {
        sortOrder: 2,
        mayWrite: false,
        mayDelete: false,
      }),
    ];
    const day = today();
    const at = (days: number, hours = 0, minutes = 0) => format(day + days * DAY + (hours * 60 + minutes) * 60_000);
    // The yoga class started a few weeks ago, on the weekday two days from now.
    const yogaDay = day + 2 * DAY - 28 * DAY;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
    const event = (
      fields: Omit<StoredEvent, "id" | "excluded" | "description" | "location"> & Partial<StoredEvent>,
    ) => ({
      id: `acc-private:e${this.nextId++}`,
      description: "",
      location: "",
      excluded: [],
      ...fields,
    });
    this.events = [
      event({
        calendarId: "acc-private:sport",
        title: "Yoga",
        location: de ? "Studio 3, Hinterhof" : "Studio 3, back yard",
        description: de ? "Matte nicht vergessen ✿" : "Don't forget the mat ✿",
        allDay: false,
        start: format(yogaDay + 18 * 3600_000),
        end: format(yogaDay + 19 * 3600_000),
        timeZone: zone,
        recurrence: {
          frequency: "weekly",
          interval: 1,
          byDay: [WEEKDAYS[new Date(yogaDay).getUTCDay()]!],
          until: null,
          count: null,
        },
      }),
      event({
        calendarId: "acc-private:personal",
        title: de ? "Call mit Emma (Bright Labs)" : "Call with Emma (Bright Labs)",
        location: "https://meet.brightlabs.example/uwu",
        allDay: false,
        start: at(1, 10),
        end: at(1, 10, 45),
        timeZone: zone,
        recurrence: null,
      }),
      event({
        calendarId: "acc-private:personal",
        title: de ? "Kaffee mit Leni" : "Coffee with Leni",
        location: "Kaffee & Kuchen",
        allDay: false,
        start: at(3, 15, 30),
        end: at(3, 17),
        timeZone: zone,
        recurrence: null,
      }),
      event({
        calendarId: "acc-private:personal",
        title: de ? "Noahs Geburtstag 🎂" : "Noah's birthday 🎂",
        allDay: true,
        start: at(5),
        end: at(6),
        timeZone: null,
        recurrence: { frequency: "yearly", interval: 1, byDay: null, until: null, count: null },
      }),
      event({
        calendarId: "acc-private:personal",
        title: de ? "Wochenende am See" : "Weekend at the lake",
        allDay: true,
        start: at(9),
        end: at(12),
        timeZone: null,
        recurrence: null,
      }),
      event({
        calendarId: "acc-private:holidays",
        title: de ? "Brückentag" : "Bridge day",
        allDay: true,
        start: at(14),
        end: at(15),
        timeZone: null,
        recurrence: null,
      }),
    ];
  }

  accounts(accountIds: string[]): CalendarAccount[] {
    return accountIds.map((accountId) =>
      accountId === "acc-private"
        ? { accountId, source: "jmap", caldavUrl: null, problem: null, checked: true }
        : {
            accountId,
            source: null,
            caldavUrl: null,
            problem: "Calendars aren't available for mailboxes signed in with Microsoft or Google.",
            checked: true,
          },
    );
  }

  calendars(): CalendarInfo[] {
    return structuredClone(this.calendarList);
  }

  private calendar(id: string): CalendarInfo {
    const calendar = this.calendarList.find((c) => c.id === id);
    if (!calendar) throw new BackendError("not_found", "This calendar no longer exists.");
    return calendar;
  }

  private writable(id: string): CalendarInfo {
    const calendar = this.calendar(id);
    if (!calendar.mayWrite) throw new BackendError("invalid_input", "This calendar is read-only.");
    return calendar;
  }

  createCalendar(input: { accountId?: string; name: string; color: string | null }): CalendarInfo {
    const accountId = input.accountId ?? "acc-private";
    if (accountId !== "acc-private") {
      throw new BackendError(
        "not_supported",
        "Calendars aren't available for mailboxes signed in with Microsoft or Google.",
      );
    }
    const name = input.name.trim();
    if (!name || name.length > 200)
      throw new BackendError("invalid_input", "Give the calendar a name of up to 200 characters.");
    const calendar: CalendarInfo = {
      id: `${accountId}:c${this.nextId++}`,
      accountId,
      name,
      color: input.color,
      isDefault: false,
      isVisible: true,
      sortOrder: this.calendarList.length,
      mayWrite: true,
      mayDelete: true,
    };
    this.calendarList.push(calendar);
    this.changed();
    return structuredClone(calendar);
  }

  updateCalendar(id: string, patch: { name?: string; color?: string | null; isVisible?: boolean }) {
    const calendar = this.calendar(id);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new BackendError("invalid_input", "Give the calendar a name of up to 200 characters.");
      calendar.name = name;
    }
    if (patch.color !== undefined) calendar.color = patch.color;
    if (patch.isVisible !== undefined) calendar.isVisible = patch.isVisible;
    this.changed();
  }

  deleteCalendar(id: string) {
    const calendar = this.calendar(id);
    if (!calendar.mayDelete) throw new BackendError("invalid_input", "This calendar can't be deleted.");
    this.calendarList = this.calendarList.filter((c) => c.id !== id);
    this.events = this.events.filter((event) => event.calendarId !== id);
    if (calendar.isDefault) {
      const next = this.calendarList.find((c) => c.accountId === calendar.accountId && c.mayWrite);
      if (next) next.isDefault = true;
    }
    this.changed();
  }

  setDefaultCalendar(id: string) {
    const calendar = this.writable(id);
    for (const other of this.calendarList) {
      if (other.accountId === calendar.accountId) other.isDefault = other.id === id;
    }
    this.changed();
  }

  occurrences(from: string, to: string): CalendarOccurrence[] {
    const [rangeStart, rangeEnd] = [parse(from), parse(to)];
    if (rangeEnd <= rangeStart) throw new BackendError("invalid_input", "The range ends before it starts.");
    if (rangeEnd - rangeStart > 400 * DAY)
      throw new BackendError("invalid_input", "At most 400 days of events at once.");
    const found: CalendarOccurrence[] = [];
    for (const event of this.events) {
      const calendar = this.calendarList.find((c) => c.id === event.calendarId);
      if (!calendar) continue;
      const first = parse(event.start);
      const length = parse(event.end) - first;
      const instances = event.recurrence ? starts(first, event.recurrence) : [first];
      for (const start of instances) {
        if (start >= rangeEnd) break;
        const recurrenceId = event.recurrence ? format(start) : null;
        if (start + length <= rangeStart || (recurrenceId && event.excluded.includes(recurrenceId))) continue;
        found.push({
          id: recurrenceId ? `${event.id}#${recurrenceId}` : event.id,
          eventId: event.id,
          accountId: calendar.accountId,
          calendarId: calendar.id,
          title: event.title,
          description: event.description,
          location: event.location,
          allDay: event.allDay,
          start: format(start),
          end: format(start + length),
          timeZone: event.timeZone,
          recurrence: structuredClone(event.recurrence),
          recurrenceEditable: true,
          recurrenceId,
          readOnly: !calendar.mayWrite,
          color: null,
        });
      }
    }
    return found.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  }

  createEvent(input: EventInput): string {
    const calendar = this.writable(input.calendarId);
    const times = check(input);
    const event: StoredEvent = {
      id: `${calendar.accountId}:e${this.nextId++}`,
      calendarId: calendar.id,
      title: input.title.trim(),
      description: input.description,
      location: input.location.trim(),
      allDay: input.allDay,
      ...times,
      recurrence: structuredClone(input.recurrence),
      excluded: [],
    };
    this.events.push(event);
    this.changed();
    return event.id;
  }

  private stored(eventId: string): StoredEvent {
    const event = this.events.find((e) => e.id === eventId);
    if (!event) throw new BackendError("not_found", "This event no longer exists.");
    return event;
  }

  updateEvent(eventId: string, input: EventInput, occurrenceStart?: string) {
    const event = this.stored(eventId);
    this.writable(event.calendarId);
    this.writable(input.calendarId);
    const times = check(input);
    if (event.recurrence && occurrenceStart) {
      // The series moves by as much as the edited occurrence did, instead of onto its date.
      const length = parse(times.end) - parse(times.start);
      const days = parse(input.start.slice(0, 10)) - parse(occurrenceStart.slice(0, 10));
      const first = input.allDay
        ? parse(event.start.slice(0, 10)) + days
        : event.allDay
          ? parse(event.start.slice(0, 10)) + days + (parse(times.start) - parse(times.start.slice(0, 10)))
          : parse(event.start) + (parse(input.start) - parse(occurrenceStart));
      times.start = format(first);
      times.end = format(first + length);
    }
    Object.assign(event, {
      calendarId: input.calendarId,
      title: input.title.trim(),
      description: input.description,
      location: input.location.trim(),
      allDay: input.allDay,
      ...times,
      recurrence: structuredClone(input.recurrence),
    });
    this.changed();
  }

  deleteEvent(occurrenceId: string, scope: EventDeleteScope) {
    const [eventId, recurrenceId] = occurrenceId.split("#");
    const event = this.stored(eventId!);
    this.writable(event.calendarId);
    if (scope === "occurrence" && recurrenceId) event.excluded.push(recurrenceId);
    else this.events = this.events.filter((e) => e.id !== event.id);
    this.changed();
  }
}
