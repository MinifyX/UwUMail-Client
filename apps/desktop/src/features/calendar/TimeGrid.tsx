import clsx from "clsx";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { CalendarInfo, CalendarOccurrence } from "@/backend/types";
import { useT } from "@/i18n";
import {
  MINUTES_PER_DAY,
  addDays,
  atMidnight,
  atMinutes,
  dateOf,
  diffMinutes,
  localWall,
  minutesOfDay,
  todayKey,
  type DateKey,
} from "@/lib/calendarDates";
import {
  EVENT_TINT,
  eventColor,
  eventStyle,
  formatDayLong,
  formatHour,
  formatTime,
  formatWeekdayShort,
} from "./format";
import { layoutBars, layoutDay, piecesOn } from "./layout";
import { anchorOf, useCalendarUi } from "./state";
import { inputOf, useEventActions } from "./useCalendarData";

/** Pixels per hour; a quarter of an hour is the smallest step. */
const HOUR = 48;
const PER_MINUTE = HOUR / 60;
const STEP = 15;
const BAR = 24;

const snap = (minutes: number, step = STEP) => Math.round(minutes / step) * step;
const clampDay = (minutes: number) => Math.max(0, Math.min(MINUTES_PER_DAY, minutes));

type Interaction =
  | { kind: "select"; day: number; from: number; to: number; x: number; y: number; moved: boolean; touch: boolean }
  | {
      kind: "move" | "resize";
      occurrence: CalendarOccurrence;
      /** Where the pointer grabbed it, in minutes from the event's start and in days. */
      grabDay: number;
      grabMinute: number;
      day: number;
      minute: number;
      x: number;
      y: number;
      moved: boolean;
    };

interface TimeGridProps {
  days: DateKey[];
  occurrences: CalendarOccurrence[];
  calendars: CalendarInfo[];
}

/** The week or a day as hours: click or drag across slots to add, drag events to move or resize them. */
export function TimeGrid({ days, occurrences, calendars }: TimeGridProps) {
  const { t } = useT();
  const today = todayKey();
  const { showPopover, openQuick, setDate, setView } = useCalendarUi.getState();
  const actions = useEventActions();
  const scroller = useRef<HTMLDivElement>(null);
  const columns = useRef<HTMLDivElement>(null);
  const allDayRow = useRef<HTMLDivElement>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const live = useRef<Interaction | null>(null);
  const [now, setNow] = useState(() => localWall());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(localWall()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Morning in view, or the current hour when today is on screen.
  const showsToday = days.includes(today);
  useLayoutEffect(() => {
    const hour = showsToday ? Math.max(0, Math.floor(minutesOfDay(localWall()) / 60) - 2) : 7;
    scroller.current?.scrollTo({ top: hour * HOUR });
  }, [days.length, showsToday]);

  const update = (next: Interaction | null) => {
    live.current = next;
    setInteraction(next);
  };

  const pointAt = (clientX: number, clientY: number) => {
    const rect = columns.current!.getBoundingClientRect();
    const day = Math.max(0, Math.min(days.length - 1, Math.floor(((clientX - rect.left) / rect.width) * days.length)));
    return { day, minute: clampDay((clientY - rect.top) / PER_MINUTE) };
  };

  const byId = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const draggable = (occurrence: CalendarOccurrence) => !occurrence.readOnly && !occurrence.recurrence;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as Element;
    const element = target.closest<HTMLElement>("[data-occurrence]");
    const { day, minute } = pointAt(event.clientX, event.clientY);
    const touch = event.pointerType === "touch";
    if (element) {
      const occurrence = byId.get(element.dataset.occurrence ?? "");
      // On touch screens events only open; dragging there scrolls.
      if (!occurrence || !draggable(occurrence) || touch) return;
      const start = diffMinutes(atMidnight(days[0]!), occurrence.start);
      update({
        kind: target.closest("[data-resize]") ? "resize" : "move",
        occurrence,
        grabDay: day,
        grabMinute: minute - (start - day * MINUTES_PER_DAY),
        day,
        minute,
        x: event.clientX,
        y: event.clientY,
        moved: false,
      });
    } else {
      const from = Math.floor(minute / STEP) * STEP;
      update({ kind: "select", day, from, to: from + STEP, x: event.clientX, y: event.clientY, moved: false, touch });
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = live.current;
    if (!current) return;
    const moved = current.moved || Math.hypot(event.clientX - current.x, event.clientY - current.y) > 5;
    if (!moved) return;
    // Held only once it's a drag: a plain click still reaches the event's button.
    if (!current.moved && !(current.kind === "select" && current.touch)) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const { day, minute } = pointAt(event.clientX, event.clientY);
    if (current.kind === "select") {
      // A finger moving over the grid is scrolling, not choosing a time.
      if (current.touch) return update(null);
      return update({ ...current, moved, to: Math.max(current.from + STEP, snap(minute)) });
    }
    update({ ...current, moved, day, minute });
  };

  /** Where a moved or resized event ends up, in wall times. */
  const placement = (current: Extract<Interaction, { kind: "move" | "resize" }>) => {
    const { occurrence } = current;
    const length = diffMinutes(occurrence.start, occurrence.end);
    if (current.kind === "resize") {
      const startOffset = diffMinutes(atMidnight(days[current.grabDay]!), occurrence.start);
      const end = Math.max(startOffset + STEP, snap(current.minute));
      return { start: occurrence.start, end: atMinutes(days[current.grabDay]!, end) };
    }
    const startMinute = snap(current.minute - current.grabMinute);
    const start = atMinutes(days[current.day]!, startMinute);
    return { start, end: atMinutes(days[current.day]!, startMinute + length) };
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = live.current;
    update(null);
    if (!current) return;
    if (current.kind === "select") {
      const day = days[current.day]!;
      const from = current.moved ? current.from : Math.floor(current.from / 30) * 30;
      const to = current.moved ? current.to : Math.min(MINUTES_PER_DAY, from + 60);
      openQuick({
        start: atMinutes(day, Math.min(from, MINUTES_PER_DAY - STEP)),
        end: atMinutes(day, to),
        allDay: false,
        anchor: anchorOf(null, { x: event.clientX, y: event.clientY }),
      });
      return;
    }
    if (!current.moved) return;
    const { start, end } = placement(current);
    if (start === current.occurrence.start && end === current.occurrence.end) return;
    void actions.update(current.occurrence, inputOf(current.occurrence, { start, end }), true);
  };

  const bars = layoutBars(days, occurrences);
  const lanes = bars.reduce((most, bar) => Math.max(most, bar.lane + 1), 0);
  const preview = interaction && interaction.kind !== "select" && interaction.moved ? placement(interaction) : null;
  const shown = occurrences.map((occurrence) =>
    preview && interaction && interaction.kind !== "select" && occurrence.id === interaction.occurrence.id
      ? { ...occurrence, ...preview }
      : occurrence,
  );

  const openOccurrence = (occurrence: CalendarOccurrence, element: Element) =>
    showPopover(occurrence, anchorOf(element));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 [scrollbar-gutter:stable] overflow-y-hidden border-b border-hairline">
        <div className="w-16 shrink-0" />
        {days.map((day) => (
          <button
            key={day}
            type="button"
            onClick={() => {
              setDate(day);
              setView("day");
            }}
            aria-label={t("calendar.openDay", { date: formatDayLong(day) })}
            className="flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 hover:bg-pink-tint/40"
          >
            <span className={clsx("text-[11.5px] font-bold uppercase", day === today ? "text-pink-ink" : "text-muted")}>
              {formatWeekdayShort(day)}
            </span>
            <span
              className={clsx(
                "grid size-8 place-items-center rounded-full text-[17px] font-extrabold",
                day === today && "bg-pink-solid text-on-pink",
              )}
            >
              {Number(day.slice(8))}
            </span>
          </button>
        ))}
      </div>

      <div className="flex shrink-0 [scrollbar-gutter:stable] overflow-y-hidden border-b border-hairline">
        <div className="flex w-16 shrink-0 items-start justify-end pt-1 pr-2 text-[10.5px] font-semibold text-muted">
          {t("calendar.allDayShort")}
        </div>
        <div
          ref={allDayRow}
          className="relative min-w-0 flex-1 cursor-pointer"
          style={{ height: Math.max(1, lanes) * BAR + 6 }}
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const index = Math.min(
              days.length - 1,
              Math.floor(((event.clientX - rect.left) / rect.width) * days.length),
            );
            const day = days[index]!;
            openQuick({
              start: atMidnight(day),
              end: atMidnight(addDays(day, 1)),
              allDay: true,
              anchor: anchorOf(null, { x: event.clientX, y: event.clientY }),
            });
          }}
        >
          {bars.map((bar) => {
            const color = eventColor(bar.occurrence, calendars);
            return (
              <button
                key={bar.occurrence.id}
                type="button"
                style={{
                  ...eventStyle(color),
                  left: `calc(${(bar.from / days.length) * 100}% + 2px)`,
                  width: `calc(${((bar.to - bar.from + 1) / days.length) * 100}% - 4px)`,
                  top: bar.lane * BAR + 3,
                }}
                onClick={(event) => showPopover(bar.occurrence, anchorOf(event.currentTarget))}
                className={clsx(
                  "absolute flex h-[21px] items-center truncate px-2 text-left text-[12px] font-semibold",
                  EVENT_TINT,
                  bar.continuesBefore ? "rounded-l-none" : "rounded-l-md",
                  bar.continuesAfter ? "rounded-r-none" : "rounded-r-md",
                )}
              >
                <span className="truncate">{bar.occurrence.title || t("calendar.untitled")}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 [scrollbar-gutter:stable] overflow-y-auto overscroll-contain">
        <div className="relative flex" style={{ height: 24 * HOUR }}>
          <div className="relative w-16 shrink-0" aria-hidden>
            {Array.from({ length: 23 }, (_, index) => index + 1).map((hour) => (
              <span
                key={hour}
                className="absolute right-2 -translate-y-1/2 text-[10.5px] font-semibold text-muted tabular-nums"
                style={{ top: hour * HOUR }}
              >
                {formatHour(hour)}
              </span>
            ))}
          </div>
          <div
            ref={columns}
            role="presentation"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => update(null)}
            className="relative flex min-w-0 flex-1 touch-pan-y bg-[repeating-linear-gradient(to_bottom,var(--uwu-hairline)_0,var(--uwu-hairline)_1px,transparent_1px,transparent_48px)] select-none"
          >
            {days.map((day, index) => {
              const placed = layoutDay(piecesOn(day, shown));
              return (
                <div
                  key={day}
                  role="group"
                  aria-label={formatDayLong(day)}
                  className={clsx(
                    "relative min-w-0 flex-1 border-l border-hairline",
                    day === today && "bg-pink-tint/15",
                  )}
                >
                  {interaction?.kind === "select" && interaction.moved && interaction.day === index && (
                    <div
                      className="pointer-events-none absolute inset-x-1 rounded-lg bg-pink/25 ring-2 ring-pink"
                      style={{
                        top: interaction.from * PER_MINUTE,
                        height: (interaction.to - interaction.from) * PER_MINUTE,
                      }}
                    />
                  )}
                  {placed.map((piece) => {
                    const { occurrence } = piece;
                    const color = eventColor(occurrence, calendars);
                    const height = Math.max(18, (piece.bottom - piece.top) * PER_MINUTE - 2);
                    const active =
                      interaction && interaction.kind !== "select" && interaction.occurrence.id === occurrence.id;
                    const canDrag = draggable(occurrence);
                    return (
                      <button
                        key={occurrence.id}
                        type="button"
                        data-occurrence={occurrence.id}
                        onClick={(event) => openOccurrence(occurrence, event.currentTarget)}
                        style={{
                          ...eventStyle(color),
                          top: piece.top * PER_MINUTE + 1,
                          height,
                          left: `calc(${(piece.column / piece.columns) * 100}% + 2px)`,
                          width: `calc(${100 / piece.columns}% - 4px)`,
                        }}
                        className={clsx(
                          "group absolute flex flex-col overflow-hidden border-l-[3px] border-[var(--event)] px-1.5 py-0.5 text-left text-[12px] leading-tight",
                          EVENT_TINT,
                          piece.continuesBefore ? "rounded-t-none" : "rounded-t-md",
                          piece.continuesAfter ? "rounded-b-none" : "rounded-b-md",
                          canDrag && "cursor-grab active:cursor-grabbing",
                          active && "z-10 shadow-float",
                        )}
                      >
                        <span className="truncate font-semibold">{occurrence.title || t("calendar.untitled")}</span>
                        {height >= 34 && (
                          <span className="truncate text-muted">
                            {formatTime(occurrence.start)} – {formatTime(occurrence.end)}
                          </span>
                        )}
                        {height >= 52 && occurrence.location && (
                          <span className="truncate text-muted">{occurrence.location}</span>
                        )}
                        {canDrag && !piece.continuesAfter && (
                          <span
                            data-resize
                            aria-hidden
                            className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize opacity-0 group-hover:opacity-100"
                          >
                            <span className="mx-auto mt-0.5 block h-1 w-6 rounded-full bg-[var(--event)]" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {day === dateOf(now) && (
                    <div
                      className="pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-danger"
                      style={{ top: minutesOfDay(now) * PER_MINUTE }}
                      aria-hidden
                    >
                      <span className="absolute -top-[5px] -left-[6px] size-3 rounded-full bg-danger" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
