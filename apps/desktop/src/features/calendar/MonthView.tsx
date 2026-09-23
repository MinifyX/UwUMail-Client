import clsx from "clsx";
import { useRef, useState } from "react";
import type { CalendarInfo, CalendarOccurrence } from "@/backend/types";
import { useT } from "@/i18n";
import { addDays, atMidnight, dateOf, diffDays, todayKey, type DateKey } from "@/lib/calendarDates";
import { EVENT_TINT, eventColor, eventStyle, formatDayLong, formatTime, formatWeekdayShort } from "./format";
import { daysOf, isAllDayRow } from "./layout";
import { anchorOf, useCalendarUi } from "./state";
import { inputOf, useEventActions } from "./useCalendarData";

/** How many events fit into a day cell before "+ n more". */
const PER_DAY = 3;

interface MonthViewProps {
  weeks: DateKey[][];
  month: string;
  occurrences: CalendarOccurrence[];
  calendars: CalendarInfo[];
}

/** Whole weeks around the month; a click on a day starts an all-day event, events move by dragging. */
export function MonthView({ weeks, month, occurrences, calendars }: MonthViewProps) {
  const { t } = useT();
  const today = todayKey();
  const { showPopover, openQuick, setDate, setView } = useCalendarUi.getState();
  const actions = useEventActions();
  const drag = useRef<{ occurrence: CalendarOccurrence; x: number; y: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const [dropDay, setDropDay] = useState<DateKey | null>(null);

  const byDay = new Map<DateKey, CalendarOccurrence[]>();
  for (const occurrence of occurrences) {
    for (const day of daysOf(occurrence)) byDay.set(day, [...(byDay.get(day) ?? []), occurrence]);
  }
  for (const list of byDay.values()) {
    list.sort(
      (a, b) =>
        Number(isAllDayRow(b)) - Number(isAllDayRow(a)) ||
        a.start.localeCompare(b.start) ||
        a.title.localeCompare(b.title),
    );
  }

  const dayAt = (x: number, y: number) =>
    (document.elementFromPoint(x, y)?.closest("[data-day]") as HTMLElement | null)?.dataset.day ?? null;

  const canDrag = (occurrence: CalendarOccurrence) => !occurrence.readOnly && !occurrence.recurrence;

  return (
    <div className="flex min-h-0 flex-1 flex-col" role="grid" aria-label={t("calendar.views.month")}>
      <div className="grid shrink-0 grid-cols-7 border-b border-hairline" role="row">
        {weeks[0]?.map((day) => (
          <div key={day} role="columnheader" className="py-2 text-center text-[12px] font-bold text-muted uppercase">
            {formatWeekdayShort(day)}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1" style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
        {weeks.map((week) => (
          <div key={week[0]} className="grid min-h-0 grid-cols-7 border-b border-hairline last:border-0" role="row">
            {week.map((day) => {
              const events = byDay.get(day) ?? [];
              const hidden = events.length - PER_DAY;
              const outside = day.slice(0, 7) !== month;
              return (
                <div
                  key={day}
                  role="gridcell"
                  data-day={day}
                  aria-label={formatDayLong(day)}
                  onClick={(event) => {
                    if (event.target !== event.currentTarget) return;
                    openQuick({
                      start: atMidnight(day),
                      end: atMidnight(addDays(day, 1)),
                      allDay: true,
                      anchor: anchorOf(event.currentTarget),
                    });
                  }}
                  className={clsx(
                    "flex min-h-0 min-w-0 flex-col gap-0.5 overflow-hidden border-r border-hairline px-1 pt-1 pb-1 last:border-r-0",
                    outside && "bg-canvas/60",
                    dropDay === day && "bg-pink-tint/60",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setDate(day);
                      setView("day");
                    }}
                    aria-label={t("calendar.openDay", { date: formatDayLong(day) })}
                    className={clsx(
                      "grid size-7 shrink-0 place-items-center self-center rounded-full text-[12.5px] font-bold transition-colors",
                      day === today
                        ? "bg-pink-solid text-on-pink"
                        : outside
                          ? "text-faint hover:bg-pink-tint/60"
                          : "text-ink hover:bg-pink-tint/60",
                    )}
                  >
                    {Number(day.slice(8))}
                  </button>
                  {events.slice(0, hidden > 0 ? PER_DAY - 1 : PER_DAY).map((occurrence) => {
                    const color = eventColor(occurrence, calendars);
                    const bar = isAllDayRow(occurrence);
                    return (
                      <button
                        key={occurrence.id}
                        type="button"
                        style={eventStyle(color)}
                        onPointerDown={(event) => {
                          if (!canDrag(occurrence) || event.button !== 0) return;
                          drag.current = { occurrence, x: event.clientX, y: event.clientY, moved: false };
                          event.currentTarget.setPointerCapture(event.pointerId);
                        }}
                        onPointerMove={(event) => {
                          const current = drag.current;
                          if (!current) return;
                          if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6)
                            return;
                          current.moved = true;
                          setDropDay(dayAt(event.clientX, event.clientY));
                        }}
                        onPointerUp={(event) => {
                          const current = drag.current;
                          drag.current = null;
                          setDropDay(null);
                          if (!current?.moved) return;
                          // The click that follows ends the drag, it doesn't open the event.
                          dragged.current = true;
                          const target = dayAt(event.clientX, event.clientY);
                          // Grabbed on this day: the event moves by as many days as it was carried.
                          const shift = target ? diffDays(day, target) : 0;
                          if (shift === 0) return;
                          const moved = current.occurrence;
                          void actions.update(
                            moved,
                            inputOf(moved, {
                              start: `${addDays(dateOf(moved.start), shift)}${moved.start.slice(10)}`,
                              end: `${addDays(dateOf(moved.end), shift)}${moved.end.slice(10)}`,
                            }),
                            true,
                          );
                        }}
                        onPointerCancel={() => {
                          drag.current = null;
                          setDropDay(null);
                        }}
                        onClick={(event) => {
                          if (dragged.current) {
                            dragged.current = false;
                            return;
                          }
                          showPopover(occurrence, anchorOf(event.currentTarget));
                        }}
                        className={clsx(
                          "flex h-[22px] w-full shrink-0 items-center gap-1.5 truncate rounded-md px-1.5 text-left text-[12px]",
                          bar ? `${EVENT_TINT} font-semibold` : "hover:bg-pink-tint/50",
                          canDrag(occurrence) && "touch-none",
                        )}
                      >
                        {!bar && <span className="size-2 shrink-0 rounded-full bg-[var(--event)]" aria-hidden />}
                        {!bar && <span className="shrink-0 text-muted">{formatTime(occurrence.start)}</span>}
                        <span className="min-w-0 truncate">{occurrence.title || t("calendar.untitled")}</span>
                      </button>
                    );
                  })}
                  {hidden > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setDate(day);
                        setView("day");
                      }}
                      className="h-[22px] shrink-0 truncate rounded-md px-1.5 text-left text-[12px] font-semibold text-muted hover:bg-pink-tint/50 hover:text-ink"
                    >
                      {t("calendar.more", { count: hidden + 1 })}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
