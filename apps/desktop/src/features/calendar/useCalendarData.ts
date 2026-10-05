import { useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/backend/backend";
import type { CalendarInfo, CalendarOccurrence, EventInput } from "@/backend/types";
import { useCallback } from "react";
import { translate, useT } from "@/i18n";
import { localizeBirthdays } from "@/lib/birthdays";
import {
  addDays,
  atMidnight,
  deviceTimeZone,
  monthWeeks,
  startOfWeek,
  type DateKey,
  type WallTime,
} from "@/lib/calendarDates";
import { queryKeys } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { askDeleteScope, type CalendarView } from "./state";

export function useCalendarsAvailable() {
  return useQuery({
    queryKey: ["calendarsAvailable"],
    queryFn: () => backend().calendarsAvailable(),
    staleTime: Infinity,
  });
}

export function useCalendars() {
  const client = useQueryClient();
  const { t } = useT();
  // The calendars the app makes itself (birthdays, invitations) are named in the UI's language.
  const select = useCallback(
    (list: CalendarInfo[]) =>
      list.map((calendar) =>
        calendar.isBirthdays && calendar.isLocal
          ? { ...calendar, name: t("calendar.birthdays.calendarName") }
          : calendar.isLocal
            ? // The calendar of invitations the app keeps on this device (see Invitation.tsx).
              { ...calendar, name: t("invitation.localCalendar") }
            : calendar,
      ),
    [t],
  );
  return useQuery({
    queryKey: queryKeys.calendars,
    queryFn: async () => {
      try {
        return await backend().calendars();
      } finally {
        // Listing them is what searches for CalDAV and CardDAV servers; now it is known whether
        // there are any, and whether birthdays can be taken over.
        void client.invalidateQueries({ queryKey: ["calendarsAvailable"] });
        void client.invalidateQueries({ queryKey: ["birthdayFeatures"] });
      }
    },
    select,
  });
}

/** The days a view shows, and the wall-time range to ask the server for. */
export function visibleDays(view: CalendarView, date: DateKey, weekStart: number): DateKey[] {
  switch (view) {
    case "month":
      return monthWeeks(date, weekStart).flat();
    case "week": {
      const first = startOfWeek(date, weekStart);
      return Array.from({ length: 7 }, (_, index) => addDays(first, index));
    }
    case "day":
      return [date];
    case "agenda":
      return Array.from({ length: 30 }, (_, index) => addDays(date, index));
  }
}

export function useOccurrences(days: DateKey[]) {
  const zone = deviceTimeZone();
  const from: WallTime = atMidnight(days[0] ?? "1970-01-01");
  const to: WallTime = atMidnight(addDays(days[days.length - 1] ?? "1970-01-01", 1));
  const { i18n } = useT();
  const language = i18n.language;
  // Birthdays with the age, titled in the UI's language.
  const select = useCallback((list: CalendarOccurrence[]) => localizeBirthdays(list, language), [language]);
  return useQuery({
    queryKey: [...queryKeys.calendarEvents, from, to, zone],
    queryFn: () => backend().calendarEvents(from, to, zone),
    placeholderData: (previous) => previous,
    select,
  });
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Creating, changing and deleting events, with the toasts and the refresh after each. */
export function useEventActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.calendarEvents });

  return {
    create: async (input: EventInput): Promise<boolean> => {
      try {
        await backend().createEvent(input);
        toast(translate("calendar.toast.created"), "success");
        return true;
      } catch (error) {
        toast(translate("calendar.toast.failed", { reason: reason(error) }), "error");
        return false;
      } finally {
        await refresh();
      }
    },
    update: async (occurrence: CalendarOccurrence, input: EventInput, quiet = false): Promise<boolean> => {
      try {
        await backend().updateEvent(occurrence.eventId, input, occurrence.recurrence ? occurrence.start : undefined);
        if (!quiet) toast(translate("calendar.toast.saved"), "success");
        return true;
      } catch (error) {
        toast(translate("calendar.toast.failed", { reason: reason(error) }), "error");
        return false;
      } finally {
        await refresh();
      }
    },
    /** A single event goes right away; a series first asks whether only this one or all of them. */
    remove: async (occurrence: CalendarOccurrence): Promise<boolean> => {
      const scope = occurrence.recurrence ? await askDeleteScope(occurrence.title) : "series";
      if (!scope) return false;
      try {
        await backend().deleteEvent(occurrence.id, scope);
        toast(translate("calendar.toast.deleted"), "success");
        return true;
      } catch (error) {
        toast(translate("calendar.toast.failed", { reason: reason(error) }), "error");
        return false;
      } finally {
        await refresh();
      }
    },
  };
}

/** What an occurrence would save as, e.g. after it was dragged somewhere else. */
export function inputOf(occurrence: CalendarOccurrence, patch: Partial<EventInput> = {}): EventInput {
  return {
    calendarId: occurrence.calendarId,
    title: occurrence.title,
    description: occurrence.description,
    location: occurrence.location,
    allDay: occurrence.allDay,
    start: occurrence.start,
    end: occurrence.end,
    timeZone: occurrence.allDay ? null : deviceTimeZone(),
    recurrence: occurrence.recurrence,
    ...patch,
  };
}
