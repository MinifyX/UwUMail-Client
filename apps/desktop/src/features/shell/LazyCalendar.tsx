import { lazy, Suspense, useState } from "react";
import { useCalendarUi } from "../calendar/state";

// The calendar loads when it is first opened, so the mail starts no slower for it.
const CalendarShell = lazy(() =>
  import("../calendar/CalendarShell").then((module) => ({ default: module.CalendarShell })),
);

/** The calendar in place of the mail (see CalendarShell). */
export function LazyCalendar() {
  return (
    <Suspense fallback={null}>
      <CalendarShell />
    </Suspense>
  );
}

const EventEditor = lazy(() => import("../calendar/EventEditor").then((module) => ({ default: module.EventEditor })));
const DeleteScopeQuestion = lazy(() =>
  import("../calendar/DeleteScopeQuestion").then((module) => ({ default: module.DeleteScopeQuestion })),
);

/**
 * The event editor and "only this one or the series?", for the calendar and the mail ("add to
 * calendar" on an appointment found in a mail), loaded once one of them is first asked for.
 */
export function LazyCalendarDialogs() {
  const wanted = useCalendarUi((s) => s.editor !== null || s.deleteScope !== null);
  // Once loaded they stay, so a dialog can close the way it opened.
  const [loaded, setLoaded] = useState(false);
  if (wanted && !loaded) setLoaded(true);
  if (!loaded) return null;
  return (
    <Suspense fallback={null}>
      <EventEditor />
      <DeleteScopeQuestion />
    </Suspense>
  );
}
