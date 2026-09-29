import type { Address } from "@/backend/types";
import { convertWall, deviceTimeZone, type WallTime } from "@/lib/calendarDates";
import type { DetectedEvent } from "@/lib/dates";
import { useCalendarUi, type EditorRequest } from "../calendar/state";

/** The mail an appointment was found in, for the event's notes and its calendar. */
export interface MailOrigin {
  subject: string;
  from: Address;
  /** The mail's account: its default calendar is the first choice for the event. */
  accountId: string;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** At most this much of the mail goes into the notes. */
const MAX_QUOTE = 400;

/** The times as this device's clock shows them: the editor works in the device's zone. */
function onDeviceClock(event: DetectedEvent): { start: WallTime; end: WallTime } {
  const device = deviceTimeZone();
  if (event.allDay || !event.timeZone || event.timeZone === device) return { start: event.start, end: event.end };
  try {
    return {
      start: convertWall(event.start, event.timeZone, device),
      end: convertWall(event.end, event.timeZone, device),
    };
  } catch {
    // A zone this device doesn't know: the mail's own numbers.
    return { start: event.start, end: event.end };
  }
}

/**
 * A new event from what was found: title, times, place, and notes quoting the mail with its subject
 * and sender. The app has no address that opens a mail from elsewhere, so that is the way back.
 */
export function eventDraft(
  event: DetectedEvent,
  origin: MailOrigin,
  t: Translate,
): NonNullable<EditorRequest["draft"]> {
  const { start, end } = onDeviceClock(event);
  // By characters, so an emoji is never cut in half.
  const chars = Array.from(event.quote);
  const quote =
    chars.length > MAX_QUOTE
      ? `${chars
          .slice(0, MAX_QUOTE - 1)
          .join("")
          .trimEnd()}…`
      : event.quote;
  const sender = origin.from.name ? `${origin.from.name} <${origin.from.email}>` : origin.from.email;
  const notes = [
    event.description?.trim() || null,
    quote ? t("dates.notesQuote", { quote }) : null,
    t("dates.notesFrom", { subject: origin.subject || t("dates.noSubject"), sender }),
    // Only ever https (see lib/dates/merge).
    event.url,
  ].filter((line): line is string => Boolean(line));
  return {
    start,
    end,
    allDay: event.allDay,
    title: event.title,
    location: event.location ?? "",
    description: notes.join("\n\n"),
    accountId: origin.accountId,
  };
}

/** Opens the calendar's editor filled in; the person checks it and saves. */
export function openInCalendar(event: DetectedEvent, origin: MailOrigin, t: Translate): void {
  useCalendarUi.getState().openEditor({ occurrence: null, draft: eventDraft(event, origin, t) });
}
