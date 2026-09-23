import { lazy, Suspense } from "react";

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
