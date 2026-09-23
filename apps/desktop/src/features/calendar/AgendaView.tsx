import clsx from "clsx";
import type { CalendarInfo, CalendarOccurrence } from "@/backend/types";
import { EmptyState } from "@/components/ui/EmptyState";
import { useT } from "@/i18n";
import { todayKey, type DateKey } from "@/lib/calendarDates";
import { eventColor, formatDayLong, formatTime, formatWeekdayShort } from "./format";
import { daysOf, isAllDayRow } from "./layout";
import { anchorOf, useCalendarUi } from "./state";

interface AgendaViewProps {
  days: DateKey[];
  occurrences: CalendarOccurrence[];
  calendars: CalendarInfo[];
}

/** The phone's list: the coming days that have something on, one after the other. */
export function AgendaView({ days, occurrences, calendars }: AgendaViewProps) {
  const { t } = useT();
  const today = todayKey();
  const { showPopover, setDate, setView } = useCalendarUi.getState();
  const byDay = days
    .map((day) => ({
      day,
      events: occurrences
        .filter((occurrence) => daysOf(occurrence).includes(day))
        .sort((a, b) => Number(isAllDayRow(b)) - Number(isAllDayRow(a)) || a.start.localeCompare(b.start)),
    }))
    .filter(({ day, events }) => events.length > 0 || day === today);

  if (byDay.every(({ events }) => events.length === 0)) {
    return (
      <EmptyState
        scene="done"
        title={t("calendar.agendaEmpty.title")}
        body={t("calendar.agendaEmpty.body")}
        className="flex-1"
      />
    );
  }

  return (
    <ol className="flex flex-col gap-4 px-3 pt-1 pb-28" aria-label={t("calendar.views.agenda")}>
      {byDay.map(({ day, events }) => (
        <li key={day} className="flex gap-3">
          <button
            type="button"
            onClick={() => {
              setDate(day);
              setView("day");
            }}
            aria-label={t("calendar.openDay", { date: formatDayLong(day) })}
            className="flex w-12 shrink-0 flex-col items-center pt-1"
          >
            <span className={clsx("text-[11.5px] font-bold uppercase", day === today ? "text-pink-ink" : "text-muted")}>
              {formatWeekdayShort(day)}
            </span>
            <span
              className={clsx(
                "grid size-9 place-items-center rounded-full text-[18px] font-extrabold",
                day === today && "bg-pink-solid text-on-pink",
              )}
            >
              {Number(day.slice(8))}
            </span>
          </button>
          <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
            {events.length === 0 && (
              <li className="rounded-2xl border border-dashed border-line px-4 py-3 text-[13.5px] text-muted">
                {t("calendar.nothingToday")}
              </li>
            )}
            {events.map((occurrence) => {
              const color = eventColor(occurrence, calendars);
              return (
                <li key={occurrence.id}>
                  <button
                    type="button"
                    onClick={(event) => showPopover(occurrence, anchorOf(event.currentTarget))}
                    className="flex w-full items-stretch gap-3 rounded-2xl bg-canvas px-3 py-2.5 text-left active:scale-[0.99]"
                  >
                    <span className="w-1 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold">
                        {occurrence.title || t("calendar.untitled")}
                      </span>
                      <span className="block truncate text-[13px] text-muted">
                        {isAllDayRow(occurrence)
                          ? t("calendar.allDay")
                          : `${formatTime(occurrence.start)} – ${formatTime(occurrence.end)}`}
                        {occurrence.location ? ` · ${occurrence.location}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}
