import clsx from "clsx";
import { CalendarDays, ChevronLeft, ChevronRight, List, Menu, Plus } from "lucide-react";
import { useMemo } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Field";
import { useT } from "@/i18n";
import { useBackLayer } from "@/lib/backStack";
import { monthWeeks } from "@/lib/calendarDates";
import { useIsPhone, useMediaQuery } from "@/lib/device";
import { useHotkeys, type HotkeyMap } from "@/lib/hotkeys";
import { useUi } from "@/state/ui";
import { useContactsAvailable } from "../contacts/useContactsData";
import { AgendaView } from "./AgendaView";
import { CalendarSidebar, startNewEvent } from "./CalendarSidebar";
import { DeleteScopeQuestion } from "./DeleteScopeQuestion";
import { EventEditor } from "./EventEditor";
import { EventPopover, QuickCreate } from "./EventPopover";
import { formatDayLong, formatMonthTitle, formatRangeTitle, weekStart } from "./format";
import { MonthView } from "./MonthView";
import { useCalendarUi, type CalendarView } from "./state";
import { TimeGrid } from "./TimeGrid";
import { useCalendars, useOccurrences, visibleDays } from "./useCalendarData";

/** Wide enough for the sidebar beside the grid. */
const ROOM_FOR_SIDEBAR = "(min-width: 1100px)";

const GRID_VIEWS: CalendarView[] = ["day", "week", "month"];

/** Keys like the mail's: t today, d/w/m for the views, c for a new event, n/p or j/k to page. */
function useCalendarHotkeys(contacts: boolean) {
  const map = useMemo<HotkeyMap>(() => {
    const ui = () => useCalendarUi.getState();
    return {
      t: () => ui().goToday(),
      d: () => ui().setView("day"),
      w: () => ui().setView("week"),
      m: () => ui().setView("month"),
      c: () => startNewEvent(),
      n: () => ui().step(1),
      j: () => ui().step(1),
      ArrowRight: () => ui().step(1),
      p: () => ui().step(-1),
      k: () => ui().step(-1),
      ArrowLeft: () => ui().step(-1),
      "g i": () => useUi.getState().setView({ kind: "unified", role: "inbox" }),
      "g m": () => useUi.getState().setSection("mail"),
      "g k": () => {
        if (contacts) useUi.getState().setSection("contacts");
      },
      "mod+k": () => useUi.getState().setPaletteOpen(true),
      "mod+,": () => useUi.getState().openSettings(),
      "?": () => useUi.getState().setShortcutsOpen(true),
      Escape: () => {
        const calendar = ui();
        if (calendar.popover) calendar.closePopover();
        else if (calendar.quick) calendar.closeQuick();
        else useUi.getState().setFolderDrawerOpen(false);
      },
    };
  }, [contacts]);
  useHotkeys(map, { repeat: ["n", "p", "j", "k", "ArrowRight", "ArrowLeft"] });
}

/** The events of what is on screen, in the chosen view, without hidden calendars. */
function CalendarBody({ view }: { view: CalendarView }) {
  const { t } = useT();
  const date = useCalendarUi((s) => s.date);
  const first = weekStart();
  const days = visibleDays(view, date, first);
  const { data: calendars = [] } = useCalendars();
  const query = useOccurrences(days);
  const hidden = new Set(calendars.filter((calendar) => !calendar.isVisible).map((calendar) => calendar.id));
  const occurrences = (query.data ?? []).filter((occurrence) => !hidden.has(occurrence.calendarId));

  if (query.isError && !query.data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-[14px] text-muted">{t("calendar.loadFailed")}</p>
        <Button size="sm" onClick={() => void query.refetch()}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }
  return (
    <div className={clsx("flex min-h-0 flex-1 flex-col", query.isFetching && !query.isPending && "opacity-95")}>
      {view === "month" ? (
        <MonthView
          weeks={monthWeeks(date, first)}
          month={date.slice(0, 7)}
          occurrences={occurrences}
          calendars={calendars}
        />
      ) : view === "agenda" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <AgendaView days={days} occurrences={occurrences} calendars={calendars} />
        </div>
      ) : (
        <TimeGrid days={days} occurrences={occurrences} calendars={calendars} />
      )}
      <p className="sr-only" aria-live="polite">
        {query.isPending ? t("calendar.loading") : ""}
      </p>
    </div>
  );
}

function title(view: CalendarView, date: string): string {
  if (view === "month") return formatMonthTitle(date);
  if (view === "day") return formatRangeTitle(date, date);
  const days = visibleDays(view, date, weekStart());
  return formatRangeTitle(days[0]!, days[days.length - 1]!);
}

/** The calendar, where the mail list and reader would be. Phones get a list and single days. */
export function CalendarShell() {
  const phone = useIsPhone();
  const { data: contacts = false } = useContactsAvailable();
  useCalendarHotkeys(contacts);
  return (
    <>
      {phone ? <PhoneCalendar /> : <DesktopCalendar />}
      <EventPopover />
      <QuickCreate />
      <EventEditor />
      <DeleteScopeQuestion />
    </>
  );
}

function DesktopCalendar() {
  const { t } = useT();
  const view = useCalendarUi((s) => (s.view === "agenda" ? "week" : s.view));
  const date = useCalendarUi((s) => s.date);
  const { setView, goToday, step } = useCalendarUi.getState();
  const room = useMediaQuery(ROOM_FOR_SIDEBAR);
  const drawerOpen = useUi((s) => s.folderDrawerOpen);
  const setDrawerOpen = useUi((s) => s.setFolderDrawerOpen);

  return (
    <div className="relative flex min-h-0 flex-1 gap-3 p-3">
      {room && <CalendarSidebar className="min-h-0 w-[240px] shrink-0 rounded-[22px] border border-hairline" />}
      <section
        className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[22px] border border-hairline bg-surface"
        aria-label={t("calendar.title")}
      >
        <header className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-3">
          {!room && (
            <IconButton icon={Menu} label={t("calendar.menu")} onClick={() => setDrawerOpen(true)} className="-ml-1" />
          )}
          <Button size="sm" onClick={goToday}>
            {t("calendar.today")}
          </Button>
          <span className="flex">
            <IconButton icon={ChevronLeft} label={t(`calendar.previous.${view}`)} onClick={() => step(-1)} />
            <IconButton icon={ChevronRight} label={t(`calendar.next.${view}`)} onClick={() => step(1)} />
          </span>
          <h1
            className="min-w-0 flex-1 truncate text-[20px] leading-tight font-extrabold tracking-[-0.01em]"
            aria-live="polite"
          >
            {title(view, date)}
          </h1>
          <Segmented
            label={t("calendar.view")}
            value={view}
            onChange={setView}
            options={GRID_VIEWS.map((option) => ({ value: option, label: t(`calendar.views.${option}`) }))}
          />
          {!room && <IconButton icon={Plus} label={t("calendar.newEvent")} onClick={startNewEvent} />}
        </header>
        <CalendarBody view={view} />
      </section>

      {drawerOpen && !room && (
        <div className="absolute inset-0 z-30 flex" role="presentation">
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 animate-fade bg-[#1c1420]/30"
          />
          <CalendarSidebar
            className="relative w-[280px] animate-slide-up rounded-r-[22px] bg-surface shadow-float"
            onNavigate={() => setDrawerOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

function PhoneCalendar() {
  const { t } = useT();
  const view = useCalendarUi((s) => (s.view === "day" ? "day" : "agenda"));
  const date = useCalendarUi((s) => s.date);
  const popover = useCalendarUi((s) => s.popover);
  const quick = useCalendarUi((s) => s.quick);
  const { setView, goToday, step } = useCalendarUi.getState();
  const drawerOpen = useUi((s) => s.folderDrawerOpen);
  const setDrawerOpen = useUi((s) => s.setFolderDrawerOpen);
  useBackLayer(drawerOpen, () => setDrawerOpen(false));
  useBackLayer(popover !== null, () => useCalendarUi.getState().closePopover());
  useBackLayer(quick !== null, () => useCalendarUi.getState().closeQuick());
  // Back from a single day goes to the list first.
  useBackLayer(view === "day", () => setView("agenda"));

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-surface">
      <header className="flex h-14 shrink-0 items-center gap-1 px-2">
        <IconButton icon={Menu} label={t("calendar.menu")} onClick={() => setDrawerOpen(true)} />
        {view === "day" && (
          <IconButton icon={ChevronLeft} label={t("calendar.previous.day")} onClick={() => step(-1)} />
        )}
        <h1 className="min-w-0 flex-1 truncate px-1 text-[18px] leading-tight font-extrabold">
          {view === "day" ? formatDayLong(date) : formatMonthTitle(date)}
        </h1>
        {view === "day" && <IconButton icon={ChevronRight} label={t("calendar.next.day")} onClick={() => step(1)} />}
        <Button size="sm" variant="ghost" onClick={goToday}>
          {t("calendar.today")}
        </Button>
        <IconButton
          icon={view === "day" ? List : CalendarDays}
          label={view === "day" ? t("calendar.views.agenda") : t("calendar.views.day")}
          onClick={() => setView(view === "day" ? "agenda" : "day")}
          active={view === "day"}
        />
      </header>
      <CalendarBody view={view} />
      <button
        type="button"
        onClick={startNewEvent}
        aria-label={t("calendar.newEvent")}
        className="fixed right-4 bottom-4 z-20 grid size-14 place-items-center rounded-2xl bg-pink-solid text-on-pink shadow-[0_6px_20px_rgb(225_29_116/0.35)] active:scale-95"
      >
        <Plus className="size-6" strokeWidth={2.4} aria-hidden />
      </button>
      {drawerOpen && (
        <div className="fixed inset-0 z-30" role="presentation">
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 animate-fade bg-[#1c1420]/40"
          />
          <div className="absolute inset-y-0 left-0 w-[300px] max-w-[85vw] animate-[uwu-drawer_220ms_cubic-bezier(0.2,0.9,0.3,1)] overflow-hidden rounded-r-[24px] bg-surface shadow-float">
            <CalendarSidebar className="h-full pt-3" onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
