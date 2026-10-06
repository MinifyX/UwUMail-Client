import { useQuery } from "@tanstack/react-query";
import { Button, Icon, IconButton, ICONS, Select } from "@uwusuite/design";
import { useState } from "react";
import { backend, BackendError } from "@/backend/backend";
import type { Person, ShareLevel } from "@/backend/types";
import { Avatar } from "@/components/ui/Avatar";
import { Dialog } from "@/components/ui/Dialog";
import { translate, useT } from "@/i18n";
import { queryKeys } from "@/lib/queries";
import { toast } from "@/state/toasts";

export const SHARE_LEVELS: readonly ShareLevel[] = ["read", "write", "all"];

/** The people of a mailbox's UwUMail server, to share with. */
function usePeople(accountId: string) {
  return useQuery({
    queryKey: queryKeys.calendarPeople(accountId),
    queryFn: () => backend().calendarPeople(accountId),
    staleTime: 5 * 60_000,
  });
}

function errorText(error: unknown): string {
  if (error instanceof BackendError && error.code === "forbidden") return translate("sharing.notAllowed");
  return error instanceof Error ? error.message : String(error);
}

interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  /** The mailbox on a UwUMail server whose people it can be shared with. */
  accountId: string;
  /** What is being shared, for the title: a calendar's name. */
  name: string;
  /** Who has it now, by person id. */
  sharedWith: Record<string, ShareLevel>;
  /** Shares at a level, or stops sharing with `null`. */
  onShare: (personId: string, level: ShareLevel | null) => Promise<void>;
  /** What the three levels mean here: a calendar's (the webmail shares folders too). */
  kind: "calendar";
}

/** Sharing with people on the same server: who has it at which level, and adding somebody. */
export function ShareDialog({ open, onClose, accountId, name, sharedWith, onShare, kind }: ShareDialogProps) {
  const { t } = useT();
  return (
    <Dialog open={open} onClose={onClose} title={t("sharing.title", { name })} width="md">
      {open && <ShareForm accountId={accountId} sharedWith={sharedWith} onShare={onShare} kind={kind} />}
    </Dialog>
  );
}

/** People matching what was typed, by name or address, without those who have it already. */
export function matchingPeople(people: Person[], query: string, taken: Set<string>): Person[] {
  const wanted = query.trim().toLowerCase();
  return people
    .filter((person) => !taken.has(person.id))
    .filter(
      (person) => !wanted || person.name.toLowerCase().includes(wanted) || person.email.toLowerCase().includes(wanted),
    );
}

function ShareForm({
  accountId,
  sharedWith,
  onShare,
  kind,
}: Pick<ShareDialogProps, "accountId" | "sharedWith" | "onShare" | "kind">) {
  const { t } = useT();
  const { data: people = [], isPending, isError } = usePeople(accountId);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Person | null>(null);
  const [level, setLevel] = useState<ShareLevel>("read");
  const [busy, setBusy] = useState<string | null>(null);

  const current = Object.entries(sharedWith).map(([id, shareLevel]) => ({
    person: people.find((person) => person.id === id) ?? { id, name: id, email: "" },
    level: shareLevel,
  }));
  const candidates = matchingPeople(people, query, new Set(Object.keys(sharedWith))).slice(0, 6);

  const run = async (personId: string, next: ShareLevel | null, done?: string) => {
    setBusy(personId);
    try {
      await onShare(personId, next);
      if (done) toast(done, "success");
      return true;
    } catch (error) {
      toast(errorText(error), "error");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const levelOptions = SHARE_LEVELS.map((value) => (
    <option key={value} value={value}>
      {t(`sharing.level.${value}`)}
    </option>
  ));

  return (
    <div className="flex flex-col gap-5 px-6 pt-1 pb-6">
      <p className="text-[13px] text-muted">{t(`sharing.levelsDesc.${kind}`)}</p>

      <section className="flex flex-col gap-2" aria-label={t("sharing.current")}>
        <h3 className="text-[12px] font-bold tracking-wide text-muted uppercase">{t("sharing.current")}</h3>
        {current.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line px-4 py-3 text-[13px] text-muted">
            {t("sharing.nobody")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {current.map(({ person, level: shareLevel }) => (
              <li key={person.id} className="flex items-center gap-3 rounded-2xl border border-hairline p-2 pl-3">
                <Avatar address={{ name: person.name, email: person.email || person.name }} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold">{person.name}</span>
                  {person.email && <span className="block truncate text-[12px] text-muted">{person.email}</span>}
                </span>
                <Select
                  aria-label={t("sharing.levelFor", { name: person.name })}
                  value={shareLevel}
                  disabled={busy !== null}
                  onChange={(event) => void run(person.id, event.target.value as ShareLevel)}
                  className="w-44 shrink-0 [&_select]:h-9"
                >
                  {levelOptions}
                </Select>
                <IconButton
                  icon={ICONS.close}
                  size="sm"
                  label={t("sharing.remove", { name: person.name })}
                  disabled={busy !== null}
                  onClick={() => void run(person.id, null, t("sharing.removed", { name: person.name }))}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-label={t("sharing.add")}>
        <h3 className="text-[12px] font-bold tracking-wide text-muted uppercase">{t("sharing.add")}</h3>
        {picked ? (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line p-2 pl-3">
            <Avatar address={{ name: picked.name, email: picked.email }} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-semibold">{picked.name}</span>
              <span className="block truncate text-[12px] text-muted">{picked.email}</span>
            </span>
            <Select
              aria-label={t("sharing.levelFor", { name: picked.name })}
              value={level}
              onChange={(event) => setLevel(event.target.value as ShareLevel)}
              className="w-44 shrink-0 [&_select]:h-9"
            >
              {levelOptions}
            </Select>
            <div className="flex w-full justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={ICONS.share}
                busy={busy === picked.id}
                onClick={async () => {
                  if (await run(picked.id, level, t("sharing.shared", { name: picked.name }))) {
                    setPicked(null);
                    setQuery("");
                    setLevel("read");
                  }
                }}
              >
                {t("sharing.share")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="relative">
              <Icon
                icon={ICONS.search}
                className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted"
              />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("sharing.search")}
                aria-label={t("sharing.search")}
                className="h-10 w-full rounded-full border border-transparent bg-canvas pr-4 pl-10 text-[13.5px] placeholder:text-muted focus:border-pink focus:bg-surface focus:shadow-focus focus:outline-none [&::-webkit-search-cancel-button]:hidden"
              />
            </div>
            {isPending ? (
              <p className="px-1 text-[13px] text-muted">{t("sharing.loadingPeople")}</p>
            ) : isError ? (
              <p className="px-1 text-[13px] text-danger-ink">{t("sharing.peopleFailed")}</p>
            ) : candidates.length === 0 ? (
              <p className="px-1 text-[13px] text-muted">{t("sharing.noPeople")}</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {candidates.map((person) => (
                  <li key={person.id}>
                    <button
                      type="button"
                      onClick={() => setPicked(person)}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-pink-tint/60"
                    >
                      <Avatar address={{ name: person.name, email: person.email }} size="sm" />
                      <span className="min-w-0">
                        <span className="block truncate text-[13.5px] font-semibold">{person.name}</span>
                        <span className="block truncate text-[12px] text-muted">{person.email}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}
