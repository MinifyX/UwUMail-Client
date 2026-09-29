import { X } from "lucide-react";
import { useId, useState } from "react";
import type { BirthdayReminder } from "@/backend/types";
import { IconButton } from "@/components/ui/Button";
import { Select, TextInput } from "@/components/ui/Field";
import { useT } from "@/i18n";
import {
  ageOn,
  formatDay,
  nextTime,
  normalizeReminders,
  parseDay,
  partialDay,
  REMINDER_PRESETS,
  sameReminder,
} from "@/lib/birthdays";
import { todayKey } from "@/lib/calendarDates";
import { formatBirthday } from "./format";

interface Parts {
  day: string;
  month: string;
  year: string;
}

function partsOf(value: string | null): Parts {
  const date = parseDay(value);
  if (!date) return { day: "", month: "", year: "" };
  return { day: String(date.day), month: String(date.month), year: date.year === null ? "" : String(date.year) };
}

/** The day the fields give: a string, null for none, or "invalid" for a day that doesn't exist. */
export function dayFromParts(parts: Parts): string | null | "invalid" {
  const day = parts.day.trim();
  const month = parts.month.trim();
  const year = parts.year.trim();
  if (!day && !month && !year) return null;
  if (!/^\d{1,2}$/.test(day) || !/^\d{1,2}$/.test(month) || (year && !/^\d{4}$/.test(year))) return "invalid";
  const date = partialDay(year ? Number(year) : null, Number(month), Number(day));
  return date ? formatDay(date) : "invalid";
}

function monthNames(locale: string): string[] {
  return Array.from({ length: 12 }, (_, index) =>
    new Date(Date.UTC(2000, index, 1)).toLocaleDateString(locale, { month: "long", timeZone: "UTC" }),
  );
}

/**
 * Day, month and an optional year: a birthday or anniversary the way cards keep it, with or
 * without the year. Below it how old someone is and when it comes next.
 */
export function DayField({
  label,
  clearLabel,
  value,
  kind,
  onChange,
}: {
  label: string;
  clearLabel: string;
  value: string | null;
  kind: "birth" | "wedding";
  /** A day, null for none; `valid` false while the fields give a day that doesn't exist. */
  onChange: (value: string | null, valid: boolean) => void;
}) {
  const { t, i18n } = useT();
  const id = useId();
  const [parts, setParts] = useState<Parts>(() => partsOf(value));
  const result = dayFromParts(parts);
  const invalid = result === "invalid";

  const change = (patch: Partial<Parts>) => {
    const next = { ...parts, ...patch };
    setParts(next);
    const day = dayFromParts(next);
    onChange(day === "invalid" ? value : day, day !== "invalid");
  };

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-[13px] font-semibold text-muted">{label}</legend>
      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          id={`${id}-day`}
          inputMode="numeric"
          autoComplete="off"
          aria-label={t("contacts.day")}
          placeholder={t("contacts.day")}
          aria-invalid={invalid}
          value={parts.day}
          maxLength={2}
          onChange={(event) => change({ day: event.target.value.replace(/\D/g, "") })}
          className="w-[4.5rem]"
        />
        <span className="w-40">
          <Select
            aria-label={t("contacts.month")}
            aria-invalid={invalid}
            value={parts.month}
            onChange={(event) => change({ month: event.target.value })}
          >
            <option value="">{t("contacts.month")}</option>
            {monthNames(i18n.language).map((name, index) => (
              <option key={name} value={String(index + 1)}>
                {name}
              </option>
            ))}
          </Select>
        </span>
        <TextInput
          inputMode="numeric"
          autoComplete="off"
          aria-label={t("contacts.yearOptional")}
          placeholder={t("contacts.yearOptional")}
          aria-invalid={invalid}
          value={parts.year}
          maxLength={4}
          onChange={(event) => change({ year: event.target.value.replace(/\D/g, "") })}
          className="w-36"
        />
        {(parts.day || parts.month || parts.year) && (
          <IconButton icon={X} size="sm" label={clearLabel} onClick={() => change({ day: "", month: "", year: "" })} />
        )}
      </div>
      {invalid ? (
        <p role="alert" className="text-[13px] text-danger">
          {t("contacts.noSuchDay")}
        </p>
      ) : (
        result && <DayPreview value={result} kind={kind} locale={i18n.language} />
      )}
    </fieldset>
  );
}

/** "30 years old · turns 31 on 12 April 2027", or when it comes next without a year. */
export function DayPreview({ value, kind, locale }: { value: string; kind: "birth" | "wedding"; locale: string }) {
  const { t } = useT();
  const text = describeDay(value, kind, locale, t);
  return text ? <p className="text-[12.5px] text-muted">{text}</p> : null;
}

/** The age and the next time of a birthday or anniversary, in words; null when it's no day. */
export function describeDay(
  value: string,
  kind: "birth" | "wedding",
  locale: string,
  t: (key: string, options?: Record<string, unknown>) => string,
  today: string = todayKey(),
): string | null {
  const date = parseDay(value);
  if (!date) return null;
  const next = nextTime(date, today);
  const now = ageOn(date, today);
  const parts: string[] = [];
  if (next.inDays === 0) {
    if (next.age !== null && next.age > 0) {
      parts.push(
        kind === "birth"
          ? t("calendar.birthdays.turns", { count: next.age })
          : t("contacts.yearsSince", { count: next.age }),
      );
    }
    parts.push(t("contacts.isToday"));
  } else {
    const when = formatBirthday(next.date, locale);
    if (now !== null) parts.push(t(kind === "birth" ? "contacts.yearsOld" : "contacts.yearsSince", { count: now }));
    parts.push(
      kind === "birth" && next.age !== null && next.age > 0
        ? t("contacts.turnsOn", { count: next.age, date: when })
        : t("contacts.nextOn", { date: when }),
    );
  }
  return parts.join(" · ");
}

/** Label of one reminder: the presets by name, others as "N days before at HH:MM". */
export function reminderLabel(
  reminder: BirthdayReminder,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (reminder.time === "09:00") {
    if (reminder.daysBefore === 0) return t("contacts.reminderDay");
    if (reminder.daysBefore === 1) return t("contacts.reminderDayBefore");
    if (reminder.daysBefore === 7) return t("contacts.reminderWeekBefore");
  }
  return t("contacts.reminderOther", { count: reminder.daysBefore, time: reminder.time });
}

/** The reminders of a contact's birthday and anniversary: the presets to tick, and any a phone set. */
export function RemindersField({
  value,
  onChange,
}: {
  value: BirthdayReminder[];
  onChange: (reminders: BirthdayReminder[]) => void;
}) {
  const { t } = useT();
  // Ones set elsewhere stay listed while the editor is open, even once unticked.
  const [others] = useState(() => value.filter((reminder) => !REMINDER_PRESETS.some((p) => sameReminder(p, reminder))));
  const has = (reminder: BirthdayReminder) => value.some((mine) => sameReminder(mine, reminder));
  const toggle = (reminder: BirthdayReminder, on: boolean) =>
    onChange(normalizeReminders(on ? [...value, reminder] : value.filter((mine) => !sameReminder(mine, reminder))));
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-[13px] font-semibold text-muted">{t("contacts.reminders")}</legend>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {[...REMINDER_PRESETS, ...others].map((reminder) => (
          <label key={`${reminder.daysBefore}-${reminder.time}`} className="flex items-center gap-2 text-[13.5px]">
            <input
              type="checkbox"
              checked={has(reminder)}
              onChange={(event) => toggle(reminder, event.target.checked)}
              className="size-4 accent-pink"
            />
            {reminderLabel(reminder, t)}
          </label>
        ))}
      </div>
      <p className="text-[12px] text-muted">{t("contacts.remindersHint")}</p>
    </fieldset>
  );
}
