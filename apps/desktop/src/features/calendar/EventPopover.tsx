import { AlignLeft, CalendarDays, Clock, MapPin, Pencil, Repeat, Trash, UserRound, X } from "lucide-react";
import { Fragment, useState } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/Field";
import { useT } from "@/i18n";
import { deviceTimeZone } from "@/lib/calendarDates";
import { requestOpenLink } from "@/state/links";
import { showContact } from "../contacts/state";
import { BirthdayMark } from "./BirthdayMark";
import { describeRecurrence, eventColor, formatWhen } from "./format";
import { Popover } from "./Popover";
import { useCalendarUi } from "./state";
import { useCalendars, useEventActions } from "./useCalendarData";

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?]/g;

/** Plain text with its web addresses clickable, through the same link check as links in mail. */
export function LinkedText({ text }: { text: string }) {
  const parts: { text: string; url: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), url: false });
    parts.push({ text: match[0], url: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), url: false });
  return (
    <>
      {parts.map((part, index) =>
        part.url ? (
          <a
            key={index}
            href={part.text}
            rel="noopener noreferrer"
            onClick={(event) => {
              event.preventDefault();
              requestOpenLink(part.text, part.text);
            }}
            // A middle click asks like a click; dragging the link out would open it elsewhere
            // without the question (security-audit C-12, as the mail reader does for W-17).
            onAuxClick={(event) => {
              event.preventDefault();
              if (event.button === 1) requestOpenLink(part.text, part.text);
            }}
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
            onContextMenu={(event) => event.preventDefault()}
            className="break-all text-pink-ink underline decoration-pink/40 underline-offset-2 hover:decoration-pink"
          >
            {part.text}
          </a>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

function Detail({ icon: Icon, children }: { icon: typeof Clock; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-[13.5px]">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** What an event is, with edit and delete where that's allowed. */
export function EventPopover() {
  const { t } = useT();
  const popover = useCalendarUi((s) => s.popover);
  const close = useCalendarUi((s) => s.closePopover);
  const openEditor = useCalendarUi((s) => s.openEditor);
  const { data: calendars = [] } = useCalendars();
  const actions = useEventActions();
  if (!popover) return null;
  const { occurrence } = popover;
  const calendar = calendars.find((c) => c.id === occurrence.calendarId);
  const color = eventColor(occurrence, calendars);
  const title = occurrence.title || t("calendar.untitled");
  const zone = occurrence.timeZone && occurrence.timeZone !== deviceTimeZone() ? occurrence.timeZone : null;
  const birthday = occurrence.birthday ?? null;

  return (
    <Popover key={occurrence.id} anchor={popover.anchor} label={title} onClose={close}>
      <div className="flex items-center justify-end gap-0.5 px-2 pt-2">
        {!occurrence.readOnly && (
          <>
            <IconButton
              icon={Pencil}
              label={t("calendar.edit")}
              onClick={() => openEditor({ occurrence })}
              data-autofocus
            />
            <IconButton
              icon={Trash}
              label={t("calendar.delete")}
              onClick={() => {
                close();
                void actions.remove(occurrence);
              }}
            />
          </>
        )}
        {occurrence.readOnly && calendar?.isLocal && !calendar.isBirthdays && (
          // An invitation kept on this device: answered from its mail, but it can go as a whole.
          <IconButton
            icon={Trash}
            label={t("calendar.delete")}
            onClick={() => {
              close();
              void actions.remove({ ...occurrence, recurrence: null });
            }}
          />
        )}
        <IconButton icon={X} label={t("common.close")} onClick={close} />
      </div>
      <div className="flex flex-col gap-3 px-5 pb-5">
        <div className="flex gap-3">
          <span className="mt-1.5 size-3.5 shrink-0 rounded-[5px]" style={{ background: color }} aria-hidden />
          <div className="min-w-0">
            <h2 className="selectable text-[18px] leading-snug font-bold break-words">{title}</h2>
            <p className="text-[13px] text-muted">{formatWhen(occurrence)}</p>
          </div>
        </div>
        {birthday && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-pink-tint/40 px-3 py-2.5">
            <BirthdayMark occurrence={occurrence} className="size-5 text-pink-ink" />
            <span className="min-w-0 flex-1 text-[14px] font-semibold">
              {birthday.age === null
                ? birthday.name
                : birthday.kind === "birth"
                  ? `${birthday.name} · ${t("calendar.birthdays.turns", { count: birthday.age })}`
                  : `${birthday.name} · ${t("calendar.birthdays.years", { count: birthday.age })}`}
            </span>
            <Button
              size="sm"
              variant="ghost"
              icon={UserRound}
              data-autofocus
              onClick={() => {
                close();
                showContact(birthday.contactId);
              }}
            >
              {t("calendar.birthdays.openContact")}
            </Button>
          </div>
        )}
        {occurrence.recurrence && !birthday && (
          <Detail icon={Repeat}>
            {describeRecurrence(occurrence.recurrence, t)}
            {!occurrence.recurrenceEditable && <span className="block text-muted">{t("calendar.repeat.complex")}</span>}
          </Detail>
        )}
        {zone && (
          <Detail icon={Clock}>
            <span className="text-muted">{t("calendar.timeZone", { zone })}</span>
          </Detail>
        )}
        {occurrence.location && (
          <Detail icon={MapPin}>
            <span className="selectable break-words">
              <LinkedText text={occurrence.location} />
            </span>
          </Detail>
        )}
        {occurrence.description && (
          <Detail icon={AlignLeft}>
            <p className="selectable max-h-48 overflow-y-auto break-words whitespace-pre-wrap">
              <LinkedText text={occurrence.description} />
            </p>
          </Detail>
        )}
        {calendar && (
          <Detail icon={CalendarDays}>
            {calendar.name}
            {calendar.sharedBy && (
              <span className="text-muted"> · {t("sharing.sharedBy", { name: calendar.sharedBy.name })}</span>
            )}
            {birthday ? (
              <span className="text-muted"> · {t("calendar.birthdays.fromContacts")}</span>
            ) : (
              occurrence.readOnly && <span className="text-muted"> · {t("calendar.readOnly")}</span>
            )}
          </Detail>
        )}
      </div>
    </Popover>
  );
}

/** A title for a new event right where it was clicked; "More options" opens the full editor. */
export function QuickCreate() {
  const { t } = useT();
  const quick = useCalendarUi((s) => s.quick);
  const close = useCalendarUi((s) => s.closeQuick);
  const openEditor = useCalendarUi((s) => s.openEditor);
  const { data: calendars = [] } = useCalendars();
  const actions = useEventActions();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  if (!quick) return null;
  const target = calendars.find((c) => c.isDefault && c.mayWrite) ?? calendars.find((c) => c.mayWrite);

  const save = async () => {
    if (!target) return;
    setBusy(true);
    const saved = await actions.create({
      calendarId: target.id,
      title: title.trim(),
      description: "",
      location: "",
      allDay: quick.allDay,
      start: quick.start,
      end: quick.end,
      timeZone: quick.allDay ? null : deviceTimeZone(),
      recurrence: null,
    });
    setBusy(false);
    if (saved) {
      setTitle("");
      close();
    }
  };

  return (
    <Popover
      key={`${quick.start}-${quick.end}`}
      anchor={quick.anchor}
      label={t("calendar.newEvent")}
      onClose={() => {
        setTitle("");
        close();
      }}
    >
      <form
        className="flex flex-col gap-3 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <TextInput
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("calendar.titlePlaceholder")}
          aria-label={t("calendar.eventTitle")}
          maxLength={500}
        />
        <p className="flex items-center gap-2 text-[13px] text-muted">
          <Clock className="size-4 shrink-0" aria-hidden />
          {formatWhen(quick)}
        </p>
        {target ? (
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <span className="size-3 rounded-[4px]" style={{ background: target.color ?? undefined }} aria-hidden />
            {target.name}
          </p>
        ) : (
          <p className="text-[13px] text-danger">{t("calendar.noWritableCalendar")}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              openEditor({
                occurrence: null,
                draft: { start: quick.start, end: quick.end, allDay: quick.allDay, title },
              });
              setTitle("");
            }}
          >
            {t("calendar.moreOptions")}
          </Button>
          <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!target}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Popover>
  );
}
