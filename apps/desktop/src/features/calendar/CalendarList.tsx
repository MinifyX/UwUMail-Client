import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Button, Field, Icon, IconButton, ICONS, Menu, type MenuItem, Select, TextInput } from "@uwusuite/design";
import { useState } from "react";
import { backend } from "@/backend/backend";
import type { CalendarInfo } from "@/backend/types";
import { NyuScene } from "@/components/nyu/scenes";
import { ArmedButton } from "@/components/ui/ArmedButton";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { queryKeys, useAccounts } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { SignInAgainHint } from "../accounts/SignInAgain";
import { ShareDialog } from "../sharing/ShareDialog";
import { defaultCalendarAccount, groupByAccount, useCalendarAccounts } from "./accounts";
import { BirthdayHint, BirthdayImportDialog, useBirthdayImportAccounts } from "./BirthdayImport";
import { CALENDAR_COLORS, DEFAULT_COLOR } from "./format";
import { useCalendars } from "./useCalendarData";

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The calendars with their colours, by account: tick to show or hide, "…" to rename, recolour, delete. */
export function CalendarList() {
  const { t } = useT();
  const client = useQueryClient();
  const { data: calendars = [] } = useCalendars();
  const { data: accounts = [] } = useAccounts();
  const { data: sources = [] } = useCalendarAccounts();
  const [editing, setEditing] = useState<CalendarInfo | "new" | null>(null);
  const [deleting, setDeleting] = useState<CalendarInfo | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  // By id, so the dialog shows who has it now after every change.
  const [sharing, setSharing] = useState<string | null>(null);
  const sharingCalendar = calendars.find((calendar) => calendar.id === sharing);
  const importable = useBirthdayImportAccounts();
  const groups = groupByAccount(calendars, accounts);
  // New calendars can go to every account with a calendar source.
  const creatable = accounts
    .filter((account) => sources.some((source) => source.accountId === account.id && source.source !== null))
    .map((account) => ({ id: account.id, name: account.name || account.email }));

  const nameOf = (accountId: string) => {
    const account = accounts.find((candidate) => candidate.id === accountId);
    return account ? account.name || account.email : accountId;
  };

  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.calendars }),
      client.invalidateQueries({ queryKey: queryKeys.calendarEvents }),
    ]);
  const run = async (action: () => Promise<unknown>, success?: string) => {
    try {
      await action();
      if (success) toast(success, "success");
      return true;
    } catch (error) {
      toast(t("calendar.toast.failed", { reason: reason(error) }), "error");
      return false;
    } finally {
      await refresh();
    }
  };

  const toggle = (calendar: CalendarInfo) => {
    // Right away on screen; the server keeps it for the next visit and the app.
    client.setQueryData<CalendarInfo[]>(queryKeys.calendars, (list) =>
      list?.map((c) => (c.id === calendar.id ? { ...c, isVisible: !calendar.isVisible } : c)),
    );
    void run(() => backend().updateCalendar(calendar.id, { isVisible: !calendar.isVisible }));
  };

  // Where birthdays are taken over: from the account's birthdays calendar, or any of its calendars
  // while it has none yet.
  const offersImport = (calendar: CalendarInfo) =>
    importable.includes(calendar.accountId) &&
    (calendar.isBirthdays || !calendars.some((c) => c.accountId === calendar.accountId && c.isBirthdays));
  const menuItems = (calendar: CalendarInfo): MenuItem[] => [
    ...(calendar.mayWrite || calendar.isBirthdays
      ? [{ label: t("calendar.editCalendar"), onSelect: () => setEditing(calendar) }]
      : []),
    ...(offersImport(calendar)
      ? [{ label: t("calendar.birthdays.import"), onSelect: () => setImporting(calendar.accountId) }]
      : []),
    ...(!calendar.isDefault && calendar.mayWrite && !calendar.isBirthdays
      ? [
          {
            label: t("calendar.makeDefault"),
            onSelect: () =>
              void run(
                () => backend().setDefaultCalendar(calendar.id),
                t("calendar.toast.defaultSet", { name: calendar.name }),
              ),
          },
        ]
      : []),
    // Only the owner shares, on a UwUMail server (JMAP calendars with people to share with).
    ...(calendar.mayShare ? [{ label: t("sharing.shareCalendar"), onSelect: () => setSharing(calendar.id) }] : []),
    // Every account keeps at least one calendar of its own; a shared one can always be left.
    ...(calendar.mayDelete &&
    !calendar.isBirthdays &&
    (calendar.sharedBy || calendars.filter((c) => c.accountId === calendar.accountId).length > 1)
      ? [
          {
            label: calendar.sharedBy ? t("sharing.leaveCalendar") : t("calendar.deleteCalendar"),
            danger: true,
            onSelect: () => setDeleting(calendar),
          },
        ]
      : []),
  ];
  const rows = (list: CalendarInfo[]) =>
    list.map((calendar) => (
      <CalendarRow key={calendar.id} calendar={calendar} items={menuItems(calendar)} onToggle={toggle} />
    ));

  return (
    <section className="flex flex-col gap-0.5" aria-labelledby="uwu-calendars">
      <div className="flex items-center justify-between pr-1 pl-3">
        <h2 id="uwu-calendars" className="text-[12px] font-bold tracking-wide text-muted uppercase">
          {t("calendar.calendars")}
        </h2>
        {creatable.length > 0 && (
          <IconButton icon={ICONS.add} size="sm" label={t("calendar.newCalendar")} onClick={() => setEditing("new")} />
        )}
      </div>
      {sources
        .filter((source) => source.needsSignIn)
        .map((source) => (
          <SignInAgainHint
            key={source.accountId}
            accountId={source.accountId}
            name={nameOf(source.accountId)}
            compact
          />
        ))}
      {importable.map((accountId) => (
        <BirthdayHint key={accountId} accountId={accountId} onOpen={() => setImporting(accountId)} />
      ))}
      {groups.length > 1 ? (
        <ul className="flex flex-col gap-3">
          {groups.map((group) => (
            <li key={group.accountId}>
              <p
                id={`uwu-calendars-${group.accountId}`}
                className="truncate px-3 pb-0.5 text-[12px] font-semibold text-muted"
              >
                {group.name}
              </p>
              <ul className="flex flex-col gap-0.5" aria-labelledby={`uwu-calendars-${group.accountId}`}>
                {rows(group.calendars)}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="flex flex-col gap-0.5">{rows(calendars)}</ul>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} width="sm">
        {editing !== null && (
          <CalendarForm
            key={editing === "new" ? "new" : editing.id}
            calendar={editing === "new" ? null : editing}
            accounts={creatable}
            defaultAccount={defaultCalendarAccount(
              calendars,
              creatable.map((account) => account.id),
            )}
            onDone={async (name, color, accountId) => {
              const ok = await run(
                () =>
                  editing === "new"
                    ? backend().createCalendar({ accountId, name, color })
                    : backend().updateCalendar(editing.id, editing.isLocal ? { color } : { name, color }),
                editing === "new" ? t("calendar.toast.calendarCreated", { name }) : undefined,
              );
              if (ok) setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        )}
      </Dialog>

      <BirthdayImportDialog accountId={importing} onClose={() => setImporting(null)} />

      <ShareDialog
        open={sharingCalendar !== undefined}
        onClose={() => setSharing(null)}
        accountId={sharingCalendar?.accountId ?? ""}
        name={sharingCalendar?.name ?? ""}
        kind="calendar"
        sharedWith={sharingCalendar?.sharedWith ?? {}}
        onShare={async (personId, level) => {
          if (!sharingCalendar) return;
          await backend().shareCalendar(sharingCalendar.id, personId, level);
          await refresh();
        }}
      />

      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} width="sm">
        {deleting && (
          <div className="flex flex-col items-center gap-3 px-6 pt-2 pb-6 text-center">
            <NyuScene name="goodbye" className="w-36" />
            <h2 className="text-[18px] font-extrabold text-balance">
              {deleting.sharedBy
                ? t("sharing.leaveCalendarTitle", { name: deleting.name })
                : t("calendar.deleteCalendarTitle", { name: deleting.name })}
            </h2>
            <p className="text-[13px] text-muted">
              {deleting.sharedBy
                ? t("sharing.leaveCalendarBody", { name: deleting.sharedBy.name })
                : t("calendar.deleteCalendarBody")}
            </p>
            <div className="flex flex-wrap justify-center gap-2 pt-1">
              <ArmedButton
                variant="danger"
                autoFocus
                onClick={() => {
                  const calendar = deleting;
                  setDeleting(null);
                  void run(
                    () => backend().deleteCalendar(calendar.id),
                    t("calendar.toast.calendarDeleted", { name: calendar.name }),
                  );
                }}
              >
                {deleting.sharedBy ? t("sharing.leaveCalendar") : t("calendar.deleteCalendar")}
              </ArmedButton>
              <Button variant="ghost" onClick={() => setDeleting(null)}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </section>
  );
}

function CalendarRow({
  calendar,
  items,
  onToggle,
}: {
  calendar: CalendarInfo;
  items: MenuItem[];
  onToggle: (calendar: CalendarInfo) => void;
}) {
  const { t } = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const color = calendar.color ?? DEFAULT_COLOR;
  return (
    <li
      className={clsx(
        "group relative flex items-center gap-2.5 rounded-xl pr-1 pl-3 hover:bg-pink-tint/50",
        calendar.sharedBy ? "min-h-9 py-1" : "h-9",
      )}
      onContextMenu={(event) => {
        if (items.length === 0) return;
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={calendar.isVisible}
        onClick={() => onToggle(calendar)}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-[13.5px]"
      >
        <span
          className="grid size-[18px] shrink-0 place-items-center rounded-[6px] border-2"
          style={{ borderColor: color, background: calendar.isVisible ? color : "transparent" }}
          aria-hidden
        >
          {calendar.isVisible && <Icon icon={ICONS.done} size="xs" strokeWidth={3.5} className="size-3 text-white" />}
        </span>
        {calendar.isBirthdays && <Icon icon={ICONS.birthday} size="xs" className="shrink-0 text-muted" />}
        <span className={clsx("min-w-0 flex-1 truncate", !calendar.isVisible && "text-muted")}>
          {calendar.name}
          {calendar.sharedBy && (
            <span className="block truncate text-[11.5px] text-muted">
              {t("sharing.sharedBy", { name: calendar.sharedBy.name })}
            </span>
          )}
        </span>
        {Object.keys(calendar.sharedWith ?? {}).length > 0 && (
          <Icon
            icon={ICONS.people}
            size="xs"
            className="shrink-0 text-muted"
            label={t("sharing.sharedWithCount", { count: Object.keys(calendar.sharedWith ?? {}).length })}
          />
        )}
        {calendar.isDefault && (
          <span className="shrink-0 text-[11px] font-semibold text-muted">{t("calendar.default")}</span>
        )}
      </button>
      {items.length > 0 && (
        <Menu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          align="end"
          items={items}
          trigger={({ toggle, ...aria }) => (
            <IconButton
              icon={ICONS.more}
              size="sm"
              label={t("calendar.calendarActions", { name: calendar.name })}
              onClick={toggle}
              className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
              {...aria}
            />
          )}
        />
      )}
    </li>
  );
}

function CalendarForm({
  calendar,
  accounts,
  defaultAccount,
  onDone,
  onCancel,
}: {
  calendar: CalendarInfo | null;
  /** Where a new calendar can go; asked only when there is a choice. */
  accounts: { id: string; name: string }[];
  defaultAccount: string | undefined;
  onDone: (name: string, color: string, accountId: string | undefined) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState(calendar?.name ?? "");
  const [accountId, setAccountId] = useState(defaultAccount);
  const [color, setColor] = useState(calendar?.color ?? CALENDAR_COLORS[1]!);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const empty = !name.trim();

  return (
    <form
      className="flex flex-col gap-4 px-6 pt-5 pb-6"
      onSubmit={async (event) => {
        event.preventDefault();
        setTried(true);
        if (empty) return;
        setBusy(true);
        await onDone(name.trim(), color, accountId);
        setBusy(false);
      }}
    >
      <h2 className="text-lg font-bold">{calendar ? t("calendar.editCalendar") : t("calendar.newCalendar")}</h2>
      {/* The app's own birthdays calendar keeps its name; its colour is this device's. */}
      {!calendar?.isLocal && (
        <Field label={t("calendar.calendarName")} error={tried && empty ? t("calendar.problem.name") : undefined}>
          {(id) => (
            <TextInput
              id={id}
              autoFocus
              value={name}
              maxLength={255}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
      )}
      {!calendar && accounts.length > 1 && (
        <Field label={t("calendar.account")}>
          {(id) => (
            <Select id={id} value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <div role="radiogroup" aria-label={t("calendar.color")} className="flex flex-wrap gap-2">
        {CALENDAR_COLORS.map((swatch, index) => (
          <button
            key={swatch}
            type="button"
            role="radio"
            aria-checked={color === swatch}
            aria-label={t("calendar.colorNumber", { number: index + 1 })}
            onClick={() => setColor(swatch)}
            className={clsx(
              "grid size-8 place-items-center rounded-full transition-transform",
              color === swatch ? "scale-110 ring-2 ring-ink/70 ring-offset-2 ring-offset-surface" : "hover:scale-105",
            )}
            style={{ background: swatch }}
          >
            {color === swatch && <Icon icon={ICONS.done} strokeWidth={3} className="text-white" />}
          </button>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" busy={busy}>
          {calendar ? t("common.save") : t("calendar.create")}
        </Button>
      </div>
    </form>
  );
}
