import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Cake, Trash, X } from "lucide-react";
import { useMemo, useState } from "react";
import { backend } from "@/backend/backend";
import type { BirthdayCandidate, BirthdayImportEntry, ContactRecord } from "@/backend/types";
import { Button, IconButton, TextInput } from "@uwusuite/design";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { foldName, parseDay } from "@/lib/birthdays";
import { queryKeys } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { formatBirthday } from "../contacts/format";
import { useContacts } from "../contacts/useContactsData";

const SCAN_KEY = ["birthdayScan"] as const;
const HINT_KEY = "uwu.birthdayHint.dismissed";
/** Contacts offered when searching for one to assign. */
const SHOWN_MATCHES = 8;

/**
 * Per account: whether its server keeps birthdays (calendar and reminders), and whether birthday
 * events of its calendars can be moved into its contacts.
 */
export function useBirthdayFeatures() {
  return useQuery({
    queryKey: ["birthdayFeatures"],
    queryFn: () => backend().birthdayFeatures(),
    staleTime: 5 * 60_000,
  });
}

/** The accounts whose birthday events can be taken over. */
export function useBirthdayImportAccounts(): string[] {
  const { data = [] } = useBirthdayFeatures();
  return data.filter((features) => features.import).map((features) => features.accountId);
}

/** The birthday events in an account's other calendars, as its server (or the app) finds them. */
export function useBirthdayScan(accountId: string, enabled: boolean) {
  const available = useBirthdayImportAccounts().includes(accountId);
  return useQuery({
    queryKey: [...SCAN_KEY, accountId],
    queryFn: () => backend().scanBirthdays(accountId),
    enabled: available && enabled,
    staleTime: 5 * 60_000,
  });
}

function hintDismissed(accountId: string): boolean {
  try {
    return localStorage.getItem(`${HINT_KEY}.${accountId}`) === "1";
  } catch {
    return false;
  }
}

function dismissHint(accountId: string) {
  try {
    localStorage.setItem(`${HINT_KEY}.${accountId}`, "1");
  } catch {
    // Without storage it comes back next time, which is fine.
  }
}

/** Beside the calendars: "N birthdays found", until taken over or waved away. */
export function BirthdayHint({ accountId, onOpen }: { accountId: string; onOpen: () => void }) {
  const { t } = useT();
  const [dismissed, setDismissed] = useState(() => hintDismissed(accountId));
  const { data } = useBirthdayScan(accountId, !dismissed);
  const open = (data?.candidates ?? []).filter((candidate) => candidate.match !== "known" || candidate.mayDeleteEvent);
  if (dismissed || open.length === 0) return null;
  return (
    <aside
      aria-label={t("calendar.birthdays.hintTitle", { count: open.length })}
      className="relative flex flex-col gap-2 rounded-2xl border border-line bg-pink-tint/35 px-3.5 pt-3 pb-3"
    >
      <IconButton
        icon={X}
        size="sm"
        label={t("calendar.birthdays.hintDismiss")}
        className="absolute top-1.5 right-1.5 size-7"
        onClick={() => {
          dismissHint(accountId);
          setDismissed(true);
        }}
      />
      <p className="flex items-center gap-2 pr-7 text-[13px] font-bold">
        <Cake className="size-4 shrink-0 text-pink-ink" aria-hidden />
        {t("calendar.birthdays.hintTitle", { count: open.length })}
      </p>
      <p className="text-[12.5px] text-muted">{t("calendar.birthdays.hintBody")}</p>
      <Button size="sm" variant="primary" onClick={onOpen} className="self-start">
        {t("calendar.birthdays.hintAction")}
      </Button>
    </aside>
  );
}

/** What becomes of one found event. */
type Plan =
  | { action: "assign"; contactId: string | null; include: boolean }
  | { action: "create"; name: string }
  | { action: "skip" };

/** Clear ones go on their own; the rest wait for a choice (a new contact for a name nobody has). */
function firstPlan(candidate: BirthdayCandidate): Plan {
  const only = candidate.contacts[0]?.contactId ?? null;
  switch (candidate.match) {
    case "matched":
    case "known":
      return { action: "assign", contactId: only, include: true };
    case "unmatched":
      return { action: "create", name: candidate.name };
    default:
      return { action: "skip" };
  }
}

const automatic = (candidate: BirthdayCandidate) => candidate.match === "matched" || candidate.match === "known";

/** The entry for the server, or null when the event stays where it is. */
function entryOf(
  candidate: BirthdayCandidate,
  plan: Plan,
  contacts: Map<string, { birthday: string | null }>,
): BirthdayImportEntry | null {
  if (plan.action === "skip") return null;
  if (plan.action === "create") {
    const name = plan.name.trim();
    return name ? { eventId: candidate.eventId, newContactName: name } : null;
  }
  if (!plan.include || !plan.contactId) return null;
  const known = contacts.get(plan.contactId)?.birthday ?? null;
  return { eventId: candidate.eventId, contactId: plan.contactId, overwrite: clashes(known, candidate.birthday) };
}

/** Whether taking `found` over replaces another day a contact has. */
function clashes(known: string | null, found: string): boolean {
  const had = parseDay(known);
  const day = parseDay(found);
  if (!had || !day) return false;
  if (had.month !== day.month || had.day !== day.day) return true;
  return had.year !== null && day.year !== null && had.year !== day.year;
}

/**
 * Birthdays kept as events in other calendars, moved into the contacts: clear matches ticked, the
 * rest one choice each, and before anything happens which events get deleted.
 */
export function BirthdayImportDialog({ accountId, onClose }: { accountId: string | null; onClose: () => void }) {
  const { t } = useT();
  return (
    <Dialog
      open={accountId !== null}
      onClose={onClose}
      title={t("calendar.birthdays.title")}
      width="lg"
      closeOnOutsideClick={false}
    >
      {accountId !== null && <ImportBody accountId={accountId} onClose={onClose} />}
    </Dialog>
  );
}

function ImportBody({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const { t, i18n } = useT();
  const client = useQueryClient();
  const scan = useBirthdayScan(accountId, true);
  const { data: allContacts = [] } = useContacts();
  // A birthday goes into a contact of the same mailbox.
  const contacts = useMemo(
    () => allContacts.filter((contact) => contact.accountId === accountId),
    [allContacts, accountId],
  );
  const [plans, setPlans] = useState<Record<string, Plan>>({});
  const [busy, setBusy] = useState(false);

  const candidates = useMemo(() => scan.data?.candidates ?? [], [scan.data]);
  const planOf = (candidate: BirthdayCandidate) => plans[candidate.eventId] ?? firstPlan(candidate);
  const setPlan = (eventId: string, plan: Plan) => setPlans((current) => ({ ...current, [eventId]: plan }));

  const known = useMemo(() => {
    const map = new Map<string, { name: string; birthday: string | null }>();
    for (const contact of contacts) map.set(contact.id, { name: contact.displayName, birthday: contact.birthday });
    for (const candidate of candidates) {
      for (const choice of candidate.contacts) {
        if (!map.has(choice.contactId)) map.set(choice.contactId, { name: choice.name, birthday: choice.birthday });
      }
    }
    return map;
  }, [contacts, candidates]);

  const chosen = candidates
    .map((candidate) => ({ candidate, entry: entryOf(candidate, planOf(candidate), known) }))
    .filter((item): item is { candidate: BirthdayCandidate; entry: BirthdayImportEntry } => item.entry !== null);
  const deleting = chosen.filter((item) => item.candidate.mayDeleteEvent).length;
  const date = (day: string) => formatBirthday(day, i18n.language);

  const confirm = async () => {
    setBusy(true);
    try {
      const result = await backend().importBirthdays(
        accountId,
        chosen.map((item) => item.entry),
      );
      if (result.failed.length === 0) {
        toast(t("calendar.birthdays.done", { count: result.imported.length }), "success");
      } else {
        toast(t("calendar.birthdays.partly", { done: result.imported.length, failed: result.failed.length }), "error");
      }
      onClose();
    } catch (error) {
      toast(t("calendar.toast.failed", { reason: error instanceof Error ? error.message : String(error) }), "error");
    } finally {
      setBusy(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: SCAN_KEY }),
        client.invalidateQueries({ queryKey: queryKeys.calendars }),
        client.invalidateQueries({ queryKey: queryKeys.calendarEvents }),
        client.invalidateQueries({ queryKey: queryKeys.contacts }),
      ]);
    }
  };

  if (scan.isPending)
    return <p className="px-6 pt-2 pb-6 text-[13.5px] text-muted">{t("calendar.birthdays.scanning")}</p>;
  if (scan.isError) return <p className="px-6 pt-2 pb-6 text-[13.5px] text-danger">{t("calendar.birthdays.failed")}</p>;
  if (candidates.length === 0) {
    return <p className="px-6 pt-2 pb-6 text-[13.5px] text-muted">{t("calendar.birthdays.none")}</p>;
  }

  const clear = candidates.filter(automatic);
  const unclear = candidates.filter((candidate) => !automatic(candidate));

  return (
    <div className="flex flex-col gap-5 px-6 pt-1 pb-6">
      <p className="text-[13.5px] text-muted">{t("calendar.birthdays.intro")}</p>
      {scan.data?.truncated && <p className="text-[13px] text-muted">{t("calendar.birthdays.truncated")}</p>}

      {clear.length > 0 && (
        <section aria-labelledby="uwu-bday-clear" className="flex flex-col gap-2">
          <h3 id="uwu-bday-clear" className="text-[12px] font-bold tracking-wide text-muted uppercase">
            {t("calendar.birthdays.automatic")}
          </h3>
          <ul className="flex flex-col gap-1.5">
            {clear.map((candidate) => {
              const plan = planOf(candidate);
              const included = plan.action === "assign" && plan.include;
              const contact = candidate.contacts[0];
              return (
                <li key={candidate.eventId} className="rounded-2xl border border-line px-3.5 py-2.5">
                  <label className="flex items-start gap-3 text-[13.5px]">
                    <input
                      type="checkbox"
                      checked={included}
                      onChange={(event) =>
                        setPlan(candidate.eventId, {
                          action: "assign",
                          contactId: contact?.contactId ?? null,
                          include: event.target.checked,
                        })
                      }
                      className="mt-0.5 size-4 accent-pink"
                      aria-label={`${t("calendar.birthdays.include")}: ${candidate.title}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold break-words">
                        {candidate.title} · {date(candidate.birthday)}
                      </span>
                      <span className="block text-[12.5px] text-muted">
                        → {contact?.name ?? candidate.name}
                        {candidate.match === "known" && ` (${t("calendar.birthdays.known")})`}
                      </span>
                      {included && <EventFate candidate={candidate} />}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {unclear.length > 0 && (
        <section aria-labelledby="uwu-bday-unclear" className="flex flex-col gap-2">
          <h3 id="uwu-bday-unclear" className="text-[12px] font-bold tracking-wide text-muted uppercase">
            {t("calendar.birthdays.decide")}
          </h3>
          <ul className="flex flex-col gap-2">
            {unclear.map((candidate) => (
              <UnclearEntry
                key={candidate.eventId}
                candidate={candidate}
                plan={planOf(candidate)}
                onPlan={(plan) => setPlan(candidate.eventId, plan)}
                contacts={contacts}
                known={known}
                date={date}
              />
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-col gap-3 border-t border-hairline pt-4">
        {deleting > 0 && (
          <p role="note" className="flex gap-2 text-[13px] font-semibold text-danger">
            <Trash className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t("calendar.birthdays.deleteWarning", { count: deleting })}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" busy={busy} disabled={chosen.length === 0} onClick={() => void confirm()}>
            {chosen.length === 0
              ? t("calendar.birthdays.nothing")
              : t("calendar.birthdays.confirm", { count: chosen.length })}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Says what becomes of the original event once its birthday is taken over. */
function EventFate({ candidate }: { candidate: BirthdayCandidate }) {
  const { t } = useT();
  return candidate.mayDeleteEvent ? (
    <span className="mt-1 flex items-center gap-1.5 text-[12px] font-semibold text-danger">
      <Trash className="size-3.5 shrink-0" aria-hidden />
      {t("calendar.birthdays.willDelete")}
    </span>
  ) : (
    <span className="mt-1 block text-[12px] text-muted">{t("calendar.birthdays.keeps")}</span>
  );
}

function UnclearEntry({
  candidate,
  plan,
  onPlan,
  contacts,
  known,
  date,
}: {
  candidate: BirthdayCandidate;
  plan: Plan;
  onPlan: (plan: Plan) => void;
  contacts: ContactRecord[];
  known: Map<string, { name: string; birthday: string | null }>;
  date: (day: string) => string;
}) {
  const { t } = useT();
  const [search, setSearch] = useState("");
  const first = candidate.contacts[0];
  const why =
    candidate.match === "conflict" && first?.birthday
      ? t("calendar.birthdays.conflict", { name: first.name, date: date(first.birthday) })
      : t(`calendar.birthdays.${candidate.match === "ambiguous" ? "ambiguous" : "unmatched"}`);

  const found = useMemo(() => {
    const wanted = foldName(search);
    if (!wanted) return candidate.contacts.map((choice) => ({ id: choice.contactId, name: choice.name }));
    const plain = foldName(search, false);
    return contacts
      .filter((contact) => !contact.isGroup && contact.displayName)
      .filter((contact) => {
        const name = foldName(contact.displayName);
        return name.includes(wanted) || foldName(contact.displayName, false).includes(plain);
      })
      .slice(0, SHOWN_MATCHES)
      .map((contact) => ({ id: contact.id, name: contact.displayName }));
  }, [search, contacts, candidate.contacts]);

  const assigned = plan.action === "assign" ? plan.contactId : null;
  const assignedBirthday = assigned ? (known.get(assigned)?.birthday ?? null) : null;
  const overwrites = assigned !== null && clashes(assignedBirthday, candidate.birthday);
  const taken =
    (plan.action === "assign" && assigned !== null) || (plan.action === "create" && plan.name.trim() !== "");

  return (
    <li className="flex flex-col gap-2.5 rounded-2xl border border-line px-3.5 py-3">
      <div className="text-[13.5px]">
        <span className="flex items-center gap-1.5 font-semibold break-words">
          <Cake className="size-3.5 shrink-0 text-muted" aria-hidden />
          {candidate.title} · {date(candidate.birthday)}
        </span>
        <span className="block text-[12.5px] text-muted">{why}</span>
      </div>
      <div role="radiogroup" aria-label={candidate.title} className="flex flex-wrap gap-1.5">
        {(["create", "assign", "skip"] as const).map((action) => (
          <button
            key={action}
            type="button"
            role="radio"
            aria-checked={plan.action === action}
            onClick={() =>
              onPlan(
                action === "create"
                  ? { action, name: candidate.name }
                  : action === "assign"
                    ? { action, contactId: first?.contactId ?? null, include: true }
                    : { action },
              )
            }
            className={clsx(
              "h-8 rounded-full px-3.5 text-[13px] font-medium transition-colors",
              plan.action === action
                ? "bg-pink-tint font-semibold text-pink-ink"
                : "border border-line text-muted hover:border-faint/60 hover:text-ink",
            )}
          >
            {t(`calendar.birthdays.${action}`)}
          </button>
        ))}
      </div>
      {plan.action === "create" && (
        <TextInput
          aria-label={t("calendar.birthdays.newName")}
          placeholder={t("calendar.birthdays.newName")}
          value={plan.name}
          maxLength={200}
          onChange={(event) => onPlan({ action: "create", name: event.target.value })}
        />
      )}
      {plan.action === "assign" && (
        <div className="flex flex-col gap-1.5">
          <TextInput
            type="search"
            aria-label={t("calendar.birthdays.search")}
            placeholder={t("calendar.birthdays.search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {found.length === 0 ? (
            <p className="text-[12.5px] text-muted">{t("calendar.birthdays.noContact")}</p>
          ) : (
            <ul role="radiogroup" aria-label={t("calendar.birthdays.assign")} className="flex flex-col gap-0.5">
              {found.map((choice) => (
                <li key={choice.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={assigned === choice.id}
                    onClick={() => onPlan({ action: "assign", contactId: choice.id, include: true })}
                    className={clsx(
                      "flex h-8 w-full items-center rounded-lg px-2.5 text-left text-[13px]",
                      assigned === choice.id ? "bg-pink-tint font-semibold text-pink-ink" : "hover:bg-pink-tint/50",
                    )}
                  >
                    <span className="min-w-0 truncate">{choice.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {overwrites && assignedBirthday && (
            <p className="text-[12.5px] text-muted">
              {t("calendar.birthdays.overwrite", { date: date(assignedBirthday) })}
            </p>
          )}
        </div>
      )}
      {taken && <EventFate candidate={candidate} />}
    </li>
  );
}
