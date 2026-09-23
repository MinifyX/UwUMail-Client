import clsx from "clsx";
import { Trash } from "lucide-react";
import { useState } from "react";
import type { CalendarOccurrence, EventInput, Recurrence, Weekday } from "@/backend/types";
import { Button } from "@/components/ui/Button";
import { ConfirmDiscardDialog } from "@/components/ui/ConfirmDiscardDialog";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Segmented, Select, TextInput, Toggle } from "@/components/ui/Field";
import { useT } from "@/i18n";
import {
  addDays,
  addMinutes,
  atMidnight,
  clockOf,
  dateOf,
  deviceTimeZone,
  diffMinutes,
  todayKey,
  withClock,
  type WallTime,
} from "@/lib/calendarDates";
import { useAccounts } from "@/lib/queries";
import { WEEKDAYS, weekdayOf } from "@/lib/recurrence";
import { groupByAccount } from "./accounts";
import { describeRecurrence, formatWeekdayNarrow, formatWeekdayShort } from "./format";
import { useCalendarUi, type EditorRequest } from "./state";
import { useCalendars, useEventActions } from "./useCalendarData";

type Frequency = Recurrence["frequency"] | "none";
type Ends = "never" | "until" | "count";

interface Form {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  calendarId: string;
  location: string;
  description: string;
  frequency: Frequency;
  interval: string;
  byDay: Weekday[];
  ends: Ends;
  until: string;
  count: string;
}

/** A Monday, for naming weekdays in the locale. */
const A_MONDAY = "2026-09-21";

function initialForm(request: EditorRequest, defaultCalendar: string): Form {
  const source = request.occurrence ?? {
    title: request.draft?.title ?? "",
    allDay: request.draft?.allDay ?? false,
    start: request.draft?.start ?? withClock(todayKey(), "09:00"),
    end: request.draft?.end ?? withClock(todayKey(), "10:00"),
    calendarId: defaultCalendar,
    location: "",
    description: "",
    recurrence: null,
  };
  const recurrence = source.recurrence;
  // All-day ends are exclusive; the form shows the last day.
  const endDate = source.allDay ? addDays(dateOf(source.end), -1) : dateOf(source.end);
  return {
    title: source.title,
    allDay: source.allDay,
    startDate: dateOf(source.start),
    startTime: source.allDay ? "09:00" : clockOf(source.start),
    endDate: endDate < dateOf(source.start) ? dateOf(source.start) : endDate,
    endTime: source.allDay ? "10:00" : clockOf(source.end),
    calendarId: source.calendarId,
    location: source.location,
    description: source.description,
    frequency: recurrence?.frequency ?? "none",
    interval: String(recurrence?.interval ?? 1),
    byDay: recurrence?.byDay ?? [weekdayOf(dateOf(source.start))],
    ends: recurrence?.until ? "until" : recurrence?.count ? "count" : "never",
    until: recurrence?.until ?? addDays(dateOf(source.start), 30),
    count: String(recurrence?.count ?? 10),
  };
}

type Problem = "end" | "interval" | "until" | "count" | "days";

function problemsOf(form: Form): Problem[] {
  const problems: Problem[] = [];
  const start = withClock(form.startDate, form.startTime);
  const end = withClock(form.endDate, form.endTime);
  if (!form.startDate || !form.endDate) problems.push("end");
  else if (form.allDay ? form.endDate < form.startDate : end <= start) problems.push("end");
  if (form.frequency !== "none") {
    const interval = Number(form.interval);
    if (!Number.isInteger(interval) || interval < 1 || interval > 999) problems.push("interval");
    if (form.frequency === "weekly" && form.byDay.length === 0) problems.push("days");
    if (form.ends === "until" && (!form.until || form.until < form.startDate)) problems.push("until");
    const count = Number(form.count);
    if (form.ends === "count" && (!Number.isInteger(count) || count < 1 || count > 9999)) problems.push("count");
  }
  return problems;
}

function recurrenceOf(form: Form): Recurrence | null {
  if (form.frequency === "none") return null;
  return {
    frequency: form.frequency,
    interval: Number(form.interval),
    byDay: form.frequency === "weekly" ? WEEKDAYS.filter((day) => form.byDay.includes(day)) : null,
    until: form.ends === "until" ? form.until : null,
    count: form.ends === "count" ? Number(form.count) : null,
  };
}

/** The whole event: times, repetition, calendar, place and notes. Mounted once in the calendar. */
export function EventEditor() {
  const request = useCalendarUi((s) => s.editor);
  const close = useCalendarUi((s) => s.closeEditor);
  const key = request ? (request.occurrence?.id ?? `new:${request.draft?.start ?? ""}`) : "closed";
  return <EditorDialog key={key} request={request} onClose={close} />;
}

function EditorDialog({ request, onClose }: { request: EditorRequest | null; onClose: () => void }) {
  const { t } = useT();
  const { data: calendars = [] } = useCalendars();
  const { data: accounts = [] } = useAccounts();
  // An event stays in its own account: it can only move to another calendar there.
  const writable = calendars.filter(
    (calendar) => calendar.mayWrite && (!request?.occurrence || calendar.accountId === request.occurrence.accountId),
  );
  const groups = groupByAccount(writable, accounts);
  const fallback = writable.find((calendar) => calendar.isDefault) ?? writable[0];
  const [form, setFormState] = useState<Form | null>(() => (request ? initialForm(request, fallback?.id ?? "") : null));
  const [dirty, setDirty] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const actions = useEventActions();
  if (!request || !form)
    return (
      <Dialog open={false} onClose={onClose}>
        {null}
      </Dialog>
    );

  const occurrence: CalendarOccurrence | null = request.occurrence;
  const editable = occurrence ? occurrence.recurrenceEditable : true;
  const problems = problemsOf(form);
  const shown = tried ? problems : [];
  const calendarId = form.calendarId || fallback?.id || "";

  const setForm = (patch: Partial<Form>) => {
    setDirty(true);
    setFormState({ ...form, ...patch });
  };
  // Moving the start keeps the length, like any calendar does.
  const moveStart = (date: string, time: string) => {
    if (!date) return setForm({ startDate: date });
    if (form.allDay) {
      const days = Math.max(0, Math.round(diffMinutes(atMidnight(form.startDate), atMidnight(form.endDate)) / 1440));
      return setForm({ startDate: date, endDate: addDays(date, days) });
    }
    const length = Math.max(
      15,
      diffMinutes(withClock(form.startDate, form.startTime), withClock(form.endDate, form.endTime)),
    );
    const end: WallTime = addMinutes(withClock(date, time), length);
    setForm({ startDate: date, startTime: time, endDate: dateOf(end), endTime: clockOf(end) });
  };

  const requestClose = () => (dirty ? setAsking(true) : onClose());

  const save = async () => {
    setTried(true);
    if (problems.length > 0 || !calendarId) return;
    const input: EventInput = {
      calendarId,
      title: form.title.trim(),
      description: form.description,
      location: form.location.trim(),
      allDay: form.allDay,
      start: form.allDay ? atMidnight(form.startDate) : withClock(form.startDate, form.startTime),
      end: form.allDay ? atMidnight(addDays(form.endDate, 1)) : withClock(form.endDate, form.endTime),
      timeZone: form.allDay ? null : deviceTimeZone(),
      recurrence: editable ? recurrenceOf(form) : (occurrence?.recurrence ?? null),
    };
    setBusy(true);
    const saved = occurrence ? await actions.update(occurrence, input) : await actions.create(input);
    setBusy(false);
    if (saved) onClose();
  };

  const unit = form.frequency === "none" ? "daily" : form.frequency;
  return (
    <>
      <Dialog
        open
        onClose={requestClose}
        closeOnOutsideClick={!dirty}
        title={occurrence ? t("calendar.editEvent") : t("calendar.newEvent")}
        width="md"
      >
        <form
          className="flex flex-col gap-4 px-6 pt-2 pb-6"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label={t("calendar.eventTitle")}>
            {(id) => (
              <TextInput
                id={id}
                autoFocus
                value={form.title}
                maxLength={500}
                placeholder={t("calendar.titlePlaceholder")}
                onChange={(event) => setForm({ title: event.target.value })}
              />
            )}
          </Field>

          <Toggle checked={form.allDay} onChange={(allDay) => setForm({ allDay })} label={t("calendar.allDay")} />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("calendar.starts")}>
              {(id) => (
                <div className={clsx("grid gap-2", !form.allDay && "grid-cols-[minmax(0,1fr)_7.5rem]")}>
                  <TextInput
                    id={id}
                    type="date"
                    required
                    value={form.startDate}
                    onChange={(event) => moveStart(event.target.value, form.startTime)}
                  />
                  {!form.allDay && (
                    <TextInput
                      type="time"
                      required
                      step={300}
                      aria-label={t("calendar.startTime")}
                      value={form.startTime}
                      onChange={(event) => moveStart(form.startDate, event.target.value)}
                    />
                  )}
                </div>
              )}
            </Field>
            <Field label={t("calendar.ends")} error={shown.includes("end") ? t("calendar.problem.end") : undefined}>
              {(id) => (
                <div className={clsx("grid gap-2", !form.allDay && "grid-cols-[minmax(0,1fr)_7.5rem]")}>
                  <TextInput
                    id={id}
                    type="date"
                    required
                    value={form.endDate}
                    aria-invalid={shown.includes("end")}
                    onChange={(event) => setForm({ endDate: event.target.value })}
                  />
                  {!form.allDay && (
                    <TextInput
                      type="time"
                      required
                      step={300}
                      aria-label={t("calendar.endTime")}
                      value={form.endTime}
                      onChange={(event) => setForm({ endTime: event.target.value })}
                    />
                  )}
                </div>
              )}
            </Field>
          </div>

          {editable ? (
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1.5 text-[13px] font-semibold text-muted">{t("calendar.repeat.label")}</legend>
              <Select
                aria-label={t("calendar.repeat.label")}
                value={form.frequency}
                onChange={(event) => setForm({ frequency: event.target.value as Frequency })}
              >
                {(["none", "daily", "weekly", "monthly", "yearly"] as const).map((frequency) => (
                  <option key={frequency} value={frequency}>
                    {t(`calendar.repeat.${frequency}`)}
                  </option>
                ))}
              </Select>
              {form.frequency !== "none" && (
                <>
                  <div className="flex items-center gap-2 text-[13.5px]">
                    <span>{t("calendar.repeat.everyLabel")}</span>
                    <span className="w-20 shrink-0">
                      <TextInput
                        type="number"
                        min={1}
                        max={999}
                        inputMode="numeric"
                        aria-label={t("calendar.repeat.interval")}
                        aria-invalid={shown.includes("interval")}
                        value={form.interval}
                        onChange={(event) => setForm({ interval: event.target.value })}
                      />
                    </span>
                    <span>{t(`calendar.repeat.unit.${unit}`, { count: Number(form.interval) || 1 })}</span>
                  </div>
                  {form.frequency === "weekly" && (
                    <div role="group" aria-label={t("calendar.repeat.days")} className="flex flex-wrap gap-1.5">
                      {WEEKDAYS.map((day, index) => {
                        const on = form.byDay.includes(day);
                        const date = addDays(A_MONDAY, index);
                        return (
                          <button
                            key={day}
                            type="button"
                            aria-pressed={on}
                            aria-label={formatWeekdayShort(date)}
                            title={formatWeekdayShort(date)}
                            onClick={() =>
                              setForm({ byDay: on ? form.byDay.filter((d) => d !== day) : [...form.byDay, day] })
                            }
                            className={clsx(
                              "grid size-9 place-items-center rounded-full text-[13px] font-bold transition-colors",
                              on ? "bg-pink-solid text-on-pink" : "bg-canvas text-muted hover:text-ink",
                            )}
                          >
                            {formatWeekdayNarrow(date)}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Segmented
                      label={t("calendar.repeat.ends")}
                      value={form.ends}
                      onChange={(ends) => setForm({ ends })}
                      options={[
                        { value: "never", label: t("calendar.repeat.never") },
                        { value: "until", label: t("calendar.repeat.onDate") },
                        { value: "count", label: t("calendar.repeat.after") },
                      ]}
                    />
                    {form.ends === "until" && (
                      <span className="w-44 max-w-full">
                        <TextInput
                          type="date"
                          aria-label={t("calendar.repeat.untilDate")}
                          aria-invalid={shown.includes("until")}
                          value={form.until}
                          onChange={(event) => setForm({ until: event.target.value })}
                        />
                      </span>
                    )}
                    {form.ends === "count" && (
                      <span className="flex items-center gap-2 text-[13.5px]">
                        <span className="w-20 shrink-0">
                          <TextInput
                            type="number"
                            min={1}
                            inputMode="numeric"
                            aria-label={t("calendar.repeat.count")}
                            aria-invalid={shown.includes("count")}
                            value={form.count}
                            onChange={(event) => setForm({ count: event.target.value })}
                          />
                        </span>
                        {t("calendar.repeat.occurrences", { count: Number(form.count) || 0 })}
                      </span>
                    )}
                  </div>
                  {shown.some((problem) => problem !== "end") && (
                    <p role="alert" className="text-[13px] text-danger">
                      {t("calendar.problem.repeat")}
                    </p>
                  )}
                </>
              )}
              {occurrence?.recurrence && <p className="text-[12.5px] text-muted">{t("calendar.repeat.wholeSeries")}</p>}
            </fieldset>
          ) : (
            occurrence?.recurrence && (
              <div className="rounded-2xl bg-canvas px-4 py-3 text-[13px]">
                <p className="font-semibold">{describeRecurrence(occurrence.recurrence, t)}</p>
                <p className="text-muted">{t("calendar.repeat.complex")}</p>
              </div>
            )
          )}

          <Field label={t("calendar.calendar")}>
            {(id) => (
              <Select id={id} value={calendarId} onChange={(event) => setForm({ calendarId: event.target.value })}>
                {groups.length > 1
                  ? groups.map((group) => (
                      <optgroup key={group.accountId} label={group.name}>
                        {group.calendars.map((calendar) => (
                          <option key={calendar.id} value={calendar.id}>
                            {calendar.name}
                          </option>
                        ))}
                      </optgroup>
                    ))
                  : writable.map((calendar) => (
                      <option key={calendar.id} value={calendar.id}>
                        {calendar.name}
                      </option>
                    ))}
              </Select>
            )}
          </Field>
          <Field label={t("calendar.location")}>
            {(id) => (
              <TextInput
                id={id}
                value={form.location}
                maxLength={500}
                onChange={(event) => setForm({ location: event.target.value })}
              />
            )}
          </Field>
          <Field label={t("calendar.description")}>
            {(id) => (
              <textarea
                id={id}
                value={form.description}
                rows={4}
                maxLength={10000}
                onChange={(event) => setForm({ description: event.target.value })}
                className="w-full resize-y rounded-control border border-line bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-faint focus:border-pink focus:shadow-focus focus:outline-none"
              />
            )}
          </Field>

          <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
            {occurrence && !occurrence.readOnly && (
              <Button
                variant="danger"
                icon={Trash}
                onClick={() =>
                  void actions.remove(occurrence).then((removed) => {
                    if (removed) onClose();
                  })
                }
              >
                {t("calendar.delete")}
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="ghost" onClick={requestClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" busy={busy} disabled={writable.length === 0}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      </Dialog>
      <ConfirmDiscardDialog
        open={asking}
        onKeepEditing={() => setAsking(false)}
        onDiscard={() => {
          setAsking(false);
          onClose();
        }}
      />
    </>
  );
}
