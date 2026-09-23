import clsx from "clsx";
import { Plus, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Wordmark } from "@/components/ui/Logo";
import { useT } from "@/i18n";
import { addMinutes, localWall, withClock } from "@/lib/calendarDates";
import { useUi } from "@/state/ui";
import { AppSwitch } from "../shell/AppSwitch";
import { CalendarList } from "./CalendarList";
import { MiniMonth } from "./MiniMonth";
import { useCalendarUi } from "./state";

/** A new event on the day on screen, at the next full hour (or at nine on another day). */
export function startNewEvent() {
  const { date, openEditor } = useCalendarUi.getState();
  const now = localWall();
  const start =
    date === now.slice(0, 10)
      ? withClock(date, `${String(Math.min(23, Number(now.slice(11, 13)) + 1)).padStart(2, "0")}:00`)
      : withClock(date, "09:00");
  openEditor({ occurrence: null, draft: { start, end: addMinutes(start, 60), allDay: false } });
}

function SidebarLink({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 w-full items-center gap-3 rounded-xl px-3 text-left text-[13.5px] text-ink/85 transition-colors hover:bg-pink-tint/50"
    >
      <Icon className="size-[17px] shrink-0 text-muted" strokeWidth={2} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

/** Beside the calendar: the switch back to mail, a new event, a small month and the calendars. */
export function CalendarSidebar({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const { t } = useT();
  const openSettings = useUi((s) => s.openSettings);
  return (
    <nav className={clsx("flex h-full flex-col gap-4 px-3 pt-4 pb-3", className)} aria-label={t("calendar.title")}>
      <div className="flex items-center justify-between px-2">
        <Wordmark className="text-[19px]" />
      </div>
      <AppSwitch />
      <Button
        variant="primary"
        size="lg"
        icon={Plus}
        onClick={() => {
          onNavigate?.();
          startNewEvent();
        }}
        className="w-full"
      >
        {t("calendar.newEvent")}
      </Button>
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-1">
        <MiniMonth onPick={onNavigate} />
        <CalendarList />
      </div>
      <div className="flex flex-col gap-0.5 border-t border-hairline pt-3">
        <SidebarLink icon={Settings} label={t("nav.settings")} onClick={() => openSettings()} />
      </div>
    </nav>
  );
}
