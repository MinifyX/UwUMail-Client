import { useState, type ReactNode } from "react";
import type { Message } from "@/backend/types";
import { useT } from "@/i18n";
import type { DetectedEvent, Mark } from "@/lib/dates";
import type { Anchor } from "../calendar/state";
import { openInCalendar } from "./addToCalendar";
import { DatePopover, EventsBar } from "./EventsBar";
import type { DateReport } from "./frameDates";
import { useMailEvents, type MailEventsOptions } from "./useMailEvents";

export interface MailDates {
  /** Above the mail: the appointments found in it, or nothing. */
  bar: ReactNode;
  /** For MessageBody: the dates to underline and where their clicks go. */
  body: { dateMarks: readonly Mark[]; onDate: DateReport };
  /** The card for an underlined date that was clicked, or nothing. */
  popover: ReactNode;
}

/**
 * Everything the reader needs for the appointments in one mail, so MessageView only places three
 * pieces: the bar, the body's marks, and the popover.
 */
export function useMailDates(message: Message, options: MailEventsOptions): MailDates {
  const { t } = useT();
  const found = useMailEvents(message, options);
  const [shown, setShown] = useState<{ index: number; anchor: Anchor } | null>(null);
  // The underlined hit, with whatever the picture or the assistant added to it.
  const hit = shown ? found.textEvents[shown.index] : undefined;
  const event = hit
    ? (found.events.find((candidate) => candidate.source === "text" && candidate.from === hit.from) ?? hit)
    : undefined;
  const add = (picked: DetectedEvent) => {
    setShown(null);
    openInCalendar(picked, { subject: message.subject, from: message.from, accountId: message.accountId }, t);
  };
  return {
    bar: <EventsBar messageId={message.id} accountId={message.accountId} found={found} onAdd={add} />,
    body: {
      dateMarks: found.marks,
      onDate: (index, anchor) => setShown(index === null ? null : { index, anchor }),
    },
    popover:
      shown && event ? (
        <DatePopover event={event} anchor={shown.anchor} onAdd={add} onClose={() => setShown(null)} />
      ) : null,
  };
}
