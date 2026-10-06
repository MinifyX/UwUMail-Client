import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Icon, type IconProps, ICONS } from "@uwusuite/design";
import { useId, useState } from "react";
import { backend } from "@/backend/backend";
import type { MailScheduling, Message, ParticipationStatus } from "@/backend/types";
import { Avatar } from "@/components/ui/Avatar";
import { useT } from "@/i18n";
import { visibleText } from "@/lib/links";
import { queryKeys } from "@/lib/queries";
import { toast } from "@/state/toasts";

type Answer = Exclude<ParticipationStatus, "needs-action">;

const ANSWERS: { status: Answer; icon: IconProps["icon"] }[] = [
  { status: "accepted", icon: ICONS.done },
  { status: "tentative", icon: ICONS.maybe },
  { status: "declined", icon: ICONS.close },
];

/** The most characters a comment for the organizer takes (the core cuts there too). */
const MAX_COMMENT = 2000;

/** The key of a mail's invitation query, so answering elsewhere refreshes it too. */
const invitationKey = (messageId: string) => ["invitation", messageId] as const;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the answer is so far, in words. */
export function invitationStatusKey(status: ParticipationStatus): string {
  return `invitation.status.${status}`;
}

/** Whether a mail has an iCalendar part (an invitation, a cancellation or an answer). */
export function carriesInvitation(message: Pick<Message, "attachments">): boolean {
  return message.attachments.some(
    (attachment) =>
      attachment.mimeType.toLowerCase().startsWith("text/calendar") ||
      attachment.mimeType.toLowerCase().startsWith("application/ics") ||
      /\.ics$/i.test(attachment.filename),
  );
}

/** A start or end from the core: a date, a UTC instant, or a wall time without zone. */
function moment(value: string, allDay: boolean): Date {
  return new Date(allDay ? `${value}T00:00:00` : value);
}

/** "Tuesday, 20 October 2026, 09:00 – 10:00" in the UI's language. */
export function formatInvitationTime(found: Pick<MailScheduling, "start" | "end" | "allDay">, language: string) {
  if (!found.start) return null;
  const start = moment(found.start, found.allDay);
  if (Number.isNaN(start.getTime())) return null;
  if (found.allDay) {
    const text = start.toLocaleDateString(language, { dateStyle: "full" });
    if (!found.end) return text;
    // All-day ends are exclusive: a one-day event ends the next morning.
    const last = moment(found.end, true);
    last.setDate(last.getDate() - 1);
    return last.getTime() > start.getTime()
      ? `${text} – ${last.toLocaleDateString(language, { dateStyle: "full" })}`
      : text;
  }
  const text = start.toLocaleString(language, { dateStyle: "full", timeStyle: "short" });
  const end = found.end ? moment(found.end, false) : null;
  if (!end || Number.isNaN(end.getTime()) || end <= start) return text;
  const sameDay = end.toDateString() === start.toDateString();
  return `${text} – ${
    sameDay
      ? end.toLocaleTimeString(language, { timeStyle: "short" })
      : end.toLocaleString(language, { dateStyle: "medium", timeStyle: "short" })
  }`;
}

/** Accept, maybe, decline, with an optional comment; nothing goes out but on a click. */
function InvitationAnswer({ messageId, found }: { messageId: string; found: MailScheduling }) {
  const { t, i18n } = useT();
  const client = useQueryClient();
  const commentId = useId();
  const [busy, setBusy] = useState<Answer | null>(null);
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState("");

  const answer = async (status: Answer) => {
    setBusy(status);
    try {
      await backend().respondToInvitation(
        messageId,
        status,
        found.canComment && comment.trim() ? comment.trim() : undefined,
        i18n.language,
      );
      toast(t(`invitation.answered.${status}`), "success");
      setComment("");
      setCommenting(false);
    } catch (error) {
      toast(t("invitation.failed", { reason: reason(error) }), "error");
    } finally {
      setBusy(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.calendarEvents }),
        client.invalidateQueries({ queryKey: queryKeys.calendars }),
        client.invalidateQueries({ queryKey: ["calendarsAvailable"] }),
        client.invalidateQueries({ queryKey: ["invitation"] }),
      ]);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <div role="group" aria-label={t("invitation.answer")} className="flex flex-wrap gap-1.5">
          {ANSWERS.map(({ status, icon: Glyph }) => {
            const chosen = found.status === status;
            return (
              <button
                key={status}
                type="button"
                aria-pressed={chosen}
                disabled={busy !== null}
                onClick={() => void answer(status)}
                className={clsx(
                  "inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold transition-colors disabled:opacity-55",
                  chosen
                    ? "border-pink-solid bg-pink-solid text-on-pink"
                    : "border-line bg-surface text-ink hover:bg-pink-tint/60",
                )}
              >
                <Icon icon={Glyph} size="xs" />
                {t(`invitation.${status}`)}
              </button>
            );
          })}
        </div>
        {found.canComment && !commenting && (
          <button
            type="button"
            onClick={() => setCommenting(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-semibold text-muted hover:bg-pink-tint/60 hover:text-ink"
          >
            <Icon icon={ICONS.comment} size="xs" />
            {t("invitation.commentAdd")}
          </button>
        )}
      </div>
      {found.canComment && commenting && (
        <div className="flex flex-col gap-1">
          <label htmlFor={commentId} className="text-[12px] font-semibold text-muted">
            {t("invitation.commentLabel")}
          </label>
          <textarea
            id={commentId}
            value={comment}
            maxLength={MAX_COMMENT}
            rows={2}
            disabled={busy !== null}
            placeholder={t("invitation.commentPlaceholder")}
            onChange={(event) => setComment(event.target.value)}
            className="w-full resize-y rounded-xl border border-line bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-pink"
          />
        </div>
      )}
    </div>
  );
}

/** Takes the event the organizer cancelled out of the calendar, on a click. */
function RemoveCancelled({ messageId, found }: { messageId: string; found: MailScheduling }) {
  const { t } = useT();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await backend().removeCancelledEvent(messageId);
      toast(t("invitation.removed"), "success");
    } catch (error) {
      toast(t("invitation.removeFailed", { reason: reason(error) }), "error");
    } finally {
      setBusy(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.calendarEvents }),
        client.invalidateQueries({ queryKey: queryKeys.calendars }),
        client.invalidateQueries({ queryKey: ["invitation"] }),
      ]);
    }
  };
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void remove()}
      className="inline-flex h-9 w-fit items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[13px] font-semibold text-ink transition-colors hover:bg-pink-tint/60 disabled:opacity-55"
    >
      <Icon icon={ICONS.removeEvent} size="xs" />
      {found.occurrence ? t("invitation.removeDate") : t("invitation.remove")}
    </button>
  );
}

/** Where, how often, who: what the mail says about the event. */
function Details({ found }: { found: MailScheduling }) {
  const { t, i18n } = useT();
  const occurrence = found.occurrence
    ? formatInvitationTime({ start: found.occurrence, end: null, allDay: found.allDay }, i18n.language)
    : null;
  const people = found.attendees.length + found.moreAttendees;
  if (!found.location && !found.repeats && !occurrence && people === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 text-[13px]">
      {found.location && (
        <p className="flex items-start gap-2">
          <Icon icon={ICONS.location} size="xs" className="mt-0.5 shrink-0 text-muted" label={t("invitation.where")} />
          <span className="min-w-0 break-words">{found.location}</span>
        </p>
      )}
      {found.repeats && !occurrence && (
        <p className="flex items-center gap-2 text-muted">
          <Icon icon={ICONS.repeat} size="xs" className="shrink-0" />
          {t("invitation.repeats")}
        </p>
      )}
      {occurrence && (
        <p className="flex items-start gap-2 text-muted">
          <Icon icon={ICONS.repeat} size="xs" className="mt-0.5 shrink-0" />
          <span>{t("invitation.occurrence", { date: occurrence })}</span>
        </p>
      )}
      {people > 0 && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-muted select-none hover:text-ink">
            <Icon icon={ICONS.people} size="xs" className="shrink-0" />
            <span>
              {t("invitation.attendees")} · {people}
            </span>
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1 pl-5.5">
            {found.attendees.map((person) => (
              <li key={person.email} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                <span className="min-w-0 truncate font-semibold">{visibleText(person.name ?? person.email)}</span>
                {person.name && <span className="min-w-0 truncate text-muted">{visibleText(person.email)}</span>}
                <span className="text-[12px] text-muted">
                  ·{" "}
                  {person.email === found.organizerEmail
                    ? t("invitation.organizer")
                    : t(`invitation.attendeeStatus.${person.status}`)}
                </span>
              </li>
            ))}
            {found.moreAttendees > 0 && (
              <li className="text-muted">{t("invitation.attendeesMore", { count: found.moreAttendees })}</li>
            )}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * An invitation, cancellation or answer in a mail: the event with the answer buttons, for every
 * kind of mailbox (the core answers through its server, Microsoft, Google, or an iTIP mail). A
 * mail that doesn't come from who may say what it says — anyone can name someone else's event —
 * is shown as unverified, and nothing is offered on its account (WEBMAIL-2).
 */
export function MailInvitationCard({ message }: { message: Message }) {
  const { t, i18n } = useT();
  const wanted = carriesInvitation(message);
  const { data: found } = useQuery({
    queryKey: invitationKey(message.id),
    queryFn: () => backend().mailInvitation(message.id),
    enabled: wanted,
    retry: false,
    staleTime: 60_000,
  });
  if (!wanted || !found) return null;
  const when = formatInvitationTime(found, i18n.language);

  const heading =
    found.kind === "reply"
      ? t("invitation.reply.title")
      : found.organizer && found.verified
        ? t("invitation.from", { name: visibleText(found.organizer) })
        : t("invitation.title");
  const person =
    found.kind === "reply"
      ? found.verified && found.attendeeEmail
        ? { name: found.attendee ?? undefined, email: found.attendeeEmail }
        : null
      : found.organizerEmail && found.verified
        ? { name: found.organizer ?? undefined, email: found.organizerEmail }
        : null;
  const singleDate = found.occurrence !== null;

  return (
    <section
      aria-label={heading}
      className="mx-1 mb-3 flex flex-col gap-2.5 rounded-2xl border border-hairline bg-canvas p-3.5"
    >
      <div className="flex gap-3">
        {person ? (
          <Avatar address={person} size="sm" />
        ) : (
          <Icon icon={ICONS.invitation} size="lg" className="mt-0.5 shrink-0 text-pink" />
        )}
        <div className="min-w-0">
          <p className="text-[12px] font-bold tracking-wide text-muted uppercase">{heading}</p>
          <p className="truncate text-[14.5px] font-bold">{found.title || t("calendar.untitled")}</p>
          {when && <p className="text-[13px] text-muted">{when}</p>}
        </div>
      </div>
      <Details found={found} />
      {!found.verified ? (
        <Unverified found={found} />
      ) : found.kind === "reply" ? (
        <p className="text-[13px]">
          {t(`invitation.reply.status.${found.status}`, { name: visibleText(found.attendee ?? found.sender) })}
        </p>
      ) : found.cancelled ? (
        <>
          <p className="text-[13px] font-semibold text-danger-ink">
            {singleDate ? t("invitation.cancelledDate") : t("invitation.cancelled")}
          </p>
          {!found.senderConfirmed && found.canRemove && <SenderUnconfirmed />}
          {found.canRemove && <RemoveCancelled messageId={message.id} found={found} />}
        </>
      ) : found.method === "cancel" ? (
        // Single dates cancelled where the calendar doesn't say so: the event itself goes on.
        <p className="text-[12px] text-muted">{t(invitationStatusKey(found.status))}</p>
      ) : found.revision === "outdated" ? (
        <p className="text-[13px] text-muted">{t("invitation.outdated")}</p>
      ) : (
        <>
          {found.revision === "update" && <p className="text-[13px]">{t("invitation.update")}</p>}
          {!found.senderConfirmed && found.canAnswer && <SenderUnconfirmed />}
          {found.canAnswer && <InvitationAnswer messageId={message.id} found={found} />}
          <p className="text-[12px] text-muted">
            {t(invitationStatusKey(found.status))}
            {found.canAnswer && <> {t(`invitation.place.${found.place}`)}</>}
          </p>
        </>
      )}
    </section>
  );
}

/** The From address is the organizer's, but the receiving server didn't vouch for it. */
function SenderUnconfirmed() {
  const { t } = useT();
  return (
    <p role="note" className="flex gap-2 rounded-xl bg-warning-tint px-3 py-2 text-[12.5px] text-warning-ink">
      <Icon icon={ICONS.warning} size="xs" className="mt-0.5 shrink-0" />
      <span>{t("invitation.senderUnconfirmed")}</span>
    </p>
  );
}

/** Why this mail isn't believed, and what the calendar says instead. No buttons. */
function Unverified({ found }: { found: MailScheduling }) {
  const { t } = useT();
  const text =
    found.kind === "reply"
      ? t("invitation.unverified.reply")
      : found.method === "cancel"
        ? t("invitation.unverified.cancel")
        : t("invitation.unverified.invitation");
  const organizer = found.kind === "invitation" ? (found.organizerEmail ?? found.organizer) : null;
  // This line tells who wrote the mail from who may; direction marks and invisible characters in
  // either would let one read as the other, so they are shown, not obeyed (security-audit W-34).
  return (
    <div role="note" className="flex gap-2.5 rounded-xl bg-warning-tint px-3 py-2.5 text-[13px] text-warning-ink">
      <Icon icon={ICONS.warning} className="mt-0.5 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold">{text}</p>
        <p className="break-words">
          {organizer
            ? t("invitation.unverified.senderAndOrganizer", {
                sender: visibleText(found.sender),
                organizer: visibleText(organizer),
              })
            : t("invitation.unverified.sender", { sender: visibleText(found.sender) })}
        </p>
      </div>
    </div>
  );
}
