import clsx from "clsx";
import { CalendarPlus, ChevronDown, ImageIcon, MapPin, Sparkles, TriangleAlert, X } from "lucide-react";
import { useId, useState } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { useT } from "@/i18n";
import type { DetectedEvent } from "@/lib/dates";
import { toast } from "@/state/toasts";
import { Popover } from "../calendar/Popover";
import type { Anchor } from "../calendar/state";
import { useDismissedDates } from "./dismissed";
import { swappedDay, whenLabel } from "./format";
import { isUpcoming, type MailEvents } from "./useMailEvents";

/** Where an appointment came from, when it wasn't simply the mail's text. */
function SourceBadge({ event }: { event: DetectedEvent }) {
  const { t } = useT();
  if (event.source === "text" && !event.refined) return null;
  const ai = event.source === "ai" || event.refined;
  const Icon = ai ? Sparkles : ImageIcon;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-pink-tint px-2 py-0.5 align-middle text-[11.5px] font-semibold text-pink-ink">
      <Icon className="size-3" aria-hidden />
      {ai ? t("dates.fromAssistant") : t("dates.fromPicture")}
    </span>
  );
}

/** What makes a find doubtful, said plainly: another reading of the day, or a weekday that doesn't fit. */
function Doubts({ event, locale }: { event: DetectedEvent; locale: string }) {
  const { t } = useT();
  const swapped = event.ambiguous ? swappedDay(event, locale) : null;
  if (!swapped && !event.weekdayMismatch) return null;
  return (
    <span className="flex items-start gap-1 text-[12px] text-warning">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        {swapped ? t("dates.ambiguous", { other: swapped }) : null}
        {swapped && event.weekdayMismatch ? " " : null}
        {event.weekdayMismatch ? t("dates.weekdayMismatch") : null}
      </span>
    </span>
  );
}

function titleOf(event: DetectedEvent, untitled: string): string {
  return event.title || untitled;
}

interface EventsBarProps {
  messageId: string;
  found: MailEvents;
  onAdd: (event: DetectedEvent) => void;
}

/**
 * Above the mail: "📅 6.–9. Okt. · Pixel Days — In Kalender". Several appointments fold into
 * "3 Termine erkannt". Put away per mail. The assistant only reads the mail on a click here, unless
 * the person switched that on for every mail.
 */
export function EventsBar({ messageId, found, onAdd }: EventsBarProps) {
  const { t, i18n } = useT();
  const dismissed = useDismissedDates((s) => s.ids.includes(messageId));
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const events = found.events.filter((event) => isUpcoming(event));
  if (dismissed || events.length === 0) return null;
  const locale = i18n.language;
  const untitled = t("calendar.untitled");
  const single = events.length === 1 ? events[0]! : null;

  const dismiss = () => {
    useDismissedDates.getState().dismiss(messageId);
    toast(t("dates.dismissed"), "info", undefined, {
      action: { label: t("dates.undoDismiss"), run: () => useDismissedDates.getState().restore(messageId) },
    });
  };

  const refine = found.canRefine && !found.refined && (
    <Button
      size="sm"
      variant="ghost"
      icon={Sparkles}
      busy={found.refining}
      onClick={found.refine}
      title={t("dates.refineHint")}
    >
      {found.refineFailed ? t("dates.refineAgain") : t("dates.refine")}
    </Button>
  );

  return (
    <section
      aria-label={t("dates.barLabel")}
      className="flex flex-col gap-2 rounded-2xl border border-hairline bg-canvas px-4 py-2.5 text-[13px]"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <CalendarPlus className="size-4 shrink-0 text-pink" aria-hidden />
        {single ? (
          <p className="flex min-w-[min(100%,14rem)] flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="font-bold">{whenLabel(single, locale)}</span>
              <span aria-hidden className="text-muted">
                ·
              </span>
              <span className="min-w-0 break-words">{titleOf(single, untitled)}</span>
              <SourceBadge event={single} />
            </span>
            <Doubts event={single} locale={locale} />
          </p>
        ) : (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded(!expanded)}
            className="flex min-w-[min(100%,12rem)] flex-1 items-center gap-1.5 rounded-lg text-left font-bold hover:text-pink-ink focus-visible:shadow-focus focus-visible:outline-none"
          >
            {t("dates.found", { count: events.length })}
            <ChevronDown
              className={clsx("size-3.5 transition-transform", expanded && "rotate-180")}
              strokeWidth={2.4}
              aria-hidden
            />
          </button>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {refine}
          {found.refineFailed && (
            <span role="status" className="text-[12px] text-muted">
              {t("dates.refineFailed")}
            </span>
          )}
          {single && (
            <Button size="sm" variant="secondary" onClick={() => onAdd(single)}>
              {t("dates.add")}
            </Button>
          )}
          <IconButton icon={X} size="sm" label={t("dates.dismiss")} title={t("dates.dismiss")} onClick={dismiss} />
        </span>
      </div>
      {!single && expanded && (
        <ul id={listId} className="flex animate-fade flex-col divide-y divide-hairline border-t border-hairline">
          {events.map((event) => (
            <li
              key={`${event.source}:${event.key}:${event.from}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2"
            >
              <span className="flex min-w-[min(100%,14rem)] flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  <span className="font-bold">{whenLabel(event, locale)}</span>
                  <span aria-hidden className="text-muted">
                    ·
                  </span>
                  <span className="min-w-0 break-words">{titleOf(event, untitled)}</span>
                  <SourceBadge event={event} />
                </span>
                <Doubts event={event} locale={locale} />
              </span>
              <Button
                size="sm"
                variant="secondary"
                className="ml-auto"
                aria-label={t("dates.addNamed", { title: titleOf(event, untitled), when: whenLabel(event, locale) })}
                onClick={() => onAdd(event)}
              >
                {t("dates.add")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface DatePopoverProps {
  event: DetectedEvent;
  anchor: Anchor;
  onAdd: (event: DetectedEvent) => void;
  onClose: () => void;
}

/** What a date underlined in the mail was read as, and the way into the calendar. */
export function DatePopover({ event, anchor, onAdd, onClose }: DatePopoverProps) {
  const { t, i18n } = useT();
  const locale = i18n.language;
  const title = titleOf(event, t("calendar.untitled"));
  return (
    <Popover anchor={anchor} label={t("dates.popoverLabel", { title })} onClose={onClose}>
      <div className="relative flex flex-col gap-3 p-5">
        <div className="flex items-start gap-3 pr-8">
          <CalendarPlus className="mt-0.5 size-5 shrink-0 text-pink" aria-hidden />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="text-[12px] font-bold tracking-wide text-muted uppercase">{t("dates.popoverHeading")}</p>
            <p className="text-[15px] font-bold break-words">
              {title} <SourceBadge event={event} />
            </p>
            <p className="text-[13.5px]">{whenLabel(event, locale)}</p>
            {event.location && (
              <p className="flex items-start gap-1.5 text-[13px] text-muted">
                <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 break-words">{event.location}</span>
              </p>
            )}
            <Doubts event={event} locale={locale} />
            {!isUpcoming(event) && <p className="text-[12.5px] text-muted">{t("dates.over")}</p>}
          </div>
        </div>
        <Button variant="primary" icon={CalendarPlus} data-autofocus onClick={() => onAdd(event)}>
          {t("dates.addLong")}
        </Button>
        {/* After the main button, so that one takes the focus first. */}
        <IconButton icon={X} size="sm" label={t("common.close")} onClick={onClose} className="absolute top-3 right-3" />
      </div>
    </Popover>
  );
}
