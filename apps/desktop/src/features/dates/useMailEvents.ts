import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { backend } from "@/backend/backend";
import type { Message } from "@/backend/types";
import { useT } from "@/i18n";
import { deviceTimeZone, localWall, zonedWall } from "@/lib/calendarDates";
import {
  eventsInImageText,
  eventsInMail,
  fromAssist,
  mergeEvents,
  type DetectedEvent,
  type Mark,
  type MailContext,
} from "@/lib/dates";
import { useSettings } from "@/state/settings";
import { useCalendarsAvailable } from "../calendar/useCalendarData";
import { readableBody } from "../mail/MessageBody";
import { whenLabel } from "./format";
import { useEventSearch } from "./search";

export interface MailEventsOptions {
  /** The mail is open, not a collapsed line of its thread. */
  open: boolean;
  /** The person allowed this mail's remote pictures. */
  allowRemote: boolean;
  /** Filed as junk: its dates are no offer worth making. */
  inJunk: boolean;
}

export interface MailEvents {
  /** Everything found, the same appointment once, in the order it happens. */
  events: DetectedEvent[];
  /** The hits in the mail's text to underline; `index` points into `textEvents`. */
  marks: Mark[];
  textEvents: DetectedEvent[];
  /** The assistant can read this mail for appointments. */
  canRefine: boolean;
  /** The person asked for this mail by a click ("Find appointment", "Check with AI"). */
  asked: boolean;
  refining: boolean;
  refined: boolean;
  refineFailed: boolean;
  /** Asks the assistant now (it costs the person tokens, so only on their click or setting). */
  refine: () => void;
  /** What the assistant is asked, for its estimate. */
  includeImages: boolean;
}

const NONE: DetectedEvent[] = [];

/**
 * The mail has pictures of its own the server could read: embedded ones (cid:, data:) or attached
 * ones. Remote ones count separately, only once they may load.
 */
export function hasOwnPictures(message: Message): boolean {
  return (
    /<img\b[^>]*\ssrc\s*=\s*["']?\s*(?:cid|data):/i.test(message.bodyHtml ?? "") ||
    message.attachments.some((attachment) => attachment.mimeType.toLowerCase().startsWith("image/"))
  );
}

/**
 * The appointments in one mail: found by rules in its text right away, by the same rules in the
 * text of its pictures once they were read (`backend.imageText`: the UwUMail server's
 * `Email/imageText`, or the system's OCR; nothing where neither can), and refined by the assistant
 * only when the person asks, by click or by their `assist.refineEvents` setting. Every call names
 * the message; its account decides who answers.
 */
export function useMailEvents(message: Message, { open, allowRemote, inJunk }: MailEventsOptions): MailEvents {
  const { t, i18n } = useT();
  const detect = useSettings((s) => s.detectEvents);
  const refineAlways = useSettings((s) => s.assistRefineEvents);
  const { data: calendars = false } = useCalendarsAvailable();
  // Unlike the webmail, the app has no invitation card of its own: a mail with an .ics is offered too.
  const on = open && detect && calendars && !inJunk && !message.flags.draft;

  const context = useMemo<MailContext>(
    () => ({
      subject: message.subject,
      reference: zonedWall(message.date, deviceTimeZone()),
      locale: navigator.language,
    }),
    [message.subject, message.date],
  );

  const textEvents = useMemo(() => (on ? eventsInMail(readableBody(message), context) : NONE), [on, message, context]);

  // Remote pictures only once they may load for the person anyway.
  const remote = allowRemote && message.hasRemoteContent;
  const pictures = on && (remote || hasOwnPictures(message));
  const imageText = useQuery({
    queryKey: ["imageText", message.id, remote],
    queryFn: () => backend().imageText(message.id, remote),
    enabled: pictures,
    staleTime: Infinity,
    retry: false,
  });
  const imageEvents = useMemo(
    () =>
      (imageText.data?.unavailable ? [] : (imageText.data?.images ?? []))
        .flatMap((image) => eventsInImageText(image.text, context))
        .slice(0, 20),
    [imageText.data, context],
  );

  const asked = useEventSearch((s) => s.asked[message.id] === true);
  const features = useQuery({
    queryKey: ["assistFeatures", message.accountId],
    queryFn: () => backend().assistFeatures(message.accountId),
    enabled: on || (asked && open),
    staleTime: Infinity,
    retry: false,
  });
  const ask = useEventSearch((s) => s.ask);
  // Asked by a click, the assistant reads the mail even when finding dates by rules is off or it
  // lies in the junk folder: the person wants to know.
  const reachable = open && calendars && !message.flags.draft;
  const canRefine = (on || (asked && reachable)) && features.data?.extractEvents === true;
  const includeImages = (remote || hasOwnPictures(message)) && reachable && (!message.hasRemoteContent || allowRemote);
  const assistant = useQuery({
    queryKey: ["extractEvents", message.id, includeImages],
    queryFn: () => backend().extractEvents(message.id, includeImages),
    enabled: canRefine && ((refineAlways && on) || asked),
    staleTime: Infinity,
    retry: false,
  });
  const aiEvents = useMemo(
    () =>
      (assistant.data?.events ?? [])
        .map((event) => fromAssist(event, context.reference))
        .filter((event): event is DetectedEvent => event !== null),
    [assistant.data, context],
  );

  const events = useMemo(() => mergeEvents(textEvents, imageEvents, aiEvents), [textEvents, imageEvents, aiEvents]);

  const language = i18n.language;
  const marks = useMemo(
    () =>
      textEvents.flatMap((event, index) =>
        // What was over before the mail came is history, not an offer.
        event.past
          ? []
          : [
              {
                from: event.from,
                to: event.to,
                index,
                label: t("dates.markLabel", { when: whenLabel(event, language) }),
              },
            ],
      ),
    // `t` changes with the language and the tone.
    [textEvents, t, language],
  );

  return {
    events,
    marks,
    textEvents,
    canRefine,
    asked,
    refining: assistant.isFetching,
    refined: assistant.isSuccess,
    refineFailed: assistant.isError,
    refine: () => {
      ask(message.id);
      if (assistant.isError) void assistant.refetch();
    },
    includeImages,
  };
}

/** Whether an appointment still lies ahead of now. */
export function isUpcoming(event: DetectedEvent, now: string = localWall()): boolean {
  return !event.past && event.end > now;
}
