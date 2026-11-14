import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Field, Hint, ICONS, Tag, TextInput } from "@uwusuite/design";
import { useId, useState, type FormEvent } from "react";
import { create } from "zustand";
import { backend, BackendError } from "@/backend/backend";
import type { BackupEmail, BackupRestoreOutcome, BackupSearch, Folder } from "@/backend/types";
import { Dialog } from "@/components/ui/Dialog";
import { i18n, useT } from "@/i18n";
import { displayName, formatFullDate, formatSize } from "@/lib/format";
import { queryKeys } from "@/lib/queries";
import { useServerAccountFeatures } from "../masked/useMasked";

/** The server takes at most this many mails per restore. */
const RESTORE_BATCH = 50;

/** Which mailbox the backup search is open for. */
export const useBackupSearch = create<{
  accountId: string | null;
  open: (accountId: string) => void;
  close: () => void;
}>()((set) => ({
  accountId: null,
  open: (accountId) => set({ accountId }),
  close: () => set({ accountId: null }),
}));

/** The trash folder's mailbox, when its UwUMail server lets the person search its backups. */
export function useBackupsFor(folder: Folder | undefined): string | null {
  const { data: features = [] } = useServerAccountFeatures();
  if (folder?.role !== "trash") return null;
  return features.some((entry) => entry.accountId === folder.accountId && entry.backups) ? folder.accountId : null;
}

/** Search the own deleted mail in the server's backups and take it back. Mount once. */
export function BackupSearchDialog() {
  const { t } = useT();
  const accountId = useBackupSearch((s) => s.accountId);
  const close = useBackupSearch((s) => s.close);
  return (
    <Dialog open={accountId !== null} onClose={close} width="md" title={t("backups.title")}>
      {accountId && <BackupSearchForm key={accountId} accountId={accountId} />}
    </Dialog>
  );
}

function errorText(error: unknown, t: (key: string) => string) {
  const code = error instanceof BackendError ? error.code : "internal";
  if (code === "forbidden") return t("backups.error.forbidden");
  if (code === "connection_failed") return t("backups.error.connection");
  return t("backups.error.generic");
}

const day = (iso: string) => new Date(iso).toLocaleDateString(i18n.language, { dateStyle: "medium" });

/** Local midnight of a `YYYY-MM-DD`, `days` later, as an ISO time. */
function midnight(date: string, days = 0) {
  const at = new Date(`${date}T00:00`);
  at.setDate(at.getDate() + days);
  return at.toISOString();
}

function BackupSearchForm({ accountId }: { accountId: string }) {
  const { t } = useT();
  const client = useQueryClient();
  const ids = useId();
  const [text, setText] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [found, setFound] = useState<BackupSearch | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [previewing, setPreviewing] = useState<BackupEmail | null>(null);
  const [busy, setBusy] = useState<"search" | "restore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BackupRestoreOutcome | null>(null);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("search");
    setError(null);
    setOutcome(null);
    try {
      const result = await backend().searchBackups(accountId, {
        text: text.trim() || undefined,
        after: from ? midnight(from) : undefined,
        before: to ? midnight(to, 1) : undefined,
      });
      setFound(result);
      setChosen(new Set());
    } catch (reason) {
      setError(errorText(reason, t));
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy("restore");
    setError(null);
    const all = [...chosen];
    const total: BackupRestoreOutcome = { restored: [], alreadyThere: [], notRestored: [] };
    try {
      for (let start = 0; start < all.length; start += RESTORE_BATCH) {
        const part = await backend().restoreBackupMail(accountId, all.slice(start, start + RESTORE_BATCH));
        total.restored.push(...part.restored);
        total.alreadyThere.push(...part.alreadyThere);
        total.notRestored.push(...part.notRestored);
      }
      setChosen(new Set());
      setFound(
        (current) =>
          current && {
            ...current,
            list: current.list.map((mail) =>
              total.restored.includes(mail.id) || total.alreadyThere.includes(mail.id)
                ? { ...mail, inMailbox: true }
                : mail,
            ),
          },
      );
    } catch (reason) {
      setError(errorText(reason, t));
    } finally {
      // Whatever got through before a failure is shown too.
      setOutcome(total);
      setBusy(null);
      // The engine syncs the mailbox; the new folder shows once the lists load again.
      void client.invalidateQueries({ queryKey: queryKeys.folders });
      void client.invalidateQueries({ queryKey: queryKeys.threads });
    }
  };

  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
  };

  if (previewing) {
    return <BackupPreviewPane accountId={accountId} mail={previewing} onBack={() => setPreviewing(null)} />;
  }

  const indexing = found && found.indexing.done < found.indexing.total;
  return (
    <div className="flex flex-col gap-4 px-6 pt-1 pb-6">
      <p className="text-[13.5px] text-muted">{t("backups.intro")}</p>
      <form role="search" className="flex flex-col gap-3" onSubmit={(event) => void search(event)}>
        <Field label={t("backups.text")} hint={t("backups.textHint")}>
          {(id) => (
            <TextInput
              id={id}
              type="search"
              maxLength={256}
              value={text}
              onChange={(event) => setText(event.target.value)}
              autoFocus
            />
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("backups.from")}>
            {(id) => (
              <TextInput
                id={id}
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
              />
            )}
          </Field>
          <Field label={t("backups.to")}>
            {(id) => (
              <TextInput
                id={id}
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
              />
            )}
          </Field>
        </div>
        <Button type="submit" icon={ICONS.search} busy={busy === "search"} className="self-start">
          {t("backups.search")}
        </Button>
      </form>

      {error && (
        <Hint tone="danger" role="alert">
          {error}
        </Hint>
      )}

      <div role="status" className="flex flex-col gap-2 text-[13px]">
        {found && <p className="font-semibold">{t("backups.count", { count: found.list.length })}</p>}
        {indexing && (
          <p className="text-muted">
            {t("backups.indexing", { done: found.indexing.done, total: found.indexing.total })}
          </p>
        )}
        {outcome && <RestoreSummary outcome={outcome} />}
      </div>

      {found && found.list.length > 0 && (
        <>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="sr-only">{t("backups.choose")}</legend>
            {found.list.map((mail) => (
              <BackupRow
                key={mail.id}
                mail={mail}
                inputId={`${ids}-${mail.id}`}
                checked={chosen.has(mail.id)}
                onToggle={(on) => toggle(mail.id, on)}
                onPreview={() => setPreviewing(mail)}
              />
            ))}
          </fieldset>
          <Button
            icon={ICONS.restore}
            busy={busy === "restore"}
            disabled={chosen.size === 0}
            onClick={() => void restore()}
            className="self-start"
          >
            {chosen.size > 0 ? t("backups.restoreCount", { count: chosen.size }) : t("backups.restore")}
          </Button>
        </>
      )}
    </div>
  );
}

function SnapshotDates({ snapshots }: { snapshots: string[] }) {
  const { t } = useT();
  const shown = snapshots.slice(-3).map(day).join(", ");
  const more = snapshots.length - 3;
  return (
    <>
      {more > 0 ? t("backups.inBackupsMore", { dates: shown, count: more }) : t("backups.inBackups", { dates: shown })}
    </>
  );
}

function BackupRow({
  mail,
  inputId,
  checked,
  onToggle,
  onPreview,
}: {
  mail: BackupEmail;
  inputId: string;
  checked: boolean;
  onToggle: (on: boolean) => void;
  onPreview: () => void;
}) {
  const { t } = useT();
  const sender = mail.from[0] ? displayName(mail.from[0]) : t("backups.noSender");
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-line px-3.5 py-2.5 text-[13.5px]">
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={(event) => onToggle(event.target.checked)}
        className="mt-1 size-4 accent-pink"
      />
      <label htmlFor={inputId} className="min-w-0 flex-1">
        <span className="block font-semibold break-words">{mail.subject || t("backups.noSubject")}</span>
        <span className="block text-[12.5px] break-words text-muted">
          {sender}
          {mail.receivedAt && ` · ${formatFullDate(mail.receivedAt, i18n.language)}`}
          {mail.folder && ` · ${t("backups.wasIn", { folder: mail.folder })}`}
        </span>
        <span className="block text-[12px] text-muted">
          <SnapshotDates snapshots={mail.snapshots} />
        </span>
        {mail.inMailbox && (
          <Tag tone="success" className="mt-1">
            {t("backups.inMailbox")}
          </Tag>
        )}
      </label>
      <Button size="sm" variant="ghost" icon={ICONS.preview} onClick={onPreview}>
        {t("backups.preview")}
        <span className="sr-only">: {mail.subject || t("backups.noSubject")}</span>
      </Button>
    </div>
  );
}

function RestoreSummary({ outcome }: { outcome: BackupRestoreOutcome }) {
  const { t } = useT();
  const reasons = new Map<string, number>();
  for (const { reason } of outcome.notRestored) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  const reasonText = (reason: string) =>
    reason === "overQuota" || reason === "invalidEmail" || reason === "notFound"
      ? t(`backups.reason.${reason}`)
      : t("backups.reason.other");
  return (
    <ul className="flex flex-col gap-1">
      {outcome.restored.length > 0 && (
        <li className="text-success">{t("backups.restored", { count: outcome.restored.length })}</li>
      )}
      {outcome.alreadyThere.length > 0 && <li>{t("backups.alreadyThere", { count: outcome.alreadyThere.length })}</li>}
      {[...reasons].map(([reason, count]) => (
        <li key={reason} className="text-danger">
          {t("backups.notRestored", { count, reason: reasonText(reason) })}
        </li>
      ))}
    </ul>
  );
}

function BackupPreviewPane({ accountId, mail, onBack }: { accountId: string; mail: BackupEmail; onBack: () => void }) {
  const { t } = useT();
  const preview = useQuery({
    queryKey: ["backupPreview", accountId, mail.id],
    queryFn: async () => (await backend().previewBackupMail(accountId, [mail.id]))[0] ?? null,
  });
  const data = preview.data;
  return (
    <div className="flex flex-col gap-3 px-6 pt-1 pb-6">
      <Button size="sm" variant="ghost" icon={ICONS.back} onClick={onBack} className="self-start" autoFocus>
        {t("backups.backToResults")}
      </Button>
      <h3 className="text-[16px] font-extrabold break-words">{mail.subject || t("backups.noSubject")}</h3>
      <p className="text-[12.5px] break-words text-muted">
        {mail.from.map(displayName).join(", ") || t("backups.noSender")}
        {mail.receivedAt && ` · ${formatFullDate(mail.receivedAt, i18n.language)}`}
      </p>
      <div role="status" className="text-[13px] text-muted">
        {preview.isPending && t("backups.loadingPreview")}
        {preview.isError && errorText(preview.error, t)}
        {preview.isSuccess && !data && t("backups.reason.notFound")}
      </div>
      {data && (
        <>
          {/* Plain text only: the mail's HTML never reaches the page from here. */}
          <pre className="max-h-[50vh] overflow-auto rounded-2xl border border-line p-3.5 font-sans text-[13.5px] break-words whitespace-pre-wrap">
            {data.textBody || t("backups.noText")}
          </pre>
          {data.attachments.length > 0 && (
            <section aria-labelledby={`${mail.id}-files`} className="flex flex-col gap-1">
              <h4 id={`${mail.id}-files`} className="text-[12px] font-bold tracking-wide text-muted uppercase">
                {t("backups.attachments")}
              </h4>
              <ul className="text-[13px]">
                {data.attachments.map((file, index) => (
                  <li key={index} className="break-words">
                    {file.name || t("backups.unnamedFile")} · {formatSize(file.size, i18n.language)}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
