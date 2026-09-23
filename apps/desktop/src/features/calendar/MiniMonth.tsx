import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { IconButton } from "@/components/ui/Button";
import { useT } from "@/i18n";
import { addMonths, monthWeeks, startOfWeek, todayKey, type DateKey } from "@/lib/calendarDates";
import { formatDayLong, formatMonthTitle, formatWeekdayNarrow, weekStart } from "./format";
import { useCalendarUi } from "./state";

/** A small month for jumping to a date. It follows the calendar until its own arrows are used. */
export function MiniMonth({ onPick }: { onPick?: () => void }) {
  const { t } = useT();
  const date = useCalendarUi((s) => s.date);
  const view = useCalendarUi((s) => s.view);
  const setDate = useCalendarUi((s) => s.setDate);
  const [shown, setShown] = useState<{ month: DateKey; for: DateKey } | null>(null);
  const month = shown && shown.for === date ? shown.month : `${date.slice(0, 7)}-01`;
  const first = weekStart();
  const weeks = monthWeeks(month, first);
  const today = todayKey();
  const weekOf = startOfWeek(date, first);
  const selected = (day: DateKey) =>
    view === "week" ? startOfWeek(day, first) === weekOf : view === "month" ? false : day === date;

  return (
    <div className="flex flex-col gap-1 px-1">
      <div className="flex items-center justify-between">
        <span className="pl-2 text-[13px] font-bold">{formatMonthTitle(month)}</span>
        <span className="flex">
          <IconButton
            icon={ChevronLeft}
            size="sm"
            label={t("calendar.previousMonth")}
            onClick={() => setShown({ month: addMonths(month, -1), for: date })}
          />
          <IconButton
            icon={ChevronRight}
            size="sm"
            label={t("calendar.nextMonth")}
            onClick={() => setShown({ month: addMonths(month, 1), for: date })}
          />
        </span>
      </div>
      <table className="w-full table-fixed text-center text-[11.5px]" role="grid" aria-label={formatMonthTitle(month)}>
        <thead>
          <tr>
            {weeks[0]?.map((day) => (
              <th key={day} scope="col" className="pb-1 font-bold text-muted">
                {formatWeekdayNarrow(day)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((day) => (
                <td key={day} className="p-0">
                  <button
                    type="button"
                    onClick={() => {
                      setDate(day);
                      setShown(null);
                      onPick?.();
                    }}
                    aria-label={formatDayLong(day)}
                    aria-current={day === today ? "date" : undefined}
                    className={clsx(
                      "mx-auto grid size-7 place-items-center rounded-full font-semibold transition-colors",
                      day === today
                        ? "bg-pink-solid text-on-pink"
                        : selected(day)
                          ? "bg-pink-tint text-pink-ink"
                          : day.slice(0, 7) === month.slice(0, 7)
                            ? "text-ink hover:bg-pink-tint/60"
                            : "text-faint hover:bg-pink-tint/60",
                    )}
                  >
                    {Number(day.slice(8))}
                  </button>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
